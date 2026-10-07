/**
 * Token Monitor panel: an entry in the extensions (wand) menu plus a draggable
 * floating panel showing main-generation usage, auxiliary (plot/fill/other)
 * usage, a per-request list (one row per AI request, so re-generations of one
 * floor stay visible) and the extension settings.
 */

import { listRequests, recomputeChat, clearChatTokenData } from './store.js';
import { setMarkerConfig, rescanAuxFrames } from './interceptor.js';
import { getPriceMeta, updatePrices, computeCost } from './pricing.js';
import { attachModelCombo } from './combo.js';

const MODULE_NAME = 'token_monitor';
const PANEL_ID = 'token_monitor_panel';
const MENU_ID = 'token_monitor_menu_entry';
const FAB_ID = 'token_monitor_fab';
const MARKER_STORAGE_KEY = 'token_monitor_markers';

const KIND_META = {
    main: { label: '主生成', emoji: '🎯', short: '主' },
    plot: { label: '剧情推进', emoji: '📖', short: '剧情' },
    fill: { label: '填表', emoji: '📋', short: '填表' },
    other: { label: '其他', emoji: '🧩', short: '其他' },
};
const KIND_ORDER = ['main', 'plot', 'fill', 'other'];

const CLEAR_PHRASE = '清空';

const defaultSettings = Object.freeze({
    mainGenModel: '',
    plotModel: '',
    fillModel: '',
    rate: 1,
    classifyMode: 'auto',
    panelVisible: false,
    panelPosition: null,
    panelSize: null,
    collapsed: false,
});

const AUX_MODEL_SETTINGS = { plot: 'plotModel', fill: 'fillModel', other: 'fillModel' };

let bound = false;
let combos = [];

