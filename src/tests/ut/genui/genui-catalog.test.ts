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
import {
    GENUI_COMPONENTS,
    GENUI_COMPONENT_NAMES,
    describeGenUiCatalog,
    describeGenUiResponse,
    listGenUiComponents,
    parseGenUiPayload,
    parseGenUiProps,
    genUiToolBaseName,
    parseGenUiResponse
} from '../../../common/genui/catalog.js';
import { SAMPLE_PROPS } from './fixtures.js';

describe('genui catalog', () => {
    it('defines exactly the components named by the protocol', () => {
        expect(Object.keys(GENUI_COMPONENTS).sort()).toEqual([...GENUI_COMPONENT_NAMES].sort());
        expect(listGenUiComponents('ask')).toEqual(['option-list', 'question-flow', 'approval-card', 'form']);
        expect(listGenUiComponents('show')).toEqual([
            'data-table',
            'chart',
            'comparison-card',
            'link-preview',
            'spec-sheet'
        ]);
    });

    it.each(GENUI_COMPONENT_NAMES)('accepts the sample props of %s', (name) => {
        const checked = parseGenUiProps(name, SAMPLE_PROPS[name]);
        expect(checked).toMatchObject({ success: true });
    });

    it('normalizes a numeric chart value to text', () => {
        const checked = parseGenUiProps('chart', SAMPLE_PROPS.chart);
        expect(checked.success && checked.props.value).toBe('12840');
    });

    it.each([
        [
            'option-list',
            {
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'a', label: 'B' }
                ]
            },
            'props.options.1.id: id "a" 重复'
        ],
        ['option-list', { options: [{ id: 'a', label: 'A' }] }, 'props.options'],
        [
            'option-list',
            {
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' }
                ],
                maxSelections: 3
            },
            'props.maxSelections: maxSelections 不能大于选项数'
        ],
        [
            'form',
            { message: 'x', fields: [{ name: 'env', label: '环境', kind: 'choice' }] },
            'props.fields.0.options: kind=choice 时必须提供 options'
        ],
        [
            'comparison-card',
            { ...SAMPLE_PROPS['comparison-card'], recommendedId: 'c' },
            'props.recommendedId: recommendedId 不在 options 中'
        ],
        [
            'comparison-card',
            {
                ...SAMPLE_PROPS['comparison-card'],
                options: [
                    { id: 'a', name: 'A', headline: '', traits: ['1'] },
                    { id: 'b', name: 'B', headline: '', traits: ['1', '2'] }
                ]
            },
            'props.options.0.traits: traits 数量必须与 traitLabels 一致'
        ],
        [
            'data-table',
            { ...SAMPLE_PROPS['data-table'], defaultSort: { key: 'missing', direction: 'asc' } },
            'props.defaultSort.key: defaultSort.key 不是已声明的列'
        ],
        ['link-preview', { href: 'javascript:alert(1)' }, 'props.href: 只支持 http/https 链接']
    ] as const)('rejects invalid %s props with a readable path', (name, props, message) => {
        const checked = parseGenUiProps(name, props);
        expect(checked.success).toBe(false);
        expect(checked.success === false && checked.error).toContain(message);
    });

    describe('responses', () => {
        const optionProps = parseGenUiProps('option-list', SAMPLE_PROPS['option-list']);
        const props = optionProps.success ? optionProps.props : {};

        it('accepts a single choice from the offered options', () => {
            expect(parseGenUiResponse('option-list', props, { selected: ['prod'] })).toEqual({
                success: true,
                response: { selected: ['prod'] }
            });
        });

        it('rejects unknown, disabled or too many choices', () => {
            expect(parseGenUiResponse('option-list', props, { selected: ['nope'] }).success).toBe(false);
            expect(parseGenUiResponse('option-list', props, { selected: ['canary'] }).success).toBe(false);
            expect(parseGenUiResponse('option-list', props, { selected: ['prod', 'staging'] }).success).toBe(false);
        });

        it('requires every question-flow step to be answered', () => {
            const flow = parseGenUiProps('question-flow', SAMPLE_PROPS['question-flow']);
            const flowProps = flow.success ? flow.props : {};
            expect(parseGenUiResponse('question-flow', flowProps, { answers: { size: ['small'] } }).success).toBe(
                false
            );
            const ok = parseGenUiResponse('question-flow', flowProps, {
                answers: { size: ['small'], budget: ['low', 'mid'] }
            });
            expect(ok.success).toBe(true);
            expect(
                describeGenUiResponse('question-flow', flowProps, {
                    answers: { size: ['small'], budget: ['low', 'mid'] }
                })
            ).toBe('问题：团队规模？\n回答：10 人以内\n问题：预算？\n回答：低、中');
        });

        it('checks required and choice form fields', () => {
            const form = parseGenUiProps('form', SAMPLE_PROPS.form);
            const formProps = form.success ? form.props : {};
            expect(
                parseGenUiResponse('form', formProps, {
                    action: 'submit',
                    values: { version: ' ', channel: 'stable', notify: true }
                })
            ).toMatchObject({ success: false, error: '必填字段 version 为空' });
            expect(
                parseGenUiResponse('form', formProps, {
                    action: 'submit',
                    values: { version: '1.0', channel: 'nightly', notify: true }
                })
            ).toMatchObject({ success: false, error: '字段 channel 的值不在选项中' });
            expect(parseGenUiResponse('form', formProps, { action: 'decline' })).toEqual({
                success: true,
                response: { action: 'decline' }
            });
        });

        it('does not accept responses for display components', () => {
            expect(parseGenUiResponse('chart', {}, {}).success).toBe(false);
        });

        it('describes responses for the model', () => {
            expect(describeGenUiResponse('option-list', props, { selected: ['prod'] })).toBe('用户选择：生产环境');
            const approval = SAMPLE_PROPS['approval-card'];
            expect(describeGenUiResponse('approval-card', approval, { decision: 'deny' })).toBe(
                '用户拒绝了「删除 3 个文件」'
            );
        });
    });

    it('documents every component of a mode in the tool description', () => {
        for (const mode of ['show', 'ask'] as const) {
            const text = describeGenUiCatalog(mode);
            for (const name of listGenUiComponents(mode)) {
                expect(text).toContain(`### ${name}\n`);
            }
            // 每段 schema 都是合法 JSON，模型能直接读懂
            for (const line of text.split('\n').filter((item) => item.startsWith('props: '))) {
                expect(() => JSON.parse(line.slice('props: '.length))).not.toThrow();
            }
            expect(text.length).toBeLessThan(12_000);
        }
    });

    it('recognizes tool names with or without the toolset prefix', () => {
        expect(genUiToolBaseName('showUI')).toBe('showUI');
        expect(genUiToolBaseName('interaction-askUI')).toBe('askUI');
        expect(genUiToolBaseName('interaction-askUser')).toBeNull();
        expect(genUiToolBaseName('myshowUI')).toBeNull();
        expect(genUiToolBaseName(undefined)).toBeNull();
    });

    it('parses only well-formed placeholder payloads', () => {
        const payload = { id: 'call_1', mode: 'show', component: 'chart', props: {}, status: 'success' };
        expect(parseGenUiPayload(JSON.stringify(payload))).toEqual(payload);
        expect(parseGenUiPayload(JSON.stringify({ ...payload, component: 'iframe' }))).toBeNull();
        expect(parseGenUiPayload(JSON.stringify({ ...payload, mode: 'x' }))).toBeNull();
        expect(parseGenUiPayload('{oops')).toBeNull();
        expect(parseGenUiPayload(undefined)).toBeNull();
    });
});
