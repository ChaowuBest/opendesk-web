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
 * 把占位节点挂载成 React 组件。
 *
 * 每个工具调用对应一个常驻的宿主节点和 React root，按「调用 id + 组件 + props」缓存：
 * taskview 重建消息 HTML 后，同一调用的新占位节点直接接回原宿主节点，组件里未提交的
 * 选择、输入不会丢；状态变化（等待中 → 已回答）只是用新载荷重新渲染同一个 root。
 * 宿主节点脱离文档一段时间后（消息被移除、切换任务）再卸载释放。
 */

import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { GENUI_PLACEHOLDER_CLASS, parseGenUiPayload, type GenUiPayload } from '../../common/genui/protocol.js';
import { createRendererTranslator, resolveRendererLocale } from '../locale.js';
import { GenUiWidget } from './widgets.js';

type LocaleSource = Parameters<typeof createRendererTranslator>[0];

interface MountedWidget {
    host: HTMLElement;
    root: Root;
    raw: string;
}

const SWEEP_DELAY_MS = 10_000;
const mounted = new Map<string, MountedWidget>();
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function hashText(text: string): string {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(36);
}

/** 调用 id 可能在不同任务间重复（部分模型用序号作 id），所以把组件与 props 一起算进键。 */
export function widgetKey(payload: GenUiPayload): string {
    return `${payload.id}:${hashText(`${payload.component}\u0000${JSON.stringify(payload.props)}`)}`;
}

function scheduleSweep(): void {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweepDetached, SWEEP_DELAY_MS);
}

export function sweepDetached(): void {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = null;
    for (const [key, widget] of mounted) {
        if (!widget.host.isConnected) {
            widget.root.unmount();
            mounted.delete(key);
        }
    }
}

export function mountedWidgetCount(): number {
    return mounted.size;
}

export function mountGenUiPlaceholders(scope: ParentNode, localeSource?: LocaleSource): void {
    const t = createRendererTranslator(localeSource);
    const locale = resolveRendererLocale(localeSource);
    const placeholders = scope.querySelectorAll<HTMLElement>(`.${GENUI_PLACEHOLDER_CLASS}`);
    // 同一调用在文档里出现两次时只挂第一个，避免宿主节点在两处之间来回搬、反复触发观察器
    const placed = new Set<string>();
    for (const placeholder of placeholders) {
        const raw = placeholder.dataset.genui ?? '';
        const payload = parseGenUiPayload(raw);
        if (!payload) continue;

        const key = widgetKey(payload);
        if (placed.has(key)) continue;
        placed.add(key);
        let widget = mounted.get(key);
        const isNew = !widget;
        if (!widget) {
            const host = document.createElement('div');
            host.className = 'od-genui-host';
            widget = { host, root: createRoot(host), raw: '' };
            mounted.set(key, widget);
        }
        // 整段重建或就地合并后，占位节点里只剩兜底文字，把组件节点接回来
        if (placeholder.firstElementChild !== widget.host || placeholder.childNodes.length !== 1) {
            placeholder.replaceChildren(widget.host);
        }
        if (widget.raw === raw) continue;
        widget.raw = raw;
        const element = <GenUiWidget payload={payload} t={t} locale={locale} />;
        if (isNew) {
            // 首次挂载同步渲染，避免占位节点先变空再出现组件
            const root = widget.root;
            flushSync(() => root.render(element));
        } else {
            widget.root.render(element);
        }
    }
    scheduleSweep();
}
