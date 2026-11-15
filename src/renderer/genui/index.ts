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

/**
 * 生成式 UI 入口：监听 DOM 里出现的组件占位节点（showUI/askUI 工具调用的渲染结果），
 * 首次出现时才按需加载 React 与组件（mount.tsx），平时不增加主包体积。
 *
 * taskview 更新消息时要么整段重建 innerHTML，要么用 morphDomChildren 就地合并：后者保留
 * 占位节点本身，只改 data-genui 属性并把子节点换回兜底文字。两种情况都要重新挂载，所以
 * 新增节点、占位节点的子节点变化、data-genui 属性变化都会触发一次扫描；回调在同一轮微任务里
 * 把组件节点接回占位节点，绘制前完成，用户看不到闪烁，组件内部状态也不丢。
 */

import { GENUI_PLACEHOLDER_CLASS } from '../../common/genui/protocol.js';

type LocaleSource = Parameters<typeof import('../locale.js').createRendererTranslator>[0];

const PLACEHOLDER_SELECTOR = `.${GENUI_PLACEHOLDER_CLASS}`;

let installed = false;
let mountModule: Promise<typeof import('./mount.js')> | null = null;
let localeSource: LocaleSource;

/** taskview 收到设置变化时同步界面语言。 */
export function setGenUiLocaleSource(source: LocaleSource): void {
    localeSource = source;
}

function isElement(node: Node | null): node is Element {
    return node !== null && node.nodeType === 1;
}

function containsPlaceholder(node: Node): boolean {
    return isElement(node) && (node.matches(PLACEHOLDER_SELECTOR) || node.querySelector(PLACEHOLDER_SELECTOR) !== null);
}

/** 这批变更是否可能让某个占位节点失去组件或换了载荷。 */
export function affectsPlaceholders(records: readonly MutationRecord[]): boolean {
    for (const record of records) {
        if (isElement(record.target) && record.target.matches(PLACEHOLDER_SELECTOR)) return true;
        for (const node of record.addedNodes) {
            if (containsPlaceholder(node)) return true;
        }
    }
    return false;
}

function mountAll(): void {
    mountModule ??= import('./mount.js');
    mountModule
        .then((module) => module.mountGenUiPlaceholders(document, localeSource))
        .catch((err) => console.error('[genui] failed to mount widgets', err));
}

export function installGenUi(): void {
    if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    installed = true;
    const observer = new MutationObserver((records) => {
        if (affectsPlaceholders(records)) mountAll();
    });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-genui']
    });
    if (document.querySelector(PLACEHOLDER_SELECTOR)) mountAll();
}
