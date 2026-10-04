/**
 * Extension entry point.
 *
 * Responsibilities:
 *  - main-generation stats: one request record per generation (swipes and
 *    continues included), input counted from the assembled request payload
 *    published via `GENERATE_AFTER_DATA`, output from the reply text
 *  - auxiliary call capture: iframe fetch interceptor + classification
 *  - pricing catalogue: load cached prices on start
 *  - panel: mount on APP_READY
 *
 * Bundled to the repository-root `index.js` by esbuild.
 */

import { initTokenTracking, takeGenerationType, isQuietType, countRequestTokens, countTextAsync, extractUsageTokens } from './tokens.js';
import { updateMessageTokens, updateChatSummary, clearAllTokenData, appendRequest, patchRequest } from './store.js';
import { installAuxFetchInterceptor, uninstallAuxFetchInterceptor, rescanAuxFrames } from './interceptor.js';
import { loadCached as loadPriceCatalogue } from './pricing.js';
import { mountPanel, unmountPanel, refreshPanel } from './panel.js';

let started = false;
let subscriptions = [];

function ctx() {
    return globalThis.SillyTavern?.getContext();
}

function resolveMessage(data) {
    const chat = ctx()?.chat ?? [];
    if (Number.isInteger(data) && data >= 0 && data < chat.length) {
        return chat[data];
    }
    return chat.length ? chat[chat.length - 1] : null;
}

function resolveMessageIndex(data) {
    const chat = ctx()?.chat ?? [];
    if (Number.isInteger(data) && data >= 0 && data < chat.length) {
        return data;
    }
    return chat.length ? chat.length - 1 : null;
}

/* ------------------------------------------------------------------ *
 * Main generation request lifecycle
 *
 * generate_interceptor (type) -> GENERATE_AFTER_DATA (prompt payload)
 *   -> fetch interceptor (API usage from the response, preferred)
 *   -> MESSAGE_RECEIVED / IMPERSONATE_READY (bind to floor, append request record)
 *
 * Local token counting is only a fallback: providers bill by their own usage
 * numbers, which the response carries whenever the API reports them.
 * ------------------------------------------------------------------ */

/** In-flight generation, not yet bound to a message. */
let pendingMainRequest = null;
/** Last capture, still patchable by a late-arriving usage payload. */
let lastMainCapture = null;

function beginMainRequest(generateData) {
    const capture = {
        ts: Date.now(),
        counted: countRequestTokens(generateData),
        usage: null,
        awaitingFetch: true,
        entry: null,
        message: null,
    };
    pendingMainRequest = capture;
    lastMainCapture = capture;
}

function takePendingMainRequest() {
    const capture = pendingMainRequest;
    pendingMainRequest = null;
    return capture;
}

function discardPendingMainRequest() {
    pendingMainRequest = null;
}

/** Called by the fetch interceptor: one capture binds at most one request. */
function claimMainFetch() {
    const capture = pendingMainRequest;
    if (!capture || !capture.awaitingFetch) {
        return false;
    }
    capture.awaitingFetch = false;
    return true;
}

/** Called by the fetch interceptor with the response's `usage` (if any). */
function deliverMainUsage({ usage, model } = {}) {
    const capture = lastMainCapture;
    if (!capture) {
        return;
    }

    const tokens = extractUsageTokens(usage);
    if (!tokens || (tokens.input === null && tokens.output === null)) {
        return;
    }

    capture.usage = {
        input: tokens.input,
        output: tokens.output,
        cachedInput: tokens.cachedInput,
        cacheWriteInput: tokens.cacheWriteInput,
        model: typeof model === 'string' ? model : '',
    };

    if (capture.entry) {
        const fields = {
            cachedInput: tokens.cachedInput,
            cacheWriteInput: tokens.cacheWriteInput,
        };
        if (tokens.input !== null) {
            fields.input = tokens.input;
        }
        if (tokens.output !== null) {
            fields.output = tokens.output;
        }
        patchRequest(capture.entry.id, fields);
        if (capture.message) {
            void updateMessageTokens(capture.message, {
                input: tokens.input !== null ? tokens.input : undefined,
                output: tokens.output !== null ? tokens.output : undefined,
            });
        }
        refreshPanel();
    }
}

async function onGenerateAfterData(generateData, dryRun) {
    const type = takeGenerationType();
    if (dryRun || isQuietType(type)) {
        return;
    }
    beginMainRequest(generateData);
}

/**
 * Bind the in-flight generation to its result: one request record (so
 * re-generations of one floor appear as separate rows) plus, when a message is
 * involved, the per-message snapshot. API usage wins over local counting.
 */
