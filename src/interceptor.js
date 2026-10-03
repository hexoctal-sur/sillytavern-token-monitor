/**
 * AI call capture and classification.
 *
 * The 酒馆助手 (TavernHelper) script runs inside a same-origin iframe and issues
 * its AI calls directly with `fetch('/api/backends/chat-completions/generate')`.
 * We wrap the iframe's `fetch` to observe those calls. The wrapper only
 * *captures* the raw request/response material; classification, token counting
 * and floor attribution all happen on the main window side.
 *
 * The main window's own fetch is wrapped too, but only to observe the in-flight
 * main generation: its response `usage` (when the provider reports one) is the
 * billed ground truth and takes precedence over locally counted tokens.
 *
 * Classification is content-independent and uses, in priority order:
 *   user markers > fill window > plot window > response regression > other.
 */

import { countMsgTokens, countTokensCached } from './tokens.js';
import { recordAuxUsage, hasPlotMatch, appendRequest } from './store.js';

const GENERATE_PATH = '/api/backends/chat-completions/generate';
const FILL_WINDOW_TTL_MS = 120000;
const PLOT_WINDOW_TTL_MS = 180000;
const AUTOCARD_RETRY_INTERVAL_MS = 5000;
const AUTOCARD_RETRY_MAX = 60;

const classification = { mode: 'auto', plotMarkers: [], fillMarkers: [] };

const observer = { instance: null };
const patchedWindows = new Map();

let plotWindowOpen = false;
let plotWindowTimer = null;
let fillWindowOpen = false;
let fillWindowTimer = null;

let stHandlers = null;
let autoCardCallback = null;
let autoCardRetryTimer = null;
let autoCardRetryCount = 0;

let seq = 0;

function ctx() {
    return globalThis.SillyTavern?.getContext();
}

function getChatLength() {
    const chat = ctx()?.chat;
    return Array.isArray(chat) ? chat.length : 0;
}

/* ------------------------------------------------------------------ *
 * Classification windows
 * ------------------------------------------------------------------ */

function openFillWindow() {
    fillWindowOpen = true;
    if (fillWindowTimer) {
        clearTimeout(fillWindowTimer);
    }
    fillWindowTimer = setTimeout(() => {
        fillWindowOpen = false;
        fillWindowTimer = null;
    }, FILL_WINDOW_TTL_MS);
}

function openPlotWindow() {
    plotWindowOpen = true;
    if (plotWindowTimer) {
        clearTimeout(plotWindowTimer);
    }
    plotWindowTimer = setTimeout(() => {
        plotWindowOpen = false;
        plotWindowTimer = null;
    }, PLOT_WINDOW_TTL_MS);
}

function closePlotWindow() {
    plotWindowOpen = false;
    if (plotWindowTimer) {
        clearTimeout(plotWindowTimer);
        plotWindowTimer = null;
    }
}

function installClassifierEvents() {
    const context = ctx();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource || !eventTypes || stHandlers) {
        return;
    }

    stHandlers = {
        plotOpen: () => openPlotWindow(),
        plotClose: () => closePlotWindow(),
        fillOpen: () => openFillWindow(),
        chatChanged: () => scheduleAutoCardRetry(true),
    };

    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, stHandlers.plotOpen);
    eventSource.on(eventTypes.GENERATION_STARTED, stHandlers.plotClose);
    eventSource.on(eventTypes.GENERATION_ENDED, stHandlers.fillOpen);
    if (eventTypes.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, stHandlers.chatChanged);
    }
}

function uninstallClassifierEvents() {
    const context = ctx();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (eventSource && eventTypes && stHandlers) {
        eventSource.removeListener?.(eventTypes.GENERATION_AFTER_COMMANDS, stHandlers.plotOpen);
        eventSource.removeListener?.(eventTypes.GENERATION_STARTED, stHandlers.plotClose);
        eventSource.removeListener?.(eventTypes.GENERATION_ENDED, stHandlers.fillOpen);
        if (eventTypes.CHAT_CHANGED) {
            eventSource.removeListener?.(eventTypes.CHAT_CHANGED, stHandlers.chatChanged);
        }
    }
    stHandlers = null;
}

/* ------------------------------------------------------------------ *
 * AutoCardUpdaterAPI hooks (fill window)
 * ------------------------------------------------------------------ */

function getAutoCardApi() {
    return globalThis.AutoCardUpdaterAPI
        ?? globalThis.topLevelWindow?.AutoCardUpdaterAPI
        ?? null;
}

function registerAutoCardHooks() {
    const api = getAutoCardApi();
    if (!api || typeof api.registerTableFillStartCallback !== 'function') {
        return false;
    }
    if (autoCardCallback) {
        return true;
    }
    autoCardCallback = () => openFillWindow();
    try {
        api.registerTableFillStartCallback(autoCardCallback);
        return true;
    } catch (error) {
        console.warn('[TokenMonitor] registerTableFillStartCallback failed:', error);
        autoCardCallback = null;
        return false;
    }
}

