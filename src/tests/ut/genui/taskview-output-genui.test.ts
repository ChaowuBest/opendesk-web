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
    buildAssistantOutputItems,
    getVisibleAssistantOutputItems,
    type GuiAssistantPart
} from '../../../renderer/components/taskview-output.js';

const reasoning: GuiAssistantPart = { type: 'reasoning', rendered: '想一想' };
const shellCall: GuiAssistantPart = {
    type: 'tool_call',
    rendered: '<div>shell</div>',
    toolcalls: [{ tool_name: 'shell', status: 'success' }]
};
const tableWidget: GuiAssistantPart = {
    type: 'tool_call',
    rendered: '<div class="od-genui"></div>',
    toolcalls: [{ tool_name: 'interaction-showUI', status: 'success' }]
};
// 实际记录的工具名带工具集前缀
const askWidget = (status: string): GuiAssistantPart => ({
    type: 'tool_call',
    rendered: '<div class="od-genui"></div>',
    toolcalls: [{ tool_name: 'interaction-askUI', status }]
});
const text = (value: string): GuiAssistantPart => ({ type: 'text', rendered: `<p>${value}</p>` });

describe('assistant output items with generative UI', () => {
    it('lifts UI tool calls out of the collapsible process', () => {
        const items = buildAssistantOutputItems([reasoning, shellCall, tableWidget, shellCall, text('结论')], {
            isRunning: false
        });
        expect(items.map((item) => item.type)).toEqual(['process', 'widget', 'process', 'final']);
        expect(items[1]).toMatchObject({ key: 'widget-2', partIndex: 2 });
    });

    it('never turns a widget into the final answer', () => {
        const items = buildAssistantOutputItems([text('先看表'), tableWidget], { isRunning: false });
        expect(items.map((item) => item.type)).toEqual(['final', 'widget']);
    });

    it('keeps widgets visible while a minimal turn is still running', () => {
        const parts = [reasoning, tableWidget, shellCall];
        const items = buildAssistantOutputItems(parts, { isRunning: true });
        const visible = getVisibleAssistantOutputItems(items, { mode: 'minimal', isRunning: true, parts });
        expect(visible.map((item) => item.type)).toEqual(['process', 'widget', 'status']);
    });

    it('drops the running status line while askUI waits for the user', () => {
        const waiting = [reasoning, askWidget('running')];
        const items = buildAssistantOutputItems(waiting, { isRunning: true });
        expect(
            getVisibleAssistantOutputItems(items, { mode: 'minimal', isRunning: true, parts: waiting }).map(
                (item) => item.type
            )
        ).toEqual(['process', 'widget']);

        const answered = [reasoning, askWidget('success')];
        const after = buildAssistantOutputItems(answered, { isRunning: true });
        expect(
            getVisibleAssistantOutputItems(after, { mode: 'minimal', isRunning: true, parts: answered }).map(
                (item) => item.type
            )
        ).toEqual(['process', 'widget', 'status']);
    });

    it('keeps a UI call that has not rendered anything yet inside the process', () => {
        const streaming: GuiAssistantPart = { type: 'tool_call', rendered: '', toolcalls: [{ tool_name: 'showUI' }] };
        expect(buildAssistantOutputItems([streaming], { isRunning: true })).toEqual([
            expect.objectContaining({ type: 'process' })
        ]);
    });
});
