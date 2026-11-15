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

import { beforeAll, describe, expect, it } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { escapeHtml } from '../../../common/utils/escape.js';
import { morphDomChildren } from '../../../renderer/utils/dom-morph.js';
import { parseGenUiProps } from '../../../common/genui/catalog.js';
import type { GenUiPayload } from '../../../common/genui/protocol.js';
import { SAMPLE_PROPS } from './fixtures.js';

type MountModule = typeof import('../../../renderer/genui/mount.js');
let mount: MountModule;

function placeholderHtml(payload: GenUiPayload): string {
    return `<div class="od-genui" data-genui-id="${payload.id}" data-genui="${escapeHtml(
        JSON.stringify(payload)
    )}"><div class="od-genui-fallback">fallback</div></div>`;
}

function specPayload(overrides: Partial<GenUiPayload> = {}): GenUiPayload {
    const parsed = parseGenUiProps('spec-sheet', SAMPLE_PROPS['spec-sheet']);
    if (!parsed.success) throw new Error(parsed.error);
    return {
        id: 'call_1',
        mode: 'show',
        component: 'spec-sheet',
        props: parsed.props,
        status: 'success',
        ...overrides
    };
}

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body><main id="chat"></main></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        navigator: { languages: ['zh-CN'], language: 'zh-CN', userAgent: 'node' },
        HTMLElement: window.HTMLElement,
        HTMLIFrameElement: window.HTMLIFrameElement ?? class {},
        Node: window.Node,
        Element: window.Element,
        Event: window.Event
    });
    mount = await import('../../../renderer/genui/mount.js');
});

describe('mountGenUiPlaceholders', () => {
    it('replaces the fallback with the rendered widget', () => {
        const chat = document.getElementById('chat')!;
        chat.innerHTML = placeholderHtml(specPayload());
        mount.mountGenUiPlaceholders(document, 'zh-CN');
        const placeholder = chat.querySelector<HTMLElement>('.od-genui')!;
        expect(placeholder.querySelector('.od-genui-fallback')).toBeNull();
        expect(placeholder.textContent).toContain('服务器配置');
        expect(placeholder.textContent).toContain('32 GB');
    });

    it('moves the same widget host into a rebuilt placeholder', () => {
        const chat = document.getElementById('chat')!;
        const host = chat.querySelector('.od-genui-host');
        expect(host).not.toBeNull();
        // taskview 重建消息 HTML：同一调用的新占位节点应接回原宿主节点
        chat.innerHTML = `<section>${placeholderHtml(specPayload())}</section>`;
        mount.mountGenUiPlaceholders(document, 'zh-CN');
        expect(chat.querySelector('.od-genui-host')).toBe(host);
        expect(mount.mountedWidgetCount()).toBe(1);
    });

    it('restores the widget after taskview morphs the placeholder in place', () => {
        const chat = document.getElementById('chat')!;
        chat.innerHTML = `<section>${placeholderHtml(specPayload({ status: 'running' }))}</section>`;
        mount.mountGenUiPlaceholders(document, 'zh-CN');
        const placeholder = chat.querySelector<HTMLElement>('.od-genui')!;
        const host = placeholder.querySelector('.od-genui-host');
        expect(host).not.toBeNull();

        // 就地合并：占位节点保留，data-genui 更新，子节点被换回兜底文字
        morphDomChildren(chat, `<section>${placeholderHtml(specPayload({ status: 'success' }))}</section>`);
        expect(chat.querySelector('.od-genui')).toBe(placeholder);
        expect(placeholder.querySelector('.od-genui-fallback')).not.toBeNull();

        mount.mountGenUiPlaceholders(document, 'zh-CN');
        expect(placeholder.querySelector('.od-genui-host')).toBe(host);
        expect(placeholder.querySelector('.od-genui-fallback')).toBeNull();
        expect(placeholder.querySelector('[data-status="success"]')).not.toBeNull();
    });

    it('mounts a call rendered twice only once', () => {
        const chat = document.getElementById('chat')!;
        chat.innerHTML = placeholderHtml(specPayload()) + placeholderHtml(specPayload());
        mount.mountGenUiPlaceholders(document, 'zh-CN');
        mount.mountGenUiPlaceholders(document, 'zh-CN');
        const [first, second] = chat.querySelectorAll('.od-genui');
        expect(first.querySelector('.od-genui-host')).not.toBeNull();
        expect(second.querySelector('.od-genui-fallback')).not.toBeNull();
    });

    it('creates a separate widget when another call reuses the id with different props', () => {
        const chat = document.getElementById('chat')!;
        const other = specPayload({
            props: { title: '另一台', rows: [{ label: 'CPU', value: '4 核' }] }
        });
        chat.innerHTML = placeholderHtml(specPayload()) + placeholderHtml(other);
        mount.mountGenUiPlaceholders(document, 'zh-CN');
        const hosts = chat.querySelectorAll('.od-genui-host');
        expect(hosts).toHaveLength(2);
        expect(hosts[1].textContent).toContain('另一台');
        expect(mount.mountedWidgetCount()).toBeGreaterThanOrEqual(2);
    });

    it('ignores placeholders with a malformed payload', () => {
        const chat = document.getElementById('chat')!;
        chat.innerHTML = '<div class="od-genui" data-genui="{bad"><div class="od-genui-fallback">保留</div></div>';
        mount.mountGenUiPlaceholders(document, 'zh-CN');
        expect(chat.textContent).toBe('保留');
    });

    it('unmounts widgets whose host left the document', () => {
        document.getElementById('chat')!.innerHTML = '';
        mount.sweepDetached();
        expect(mount.mountedWidgetCount()).toBe(0);
    });
});
