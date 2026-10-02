/**
 * Persistence layer for per-message token stats.
 *
 * Two kinds of usage are tracked:
 *  - Main chat generation: `input` (prompt context size) and `output` (reply
 *    text) per message, stored on `message.extra.token_monitor`.
 *  - Auxiliary AI calls made by other scripts (plot progression, table filling,
 *    other same-endpoint calls): aggregated per message under
 *    `aux.{plot,fill,other}`, or parked on
 *    `chatMetadata.token_monitor_unattributed` when no floor can be resolved.
 *
 * Everything lives inside the chat JSONL file (message lines + header), so it is
 * persisted to disk together with the chat.
 */

import { countTextAsync, consumePendingInput } from './tokens.js';

export const DATA_KEY = 'token_monitor';
export const UNATTRIBUTED_KEY = 'token_monitor_unattributed';

const SCHEMA_VERSION = 2;
const SAVE_DEBOUNCE_MS = 1500;
const AUX_CATEGORIES = ['plot', 'fill', 'other'];

const PLOT_MATCH_RETRIES = 40;
const PLOT_MATCH_INTERVAL_MS = 1000;
const FILL_TEXT_MIN_LENGTH = 60;
const TEXT_MATCH_MIN_LENGTH = 20;

let saveTimer = null;

function ctx() {
    return globalThis.SillyTavern?.getContext();
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function isTrackable(message) {
    return Boolean(message)
        && typeof message === 'object'
        && message.is_system !== true
        && typeof message.mes === 'string';
}

/* ------------------------------------------------------------------ *
 * Data model
 * ------------------------------------------------------------------ */

function emptyCategory() {
    return { calls: 0, input: 0, output: 0, byModel: {} };
}

function emptyAux() {
    return { plot: emptyCategory(), fill: emptyCategory(), other: emptyCategory() };
}

function normalizeByModel(byModel) {
    const result = {};
    if (!byModel || typeof byModel !== 'object') {
        return result;
    }
    for (const [model, value] of Object.entries(byModel)) {
        result[model] = {
            calls: toNumber(value?.calls),
            input: toNumber(value?.input),
            output: toNumber(value?.output),
        };
    }
    return result;
}

/** Coerce arbitrary/legacy aux data into the v2 shape. */
export function normalizeAux(aux) {
    const result = emptyAux();
    if (!aux || typeof aux !== 'object') {
        return result;
    }
    for (const category of AUX_CATEGORIES) {
        const source = aux[category];
        if (!source || typeof source !== 'object') {
            continue;
        }
        result[category] = {
            calls: toNumber(source.calls),
            input: toNumber(source.input),
            output: toNumber(source.output),
            byModel: normalizeByModel(source.byModel),
        };
    }
    return result;
}

function addToCategory(category, { model, input, output }) {
    category.calls += 1;
    category.input += toNumber(input);
    category.output += toNumber(output);

    const key = model || '';
    if (!key) {
        return;
    }
    const entry = category.byModel[key] ?? { calls: 0, input: 0, output: 0 };
    entry.calls += 1;
    entry.input += toNumber(input);
    entry.output += toNumber(output);
    category.byModel[key] = entry;
}

function mergeCategory(target, source) {
    target.calls += toNumber(source.calls);
    target.input += toNumber(source.input);
    target.output += toNumber(source.output);
    for (const [model, value] of Object.entries(source.byModel ?? {})) {
        const entry = target.byModel[model] ?? { calls: 0, input: 0, output: 0 };
        entry.calls += toNumber(value.calls);
        entry.input += toNumber(value.input);
        entry.output += toNumber(value.output);
        target.byModel[model] = entry;
    }
}

function aggregateAuxByModel(aux) {
    const result = {};
    for (const category of AUX_CATEGORIES) {
        for (const [model, value] of Object.entries(aux[category].byModel)) {
            const entry = result[model] ?? { calls: 0, input: 0, output: 0 };
            entry.calls += toNumber(value.calls);
            entry.input += toNumber(value.input);
            entry.output += toNumber(value.output);
            result[model] = entry;
        }
    }
    return result;
}

function buildData({ input, output, aux, ts }) {
    return {
        v: SCHEMA_VERSION,
        input: input ?? null,
        output: output ?? null,
        total: (input ?? 0) + (output ?? 0),
        aux: normalizeAux(aux),
        ts: ts ?? Date.now(),
    };
}

export function getMessageTokens(message) {
    return message?.extra?.[DATA_KEY] ?? null;
}

function attach(message, data) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    message.extra[DATA_KEY] = data;
}

