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

import { initTokenTracking, takeGenerationType, isQuietType, countRequestTokens, countTextAsync } from './tokens.js';
import { updateMessageTokens, updateChatSummary, clearAllTokenData, appendRequest } from './store.js';
import { installAuxFetchInterceptor, uninstallAuxFetchInterceptor, rescanAuxFrames } from './interceptor.js';
import { loadCached as loadPriceCatalogue } from './pricing.js';
import { mountPanel, unmountPanel, refreshPanel } from './panel.js';

let started = false;
let subscriptions = [];

/** In-flight main generation: { ts, inputPromise } until a message event binds it. */
let pendingMainRequest = null;

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
 *   -> MESSAGE_RECEIVED / IMPERSONATE_READY (bind to floor, append request record)
 * ------------------------------------------------------------------ */

function beginMainRequest(generateData) {
    pendingMainRequest = {
        ts: Date.now(),
        inputPromise: countRequestTokens(generateData),
    };
}

async function takePendingMainRequest() {
    const pending = pendingMainRequest;
    pendingMainRequest = null;
    if (!pending) {
        return null;
    }
    const input = await pending.inputPromise;
    return { ts: pending.ts, input };
}

function discardPendingMainRequest() {
    pendingMainRequest = null;
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
 * re-generations of the same floor appear as separate rows) plus, when a
 * message is involved, the per-message snapshot.
 */
async function finalizeMainRequest({ text, model, message }, index) {
    const pending = await takePendingMainRequest();
    if (!pending) {
        return false;
    }

    const output = await countTextAsync(text ?? '');
    const capturedModel = model ?? '';

    if (message) {
        await updateMessageTokens(message, { input: pending.input, output });
    }
    appendRequest({
        kind: 'main',
        floor: Number.isInteger(index) ? index : null,
        model: capturedModel,
        input: pending.input,
        output,
        ts: pending.ts,
    });
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
