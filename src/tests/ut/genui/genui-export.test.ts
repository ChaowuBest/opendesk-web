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
import { GENUI_COMPONENTS, parseGenUiProps } from '../../../common/genui/catalog.js';
import type { GenUiComponentName, GenUiPayload } from '../../../common/genui/protocol.js';
import { SAMPLE_PROPS } from './fixtures.js';

let genui: typeof import('../../../renderer/genui/index.js');
let staticModule: typeof import('../../../renderer/genui/static.js');

function placeholder(component: GenUiComponentName, overrides: Partial<GenUiPayload> = {}): string {
    const parsed = parseGenUiProps(component, SAMPLE_PROPS[component]);
    if (!parsed.success) throw new Error(parsed.error);
    const payload: GenUiPayload = {
        id: `call_${component}`,
        mode: GENUI_COMPONENTS[component].mode,
        component,
        props: parsed.props,
        status: 'success',
        ...overrides
    };
    return `<div class="od-genui" data-genui="${escapeHtml(JSON.stringify(payload))}"><div class="od-genui-fallback">${component}</div></div>`;
}

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, { window, document: window.document, Node: window.Node });
    genui = await import('../../../renderer/genui/index.js');
    staticModule = await import('../../../renderer/genui/static.js');
});

describe('genui export', () => {
    it('renders placeholders into static widget markup', () => {
        const html = staticModule.renderGenUiStaticHtml(
            `<div class="od-genui-item">${placeholder('data-table')}</div><p>正文</p>`,
            'zh-CN'
        );
        expect(html).not.toContain('od-genui-fallback');
        expect(html).toContain('data-component="data-table"');
        expect(html).toContain('华东');
        expect(html).toContain('<p>正文</p>');
    });

    it('freezes a waiting askUI card without clickable choices', () => {
        const html = staticModule.renderGenUiStaticHtml(
            placeholder('option-list', { status: 'running', requestId: 'genui-1' }),
            'zh-CN'
        );
        expect(html).toContain('生产环境');
        expect(html).not.toContain('<button');
    });

    it('keeps answered cards as receipts', () => {
        const html = staticModule.renderGenUiStaticHtml(
            placeholder('approval-card', { response: { decision: 'approve' } }),
            'zh-CN'
        );
        expect(html).toContain('已批准');
    });

    it('leaves fragments without widgets and malformed payloads untouched', async () => {
        const plain = ['<p>a</p>', '<p>b</p>'];
        await expect(genui.renderGenUiForExport(plain)).resolves.toBe(plain);
        const broken = '<div class="od-genui" data-genui="{bad"><div class="od-genui-fallback">保留</div></div>';
        expect(staticModule.renderGenUiStaticHtml(broken, 'zh-CN')).toContain('保留');
    });

    it('renders only the fragments that need it', async () => {
        const [first, second] = await genui.renderGenUiForExport(['<p>前</p>', placeholder('spec-sheet')]);
        expect(first).toBe('<p>前</p>');
        expect(second).toContain('32 GB');
    });
});