/* ------------------------------------------------------------------ *
 * Main generation (input / output per message)
 * ------------------------------------------------------------------ */

/** Record or refresh the main-generation token stats of a single message. */
export async function updateMessageTokens(message, { usePendingInput = false } = {}) {
    if (!isTrackable(message)) {
        return null;
    }

    const existing = getMessageTokens(message) ?? {};
    const own = await countTextAsync(message.mes);
    const isUser = message.is_user === true;

    const input = isUser
        ? own
        : (usePendingInput ? (consumePendingInput() ?? existing.input ?? null) : (existing.input ?? null));
    const output = isUser ? 0 : own;

    const data = buildData({ input, output, aux: existing.aux, ts: existing.ts });
    attach(message, data);
    scheduleSave();
    return data;
}

/**
 * Recompute own-text tokens for every message.
 * Preserves known prompt inputs and any recorded aux data.
 */
export async function recomputeChat() {
    const context = ctx();
    const chat = context?.chat ?? [];

    for (const message of chat) {
        if (!isTrackable(message)) {
            continue;
        }

        const existing = getMessageTokens(message) ?? {};
        const own = await countTextAsync(message.mes);
        const isUser = message.is_user === true;
        const input = isUser ? own : (existing.input ?? null);
        const output = isUser ? 0 : own;

        attach(message, buildData({ input, output, aux: existing.aux, ts: existing.ts }));
    }

    await flushSave();
}

/* ------------------------------------------------------------------ *
 * Auxiliary calls: attribution
 * ------------------------------------------------------------------ */

function textMatches(a, b) {
    if (!a || !b) {
        return false;
    }
    if (a === b) {
        return true;
    }
    if (a.length >= TEXT_MATCH_MIN_LENGTH && b.includes(a)) {
        return true;
    }
    if (b.length >= TEXT_MATCH_MIN_LENGTH && a.includes(b)) {
        return true;
    }
    return false;
}

function findPlotMessage(responseText) {
    if (!responseText) {
        return null;
    }
    const chat = ctx()?.chat ?? [];

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system === true) {
            continue;
        }
        if (textMatches(message.qrf_plot, responseText)) {
            return message;
        }
        const tasks = message.qrf_plot_tasks;
        if (tasks && typeof tasks === 'object') {
            for (const value of Object.values(tasks)) {
                if (typeof value === 'string' && textMatches(value, responseText)) {
                    return message;
                }
            }
        }
    }
    return null;
}

/** Whether a response text can be matched to a floor's plot result. */
export function hasPlotMatch(responseText) {
    return Boolean(findPlotMessage(responseText));
}

function findNearestUserMessage(chatLenAt) {
    const chat = ctx()?.chat ?? [];
    const limit = Number.isInteger(chatLenAt) && chatLenAt > 0 && chatLenAt <= chat.length
        ? chatLenAt
        : chat.length;

    for (let i = limit - 1; i >= 0; i--) {
        if (chat[i]?.is_user === true) {
            return chat[i];
        }
    }
    return null;
}

function findDeepestMatchingAiFloor(requestTexts) {
    const chat = ctx()?.chat ?? [];

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system === true) {
            continue;
        }
        const mes = typeof message.mes === 'string' ? message.mes : '';
        if (mes.length < FILL_TEXT_MIN_LENGTH) {
            continue;
        }
        if (requestTexts.some(text => text.includes(mes) || mes.includes(text))) {
            if (message.is_user !== true) {
                return message;
            }
        }
    }
    return null;
}

function findLatestAiFloor() {
    const chat = ctx()?.chat ?? [];

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && message.is_system !== true && message.is_user !== true) {
            return message;
        }
    }
    return null;
}

function addAuxToMessage(message, category, record) {
    if (!isTrackable(message)) {
        addUnattributed(category, record);
        return;
    }

    const existing = getMessageTokens(message) ?? {};
    const data = buildData({
        input: existing.input ?? null,
        output: existing.output ?? null,
        aux: existing.aux,
        ts: existing.ts,
    });
    addToCategory(data.aux[category], record);
    attach(message, data);
}

function addUnattributed(category, record) {
    const context = ctx();
    if (!context?.chatMetadata) {
        return;
    }

    const bucket = normalizeAux(context.chatMetadata[UNATTRIBUTED_KEY]);
    addToCategory(bucket[category], record);
    context.chatMetadata[UNATTRIBUTED_KEY] = bucket;

    if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    }
}