function unregisterAutoCardHooks() {
    const api = getAutoCardApi();
    if (api && autoCardCallback && typeof api.unregisterTableFillStartCallback === 'function') {
        try {
            api.unregisterTableFillStartCallback(autoCardCallback);
        } catch (error) {
            console.warn('[TokenMonitor] unregisterTableFillStartCallback failed:', error);
        }
    }
    autoCardCallback = null;
}

function stopAutoCardRetry() {
    if (autoCardRetryTimer) {
        clearInterval(autoCardRetryTimer);
        autoCardRetryTimer = null;
    }
}

function scheduleAutoCardRetry(reset = false) {
    if (reset) {
        autoCardRetryCount = 0;
    }
    if (registerAutoCardHooks()) {
        stopAutoCardRetry();
        return;
    }
    if (autoCardRetryTimer) {
        return;
    }
    autoCardRetryTimer = setInterval(() => {
        autoCardRetryCount += 1;
        if (registerAutoCardHooks() || autoCardRetryCount >= AUTOCARD_RETRY_MAX) {
            stopAutoCardRetry();
        }
    }, AUTOCARD_RETRY_INTERVAL_MS);
}

/* ------------------------------------------------------------------ *
 * iframe fetch wrapping
 * ------------------------------------------------------------------ */

function collectSameOriginWindows(rootDocument, result) {
    let iframes;
    try {
        iframes = rootDocument.querySelectorAll('iframe');
    } catch {
        return result;
    }

    iframes.forEach(iframe => {
        if (!iframe.__tokenMonitorLoadBound) {
            iframe.__tokenMonitorLoadBound = true;
            iframe.addEventListener('load', () => scanIframes());
        }

        let win = null;
        try {
            win = iframe.contentWindow;
        } catch {
            win = null;
        }
        if (!win) {
            return;
        }
        try {
            if (!win.document) {
                return;
            }
        } catch {
            return;
        }

        if (!result.includes(win)) {
            result.push(win);
        }
        try {
            collectSameOriginWindows(win.document, result);
        } catch {
            /* ignore cross-origin descendants */
        }
    });

    return result;
}

function patchWindow(win, isMainWindow = false) {
    if (!win || win.__tokenMonitorAuxHooked) {
        return;
    }
    if (typeof win.fetch !== 'function') {
        return;
    }
    const original = win.fetch.bind(win);
    patchedWindows.set(win, win.fetch);
    win.fetch = createWrappedFetch(original, isMainWindow);
    win.__tokenMonitorAuxHooked = true;
}

function pruneClosedWindows() {
    for (const win of [...patchedWindows.keys()]) {
        try {
            if (win.closed) {
                patchedWindows.delete(win);
            }
        } catch {
            patchedWindows.delete(win);
        }
    }
}

function scanIframes() {
    if (typeof document === 'undefined') {
        return;
    }
    pruneClosedWindows();
    for (const win of collectSameOriginWindows(document, [])) {
        patchWindow(win);
    }
}

function isGenerateUrl(url) {
    if (typeof url !== 'string' || !url) {
        return false;
    }
    const path = url.split('?')[0].split('#')[0];
    return path.endsWith(GENERATE_PATH);
}

function contentToText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    if (content == null) {
        return '';
    }
    return String(content);
}

function extractRequestTexts(body) {
    return (body.messages ?? []).map(message => ({
        role: message?.role,
        content: contentToText(message?.content),
    }));
}

function matchMarkers(text, markers) {
    return markers.some(marker => marker && text.includes(marker));
}

function classifyAtRequest(body) {
    const requestText = extractRequestTexts(body).map(item => item.content).join('\n');

    if (matchMarkers(requestText, classification.plotMarkers)) {
        return 'plot';
    }
    if (matchMarkers(requestText, classification.fillMarkers)) {
        return 'fill';
    }
    if (classification.mode === 'markers-only') {
        return null;
    }
    if (fillWindowOpen) {
        return 'fill';
    }
    if (plotWindowOpen) {
        return 'plot';
    }
    return null;
}

function resolveCategory(record) {
    if (record.categoryHint) {
        return record.categoryHint;
    }
    if (hasPlotMatch(record.responseText)) {
        return 'plot';
    }
    return 'other';
}

async function readSse(response) {
    let text = '';
    let usage = null;
    const reader = response.body?.getReader?.();
    if (!reader) {
        return { text, usage };
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) {
                continue;
            }
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') {
                continue;
            }
            try {
                const chunk = JSON.parse(payload);
                const delta = chunk?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') {
                    text += delta;
                }
                if (chunk?.usage) {
                    usage = chunk.usage;
                }
            } catch {
                /* ignore malformed chunk */
            }
        }
    }

    return { text, usage };
}

function collectResponse(response, onDone) {
    const clone = response.clone();
    const contentType = clone.headers?.get?.('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
        void readSse(clone)
            .then(({ text, usage }) => onDone({ text, usage }))
            .catch(() => onDone({ text: '', usage: null }));
        return;
    }

    void clone.json()
        .then(payload => {
            const content = payload?.choices?.[0]?.message?.content;
            onDone({
                text: typeof content === 'string' ? content : (content == null ? '' : JSON.stringify(content)),
                usage: payload?.usage ?? null,
            });
        })
        .catch(() => onDone({ text: '', usage: null }));
}