async function finalizeMainRequest({ text, model, message }, index) {
    const capture = takePendingMainRequest();
    if (!capture) {
        return false;
    }

    const countedInput = await capture.counted;
    const usage = capture.usage;
    const input = usage?.input ?? countedInput ?? null;
    const cachedInput = usage?.cachedInput ?? 0;
    const cacheWriteInput = usage?.cacheWriteInput ?? 0;

    let output = usage?.output ?? null;
    if (message) {
        const data = await updateMessageTokens(message, {
            input,
            output: usage?.output,
        });
        if (output === null) {
            output = data?.output ?? null;
        }
    } else if (output === null) {
        output = await countTextAsync(text ?? '');
    }

    const entry = appendRequest({
        kind: 'main',
        floor: Number.isInteger(index) ? index : null,
        model: model || usage?.model || '',
        input,
        output,
        cachedInput,
        cacheWriteInput,
        ts: capture.ts,
    });
    capture.entry = entry ?? null;
    capture.message = message ?? null;
    return true;
}

/* ------------------------------------------------------------------ *
 * Event handlers
 * ------------------------------------------------------------------ */

async function onMessageSent(data) {
    const message = resolveMessage(data);
    if (!message) {
        return;
    }
    await updateMessageTokens(message);
    refreshPanel();
}

async function onMessageReceived(data) {
    const message = resolveMessage(data);
    if (!message) {
        return;
    }
    const finalized = await finalizeMainRequest({
        text: message.mes,
        model: message?.extra?.model || '',
        message,
    }, resolveMessageIndex(data));
    if (!finalized) {
        await updateMessageTokens(message);
    }
    refreshPanel();
}

/** Impersonation only fills the send box: no message is saved, so the request
 *  is recorded without a floor. */
async function onImpersonateReady(text) {
    await finalizeMainRequest({ text, model: '' }, null);
    refreshPanel();
}

async function onMessageEdited(data) {
    const message = resolveMessage(data);
    if (!message) {
        return;
    }
    await updateMessageTokens(message);
    refreshPanel();
}

async function onMessageSwiped(data) {
    const message = resolveMessage(data);
    if (!message) {
        return;
    }
    await updateMessageTokens(message);
    refreshPanel();
}

function onChatChanged() {
    updateChatSummary();
    rescanAuxFrames();
    refreshPanel();
}

function onGenerationStopped() {
    discardPendingMainRequest();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function subscribe(eventSource, eventType, handler) {
    if (!eventType || typeof eventSource?.on !== 'function') {
        return;
    }
    eventSource.on(eventType, handler);
    subscriptions.push([eventType, handler]);
}

function registerEvents() {
    const context = ctx();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource || !eventTypes || subscriptions.length) {
        return;
    }

    subscribe(eventSource, eventTypes.APP_READY, () => mountPanel());
    subscribe(eventSource, eventTypes.GENERATE_AFTER_DATA, onGenerateAfterData);
    subscribe(eventSource, eventTypes.MESSAGE_SENT, onMessageSent);
    subscribe(eventSource, eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    subscribe(eventSource, eventTypes.IMPERSONATE_READY, onImpersonateReady);
    subscribe(eventSource, eventTypes.MESSAGE_EDITED, onMessageEdited);
    subscribe(eventSource, eventTypes.MESSAGE_SWIPED, onMessageSwiped);
    subscribe(eventSource, eventTypes.MESSAGE_DELETED, onChatChanged);
    subscribe(eventSource, eventTypes.CHAT_CHANGED, onChatChanged);
    subscribe(eventSource, eventTypes.GENERATION_STOPPED, onGenerationStopped);
}

function unregisterEvents() {
    const eventSource = ctx()?.eventSource;
    for (const [eventType, handler] of subscriptions) {
        eventSource?.removeListener?.(eventType, handler);
    }
    subscriptions = [];
}

export function start() {
    if (started) {
        return;
    }
    started = true;

    initTokenTracking();
    globalThis.__tokenMonitorClaimMainFetch = claimMainFetch;
    globalThis.__tokenMonitorDeliverMainUsage = deliverMainUsage;
    installAuxFetchInterceptor();
    void loadPriceCatalogue();
    registerEvents();
}

export function stop() {
    if (!started) {
        return;
    }
    started = false;

    unregisterEvents();
    uninstallAuxFetchInterceptor();
    unmountPanel();
    if (globalThis.__tokenMonitorClaimMainFetch === claimMainFetch) {
        delete globalThis.__tokenMonitorClaimMainFetch;
    }
    if (globalThis.__tokenMonitorDeliverMainUsage === deliverMainUsage) {
        delete globalThis.__tokenMonitorDeliverMainUsage;
    }
}

/* ------------------------------------------------------------------ *
 * Lifecycle hooks (referenced from manifest.json)
 * ------------------------------------------------------------------ */

export function onEnable() {
    start();
}

export function onDisable() {
    stop();
}

export function onClean() {
    clearAllTokenData();
    stop();
}

start();
