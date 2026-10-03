/**
 * Token Monitor panel: an entry in the extensions (wand) menu plus a draggable
 * floating panel showing main-generation usage, auxiliary (plot/fill/other)
 * usage, a per-request list (one row per AI request, so re-generations of one
 * floor stay visible) and the extension settings.
 */

import { computeRequestSummary, listRequests, recomputeChat, clearChatTokenData } from './store.js';
import { setMarkerConfig, rescanAuxFrames } from './interceptor.js';
import { getPriceMeta, updatePrices, computeCost } from './pricing.js';
import { attachModelCombo } from './combo.js';

const MODULE_NAME = 'token_monitor';
const PANEL_ID = 'token_monitor_panel';
const MENU_ID = 'token_monitor_menu_entry';
const FAB_ID = 'token_monitor_fab';
const MARKER_STORAGE_KEY = 'token_monitor_markers';

const AUX_LABELS = { plot: '剧情推进', fill: '填表', other: '其他' };
const KIND_SHORT = { main: '主', plot: '剧情', fill: '填表', other: '其他' };
const KIND_BADGE = { main: 'M', plot: 'P', fill: 'F', other: 'O' };

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
    const digits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 2;
    return `${symbol}${value.toFixed(digits)}`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setText(id, text) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = text;
    }
}

/* ------------------------------------------------------------------ *
 * Cost helpers
 *
 * Costs are never stored: every request record is priced at display time
 * against the current catalogue. A captured model name that is unknown to the
 * catalogue falls back to the configured override model (主生成 / 剧情推进 /
 * 填表), which is flagged in the UI.
 * ------------------------------------------------------------------ */

function fallbackModelFor(kind, settings) {
    if (kind === 'main') {
        return settings.mainGenModel || detectCurrentModel();
    }
    return settings[AUX_MODEL_SETTINGS[kind]] ?? '';
}

function recordCost(entry, rate, settings) {
    const fallbackModel = fallbackModelFor(entry.kind, settings);
    let result = computeCost({ input: entry.input ?? 0, output: entry.output ?? 0, model: entry.model, rate });

    if (!result.found && fallbackModel) {
        const fallback = computeCost({ input: entry.input ?? 0, output: entry.output ?? 0, model: fallbackModel, rate });
        if (fallback.found) {
            return { found: true, cost: fallback.cost, pricedAtFallback: true, fallbackModel };
        }
    }

    return { found: result.found, cost: result.cost, pricedAtFallback: false, fallbackModel };
}

