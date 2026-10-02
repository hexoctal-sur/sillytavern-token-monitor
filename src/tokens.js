/**
 * Token counting helpers.
 *
 * Two counting paths are provided:
 *  - `countTextAsync` / `countTokensCached`: count a single text (prompt material
 *    or message) with the active SillyTavern tokenizer.
 *  - `countMsgTokens`: count an array of chat-completion messages and sum them.
 *
 * The prompt input token count for a main-chat generation is captured from
 * SillyTavern's `generate_interceptor` (declared in manifest.json), which is
 * invoked with the already computed context size for the upcoming generation.
 */

const QUIET_TYPES = new Set(['quiet']);
const TOKEN_CACHE_MAX = 400;
const ESTIMATE_CHARS_PER_TOKEN = 1.5;

const tokenCache = new Map();

let pendingInputTokens = null;

function ctx() {
    return globalThis.SillyTavern?.getContext();
}

function hashString(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

export function initTokenTracking() {
    globalThis.tokenMonitorInterceptor = function (_chat, contextSize, _abort, type) {
        if (QUIET_TYPES.has(type)) {
            return;
        }

        const value = Number(contextSize);
        if (Number.isFinite(value) && value > 0) {
            pendingInputTokens = value;
        }
    };
}

export async function countTextAsync(text) {
    const context = ctx();
    if (!context || typeof context.getTokenCountAsync !== 'function') {
        return null;
    }

    try {
        const count = await context.getTokenCountAsync(text ?? '');
        return Number.isFinite(count) ? count : null;
    } catch (error) {
        console.error('[TokenMonitor] token count failed:', error);
        return null;
    }
}

/** Count a text with a small LRU cache keyed by content hash. */
export async function countTokensCached(text) {
    const value = text ?? '';
    const key = `${hashString(value)}:${value.length}`;

    if (tokenCache.has(key)) {
        const cached = tokenCache.get(key);
        tokenCache.delete(key);
        tokenCache.set(key, cached);
        return cached;
    }

    const count = await countTextAsync(value);
    if (count !== null) {
        tokenCache.set(key, count);
        if (tokenCache.size > TOKEN_CACHE_MAX) {
            const oldest = tokenCache.keys().next().value;
            tokenCache.delete(oldest);
        }
    }
    return count;
}

/**
 * Sum the token counts of a chat-completion message array.
 * Falls back to a character-based estimate when counting is unavailable.
 */
export async function countMsgTokens(messages) {
    let total = 0;

    for (const message of messages ?? []) {
        const raw = typeof message === 'string' ? message : (message?.content ?? '');
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
        const count = await countTokensCached(text);
        total += count !== null ? count : Math.ceil(text.length / ESTIMATE_CHARS_PER_TOKEN);
    }

    return total;
}

export function clearTokenCache() {
    tokenCache.clear();
}

export function consumePendingInput() {
    const value = pendingInputTokens;
    pendingInputTokens = null;
    return value;
}

export function clearPendingInput() {
    pendingInputTokens = null;
}
