/**
 * Extension entry point.
 *
 * Responsibilities:
 *  - main-generation stats: input/output per message (via store)
 *  - auxiliary call capture: iframe fetch interceptor + classification
 *  - pricing catalogue: load cached prices on start
 *  - panel: mount on APP_READY
 *
 * Bundled to the repository-root `index.js` by esbuild.
 */

import { initTokenTracking, clearPendingInput } from './tokens.js';
import { updateMessageTokens, updateChatSummary, clearAllTokenData } from './store.js';
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

/* ------------------------------------------------------------------ *
 * Event handlers (main generation)
 * ------------------------------------------------------------------ */

async function onMessageSent(data) {
    const message = resolveMessage(data);
    if (!message || message.is_user !== true) {
        return;
    }
    await updateMessageTokens(message);
    refreshPanel();
}

async function onMessageReceived(data) {
    const message = resolveMessage(data);
    if (!message || message.is_user === true) {
        return;
    }
    await updateMessageTokens(message, { usePendingInput: true });
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
    await updateMessageTokens(message, { usePendingInput: true });
    refreshPanel();
}

function onChatChanged() {
    updateChatSummary();
    rescanAuxFrames();
    refreshPanel();
}

function onGenerationStopped() {
    clearPendingInput();
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
    subscribe(eventSource, eventTypes.MESSAGE_SENT, onMessageSent);
    subscribe(eventSource, eventTypes.MESSAGE_RECEIVED, onMessageReceived);
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
