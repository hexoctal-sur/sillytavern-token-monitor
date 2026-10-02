/**
 * Token Monitor panel: an entry in the extensions (wand) menu plus a draggable
 * floating panel showing main-generation usage, auxiliary (plot/fill/other)
 * usage, a per-floor table and the extension settings.
 */

import { computeChatSummary, getMessageTokens, recomputeChat, clearChatTokenData } from './store.js';
import { setMarkerConfig, rescanAuxFrames } from './interceptor.js';
import { getPriceMeta, updatePrices, computeCost } from './pricing.js';

const MODULE_NAME = 'token_monitor';
const PANEL_ID = 'token_monitor_panel';
const MENU_ID = 'token_monitor_menu_entry';
const FAB_ID = 'token_monitor_fab';
const MARKER_STORAGE_KEY = 'token_monitor_markers';

const AUX_LABELS = { plot: '剧情推进', fill: '填表', other: '其他' };
const AUX_BADGE = { plot: 'P', fill: 'F', other: 'O' };

const defaultSettings = Object.freeze({
    mainGenModel: '',
    rate: 1,
    classifyMode: 'auto',
    panelVisible: false,
    panelPosition: null,
    collapsed: false,
});

let bound = false;

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
 * ------------------------------------------------------------------ */

function categoryCost(category, rate) {
    const models = Object.entries(category?.byModel ?? {});
    if (models.length === 0) {
        return { cost: null, unknown: (category?.input ?? 0) > 0 || (category?.output ?? 0) > 0 };
    }

    let cost = 0;
    let anyFound = false;
    let unknown = false;

    for (const [model, value] of models) {
        const result = computeCost({ input: value.input, output: value.output, model, rate });
        if (result.found) {
            cost += result.cost;
            anyFound = true;
        } else {
            unknown = true;
        }
    }

    return { cost: anyFound ? cost : null, unknown };
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
                <div class="tm-row"><span class="tm-label">主生成</span><span class="tm-value" id="tm-main-cost">—</span></div>
                <div class="tm-sub">
                    <span id="tm-main-in">in —</span>
                    <span id="tm-main-out">out —</span>
                    <span id="tm-main-total">total —</span>
                </div>
                <div class="tm-hint" id="tm-main-model"></div>
            </div>
            <div class="tm-aux" id="tm-aux"></div>
            <div class="tm-list">
                <div class="tm-messages-head">
                    <span>#</span><span>角色</span><span>in</span><span>out</span><span>aux</span>
                </div>
                <div class="tm-messages" id="tm-messages"></div>
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
        </div>`;
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

function bindSettingsInputs() {
    const settings = getSettings();
    const markers = loadMarkers();

    const modelInput = document.getElementById('tm-set-model');
    const rateInput = document.getElementById('tm-set-rate');
    const modeSelect = document.getElementById('tm-set-mode');
    const plotMarkers = document.getElementById('tm-set-plot-markers');
    const fillMarkers = document.getElementById('tm-set-fill-markers');

    modelInput.value = settings.mainGenModel ?? '';
    rateInput.value = String(settings.rate ?? 1);
    modeSelect.value = settings.classifyMode ?? 'auto';
    plotMarkers.value = markers.plotMarkers.join('\n');
    fillMarkers.value = markers.fillMarkers.join('\n');

    modelInput.addEventListener('input', () => {
        const current = getSettings();
        current.mainGenModel = modelInput.value.trim();
        saveSettings();
        refreshPanel();
    });

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

function buildBadges(aux) {
    if (!aux) {
        return '—';
    }
    const badges = [];
    for (const category of Object.keys(AUX_BADGE)) {
        const data = aux[category];
        if (!data || !data.calls) {
            continue;
        }
        const title = `${AUX_LABELS[category]}: ${data.calls}次 · in ${formatNumber(data.input)} · out ${formatNumber(data.output)}`;
        badges.push(`<span class="tm-badge tm-badge-${category}" title="${escapeHtml(title)}">${AUX_BADGE[category]}${data.calls}</span>`);
    }
    return badges.join('') || '—';
}

function renderMessages() {
    const container = document.getElementById('tm-messages');
    if (!container) {
        return;
    }
    const chat = ctx()?.chat ?? [];
    const rows = [];

    chat.forEach((message, index) => {
        if (!message || message.is_system === true) {
            return;
        }
        const data = getMessageTokens(message);
        const role = message.is_user === true ? '用户' : (message.name || '角色');
        const input = data && Number.isFinite(Number(data.input)) ? Number(data.input) : null;
        const output = data && Number.isFinite(Number(data.output)) ? Number(data.output) : null;

        rows.push(`
            <div class="tm-message-row" data-index="${index}">
                <span class="tm-message-index">${index + 1}</span>
                <span class="tm-message-role" title="${escapeHtml(role)}">${escapeHtml(role)}</span>
                <span class="tm-message-in">${input === null ? '—' : formatNumber(input)}</span>
                <span class="tm-message-out">${output === null ? '—' : formatNumber(output)}</span>
                <span class="tm-message-aux">${buildBadges(data?.aux)}</span>
            </div>`);
    });

    if (rows.length === 0) {
        container.innerHTML = '<div class="tm-empty">本聊天暂无统计数据</div>';
        return;
    }

    container.innerHTML = rows.join('');
    container.querySelectorAll('.tm-message-row').forEach(row => {
        row.addEventListener('click', () => {
            const index = row.getAttribute('data-index');
            const target = document.querySelector(`.mes[mesid="${index}"]`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    });
}

function renderAux(summary, rate) {
    const container = document.getElementById('tm-aux');
    if (!container) {
        return;
    }

    container.innerHTML = Object.keys(AUX_LABELS).map(category => {
        const data = summary.aux[category];
        const { cost, unknown } = categoryCost(data, rate);
        const costText = cost === null ? '—' : `${formatCost(cost, rate)}${unknown ? '*' : ''}`;
        return `
            <div class="tm-row tm-aux-row">
                <span class="tm-label">${AUX_LABELS[category]}</span>
                <span class="tm-aux-metrics">${data.calls}次 · in ${formatNumber(data.input)} · out ${formatNumber(data.output)} · <b>${costText}</b></span>
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
    const summary = computeChatSummary();

    const model = settings.mainGenModel || detectCurrentModel();
    const mainResult = model
        ? computeCost({ input: summary.totalInput, output: summary.totalOutput, model, rate })
        : { found: false, cost: null };

    setText('tm-main-in', `in ${formatNumber(summary.totalInput)}`);
    setText('tm-main-out', `out ${formatNumber(summary.totalOutput)}`);
    setText('tm-main-total', `total ${formatNumber(summary.total)}`);
    setText('tm-main-cost', mainResult.found ? formatCost(mainResult.cost, rate) : '—');
    setText('tm-main-model', model ? `模型：${model}` : '未设置模型（不计算主生成成本）');

    renderAux(summary, rate);
    renderMessages();
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
    if (getSettings().collapsed) {
        panel.classList.add('tm-collapsed');
    }
    bindPanelEvents(panel);

    setPanelVisible(Boolean(getSettings().panelVisible), { persist: false });
}

export function unmountPanel() {
    bound = false;
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(MENU_ID)?.remove();
    document.getElementById(FAB_ID)?.remove();
}
