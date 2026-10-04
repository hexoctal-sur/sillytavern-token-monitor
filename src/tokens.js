/**
 * Token counting helpers.
 *
 * Two counting paths are provided:
 *  - `countTextAsync` / `countTokensCached`: count a single text (prompt material
 *    or message) with the active SillyTavern tokenizer.
 *  - `countMsgTokens`: count an array of chat-completion messages and sum them.
 *
 * The prompt input token count of a main-chat generation cannot be taken from
 * `generate_interceptor`: its `contextSize` argument is `getMaxPromptTokens()`,
 * i.e. the *budget* (context window minus response length), not the size of the
 * prompt that is actually sent. The real prompt is only known once SillyTavern
 * has assembled it, which it publishes via the `GENERATE_AFTER_DATA` event
 * (`generate_data.prompt` is the final messages array for chat completions, or
 * the raw prompt string for text-completion APIs). `countRequestTokens` counts
 * exactly that payload.
 *
 * `generate_interceptor` is still registered (manifest.json) but only records
 * the generation *type*, so quiet/internal generations can be excluded.
 */

const QUIET_TYPES = new Set(['quiet']);
const TOKEN_CACHE_MAX = 400;

const tokenCache = new Map();

let pendingGenType = null;

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
    globalThis.tokenMonitorInterceptor = function (_chat, _contextSize, _abort, type) {
        pendingGenType = typeof type === 'string' && type ? type : 'normal';
    };
}

/** Consume the generation type captured by the generate interceptor. */
export function takeGenerationType() {
    const type = pendingGenType;
    pendingGenType = null;
    return type;
}

export function isQuietType(type) {
    return QUIET_TYPES.has(type);
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
 * Count one chat-completion message: content (string or content parts),
 * tool calls and the optional name — everything that goes over the wire.
 */
async function countMessageTokens(message) {
    if (typeof message === 'string') {
        return countTokensCached(message);
    }

    let total = 0;
    const content = message?.content ?? '';

    if (typeof content === 'string') {
        total += (await countTokensCached(content)) ?? 0;
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part?.text === 'string') {
                total += (await countTokensCached(part.text)) ?? 0;
            }
            // image/video parts are not counted locally; API usage covers them
        }
    } else if (content != null) {
        total += (await countTokensCached(JSON.stringify(content))) ?? 0;
    }

    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
        total += (await countTokensCached(JSON.stringify(message.tool_calls))) ?? 0;
    }
    if (typeof message?.name === 'string' && message.name) {
        total += (await countTokensCached(message.name)) ?? 0;
    }

    return total;
}

/**
 * Sum the token counts of a chat-completion message array.
 * This is a fallback for providers that don't report usage: it cannot see
 * chat-template overhead or image parts, so API usage is preferred when the
 * response carries it.
 */
export async function countMsgTokens(messages) {
    let total = 0;

    for (const message of messages ?? []) {
        const count = await countMessageTokens(message);
        total += count !== null ? count : 0;
    }

    return total;
}

/**
 * Count the request payload of a generation (`generate_data` as published by
 * `GENERATE_AFTER_DATA`): a messages array for chat completions, or a raw
 * prompt string for text-completion APIs.
 * @returns {Promise<number|null>} token count, or null when the payload is unusable
 */
export async function countRequestTokens(generateData) {
    const raw = generateData?.prompt ?? generateData?.messages ?? generateData?.input ?? null;

    if (Array.isArray(raw)) {
        return countMsgTokens(raw);
    }
    if (typeof raw === 'string' && raw.length > 0) {
        return countTokensCached(raw);
    }
    return null;
}

export function clearTokenCache() {
    tokenCache.clear();
}

function firstFinite(...values) {
    for (const value of values) {
        if (value === null || value === undefined) {
            continue;
        }
        const num = Number(value);
        if (Number.isFinite(num)) {
            return num;
        }
    }
    return null;
}

/**
 * Normalize an API `usage` object across provider shapes.
 *
 * Cache traffic is reported under different names:
 *  - `prompt_tokens_details.cached_tokens` (OpenAI / OpenRouter / most proxies)
 *  - `prompt_cache_hit_tokens` (DeepSeek)
 *  - `cache_read_input_tokens` + `cache_creation_input_tokens` (Anthropic)
 *  - `cached_content_token_count` / `cachedContentTokenCount` (Gemini)
 *
 * @returns {{ input: number|null, output: number|null, cachedInput: number, cacheWriteInput: number }|null}
 */
export function extractUsageTokens(usage) {
    if (!usage || typeof usage !== 'object') {
        return null;
    }

    const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
    return {
        input: firstFinite(usage.prompt_tokens, usage.input_tokens),
        output: firstFinite(usage.completion_tokens, usage.output_tokens),
        cachedInput: firstFinite(
            usage.cache_read_input_tokens,
            usage.prompt_cache_hit_tokens,
            usage.cached_tokens,
            details.cached_tokens,
            usage.cached_content_token_count,
            usage.cachedContentTokenCount,
        ) ?? 0,
        cacheWriteInput: firstFinite(usage.cache_creation_input_tokens) ?? 0,
    };
}
