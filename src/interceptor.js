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

import { countMsgTokens, countTokensCached, extractUsageTokens } from './tokens.js';
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

function tryParseJson(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const text = value.trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Text carried by one streamed delta (content, reasoning and tool arguments). */
function deltaText(delta) {
    if (!delta || typeof delta !== 'object') {
        return '';
    }
    let out = '';
    if (typeof delta.content === 'string') {
        out += delta.content;
    } else if (Array.isArray(delta.content)) {
        out += contentToText(delta.content);
    }
    if (typeof delta.reasoning_content === 'string') {
        out += delta.reasoning_content;
    } else if (typeof delta.reasoning === 'string') {
        out += delta.reasoning;
    }
    if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
            const args = call?.function?.arguments;
            if (typeof args === 'string') {
                out += args;
            } else if (args != null) {
                out += JSON.stringify(args);
            }
        }
    }
    return out;
}

function absorbChunk(state, chunk) {
    if (!chunk || typeof chunk !== 'object') {
        return;
    }
    // Some proxies wrap the chunk one level deep, e.g. {"data": {"choices": ...}}
    if (chunk.data && typeof chunk.data === 'object' && (chunk.data.choices || chunk.data.usage)) {
        absorbChunk(state, chunk.data);
        return;
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (choice) {
        state.text += deltaText(choice.delta);
        const messageContent = choice.message?.content;
        if (typeof messageContent === 'string') {
            state.text += messageContent;
        } else if (Array.isArray(messageContent)) {
            state.text += contentToText(messageContent);
        }
        if (typeof choice.text === 'string') {
            state.text += choice.text;
        }
        if (Array.isArray(choice.message?.tool_calls)) {
            for (const call of choice.message.tool_calls) {
                const args = call?.function?.arguments;
                if (typeof args === 'string') {
                    state.text += args;
                }
            }
        }
    }

    // Gemini native streamGenerateContent: candidates[].content.parts[].text
    if (Array.isArray(chunk.candidates)) {
        for (const candidate of chunk.candidates) {
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
                state.text += contentToText(parts);
            }
        }
    }

    if (chunk.usage && typeof chunk.usage === 'object') {
        state.usage = chunk.usage;
    } else if (chunk.usageMetadata && typeof chunk.usageMetadata === 'object') {
        state.usage = chunk.usageMetadata;
    }
}

/**
 * Parse a generate-response body.
 *
 * The `content-type` header cannot be trusted: several proxies stream SSE
 * (`data: {...}` lines) while announcing `application/json`, `text/plain` or no
 * type at all. Deciding by header alone made the whole body fall into the
 * `JSON.parse` branch, which throws on SSE, so both the reply text and the
 * `usage` numbers (including the final chunk shown by providers) were lost and
 * the extension silently fell back to local counting.
 *
 * Instead: try the body as one JSON document, otherwise parse it as SSE/NDJSON
 * lines. The final buffer is always flushed, so a last chunk without a trailing
 * newline is not dropped.
 *
 * @param {string} raw response body
 * @returns {{ text: string, usage: object|null }}
 */
export function parseResponseBody(raw) {
    const source = typeof raw === 'string' ? raw : '';
    const state = { text: '', usage: null };
    if (!source.trim()) {
        return state;
    }

    const single = tryParseJson(source);
    if (single) {
        absorbChunk(state, single);
        return state;
    }

    let sawSse = false;
    for (const line of source.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || /^(event|id|retry):/.test(trimmed)) {
            continue;
        }

        let payload;
        if (trimmed.startsWith('data:')) {
            sawSse = true;
            payload = trimmed.slice(5).trim();
        } else if (!sawSse) {
            // NDJSON / bare JSON lines without SSE framing
            payload = trimmed;
        } else {
            continue;
        }

        if (!payload || payload === '[DONE]' || payload === 'DONE') {
            continue;
        }
        const chunk = tryParseJson(payload);
        if (chunk) {
            absorbChunk(state, chunk);
        }
    }

    return state;
}

function collectResponse(response, onDone) {
    let clone;
    try {
        clone = response.clone();
    } catch {
        onDone({ text: '', usage: null });
        return;
    }

    // Read as text and sniff the format: the content-type header is unreliable.
    void clone.text()
        .then(raw => onDone(parseResponseBody(raw)))
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

        // Main window: only the in-flight main generation is observed. Its
        // response usage (prompt_tokens/completion_tokens) is the ground truth
        // the provider bills for, so it is preferred over local counting.
        // The request body is handed over too: `generate_data.prompt` can be
        // incomplete for some channels (that is where a bogus constant input
        // count came from), while the body is exactly what went over the wire.
        const interceptable = isGenerateUrl(url) && Boolean(body);
        const mainCapture = isMainWindow
            && interceptable
            && typeof globalThis.__tokenMonitorClaimMainFetch === 'function'
            && globalThis.__tokenMonitorClaimMainFetch()
                ? {
                    model: typeof body?.model === 'string' ? body.model : '',
                    request: body,
                }
                : null;

        const record = !isMainWindow
            && interceptable
            && Array.isArray(body?.messages)
            && body.messages.length > 0
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
                    void globalThis.__tokenMonitorDeliverMainUsage({
                        text,
                        usage,
                        model: mainCapture.model,
                        request: mainCapture.request,
                    });
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
        const usage = extractUsageTokens(record.usage);

        const input = usage && usage.input !== null
            ? usage.input
            : await countMsgTokens(record.requestTexts);
        const output = (usage && usage.output !== null)
            ? usage.output
            : (await countTokensCached(record.responseText ?? ''));
        const cachedInput = usage?.cachedInput ?? 0;
        const cacheWriteInput = usage?.cacheWriteInput ?? 0;

        const category = resolveCategory(record);
        const entry = appendRequest({
            kind: category,
            floor: null,
            model: record.model,
            input: input ?? 0,
            output: output ?? 0,
            cachedInput,
            cacheWriteInput,
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