function createWrappedFetch(original, isMainWindow) {
    return async function tokenMonitorFetch(input, init) {
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        let body = null;
        try {
            const raw = init?.body ?? (input && typeof input === 'object' ? input.body : null);
            if (typeof raw === 'string') {
                body = JSON.parse(raw);
            }
        } catch {
            body = null;
        }

        const interceptable = isGenerateUrl(url)
            && body
            && Array.isArray(body.messages)
            && body.messages.length > 0;

        // Main window: only the in-flight main generation is observed. Its
        // response usage (prompt_tokens/completion_tokens) is the ground truth
        // the provider bills for, so it is preferred over local counting.
        const mainCapture = isMainWindow
            && interceptable
            && typeof globalThis.__tokenMonitorClaimMainFetch === 'function'
            && globalThis.__tokenMonitorClaimMainFetch()
                ? { model: typeof body.model === 'string' ? body.model : '' }
                : null;

        const record = !isMainWindow && interceptable
            ? {
                seq: ++seq,
                ts: Date.now(),
                model: body.model || '',
                requestTexts: extractRequestTexts(body),
                stream: Boolean(body.stream),
                responseText: '',
                usage: null,
                categoryHint: classifyAtRequest(body),
                chatLenAt: getChatLength(),
            }
            : null;

        const response = await original(input, init);

        if (mainCapture) {
            collectResponse(response, ({ text, usage }) => {
                if (typeof globalThis.__tokenMonitorDeliverMainUsage === 'function') {
                    void globalThis.__tokenMonitorDeliverMainUsage({ text, usage, model: mainCapture.model });
                }
            });
        }

        if (record) {
            try {
                collectResponse(response, ({ text, usage }) => {
                    record.responseText = text;
                    record.usage = usage;
                    ingest(record);
                });
            } catch (error) {
                console.error('[TokenMonitor] aux capture failed:', error);
            }
        }

        return response;
    };
}

/* ------------------------------------------------------------------ *
 * Main-window ingest
 * ------------------------------------------------------------------ */

function ingest(record) {
    if (typeof globalThis.__tokenMonitorIngest === 'function') {
        void globalThis.__tokenMonitorIngest(record);
    }
}

async function handleIngest(record) {
    try {
        const usage = record.usage ?? null;
        const usageInput = Number(usage?.prompt_tokens);
        const usageOutput = Number(usage?.completion_tokens);

        const input = Number.isFinite(usageInput)
            ? usageInput
            : await countMsgTokens(record.requestTexts);
        const output = Number.isFinite(usageOutput)
            ? usageOutput
            : await countTokensCached(record.responseText ?? '');

        const category = resolveCategory(record);
        const entry = appendRequest({
            kind: category,
            floor: null,
            model: record.model,
            input: input ?? 0,
            output: output ?? 0,
            ts: record.ts,
        });

        await recordAuxUsage({
            category,
            logId: entry?.id,
            model: record.model,
            input: input ?? 0,
            output: output ?? 0,
            chatLenAt: record.chatLenAt,
            responseText: record.responseText,
            requestTexts: record.requestTexts,
            ts: record.ts,
        });
    } catch (error) {
        console.error('[TokenMonitor] aux ingest failed:', error);
    }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export function installAuxFetchInterceptor() {
    globalThis.__tokenMonitorIngest = handleIngest;
    installClassifierEvents();
    scheduleAutoCardRetry();
    patchWindow(window, true);
    scanIframes();

    if (!observer.instance && typeof MutationObserver === 'function' && typeof document !== 'undefined') {
        observer.instance = new MutationObserver(() => scanIframes());
        observer.instance.observe(document.documentElement, { childList: true, subtree: true });
    }
}

export function uninstallAuxFetchInterceptor() {
    for (const [win, original] of patchedWindows) {
        try {
            win.fetch = original;
            delete win.__tokenMonitorAuxHooked;
        } catch {
            /* ignore */
        }
    }
    patchedWindows.clear();

    observer.instance?.disconnect();
    observer.instance = null;

    stopAutoCardRetry();
    unregisterAutoCardHooks();
    uninstallClassifierEvents();

    if (globalThis.__tokenMonitorIngest === handleIngest) {
        delete globalThis.__tokenMonitorIngest;
    }
}

export function setMarkerConfig({ mode, plotMarkers, fillMarkers } = {}) {
    if (typeof mode === 'string') {
        classification.mode = mode;
    }
    if (Array.isArray(plotMarkers)) {
        classification.plotMarkers = plotMarkers.map(String).filter(Boolean);
    }
    if (Array.isArray(fillMarkers)) {
        classification.fillMarkers = fillMarkers.map(String).filter(Boolean);
    }
}

export function rescanAuxFrames() {
    scanIframes();
    scheduleAutoCardRetry(true);
}