function sumRecordsCost(entries, rate, settings) {
    let cost = 0;
    let anyFound = false;
    let unknown = false;
    let fallback = false;

    for (const entry of entries) {
        const result = recordCost(entry, rate, settings);
        if (result.found) {
            cost += result.cost;
            anyFound = true;
            fallback = fallback || result.pricedAtFallback;
        } else if ((entry.input ?? 0) > 0 || (entry.output ?? 0) > 0) {
            unknown = true;
        }
    }

    return { cost: anyFound ? cost : null, unknown, fallback };
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
            <span class="tm-title">Token 统计</span>
            <span class="tm-header-actions">
                <span class="tm-icon tm-collapse fa-solid fa-chevron-down" title="折叠/展开"></span>
                <span class="tm-icon tm-close fa-solid fa-xmark" title="隐藏"></span>
            </span>
        </div>
        <div class="tm-body">
            <div class="tm-main">
                <div class="tm-row"><span class="tm-label">主生成 <span class="tm-calls" id="tm-main-calls"></span></span><span class="tm-value" id="tm-main-cost">—</span></div>
                <div class="tm-sub">
                    <span id="tm-main-in">in —</span>
                    <span id="tm-main-out">out —</span>
                    <span id="tm-main-total">total —</span>
                </div>
                <div class="tm-hint" id="tm-main-model"></div>
            </div>
            <div class="tm-aux" id="tm-aux"></div>
            <div class="tm-list">
                <div class="tm-requests-head">
                    <span>#</span><span>时间</span><span>类型</span><span>楼层</span><span>模型</span><span>in</span><span>out</span><span>费用</span>
                </div>
                <div class="tm-requests" id="tm-requests"></div>
            </div>
            <div class="tm-settings">
                <div class="tm-settings-head" id="tm-settings-toggle">
                    <span>设置</span>
                    <span class="tm-icon fa-solid fa-chevron-down"></span>
                </div>
                <div class="tm-settings-body tm-hidden" id="tm-settings-body">
                    <label class="tm-field">主生成模型
                        <input id="tm-set-model" class="text_pole" type="text" placeholder="留空则自动读取当前模型">
                    </label>
                    <label class="tm-field">剧情推进模型
                        <input id="tm-set-plot-model" class="text_pole" type="text" placeholder="留空则用拦截到的模型名">
                    </label>
                    <label class="tm-field">填表模型（含其他）
                        <input id="tm-set-fill-model" class="text_pole" type="text" placeholder="留空则用拦截到的模型名">
                    </label>
                    <label class="tm-field">汇率（rate=1 时按美元直显）
                        <input id="tm-set-rate" class="text_pole" type="number" min="0" step="0.01">
                    </label>
                    <label class="tm-field">分类模式
                        <select id="tm-set-mode" class="text_pole">
                            <option value="auto">自动（窗口 + 标记）</option>
                            <option value="markers-only">仅标记</option>
                        </select>
                    </label>
                    <label class="tm-field">剧情推进标记（逗号或换行分隔）
                        <textarea id="tm-set-plot-markers" class="text_pole" rows="2"></textarea>
                    </label>
                    <label class="tm-field">填表标记（逗号或换行分隔）
                        <textarea id="tm-set-fill-markers" class="text_pole" rows="2"></textarea>
                    </label>
                    <div class="tm-price-status" id="tm-price-status">未加载价格库</div>
                    <div class="tm-actions">
                        <div id="tm-update-prices" class="menu_button">更新价格库</div>
                        <div id="tm-recount" class="menu_button">重新统计</div>
                        <div id="tm-refresh" class="menu_button">刷新</div>
                        <div id="tm-clear" class="menu_button">清空本聊天</div>
                    </div>
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

    document.getElementById('tm-settings-toggle').addEventListener('click', () => {
        document.getElementById('tm-settings-body').classList.toggle('tm-hidden');
    });

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

    const onModelChanged = key => value => {
        const current = getSettings();
        current[key] = value;
        saveSettings();
        refreshPanel();
    };

    const modelCommit = {
        'tm-set-model': onModelChanged('mainGenModel'),
        'tm-set-plot-model': onModelChanged('plotModel'),
        'tm-set-fill-model': onModelChanged('fillModel'),
    };
    combos = [modelInput, plotModelInput, fillModelInput].map(input => attachModelCombo(input, { onCommit: modelCommit[input.id] }));

    rateInput.addEventListener('input', () => {
        const current = getSettings();
        current.rate = Number(rateInput.value) || 1;
        saveSettings();
        refreshPanel();
    });

    modeSelect.addEventListener('change', () => {
        const current = getSettings();
        current.classifyMode = modeSelect.value === 'markers-only' ? 'markers-only' : 'auto';
        saveSettings();
        applyClassification();
    });

    const onMarkersChanged = () => {
        saveMarkers({
            plotMarkers: parseMarkers(plotMarkers.value),
            fillMarkers: parseMarkers(fillMarkers.value),
        });
        applyClassification();
    };
    plotMarkers.addEventListener('input', onMarkersChanged);
    fillMarkers.addEventListener('input', onMarkersChanged);

    document.getElementById('tm-update-prices').addEventListener('click', handleUpdatePrices);
    document.getElementById('tm-refresh').addEventListener('click', () => {
        rescanAuxFrames();
        refreshPanel();
    });
    document.getElementById('tm-recount').addEventListener('click', async () => {
        await recomputeChat();
        refreshPanel();
    });
    document.getElementById('tm-clear').addEventListener('click', () => {
        clearChatTokenData();
        refreshPanel();
    });
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

/**
 * Per-request list: one row per AI request, appended in request order —
 * main generations (including every re-generation of a floor), plot
 * progression, table filling and other auxiliary calls.
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
        container.innerHTML = '<div class="tm-empty">本聊天暂无请求记录</div>';
        return;
    }

    const regenCounter = new Map();
    const rows = entries.map((entry, index) => {
        const kind = entry.kind in KIND_SHORT ? entry.kind : 'other';
        const floorKnown = Number.isInteger(entry.floor);
        let regen = '';
        if (kind === 'main' && floorKnown) {
            const seen = (regenCounter.get(entry.floor) ?? 0) + 1;
            regenCounter.set(entry.floor, seen);
            if (seen > 1) {
                regen = ` <span class="tm-regen">↻${seen}</span>`;
            }
        }

        const priced = recordCost(entry, rate, settings);
        const costText = priced.found
            ? `${formatCost(priced.cost, rate)}${priced.pricedAtFallback ? '*' : ''}`
            : '—';
        const costTitle = priced.pricedAtFallback
            ? `模型 ${entry.model || '(空)'} 不在价格库，按 ${priced.fallbackModel} 计价`
            : (entry.model || '');

        const floorText = floorKnown ? `${entry.floor + 1}` : '—';
        const modelText = entry.model || '—';

        return `
            <div class="tm-request-row" data-floor="${floorKnown ? entry.floor : ''}">
                <span class="tm-request-index">${index + 1}</span>
                <span class="tm-request-time">${formatRequestTime(entry.ts)}</span>
                <span class="tm-request-kind"><span class="tm-badge tm-badge-${kind}" title="${AUX_LABELS[kind] ?? '主生成'}">${KIND_BADGE[kind]}${KIND_SHORT[kind]}</span></span>
                <span class="tm-request-floor">${floorText}${regen}</span>
                <span class="tm-request-model" title="${escapeHtml(modelText)}">${escapeHtml(modelText)}</span>
                <span class="tm-request-in">${entry.input === null ? '—' : formatNumber(entry.input)}</span>
                <span class="tm-request-out">${entry.output === null ? '—' : formatNumber(entry.output)}</span>
                <span class="tm-request-cost" title="${escapeHtml(costTitle)}">${costText}</span>
            </div>`;
    });

    container.innerHTML = rows.join('');
    container.querySelectorAll('.tm-request-row').forEach(row => {
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

function renderAux(entries, rate, settings) {
    const container = document.getElementById('tm-aux');
    if (!container) {
        return;
    }

    container.innerHTML = Object.keys(AUX_LABELS).map(category => {
        const own = entries.filter(entry => entry.kind === category);
        const input = own.reduce((sum, entry) => sum + (entry.input ?? 0), 0);
        const output = own.reduce((sum, entry) => sum + (entry.output ?? 0), 0);
        const priced = sumRecordsCost(own, rate, settings);
        const costText = priced.cost === null ? '—' : `${formatCost(priced.cost, rate)}${priced.unknown ? '*' : ''}`;
        const modelNote = priced.fallback
            ? ` <i>按 ${escapeHtml(fallbackModelFor(category, settings))} 计价</i>`
            : '';
        return `
            <div class="tm-row tm-aux-row">
                <span class="tm-label">${AUX_LABELS[category]}</span>
                <span class="tm-aux-metrics">${own.length}次 · in ${formatNumber(input)} · out ${formatNumber(output)} · <b>${costText}</b>${modelNote}</span>
            </div>`;
    }).join('');
}

export function refreshPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }

    const settings = getSettings();
    const rate = Number(settings.rate) || 1;
    const summary = computeRequestSummary();
    const entries = listRequests();

    const model = settings.mainGenModel || detectCurrentModel();
    const mainEntries = entries.filter(entry => entry.kind === 'main');
    const mainPriced = sumRecordsCost(mainEntries, rate, settings);
    const mainCostText = mainPriced.cost === null
        ? '—'
        : `${formatCost(mainPriced.cost, rate)}${mainPriced.unknown ? '*' : ''}`;

    setText('tm-main-calls', `${summary.main.calls}次`);
    setText('tm-main-in', `in ${formatNumber(summary.main.input)}${summary.main.unknownInput ? '*' : ''}`);
    setText('tm-main-out', `out ${formatNumber(summary.main.output)}`);
    setText('tm-main-total', `total ${formatNumber(summary.main.input + summary.main.output)}`);
    setText('tm-main-cost', mainCostText);
    setText('tm-main-model', model ? `模型：${model}` : '未设置模型（不计算主生成成本）');

    renderAux(entries, rate, settings);
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
