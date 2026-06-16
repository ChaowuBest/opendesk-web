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

import { getDefaultWorkspace, subscribeDefaultWorkspace } from './state.js';
import { DRIVE_ROOT_PATH, getHomeRoot } from './tree/utils.js';

const ACTIONS_STYLE_ID = 'filemgr-actions-styles';

function resolveDocument(container, documentOverride) {
    const doc = documentOverride || container?.ownerDocument || globalThis.document;
    if (!doc) {
        throw new Error('createActions requires a DOM document.');
    }

    return doc;
}

function injectStyles(doc) {
    if (doc.getElementById(ACTIONS_STYLE_ID)) {
        return;
    }

    const style = doc.createElement('style');
    style.id = ACTIONS_STYLE_ID;
    style.textContent = `
.fs-lower-head {
    --filemgr-danger: #dc2626;
    --filemgr-danger-bg: color-mix(in srgb, var(--filemgr-danger) 10%, var(--od-bg-elevated));
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
}

.fs-lower-head .hint {
    font-size: 12.5px;
    color: var(--od-text-muted);
    font-weight: 500;
}

.fs-lower-head .fs-quick-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex: 0 0 auto;
}

.fs-lower-head .fs-quick-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--od-bg-elevated);
    border-radius: 8px;
    font-size: 12px;
    color: var(--od-text);
    cursor: pointer;
    transition: background 0.15s, box-shadow 0.15s, transform 0.15s;
    border: none;
    box-shadow: 0 0 0 1px var(--od-border), 0 1px 1px rgba(0, 0, 0, 0.02);
    font-weight: 500;
}

.fs-lower-head .fs-quick-btn:hover {
    background: var(--od-bg-muted);
    box-shadow: 0 0 0 1px var(--od-border-strong), 0 1px 2px rgba(0, 0, 0, 0.04);
}

.fs-lower-head .fs-quick-btn:active {
    transform: scale(0.97);
}

.fs-lower-head .fs-quick-btn i {
    color: var(--od-text-muted);
    font-size: 11px;
}

.fs-lower-head .fs-action-divider {
    width: 1px;
    height: 18px;
    background: var(--od-border);
    margin: 0 4px;
    flex-shrink: 0;
}

.fs-lower-head .fs-reset-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    background: var(--filemgr-danger-bg);
    border-radius: 8px;
    font-size: 12px;
    color: var(--filemgr-danger);
    cursor: pointer;
    transition: background 0.15s, box-shadow 0.18s, transform 0.15s, color 0.15s;
    border: none;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--filemgr-danger) 28%, var(--od-bg-elevated)), 0 1px 2px rgba(220, 38, 38, 0.04);
    font-weight: 600;
    letter-spacing: 0;
}

.fs-lower-head .fs-reset-btn:hover {
    background: var(--filemgr-danger);
    color: #fff;
    box-shadow: 0 0 0 1px var(--filemgr-danger), 0 4px 12px rgba(220, 38, 38, 0.28);
}

.fs-lower-head .fs-reset-btn:hover i {
    color: #fff;
}

.fs-lower-head .fs-reset-btn:active {
    transform: scale(0.97);
}

.fs-lower-head .fs-reset-btn i {
    color: var(--filemgr-danger);
    font-size: 11px;
    transition: color 0.15s;
}
`;

    doc.head.appendChild(style);
}

function createIcon(doc, iconClass) {
    const icon = doc.createElement('i');
    icon.className = `fas ${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');

    return icon;
}

function createButton(doc, className, iconClass, label) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = className;
    button.append(createIcon(doc, iconClass), doc.createTextNode(label));

    return button;
}

function buildActionsDom(doc, options) {
    const element = doc.createElement('div');
    element.className = 'fs-lower-head';

    const hint = doc.createElement('div');
    hint.className = 'hint';
    hint.textContent = '勾选你想让 AI 理解的文件夹';

    const actions = doc.createElement('div');
    actions.className = 'fs-quick-actions';

    const workspaceButton = createButton(doc, 'fs-quick-btn', 'fa-arrow-rotate-left', '当前工作空间');
    const homeButton = createButton(doc, 'fs-quick-btn', 'fa-house', '家目录');
    const divider = doc.createElement('span');
    divider.className = 'fs-action-divider';
    divider.setAttribute('aria-hidden', 'true');
    const resetButton = createButton(doc, 'fs-reset-btn', 'fa-arrows-rotate', '重置文件系统');

    workspaceButton.addEventListener('click', () => {
        const defaultWorkspace = getDefaultWorkspace();
        const home = getHomeRoot(defaultWorkspace);
        if (!defaultWorkspace || home === DRIVE_ROOT_PATH) {
            return;
        }

        void options.tree?.setRootEntryAndExpandTo?.(home, defaultWorkspace);
    });

    homeButton.addEventListener('click', () => {
        const home = getHomeRoot(getDefaultWorkspace());
        if (home !== DRIVE_ROOT_PATH && home && home !== '/') {
            void options.tree?.setRootEntry?.(home);
            return;
        }

        void options.tree?.setRoot(home);
    });

    resetButton.addEventListener('click', () => {
        options.onShowModal?.();
    });

    actions.append(workspaceButton, homeButton, divider, resetButton);
    element.append(hint, actions);

    return {
        element,
        workspaceButton
    };
}

export function createActions(container, options = {}) {
    const doc = resolveDocument(container, options.document);
    injectStyles(doc);

    const refs = buildActionsDom(doc, options);
    const refresh = () => {
        const defaultWorkspace = getDefaultWorkspace();
        const home = getHomeRoot(defaultWorkspace);
        refs.workspaceButton.hidden = !defaultWorkspace || home === DRIVE_ROOT_PATH;
    };

    refresh();
    container.appendChild(refs.element);

    const unsubscribeDefaultWorkspace = subscribeDefaultWorkspace(refresh);

    return {
        element: refs.element,
        refresh,
        destroy() {
            unsubscribeDefaultWorkspace();
            refs.element.remove();
        }
    };
}