function ctx() {
    return globalThis.SillyTavern?.getContext();
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function getSettings() {
    const context = ctx();
    if (!context?.extensionSettings) {
        return structuredClone(defaultSettings);
    }
    const store = context.extensionSettings;
    if (!store[MODULE_NAME]) {
        store[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(store[MODULE_NAME], key)) {
            store[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return store[MODULE_NAME];
}

function saveSettings() {
    const context = ctx();
    if (typeof context?.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }
}

function loadMarkers() {
    try {
        const parsed = JSON.parse(localStorage.getItem(MARKER_STORAGE_KEY));
        return {
            plotMarkers: Array.isArray(parsed?.plotMarkers) ? parsed.plotMarkers : [],
            fillMarkers: Array.isArray(parsed?.fillMarkers) ? parsed.fillMarkers : [],
        };
    } catch {
        return { plotMarkers: [], fillMarkers: [] };
    }
}

function saveMarkers(markers) {
    try {
        localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(markers));
    } catch (error) {
        console.warn('[TokenMonitor] cannot save markers:', error);
    }
}

function parseMarkers(text) {
    return String(text ?? '')
        .split(/[\n,]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function detectCurrentModel() {
    const context = ctx();
    try {
        const model = context?.getChatCompletionModel?.();
        if (typeof model === 'string' && model) {
            return model;
        }
    } catch {
        /* ignore */
    }
    try {
        const model = context?.chatCompletionSettings?.openai_model;
        if (typeof model === 'string' && model) {
            return model;
        }
    } catch {
        /* ignore */
    }
    return '';
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function formatNumber(value) {
    if (!Number.isFinite(Number(value))) {
        return '—';
    }
    return Math.round(Number(value)).toLocaleString('en-US');
}

function formatCost(value, rate) {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const symbol = Number(rate) === 1 ? '$' : '¥';
    return `${symbol}${value.toFixed(4)}`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ *
 * Cost helpers
 *
 * Costs are never stored: every request record is priced at display time
 * against the current catalogue. A captured model name that is unknown to the
 * catalogue falls back to the configured override model (主生成 / 剧情推进 /
 * 填表), which is flagged in the UI.
 * ------------------------------------------------------------------ */

/** Model explicitly configured for a request kind ('' = not configured). */
function configuredModelFor(kind, settings) {
    if (kind === 'main') {
        return String(settings.mainGenModel ?? '').trim();
    }
    return String(settings[AUX_MODEL_SETTINGS[kind]] ?? '').trim();
}

/**
 * Price one request record at display time.
 *
 * The model configured in the settings wins, so editing it and saving re-prices
 * the whole history; otherwise the captured model name is used, then (for main
 * generation) the currently detected model.
 */
function recordCost(entry, rate, settings) {
    const usage = {
        input: entry.input ?? 0,
        output: entry.output ?? 0,
        cachedInput: entry.cachedInput ?? 0,
        cacheWriteInput: entry.cacheWriteInput ?? 0,
        rate,
    };

    const candidates = [];
    const configured = configuredModelFor(entry.kind, settings);
    if (configured) {
        candidates.push({ model: configured, source: 'configured' });
    }
    if (entry.model && entry.model !== configured) {
        candidates.push({ model: entry.model, source: 'captured' });
    }
    const auto = entry.kind === 'main' ? detectCurrentModel().trim() : '';
    if (auto && auto !== configured && auto !== entry.model) {
        candidates.push({ model: auto, source: 'auto' });
    }

    for (const candidate of candidates) {
        const result = computeCost({ ...usage, model: candidate.model });
        if (result.found) {
            return { found: true, cost: result.cost, source: candidate.source, pricingModel: candidate.model };
        }
    }

    return { found: false, cost: null, source: null, pricingModel: '' };
}

function sumRecordsCost(entries, rate, settings) {
    let cost = 0;
    let anyFound = false;
    let unknown = false;
    let fallback = false;
    let fallbackModel = '';

    for (const entry of entries) {
        const result = recordCost(entry, rate, settings);
        if (result.found) {
            cost += result.cost;
            anyFound = true;
            if (result.source !== 'captured') {
                fallback = true;
                fallbackModel = result.pricingModel;
            }
        } else if ((entry.input ?? 0) > 0 || (entry.output ?? 0) > 0) {
            unknown = true;
        }
    }

    return { cost: anyFound ? cost : null, unknown, fallback, fallbackModel };
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

function addMenuEntry() {
    if (document.getElementById(MENU_ID)) {
        return;
    }

    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        const entry = document.createElement('div');
        entry.id = MENU_ID;
        entry.className = 'list-group-item flex-container flexGap5';
        entry.innerHTML = '<div class="fa-solid fa-chart-column extensionsMenuExtensionButton"></div>Token 统计';
        entry.addEventListener('click', () => togglePanel());
        menu.appendChild(entry);
        return;
    }

    if (document.getElementById(FAB_ID)) {
        return;
    }
    const fab = document.createElement('div');
    fab.id = FAB_ID;
    fab.className = 'fa-solid fa-chart-column';
    fab.title = 'Token 统计';
    fab.addEventListener('click', () => togglePanel());
    document.body.appendChild(fab);
}

function buildPanelSkeleton() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.classList.add('tm-hidden');
    panel.innerHTML = `
        <div class="tm-header">
            <span class="tm-title">📊 Token 统计</span>
            <span class="tm-header-actions">
                <span class="tm-icon tm-gear" id="tm-settings-toggle" title="设置">⚙️</span>
                <span class="tm-icon tm-collapse fa-solid fa-chevron-down" title="折叠/展开"></span>
                <span class="tm-icon tm-close fa-solid fa-xmark" title="隐藏"></span>
            </span>
        </div>
        <div class="tm-body">
            <div class="tm-total" id="tm-total"></div>
            <div class="tm-cats" id="tm-cats"></div>
            <div class="tm-list">
                <div class="tm-list-title">📋 请求流水</div>
                <div class="tm-requests" id="tm-requests"></div>
            </div>
        </div>
        <div class="tm-settings-page tm-hidden" id="tm-settings-page">
            <div class="tm-settings-head">
                <span class="tm-settings-title">⚙️ 设置</span>
                <span class="tm-icon tm-settings-close fa-solid fa-xmark" title="返回主页面"></span>
            </div>
            <div class="tm-settings-body" id="tm-settings-body">
                <div class="tm-settings-note">✏️ 修改后点击「保存设置」才会生效，并按新配置重算全部费用</div>
                <label class="tm-field">🎯 主生成模型
                    <input id="tm-set-model" class="text_pole" type="text" placeholder="留空则用拦截到的模型名">
                </label>
                <label class="tm-field">📖 剧情推进模型
                    <input id="tm-set-plot-model" class="text_pole" type="text" placeholder="留空则用拦截到的模型名">
                </label>
                <label class="tm-field">📋 填表模型（含其他）
                    <input id="tm-set-fill-model" class="text_pole" type="text" placeholder="留空则用拦截到的模型名">
                </label>
                <label class="tm-field">💱 汇率（1 = 美元直显）
                    <input id="tm-set-rate" class="text_pole" type="number" min="0" step="0.01">
                </label>
                <label class="tm-field">🗂 分类模式
                    <select id="tm-set-mode" class="text_pole">
                        <option value="auto">自动（窗口 + 标记）</option>
                        <option value="markers-only">仅标记</option>
                    </select>
                </label>
                <label class="tm-field">📖 剧情推进标记（逗号或换行分隔）
                    <textarea id="tm-set-plot-markers" class="text_pole" rows="2"></textarea>
                </label>
                <label class="tm-field">📋 填表标记（逗号或换行分隔）
                    <textarea id="tm-set-fill-markers" class="text_pole" rows="2"></textarea>
                </label>
                <div class="tm-price-status" id="tm-price-status">未加载价格库</div>
                <div class="tm-actions">
                    <div id="tm-save-settings" class="menu_button">💾 保存设置</div>
                    <div id="tm-update-prices" class="menu_button">🔄 更新价格库</div>
                    <div id="tm-recount" class="menu_button">🧮 重新统计</div>
                    <div id="tm-refresh" class="menu_button">🔃 刷新</div>
                    <div id="tm-clear" class="menu_button tm-danger">🗑 清空本聊天</div>
                </div>
            </div>
        </div>
        <div class="tm-resize tm-resize-bl" title="拖拽调整大小"></div>
        <div class="tm-resize tm-resize-br" title="拖拽调整大小"></div>`;
    return panel;
}

function bindPanelEvents(panel) {
    panel.querySelector('.tm-collapse').addEventListener('click', () => {
        const collapsed = panel.classList.toggle('tm-collapsed');
        const settings = getSettings();
        settings.collapsed = collapsed;
        saveSettings();
    });

    panel.querySelector('.tm-close').addEventListener('click', () => setPanelVisible(false));

    const settingsPage = document.getElementById('tm-settings-page');
    const toggleSettings = (open) => {
        settingsPage.classList.toggle('tm-hidden', !open);
    };
    document.getElementById('tm-settings-toggle').addEventListener('click', () => {
        toggleSettings(settingsPage.classList.contains('tm-hidden'));
    });
    panel.querySelector('.tm-settings-close').addEventListener('click', () => toggleSettings(false));

    bindDrag(panel);
    bindResize(panel);
    bindSettingsInputs();
}

function bindDrag(panel) {
    const header = panel.querySelector('.tm-header');
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    header.addEventListener('mousedown', event => {
        if (event.target.closest('.tm-icon')) {
            return;
        }
        const rect = panel.getBoundingClientRect();
        dragging = true;
        startX = event.clientX;
        startY = event.clientY;
        originX = rect.left;
        originY = rect.top;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = `${originX}px`;
        panel.style.top = `${originY}px`;
        event.preventDefault();
    });

    window.addEventListener('mousemove', event => {
        if (!dragging) {
            return;
        }
        const nextX = Math.max(0, originX + (event.clientX - startX));
        const nextY = Math.max(0, originY + (event.clientY - startY));
        panel.style.left = `${nextX}px`;
        panel.style.top = `${nextY}px`;
    });

    window.addEventListener('mouseup', () => {
        if (!dragging) {
            return;
        }
        dragging = false;
        const rect = panel.getBoundingClientRect();
        const settings = getSettings();
        settings.panelPosition = { x: Math.round(rect.left), y: Math.round(rect.top) };
        saveSettings();
    });
}

const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 220;

function clampSize(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/** Resize via the bottom-left / bottom-right corner handles. */
function bindResize(panel) {
    let resizing = null;

    const startResize = (mode, event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = panel.getBoundingClientRect();
        // switch to left/top anchoring so the resize math is stable
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        resizing = {
            mode,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
        panel.classList.add('tm-resized');
    };

    panel.querySelector('.tm-resize-bl')?.addEventListener('mousedown', event => startResize('bl', event));
    panel.querySelector('.tm-resize-br')?.addEventListener('mousedown', event => startResize('br', event));

    window.addEventListener('mousemove', event => {
        if (!resizing) {
            return;
        }
        const dx = event.clientX - resizing.startX;
        const dy = event.clientY - resizing.startY;
        const maxWidth = window.innerWidth - 20;
        const maxHeight = window.innerHeight * 0.95;

        const width = clampSize(
            resizing.mode === 'br' ? resizing.width + dx : resizing.width - dx,
            MIN_PANEL_WIDTH,
            maxWidth,
        );
        const height = clampSize(resizing.height + dy, MIN_PANEL_HEIGHT, maxHeight);

        panel.style.width = `${Math.round(width)}px`;
        panel.style.height = `${Math.round(height)}px`;
        // bottom-left resize keeps the right edge fixed
        panel.style.left = `${Math.round(resizing.mode === 'bl' ? resizing.left + (resizing.width - width) : resizing.left)}px`;
    });

    window.addEventListener('mouseup', () => {
        if (!resizing) {
            return;
        }
        resizing = null;
        const rect = panel.getBoundingClientRect();
        const settings = getSettings();
        settings.panelSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
        settings.panelPosition = { x: Math.round(rect.left), y: Math.round(rect.top) };
        saveSettings();
    });
}

function bindSettingsInputs() {
    const settings = getSettings();
    const markers = loadMarkers();

    const modelInput = document.getElementById('tm-set-model');
    const plotModelInput = document.getElementById('tm-set-plot-model');
    const fillModelInput = document.getElementById('tm-set-fill-model');
    const rateInput = document.getElementById('tm-set-rate');
    const modeSelect = document.getElementById('tm-set-mode');
    const plotMarkers = document.getElementById('tm-set-plot-markers');
    const fillMarkers = document.getElementById('tm-set-fill-markers');

    modelInput.value = settings.mainGenModel ?? '';
    plotModelInput.value = settings.plotModel ?? '';
    fillModelInput.value = settings.fillModel ?? '';
    rateInput.value = String(settings.rate ?? 1);
    modeSelect.value = settings.classifyMode ?? 'auto';
    plotMarkers.value = markers.plotMarkers.join('\n');
    fillMarkers.value = markers.fillMarkers.join('\n');

    // The form is only a draft: nothing is stored or applied until 保存设置
    // is pressed, which also re-prices every request with the new models/rate.
    combos = [modelInput, plotModelInput, fillModelInput].map(input => attachModelCombo(input));

    document.getElementById('tm-save-settings').addEventListener('click', handleSaveSettings);
    document.getElementById('tm-update-prices').addEventListener('click', handleUpdatePrices);
    document.getElementById('tm-refresh').addEventListener('click', () => {
        rescanAuxFrames();
        refreshPanel();
    });
    document.getElementById('tm-recount').addEventListener('click', async () => {
        await recomputeChat();
        refreshPanel();
    });
    document.getElementById('tm-clear').addEventListener('click', handleClearChat);
}

/**
 * Wipe the chat's token data — only after the user typed the confirmation
 * phrase. Destructive and irreversible, hence the explicit confirmation.
 */
async function handleClearChat() {
    const confirmed = await confirmChatClear();
    if (!confirmed) {
        return;
    }
    clearChatTokenData();
    refreshPanel();
}

/**
 * Ask for a typed confirmation before clearing.
 * Prefers SillyTavern's dialog system, falls back to the browser prompt.
 * @returns {Promise<boolean>} true only when the exact phrase was typed
 */
async function confirmChatClear() {
    const warning = '即将清空当前聊天的<b>全部</b> token 消耗数据（请求流水、楼层统计与汇总），<b>操作无法复原</b>。';
    const context = ctx();
    const Popup = context?.Popup;
    const POPUP_TYPE = context?.POPUP_TYPE;
    const POPUP_RESULT = context?.POPUP_RESULT;

    if (typeof Popup === 'function' && POPUP_TYPE && POPUP_RESULT) {
        try {
            const popup = new Popup(
                `${warning}<br><br>请输入「<b>${CLEAR_PHRASE}</b>」以确认：`,
                POPUP_TYPE.INPUT,
                '',
                {
                    okButton: '确认清空',
                    cancelButton: '取消',
                    placeholder: `输入「${CLEAR_PHRASE}」以确认`,
                    onClosing: (instance) => {
                        if (instance?.result !== POPUP_RESULT.AFFIRMATIVE) {
                            return true;
                        }
                        if (String(instance?.mainInput?.value ?? '').trim() === CLEAR_PHRASE) {
                            return true;
                        }
                        if (typeof toastr !== 'undefined') {
                            toastr.warning(`请准确输入「${CLEAR_PHRASE}」后再确认`);
                        }
                        return false;
                    },
                },
            );
            const value = await popup.show();
            return typeof value === 'string' && value.trim() === CLEAR_PHRASE;
        } catch (error) {
            console.warn('[TokenMonitor] popup failed, falling back to browser dialog:', error);
        }
    }

    const typed = window.prompt(
        `警告：这会清空当前聊天的全部 token 消耗数据，且无法复原。\n请输入「${CLEAR_PHRASE}」以确认：`,
        '',
    );
    return String(typed ?? '').trim() === CLEAR_PHRASE;
}

function applyClassification() {
    const settings = getSettings();
    const markers = loadMarkers();
    setMarkerConfig({
        mode: settings.classifyMode ?? 'auto',
        plotMarkers: markers.plotMarkers,
        fillMarkers: markers.fillMarkers,
    });
}

/** Persist the settings form and re-price everything with the saved values. */
function handleSaveSettings() {
    const current = getSettings();
    current.mainGenModel = document.getElementById('tm-set-model').value.trim();
    current.plotModel = document.getElementById('tm-set-plot-model').value.trim();
    current.fillModel = document.getElementById('tm-set-fill-model').value.trim();
    current.rate = Number(document.getElementById('tm-set-rate').value) || 1;
    current.classifyMode = document.getElementById('tm-set-mode').value === 'markers-only' ? 'markers-only' : 'auto';
    saveSettings();

    saveMarkers({
        plotMarkers: parseMarkers(document.getElementById('tm-set-plot-markers').value),
        fillMarkers: parseMarkers(document.getElementById('tm-set-fill-markers').value),
    });
    applyClassification();

    // Costs are computed at display time, so a refresh re-prices every request
    // record with the just-saved models and exchange rate.
    refreshPanel();
    if (typeof toastr !== 'undefined') {
        toastr.success('设置已保存，费用已按当前配置重新计算');
    }
}

async function handleUpdatePrices() {
    const button = document.getElementById('tm-update-prices');
    button?.classList.add('disabled');
    try {
        const result = await updatePrices();
        if (result.ok) {
            if (typeof toastr !== 'undefined') {
                toastr.success(`价格库已更新（${result.count} 条）`);
            }
        } else if (typeof toastr !== 'undefined') {
            toastr.error(`价格库更新失败：${result.error}`);
        }
    } finally {
        button?.classList.remove('disabled');
        updatePriceStatus();
        refreshPanel();
    }
}

function updatePriceStatus() {
    const element = document.getElementById('tm-price-status');
    if (!element) {
        return;
    }
    const meta = getPriceMeta();
    if (!meta.count) {
        element.textContent = '未加载价格库';
        return;
    }
    const time = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : '未知时间';
    element.textContent = `已加载 ${meta.count} 条 · ${time}`;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function formatRequestTime(ts) {
    const date = new Date(Number(ts) || 0);
    if (Number.isNaN(date.getTime())) {
        return '—';
    }
    return date.toLocaleTimeString([], { hour12: false });
}

function sumTokens(entries) {
    const totals = { calls: 0, input: 0, output: 0, cached: 0, cacheWrite: 0 };
    for (const entry of entries) {
        totals.calls += 1;
        totals.input += entry.input ?? 0;
        totals.output += entry.output ?? 0;
        totals.cached += entry.cachedInput ?? 0;
        totals.cacheWrite += entry.cacheWriteInput ?? 0;
    }
    return totals;
}

function formatCacheRate(cached, input) {
    const total = Number(input);
    const hit = Number(cached);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(hit)) {
        return '—';
    }
    return `${Math.min(100, (hit / total) * 100).toFixed(1)}%`;
}

function metricsHtml(totals) {
    return `
        <span class="tm-metric">⬇️ <b>${formatNumber(totals.input)}</b></span>
        <span class="tm-metric">⬆️ <b>${formatNumber(totals.output)}</b></span>
        <span class="tm-metric">💾 <b>${formatNumber(totals.cached)}</b></span>
        <span class="tm-metric">📈 <b>${formatCacheRate(totals.cached, totals.input)}</b></span>`;
}

/** 合计区：主生成 + 剧情推进 + 填表 + 其他的总和。 */
function renderTotal(entries, rate, settings) {
    const container = document.getElementById('tm-total');
    if (!container) {
        return;
    }

    const totals = sumTokens(entries);
    const priced = sumRecordsCost(entries, rate, settings);
    const costText = priced.cost === null ? '—' : formatCost(priced.cost, rate);

    container.innerHTML = `
        <div class="tm-total-card">
            <div class="tm-total-row">
                <span class="tm-total-label">💰 总花费</span>
                <span class="tm-total-cost">${costText}</span>
            </div>
            <div class="tm-total-sub">📦 总请求 <b>${totals.calls}</b> 次 · 🧮 总计 <b>${formatNumber(totals.input + totals.output)}</b> tokens</div>
            <div class="tm-metrics">${metricsHtml(totals)}</div>
        </div>`;
}

/** 分类区：各类的总和（不展示模型）。 */
function renderCategories(entries, rate, settings) {
    const container = document.getElementById('tm-cats');
    if (!container) {
        return;
    }

    container.innerHTML = KIND_ORDER.map(kind => {
        const own = entries.filter(entry => entry.kind === kind);
        const totals = sumTokens(own);
        const priced = sumRecordsCost(own, rate, settings);
        const costText = priced.cost === null ? '—' : formatCost(priced.cost, rate);
        const meta = KIND_META[kind];
        return `
            <div class="tm-cat-card">
                <div class="tm-cat-head">
                    <span class="tm-cat-name">${meta.emoji} ${meta.label}</span>
                    <span class="tm-cat-cost">${costText}</span>
                </div>
                <div class="tm-cat-sub">📦 ${totals.calls} 次</div>
                <div class="tm-metrics tm-metrics-mini">${metricsHtml(totals)}</div>
            </div>`;
    }).join('');
}

/**
 * 明细区：每条 AI 请求一张卡片（含同一楼层的每次重新生成），按请求顺序追加：
 * 类型 / 楼层、时间、输入、输出、缓存命中、命中率、模型、成本。
 */
function renderRequests() {
    const container = document.getElementById('tm-requests');
    if (!container) {
        return;
    }

    const settings = getSettings();
    const rate = Number(settings.rate) || 1;
    const entries = listRequests();

    if (entries.length === 0) {
        container.innerHTML = '<div class="tm-empty">✨ 本聊天暂无请求记录</div>';
        return;
    }

    const regenCounter = new Map();
    const rows = entries.map(entry => {
        const kind = entry.kind in KIND_META ? entry.kind : 'other';
        const meta = KIND_META[kind];
        const floorKnown = Number.isInteger(entry.floor);
        let regen = '';
        if (kind === 'main' && floorKnown) {
            const seen = (regenCounter.get(entry.floor) ?? 0) + 1;
            regenCounter.set(entry.floor, seen);
            if (seen > 1) {
                regen = `<span class="tm-regen">↻${seen}</span>`;
            }
        }

        const priced = recordCost(entry, rate, settings);
        const costText = priced.found ? formatCost(priced.cost, rate) : '—';
        const costTitle = !priced.found
            ? '未能在价格库中匹配到模型，无法计价'
            : (priced.source === 'captured'
                ? (entry.model || '')
                : `按 ${priced.pricingModel} 计价${entry.model ? `（请求模型：${entry.model}）` : ''}`);

        const floorText = floorKnown ? `${entry.floor}楼` : '未归层';
        const modelText = entry.model || '—';
        const input = entry.input ?? 0;
        const cached = entry.cachedInput ?? 0;

        return `
            <div class="tm-request" data-floor="${floorKnown ? entry.floor : ''}">
                <div class="tm-request-head">
                    <span class="tm-request-kind"><span class="tm-badge tm-badge-${kind}">${meta.emoji} ${meta.short}</span><span class="tm-request-floor">📍 ${floorText}${regen}</span></span>
                    <span class="tm-request-time">🕐 ${formatRequestTime(entry.ts)}</span>
                </div>
                <div class="tm-metrics tm-request-metrics">
                    <span class="tm-metric">⬇️ <b>${entry.input === null ? '—' : formatNumber(entry.input)}</b></span>
                    <span class="tm-metric">⬆️ <b>${entry.output === null ? '—' : formatNumber(entry.output)}</b></span>
                    <span class="tm-metric">💾 <b>${formatNumber(cached)}</b></span>
                    <span class="tm-metric">📈 <b>${formatCacheRate(cached, input)}</b></span>
                </div>
                <div class="tm-request-foot">
                    <span class="tm-request-model" title="${escapeHtml(modelText)}">🤖 ${escapeHtml(modelText)}</span>
                    <span class="tm-request-cost" title="${escapeHtml(costTitle)}">💲 ${costText}</span>
                </div>
            </div>`;
    });

    container.innerHTML = rows.join('');
    container.querySelectorAll('.tm-request').forEach(row => {
        const floor = row.getAttribute('data-floor');
        if (floor === '') {
            return;
        }
        row.addEventListener('click', () => {
            const target = document.querySelector(`.mes[mesid="${floor}"]`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    });
}

export function refreshPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    const settings = getSettings();
    const rate = Number(settings.rate) || 1;
    const entries = listRequests();

    renderTotal(entries, rate, settings);
    renderCategories(entries, rate, settings);
    renderRequests();
    updatePriceStatus();
}

/* ------------------------------------------------------------------ *
 * Visibility
 * ------------------------------------------------------------------ */

export function setPanelVisible(visible, { persist = true } = {}) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
        if (!visible) {
            return;
        }
        panel = buildPanelSkeleton();
        document.body.appendChild(panel);
        applySavedPosition(panel);
        applySavedSize(panel);
        if (getSettings().collapsed) {
            panel.classList.add('tm-collapsed');
        }
        bindPanelEvents(panel);
    }

    panel.classList.toggle('tm-hidden', !visible);

    if (persist) {
        const settings = getSettings();
        settings.panelVisible = Boolean(visible);
        saveSettings();
    }
    if (visible) {
        refreshPanel();
    }
}

export function togglePanel() {
    const panel = document.getElementById(PANEL_ID);
    const currentlyVisible = panel ? !panel.classList.contains('tm-hidden') : Boolean(getSettings().panelVisible);
    setPanelVisible(!currentlyVisible);
}

function applySavedPosition(panel) {
    const position = getSettings().panelPosition;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        panel.style.left = `${position.x}px`;
        panel.style.top = `${position.y}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }
}

function applySavedSize(panel) {
    const size = getSettings().panelSize;
    if (size && Number.isFinite(size.w) && Number.isFinite(size.h)) {
        panel.style.width = `${clampSize(size.w, MIN_PANEL_WIDTH, window.innerWidth - 20)}px`;
        panel.style.height = `${clampSize(size.h, MIN_PANEL_HEIGHT, window.innerHeight * 0.95)}px`;
        panel.classList.add('tm-resized');
    }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export function mountPanel() {
    if (bound) {
        return;
    }
    bound = true;

    addMenuEntry();
    applyClassification();

    for (const panel of document.querySelectorAll(`#${PANEL_ID}`)) {
        panel.remove();
    }
    const panel = buildPanelSkeleton();
    document.body.appendChild(panel);
    applySavedPosition(panel);
    applySavedSize(panel);
    if (getSettings().collapsed) {
        panel.classList.add('tm-collapsed');
    }
    bindPanelEvents(panel);

    setPanelVisible(Boolean(getSettings().panelVisible), { persist: false });
}

export function unmountPanel() {
    bound = false;
    for (const combo of combos) {
        combo.destroy();
    }
    combos = [];
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(FAB_ID)?.remove();
}
