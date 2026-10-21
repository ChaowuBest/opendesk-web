/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { getUndo, rollbackUndo, subscribeSelection } from './state.js';
import { createRendererTranslator } from '../../../../renderer/locale.ts';

const STYLE_ID = 'filemgr-toast-style';
const INFO_DURATION_MS = 3_000;
const UNDO_DURATION_MS = 3_000;
const MAX_NAME_LENGTH = 28;

const TOAST_MESSAGE_KEYS = {
    'add-entry': 'add',
    exclude: 'exclude',
    restore: 'restore',
    'carve-out': 'restore',
    consolidate: 'add'
};

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.fs-toast {
    position: fixed;
    bottom: 28px;
    right: 28px;
    max-width: min(420px, calc(100vw - 56px));
    background: rgba(29, 29, 31, 0.96);
    backdrop-filter: blur(20px);
    color: white;
    padding: 12px 16px;
    border-radius: 11px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 14px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(255, 255, 255, 0.05);
    z-index: 1000;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.22s var(--od-ease-out, cubic-bezier(0.16, 1, 0.3, 1)), transform 0.22s var(--od-ease-out, cubic-bezier(0.16, 1, 0.3, 1));
    pointer-events: none;
}

.fs-toast.show {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
}

.fs-toast__icon {
    flex: 0 0 auto;
    color: #34d399;
}

.fs-toast__icon.is-info {
    color: #60a5fa;
}

.fs-toast__text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.fs-toast .undo-btn {
    flex: 0 0 auto;
    background: transparent;
    border: none;
    color: #60a5fa;
    font-weight: 600;
    cursor: pointer;
    font-size: 13px;
    padding: 0;
}

.fs-toast .undo-btn:hover {
    color: #93c5fd;
}
`;
    document.head.appendChild(style);
}

function basename(path) {
    if (!path || typeof path !== 'string') {
        return '该路径';
    }

    const normalizedPath = path.replace(/[\\/]+$/, '');
    const parts = normalizedPath.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) || normalizedPath || path;
}

function truncateName(name) {
    if (name.length <= MAX_NAME_LENGTH) {
        return name;
    }

    return `${name.slice(0, MAX_NAME_LENGTH - 1)}…`;
}

function quotedName(path) {
    return `「${truncateName(basename(path))}」`;
}

function getToastAction(payload) {
    const result = payload?.result ?? payload ?? {};
    if (typeof result.toastAction === 'string') {
        return result.toastAction;
    }

    if (payload?.toast === 'undo' || result.toast === 'undo') {
        return 'exclude';
    }

    return 'add-entry';
}

function getToastText(payload, t) {
    const action = getToastAction(payload);
    const prefix = t(`renderer.filemgr.selection.toast.${TOAST_MESSAGE_KEYS[action] ?? 'add'}`);
    return `${prefix}${quotedName(payload?.path)}`;
}

function getVariantOptions(payload, t) {
    if (payload?.variant) {
        return payload;
    }

    const toastType = payload?.toast ?? payload?.result?.toast ?? 'info';
    if (toastType === 'undo') {
        return {
            variant: 'undo',
            text: getToastText(payload, t),
            durationMs: UNDO_DURATION_MS
        };
    }

    return {
        variant: 'info',
        text: getToastText(payload, t),
        durationMs: INFO_DURATION_MS
    };
}

function createElement() {
    const element = document.createElement('div');
    element.className = 'fs-toast';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');

    const icon = document.createElement('i');
    icon.className = 'fas fa-circle-check fs-toast__icon';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'fs-toast__text';

    const undoButton = document.createElement('button');
    undoButton.className = 'undo-btn';
    undoButton.type = 'button';
    undoButton.textContent = '撤销';
    undoButton.hidden = true;

    element.append(icon, text, undoButton);

    return {
        element,
        icon,
        text,
        undoButton
    };
}

export function createToast(options = {}) {
    ensureStyles();

    const parts = createElement();
    const container = options.container ?? document.body;
    let timer = null;
    let currentVariant = null;
    let undoToken = null;
    let t = options.t ?? createRendererTranslator();

    container.appendChild(parts.element);

    function clearTimer() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function hide() {
        clearTimer();
        parts.element.classList.remove('show');
        currentVariant = null;
    }

    function show(rawPayload) {
        const payload = getVariantOptions(rawPayload, t);
        const variant = payload.variant;
        clearTimer();

        currentVariant = variant;
        parts.text.textContent = payload.text;
        parts.icon.className =
            variant === 'undo-success'
                ? 'fas fa-info-circle fs-toast__icon is-info'
                : 'fas fa-circle-check fs-toast__icon';
        undoToken = variant === 'undo' ? getUndo()?.token : null;
        parts.undoButton.textContent = t('renderer.filemgr.selection.undo');
        parts.undoButton.hidden = undoToken == null;
        parts.element.classList.add('show');

        const duration =
            variant === 'undo'
                ? Math.max(0, (getUndo()?.expiresAt ?? Date.now()) - Date.now())
                : (payload.durationMs ?? INFO_DURATION_MS);
        timer = setTimeout(hide, duration);
    }

    function showUndoSuccess() {
        show({
            variant: 'undo-success',
            text: t('renderer.filemgr.selection.undone'),
            durationMs: INFO_DURATION_MS
        });
    }

    parts.undoButton.addEventListener('click', () => {
        if (currentVariant !== 'undo') {
            return;
        }

        const restoredEntries = rollbackUndo(undoToken);
        hide();

        if (restoredEntries) {
            options.tree?.refreshCheckboxes?.();
            options.onRollback?.(restoredEntries);
        }

        if (restoredEntries) showUndoSuccess();
    });

    const unsubscribe = subscribeSelection(() => {
        if (currentVariant === 'undo' && getUndo()?.token !== undoToken) hide();
    });
    return {
        element: parts.element,
        setTranslator(translator) {
            t = translator;
            parts.undoButton.textContent = t('renderer.filemgr.selection.undo');
        },
        show,
        showFromPayload(payload) {
            show(payload);
        },
        hide,
        destroy() {
            unsubscribe();
            hide();
            parts.element.remove();
        }
    };
}
