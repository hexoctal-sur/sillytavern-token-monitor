/**
 * Cost estimation backed by the LiteLLM model price catalogue.
 *
 * Prices are never persisted alongside the token data: only tokens and model
 * names are stored, and cost is recomputed on display against the currently
 * loaded catalogue. Updating the catalogue therefore re-prices all history.
 */

const DB_NAME = 'token_monitor_pricing';
const STORE_NAME = 'pricing';
const DB_VERSION = 1;
const CACHE_KEY = 'catalogue';

const PRICE_URLS = [
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
    'https://gcore.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
    'https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
    'https://fastly.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json',
];

const MIN_FUZZY_LENGTH = 6;
const MIN_VALID_ENTRIES = 3;

const SEARCH_RESULT_LIMIT = 40;

let byKey = new Map();
let byTail = new Map();
let meta = { count: 0, updatedAt: null };

/* ------------------------------------------------------------------ *
 * IndexedDB cache
 * ------------------------------------------------------------------ */

function openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

function isValidPriceData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }
    let valid = 0;
    for (const value of Object.values(data)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        if ('input_cost_per_token' in value && 'max_tokens' in value) {
            valid += 1;
            if (valid >= MIN_VALID_ENTRIES) {
                return true;
            }
        }
    }
    return false;
}

function setCatalogue(data, updatedAt) {
    byKey = new Map();
    byTail = new Map();

    for (const [key, value] of Object.entries(data ?? {})) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        const inputCost = Number(value.input_cost_per_token);
        const outputCost = Number(value.output_cost_per_token);
        if (!Number.isFinite(inputCost) && !Number.isFinite(outputCost)) {
            continue;
        }
        const entry = {
            key,
            inputCost: Number.isFinite(inputCost) ? inputCost : 0,
            outputCost: Number.isFinite(outputCost) ? outputCost : 0,
        };
        const lowerKey = key.toLowerCase();
        byKey.set(lowerKey, entry);

        const tail = lowerKey.split('/').pop();
        if (tail && !byTail.has(tail)) {
            byTail.set(tail, entry);
        }
    }

    meta = { count: byKey.size, updatedAt: updatedAt ?? null };
}

export function getPriceMeta() {
    return { ...meta };
}

/**
 * Search catalogue model keys by substring (case-insensitive).
 * Ranks tail-segment hits first, then shorter keys, so the most specific
 * `provider/model` entries surface near the top.
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]} matching model keys, best first
 */
export function searchModels(query, limit = SEARCH_RESULT_LIMIT) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!byKey.size) {
        return [];
    }
    if (!needle) {
        return [...byKey.keys()].slice(0, limit);
    }

    const matches = [];
    for (const key of byKey.keys()) {
        const index = key.indexOf(needle);
        if (index === -1) {
            continue;
        }
        const tail = key.split('/').pop();
        const isTailHit = tail?.includes(needle) ?? false;
        matches.push({
            key,
            tailHit: isTailHit ? 0 : 1,
            position: index,
            length: key.length,
        });
    }

    matches.sort((a, b) => (
        a.tailHit - b.tailHit
        || a.position - b.position
        || a.length - b.length
        || a.key.localeCompare(b.key)
    ));

    return matches.slice(0, limit).map(item => item.key);
}

export async function loadCached() {
    try {
        const cached = await idbGet(CACHE_KEY);
        if (cached?.data && isValidPriceData(cached.data)) {
            setCatalogue(cached.data, cached.updatedAt ?? null);
        }
    } catch (error) {
        console.warn('[TokenMonitor] pricing cache load failed:', error);
    }
    return getPriceMeta();
}

export async function updatePrices() {
    let lastError = null;

    for (const url of PRICE_URLS) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) {
                lastError = new Error(`HTTP ${response.status}`);
                continue;
            }
            const data = await response.json();
            if (!isValidPriceData(data)) {
                lastError = new Error('invalid price data');
                continue;
            }
            const updatedAt = Date.now();
            setCatalogue(data, updatedAt);
            try {
                await idbSet(CACHE_KEY, { data, updatedAt });
            } catch (error) {
                console.warn('[TokenMonitor] pricing cache write failed:', error);
            }
            return { ok: true, ...getPriceMeta(), url };
        } catch (error) {
            lastError = error;
        }
    }

    return { ok: false, error: lastError?.message ?? 'unknown error' };
}

/* ------------------------------------------------------------------ *
 * Model matching + cost
 * ------------------------------------------------------------------ */

/**
 * Resolve a model name to a price entry.
 * 1. case-insensitive exact match
 * 2. tail segment match (strip `provider/` prefix)
 * 3. bidirectional contains, longest match (>= 6 chars), flagged fuzzy
 */
export function resolvePrice(model) {
    if (!byKey.size || !model) {
        return { found: false };
    }
    const query = String(model).trim().toLowerCase();
    if (!query) {
        return { found: false };
    }

    if (byKey.has(query)) {
        return { found: true, fuzzy: false, ...byKey.get(query) };
    }

    const tail = query.split('/').pop();
    if (tail && byTail.has(tail)) {
        return { found: true, fuzzy: false, ...byTail.get(tail) };
    }

    let best = null;
    for (const [key, entry] of byKey) {
        if (key.length < MIN_FUZZY_LENGTH) {
            continue;
        }
        if (query.includes(key) || key.includes(query)) {
            if (!best || key.length > best.matchLength) {
                best = { ...entry, matchLength: key.length };
            }
        }
    }
    if (best) {
        return { found: true, fuzzy: true, ...best };
    }

    return { found: false };
}

/**
 * Compute the cost of a usage in the display currency.
 * @param {{ input?: number, output?: number, model?: string, rate?: number }} params
 */
export function computeCost({ input, output, model, rate = 1 }) {
    const price = resolvePrice(model);
    if (!price.found) {
        return { found: false, cost: null, usd: null, price };
    }
    const usd = (Number(input) || 0) * price.inputCost + (Number(output) || 0) * price.outputCost;
    return { found: true, cost: usd * (Number(rate) || 1), usd, price };
}
