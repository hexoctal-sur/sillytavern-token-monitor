/**
 * Typeahead combo box for picking a model from the LiteLLM catalogue.
 *
 * The catalogue holds tens of thousands of entries, so a plain <select> is
 * unusable and free text is unsafe (user-side model names rarely match the
 * catalogue verbatim, which silently breaks cost estimation). Instead the user
 * types a fragment and a dropdown of every catalogue key containing it is shown,
 * re-filtered on every keystroke.
 */

import { searchModels } from './pricing.js';

const MAX_OPTIONS = 40;
const MAX_OPTION_HEIGHT = 220;

let seq = 0;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function createList() {
    const list = document.createElement('div');
    list.className = 'tm-combo-list tm-hidden';
    list.id = `tm_combo_list_${++seq}`;
    document.body.appendChild(list);
    return list;
}

function renderOptions(list, options, activeIndex) {
    if (options.length === 0) {
        list.innerHTML = '<div class="tm-combo-empty">价格库中无匹配模型</div>';
        return;
    }

    list.innerHTML = options.map((model, index) => {
        const label = escapeHtml(model);
        const className = index === activeIndex ? 'tm-combo-option tm-active' : 'tm-combo-option';
        return `<div class="${className}" data-model="${label}">${label}</div>`;
    }).join('');
}

/** Anchor the list below the input, flipping up when there is no room below. */
function positionList(input, list) {
    const rect = input.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const height = Math.min(MAX_OPTION_HEIGHT, list.scrollHeight);

    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
    list.style.maxHeight = `${height}px`;

    if (below < height && rect.top > below) {
        list.style.top = 'auto';
        list.style.bottom = `${window.innerHeight - rect.top}px`;
    } else {
        list.style.bottom = 'auto';
        list.style.top = `${rect.bottom + 2}px`;
    }
}

/**
 * Attach a typeahead dropdown to an existing <input>.
 * The list lives on document.body so panel overflow cannot clip it.
 * @param {HTMLInputElement} input
 * @param {{ onCommit?: (value: string) => void }} [options]
 * @returns {{ close: () => void, refresh: () => void, destroy: () => void }}
 */
export function attachModelCombo(input, { onCommit } = {}) {
    const list = createList();
    let matches = [];
    let activeIndex = -1;

    const onWindowChange = () => close();

    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-autocomplete', 'list');

    function open() {
        positionList(input, list);
        list.classList.remove('tm-hidden');
        input.setAttribute('aria-expanded', 'true');
    }

    function close() {
        list.classList.add('tm-hidden');
        input.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
    }

    function commit(value) {
        input.value = value;
        close();
        onCommit?.(value.trim());
    }

    function refresh() {
        matches = searchModels(input.value).slice(0, MAX_OPTIONS);
        activeIndex = matches.length ? 0 : -1;
        renderOptions(list, matches, activeIndex);
        open();
    }

    function selectActive() {
        if (activeIndex < 0 || activeIndex >= matches.length) {
            return;
        }
        commit(matches[activeIndex]);
    }

    function move(step) {
        if (matches.length === 0) {
            return;
        }
        activeIndex = (activeIndex + step + matches.length) % matches.length;
        renderOptions(list, matches, activeIndex);
        list.querySelector('.tm-active')?.scrollIntoView({ block: 'nearest' });
    }

    input.addEventListener('input', refresh);
    input.addEventListener('focus', refresh);

    input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
        } else if (event.key === 'Enter') {
            if (!list.classList.contains('tm-hidden')) {
                event.preventDefault();
                event.stopPropagation();
                selectActive();
            }
        } else if (event.key === 'Escape') {
            close();
        }
    });

    // mousedown + preventDefault keeps focus in the input, so the click lands.
    list.addEventListener('mousedown', event => {
        const option = event.target.closest('.tm-combo-option');
        if (!option) {
            return;
        }
        event.preventDefault();
        commit(option.dataset.model);
    });

    input.addEventListener('blur', close);
    window.addEventListener('resize', onWindowChange);
    window.addEventListener('scroll', onWindowChange, true);

    function destroy() {
        close();
        window.removeEventListener('resize', onWindowChange);
        window.removeEventListener('scroll', onWindowChange, true);
        list.remove();
    }

    return { close, refresh, destroy };
}