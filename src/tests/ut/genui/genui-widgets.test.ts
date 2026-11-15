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

import { describe, expect, it } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GENUI_COMPONENTS, GENUI_COMPONENT_NAMES, parseGenUiProps } from '../../../common/genui/catalog.js';
import type { GenUiComponentName, GenUiPayload } from '../../../common/genui/protocol.js';
import { createRendererTranslator } from '../../../renderer/locale.js';
import { GenUiWidget } from '../../../renderer/genui/widgets.js';
import { SAMPLE_PROPS } from './fixtures.js';

const t = createRendererTranslator('zh-CN');

function payload(component: GenUiComponentName, overrides: Partial<GenUiPayload> = {}): GenUiPayload {
    const parsed = parseGenUiProps(component, SAMPLE_PROPS[component]);
    if (!parsed.success) throw new Error(parsed.error);
    return {
        id: 'call_1',
        mode: GENUI_COMPONENTS[component].mode,
        component,
        props: parsed.props,
        status: 'success',
        ...overrides
    };
}

function render(value: GenUiPayload): string {
    return renderToStaticMarkup(createElement(GenUiWidget, { payload: value, t, locale: 'zh-CN' }));
}

describe('GenUiWidget', () => {
    it.each(GENUI_COMPONENT_NAMES)('renders %s from the sample props', (component) => {
        const html = render(payload(component, { title: '标题' }));
        expect(html).toContain(`data-component="${component}"`);
        expect(html).toContain('标题');
    });

    it('formats table cells with the UI locale and localized booleans', () => {
        const html = render(payload('data-table'));
        expect(html).toContain('季度销售');
        expect(html).toContain('华东');
        expect(html).toMatch(/¥1,280,000/);
        expect(html).toContain('12%');
        expect(html).toContain('是');
        expect(html).toContain('否');
    });

    it('shows the metric, comparison and spec contents', () => {
        expect(render(payload('chart'))).toContain('12840');
        const comparison = render(payload('comparison-card'));
        expect(comparison).toContain('方案 B');
        expect(comparison).toContain('需要离线使用');
        expect(render(payload('spec-sheet'))).toContain('32 GB');
        expect(render(payload('link-preview'))).toContain('href="https://example.com/post"');
    });

    describe('option-list', () => {
        it('is display-only until a request id arrives', () => {
            const html = render(payload('option-list', { status: 'running' }));
            expect(html).toContain('预发环境');
            expect(html).not.toContain('<button');
        });

        it('is interactive while waiting for the user', () => {
            const html = render(payload('option-list', { status: 'running', requestId: 'genui-1' }));
            expect(html).toContain('<button');
            expect(html).toContain('生产环境');
        });

        it('collapses to a receipt of the chosen option', () => {
            const html = render(payload('option-list', { response: { selected: ['prod'] } }));
            expect(html).toContain('生产环境');
            expect(html).not.toContain('预发环境');
            expect(html).not.toContain('<button');
        });

        it('notes a cancelled request', () => {
            expect(render(payload('option-list', { cancelled: true }))).toContain('已取消');
        });
    });

    describe('approval-card', () => {
        it('offers localized approve and deny buttons while waiting', () => {
            const html = render(payload('approval-card', { status: 'running', requestId: 'genui-1' }));
            expect(html).toContain('批准');
            expect(html).toContain('拒绝');
            expect(html).toContain('rm build/a.log');
        });

        it('shows the decision afterwards', () => {
            expect(render(payload('approval-card', { response: { decision: 'approve' } }))).toContain('已批准');
            const denied = render(payload('approval-card', { response: { decision: 'deny' } }));
            expect(denied).toContain('已拒绝');
            expect(denied).not.toContain('<button');
        });
    });

    describe('form', () => {
        it('prefills defaults and localizes the actions', () => {
            const html = render(payload('form', { status: 'running', requestId: 'genui-1' }));
            expect(html).toContain('value="1.2.0"');
            expect(html).toContain('需要填写');
            expect(html).toContain('提交');
            expect(html).toContain('aria-checked="true"');
        });

        it('shows submitted values as a receipt', () => {
            const html = render(
                payload('form', {
                    response: { action: 'submit', values: { version: '2.0.0', channel: 'beta', notify: false } }
                })
            );
            expect(html).toContain('2.0.0');
            expect(html).toContain('已提交');
            expect(html).not.toContain('<input');
        });
    });

    it('renders question-flow answers as a receipt', () => {
        const html = render(payload('question-flow', { response: { answers: { size: ['large'], budget: ['low'] } } }));
        expect(html).toContain('10 人以上');
        expect(html).toContain('低');
        expect(html).not.toContain('<button');
    });
});
