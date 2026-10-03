/**
 * Persistence layer for token stats.
 *
 * Two layers are kept:
 *  - A per-request log (`chatMetadata.token_monitor_requests`): one append-only
 *    entry per AI request — main generation (including swipes/continues of the
 *    same floor), plot progression, table filling and other auxiliary calls.
 *    Entries keep their own model/input/output and the floor they were
 *    attributed to, so re-generations of one floor stay visible as separate
 *    rows.
 *  - Per-message stats (`message.extra.token_monitor`): a snapshot of the
 *    current content of each floor — `input`/`output` for the main generation
 *    plus `aux.{plot,fill,other}` aggregates (or
 *    `chatMetadata.token_monitor_unattributed` when no floor resolves).
 *
 * Everything lives inside the chat JSONL file (message lines + header), so it is
 * persisted to disk together with the chat.
 */

import { countTextAsync } from './tokens.js';

export const DATA_KEY = 'token_monitor';
export const UNATTRIBUTED_KEY = 'token_monitor_unattributed';
export const REQUESTS_KEY = 'token_monitor_requests';

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

/**
 * Text a generation produced for this message. Reasoning (thinking) is part of
 * the billed completion, so it counts towards the output too.
 */
function ownTextOf(message) {
    const mes = typeof message?.mes === 'string' ? message.mes : '';
    if (message?.is_user === true) {
        return mes;
    }
    const reasoning = message?.extra?.reasoning;
    return `${typeof reasoning === 'string' ? reasoning : ''}${mes}`;
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
 * Request log (append-only, one entry per AI request)
 * ------------------------------------------------------------------ */

function getRequestLog() {
    const context = ctx();
    if (!context?.chatMetadata) {
        return [];
    }
    if (!Array.isArray(context.chatMetadata[REQUESTS_KEY])) {
        context.chatMetadata[REQUESTS_KEY] = [];
    }
    return context.chatMetadata[REQUESTS_KEY];
}

/** Normalized copy of the request log, sorted by request time. */
export function listRequests() {
    return getRequestLog()
        .map(entry => ({ ...entry, floor: Number.isInteger(entry.floor) ? entry.floor : null }))
        .sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
}

/**
 * Append one request record to the log.
 * @param {{ kind: 'main'|'plot'|'fill'|'other', floor?: number|null, model?: string,
 *           input?: number|null, output?: number|null, ts?: number }} record
 * @returns {object|null} the stored entry (mutable; use `patchRequest` to update)
 */
export function appendRequest(record) {
    const context = ctx();
    if (!context?.chatMetadata || !record) {
        return null;
    }

    const log = getRequestLog();
    const lastId = log.length ? toNumber(log[log.length - 1].id) : 0;
    const entry = {
        id: lastId + 1,
        ts: toNumber(record.ts) || Date.now(),
        kind: record.kind,
        floor: Number.isInteger(record.floor) ? record.floor : null,
        model: typeof record.model === 'string' ? record.model : '',
        input: Number.isFinite(Number(record.input)) && record.input !== null ? Number(record.input) : null,
        output: Number.isFinite(Number(record.output)) && record.output !== null ? Number(record.output) : null,
    };
    log.push(entry);
    scheduleSave();
    return entry;
}

/** Patch fields of an existing request record (e.g. late floor attribution). */
export function patchRequest(id, fields) {
    const entry = getRequestLog().find(item => toNumber(item.id) === toNumber(id));
    if (!entry || !fields) {
        return null;
    }
    if ('floor' in fields) {
        entry.floor = Number.isInteger(fields.floor) ? fields.floor : null;
    }
    if ('input' in fields) {
        entry.input = Number.isFinite(Number(fields.input)) ? Number(fields.input) : null;
    }
    if ('output' in fields) {
        entry.output = Number.isFinite(Number(fields.output)) ? Number(fields.output) : null;
    }
    if ('model' in fields && typeof fields.model === 'string') {
        entry.model = fields.model;
    }
    scheduleSave();
    return entry;
}

/** Aggregate the request log: main totals plus per-kind aux usage. */
export function computeRequestSummary() {
    const main = { calls: 0, input: 0, output: 0, unknownInput: false };
    const aux = emptyAux();

    for (const entry of getRequestLog()) {
        const input = entry.input === null ? 0 : toNumber(entry.input);
        const output = entry.output === null ? 0 : toNumber(entry.output);

        if (entry.kind === 'main') {
            main.calls += 1;
            main.input += input;
            main.output += output;
            if (entry.input === null) {
                main.unknownInput = true;
            }
            continue;
        }

        const category = aux[entry.kind];
        if (category) {
            addToCategory(category, { model: entry.model, input, output });
        }
    }

    return {
        main,
        aux,
        totalInput: main.input,
        totalOutput: main.output,
        total: main.input + main.output,
    };
}

/* ------------------------------------------------------------------ *
 * Main generation (input / output per message)
 * ------------------------------------------------------------------ */

/**
 * Record or refresh the main-generation token stats of a single message.
 * `input`/`output` are explicit overrides coming from the captured request;
 * when omitted they fall back to the natural defaults (own text for user
 * messages, preserved input / recounted text for AI messages).
 */
export async function updateMessageTokens(message, { input, output } = {}) {
    if (!isTrackable(message)) {
        return null;
    }

    const existing = getMessageTokens(message) ?? {};
    const own = await countTextAsync(ownTextOf(message));
    const isUser = message.is_user === true;

    const resolvedInput = input !== undefined ? input : (isUser ? own : (existing.input ?? null));
    const resolvedOutput = output !== undefined ? output : (isUser ? 0 : own);

    const data = buildData({ input: resolvedInput, output: resolvedOutput, aux: existing.aux, ts: existing.ts });
    attach(message, data);
    scheduleSave();
    return data;
}

/**
 * Recompute own-text tokens for every message and for the request log.
 * Preserves known prompt inputs and any recorded aux data; only the *current*
 * text of each floor is recounted, superseded generations keep their counts.
 */
export async function recomputeChat() {
    const context = ctx();
    const chat = context?.chat ?? [];

    for (const message of chat) {
        if (!isTrackable(message)) {
            continue;
        }

        const existing = getMessageTokens(message) ?? {};
        const own = await countTextAsync(ownTextOf(message));
        const isUser = message.is_user === true;
        const input = isUser ? own : (existing.input ?? null);
        const output = isUser ? 0 : own;

        attach(message, buildData({ input, output, aux: existing.aux, ts: existing.ts }));
    }

    const lastMainByFloor = new Map();
    for (const entry of getRequestLog()) {
        if (entry.kind === 'main' && Number.isInteger(entry.floor)) {
            lastMainByFloor.set(entry.floor, entry);
        }
    }
    for (const [floor, entry] of lastMainByFloor) {
        const message = chat[floor];
        if (!isTrackable(message)) {
            continue;
        }
        const own = await countTextAsync(ownTextOf(message));
        if (own !== null) {
            entry.output = own;
        }
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

function findPlotMessage(responseText, minIndex = 0) {
    if (!responseText) {
        return null;
    }
    const chat = ctx()?.chat ?? [];

    for (let i = chat.length - 1; i >= minIndex; i--) {
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

/**
 * The user message that triggered the call — the floor being created, not some
 * older existing floor. Requests are often issued just before SillyTavern
 * pushes the message into the chat, so the search must NOT be bounded by the
 * chat length captured at request time (`chatLenAt`), otherwise the just-sent
 * message is skipped and an older user message gets the usage instead.
 */
function findTriggerUserMessage() {
    const chat = ctx()?.chat ?? [];

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && message.is_system !== true && message.is_user === true) {
            return message;
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

function indexOfMessage(message) {
    const chat = ctx()?.chat ?? [];
    const index = chat.indexOf(message);
    return index >= 0 ? index : null;
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
    // Only floors at/after the trigger may own the plot result; a match on an
    // older floor is a stale `qrf_plot` and must not steal the usage.
    const findMatch = () => {
        const minIndex = indexOfMessage(findTriggerUserMessage()) ?? 0;
        return findPlotMessage(record.responseText, minIndex);
    };

    let target = findMatch();

    if (!target && record.responseText) {
        for (let attempt = 0; attempt < PLOT_MATCH_RETRIES && !target; attempt++) {
            await delay(PLOT_MATCH_INTERVAL_MS);
            target = findMatch();
        }
    }

    if (!target) {
        target = findTriggerUserMessage();
    }

    if (!target) {
        addUnattributed('plot', record);
        return;
    }

    patchRequest(record.logId, { floor: indexOfMessage(target) });
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

    patchRequest(record.logId, { floor: indexOfMessage(target) });
    addAuxToMessage(target, 'fill', record);
    scheduleSave();
}

/**
 * Attribute one classified auxiliary call to its floor (message-level
 * aggregates) and update the floor of its request-log entry.
 * @param {{ category: 'plot'|'fill'|'other', logId?: number, model?: string,
 *           input?: number, output?: number, chatLenAt?: number,
 *           responseText?: string, requestTexts?: Array<{content?: string}>,
 *           ts?: number }} record
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

export function updateChatSummary() {
    const context = ctx();
    if (!context?.chatMetadata) {
        return;
    }

    const summary = computeRequestSummary();
    context.chatMetadata[DATA_KEY] = {
        v: SCHEMA_VERSION,
        totalInput: summary.main.input,
        totalOutput: summary.main.output,
        calls: summary.main.calls,
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
        delete context.chatMetadata[REQUESTS_KEY];
    }

    void flushSave();
}

export function clearAllTokenData() {
    clearChatTokenData();
}