async function recordPlotUsage(record) {
    let target = findPlotMessage(record.responseText);

    if (!target && record.responseText) {
        for (let attempt = 0; attempt < PLOT_MATCH_RETRIES && !target; attempt++) {
            await delay(PLOT_MATCH_INTERVAL_MS);
            target = findPlotMessage(record.responseText);
        }
    }

    if (!target) {
        target = findNearestUserMessage(record.chatLenAt);
    }

    if (!target) {
        addUnattributed('plot', record);
        return;
    }

    addAuxToMessage(target, 'plot', record);
    scheduleSave();
}

function recordFillUsage(record) {
    const requestTexts = (record.requestTexts ?? [])
        .map(item => item?.content)
        .filter(text => typeof text === 'string' && text.length > 0);

    const target = findDeepestMatchingAiFloor(requestTexts) ?? findLatestAiFloor();

    if (!target) {
        addUnattributed('fill', record);
        return;
    }

    addAuxToMessage(target, 'fill', record);
    scheduleSave();
}

/**
 * Attribute one classified auxiliary call.
 * @param {{ category: 'plot'|'fill'|'other', model?: string, input?: number,
 *           output?: number, chatLenAt?: number, responseText?: string,
 *           requestTexts?: Array<{content?: string}>, ts?: number }} record
 */
export async function recordAuxUsage(record) {
    if (!record || !AUX_CATEGORIES.includes(record.category)) {
        return;
    }

    if (record.category === 'plot') {
        await recordPlotUsage(record);
        return;
    }

    if (record.category === 'fill') {
        recordFillUsage(record);
        return;
    }

    addUnattributed(record.category, record);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

export function computeChatSummary() {
    const context = ctx();
    const chat = context?.chat ?? [];

    let totalInput = 0;
    let totalOutput = 0;
    let ownTotal = 0;
    let counted = 0;
    let messageCount = 0;
    let lastInput = null;

    const aux = emptyAux();

    for (const message of chat) {
        if (!message || message.is_system === true) {
            continue;
        }
        messageCount += 1;

        const data = getMessageTokens(message);
        if (!data) {
            continue;
        }

        const input = Number(data.input);
        const output = Number(data.output);
        const hasInput = Number.isFinite(input);
        const hasOutput = Number.isFinite(output);

        totalInput += hasInput ? input : 0;
        totalOutput += hasOutput ? output : 0;
        ownTotal += message.is_user === true
            ? (hasInput ? input : 0)
            : (hasOutput ? output : 0);
        counted += 1;

        if (message.is_user !== true && hasInput) {
            lastInput = input;
        }

        if (data.aux) {
            const normalized = normalizeAux(data.aux);
            for (const category of AUX_CATEGORIES) {
                mergeCategory(aux[category], normalized[category]);
            }
        }
    }

    const unattributed = normalizeAux(context?.chatMetadata?.[UNATTRIBUTED_KEY]);
    for (const category of AUX_CATEGORIES) {
        mergeCategory(aux[category], unattributed[category]);
    }

    return {
        totalInput,
        totalOutput,
        total: totalInput + totalOutput,
        ownTotal,
        counted,
        messageCount,
        lastInput,
        aux,
        auxByModel: aggregateAuxByModel(aux),
    };
}

export function updateChatSummary() {
    const context = ctx();
    if (!context?.chatMetadata) {
        return;
    }

    const summary = computeChatSummary();
    context.chatMetadata[DATA_KEY] = {
        v: SCHEMA_VERSION,
        totalInput: summary.totalInput,
        totalOutput: summary.totalOutput,
        aux: summary.aux,
        updatedAt: Date.now(),
    };

    if (typeof context.saveMetadataDebounced === 'function') {
        context.saveMetadataDebounced();
    }
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export function scheduleSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushSave();
    }, SAVE_DEBOUNCE_MS);
}

export async function flushSave() {
    const context = ctx();
    updateChatSummary();

    if (context && typeof context.saveChat === 'function') {
        try {
            await context.saveChat();
        } catch (error) {
            console.error('[TokenMonitor] save chat failed:', error);
        }
    }
}

export function clearChatTokenData() {
    const context = ctx();
    const chat = context?.chat ?? [];

    for (const message of chat) {
        if (message?.extra && Object.hasOwn(message.extra, DATA_KEY)) {
            delete message.extra[DATA_KEY];
        }
    }

    if (context?.chatMetadata) {
        delete context.chatMetadata[DATA_KEY];
        delete context.chatMetadata[UNATTRIBUTED_KEY];
    }

    void flushSave();
}

export function clearAllTokenData() {
    clearChatTokenData();
}
