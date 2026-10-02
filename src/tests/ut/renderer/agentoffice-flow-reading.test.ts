import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { enUs } from '../../../main/applications/agentoffice/locale/en-us.js';
import { zhCn } from '../../../main/applications/agentoffice/locale/zh-cn.js';

describe('flow reading UI', () => {
    let Widget: new () => HTMLElement;
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLInputElement: window.HTMLInputElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLSelectElement: window.HTMLSelectElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: () => 0,
            cancelAnimationFrame: () => undefined
        });
        (window as any).applicationAPI = { subscribe: jest.fn(), unsubscribe: jest.fn() };
        Widget = (await import('../../../main/applications/agentoffice/renderer/entry.js')).AgentOfficeEntryWidget;
    });
    function fixture() {
        const w = new Widget() as any;
        w.attachShadow({ mode: 'open' });
        w.strings = enUs;
        w.activeTab = 'flows';
        w.flowFeatureEnabled = true;
        w.selectedFlow = {
            id: 'flow1',
            name: 'Test',
            goal: '',
            status: 'active',
            revision: 1,
            memberIds: ['s1'],
            members: [{ staffId: 's1', name: 'Ada', enabled: true }]
        };
        const message = (n: number) => ({
            id: `m${n}`,
            sequence: n,
            sender: { type: 'user' },
            kind: 'message',
            content: [{ type: 'text', text: `text${n}` }],
            createdAt: new Date().toISOString()
        });
        w.flowMessages = [message(1)];
        const view = {
            flowId: 'flow1',
            mode: 'immediate',
            deleting: false,
            members: [{ staffId: 's1', name: 'Ada', availability: 'active', intervalMinutes: 10 }],
            receipts: { m1: { read: 1, total: 1, members: [{ staffId: 's1', status: 'read' }] } }
        };
        w.call = jest.fn(async (method: string) => {
            if (method === 'getFlowReadingView') return view;
            if (method === 'listFlows') return [w.selectedFlow];
            if (method === 'getFlow') return w.selectedFlow;
            return { messages: [message(1)], hasMore: false };
        });
        return { w, view, message };
    }
    test.each([
        ['zh-CN', zhCn, '已读 0/1', '已读 1/1', '10 分钟'],
        ['en-US', enUs, 'Read 0/1', 'Read 1/1', '10 minutes']
    ])(
        'reading labels interpolate counts, periods and next time (%s)',
        async (_locale, strings, unread, read, period) => {
            const { w, view } = fixture();
            w.strings = strings;
            view.receipts.m1.read = 0;
            w.flowReadingView = view;
            w.render();
            expect(w.shadowRoot.querySelector('[data-flow-receipt] summary').textContent).toBe(unread);
            view.receipts.m1.read = 1;
            await w.loadFlowReading();
            expect(w.shadowRoot.querySelector('[data-flow-receipt] summary').textContent).toBe(read);
            w.flowView = 'settings';
            w.render();
            expect(w.shadowRoot.querySelector('[data-flow-interval] option[value="10"]').textContent).toBe(period);
            const nextTriggerAt = '2026-10-02T07:30:00.000Z';
            const next = w.renderNextReading({ ...view.members[0], nextTriggerAt });
            expect(next).toContain(new Date(nextTriggerAt).toLocaleString(w.locale));
            expect(next).not.toContain('{time}');
        }
    );

    test('reading-only updates preserve composer node, caret, scroll and open receipt details', async () => {
        const { w, view } = fixture();
        w.flowReadingView = view;
        w.render();
        const input = w.shadowRoot.querySelector('#flow-message-input');
        input.value = 'draft';
        input.selectionStart = 2;
        const list = w.shadowRoot.querySelector('.flow-message-list');
        list.scrollTop = 88;
        const details = w.shadowRoot.querySelector('[data-flow-receipt]');
        details.open = true;
        view.receipts.m1.read = 0;
        view.receipts.m1.members[0].status = 'reading';
        await w.loadFlowReading();
        expect(w.shadowRoot.querySelector('#flow-message-input')).toBe(input);
        expect(input.value).toBe('draft');
        expect(input.selectionStart).toBe(2);
        expect(list.scrollTop).toBe(88);
        expect(w.shadowRoot.querySelector('[data-flow-receipt]').open).toBe(true);
        expect(w.shadowRoot.querySelector('[data-flow-receipt]').textContent).toContain('Reading');
    });
    test('background updates preserve unsaved group settings', async () => {
        const { w, view } = fixture();
        w.flowView = 'settings';
        w.flowReadingView = view;
        w.render();
        const name = w.shadowRoot.querySelector('#flow-name');
        name.value = 'unsaved';
        await w.reloadFlows();
        await w.loadFlowMessages();
        expect(w.shadowRoot.querySelector('#flow-name')).toBe(name);
        expect(name.value).toBe('unsaved');
    });
    test('message refresh retains loaded history and updates deleted messages', async () => {
        const { w, view, message } = fixture();
        w.flowMessages = Array.from({ length: 75 }, (_, n) => message(n + 1));
        w.call = jest.fn(async (method: string, _id: string, query: any) => {
            if (method === 'getFlowReadingView') return view;
            if (!query.cursor)
                return {
                    messages: Array.from({ length: 50 }, (_, n) => message(n + 27)),
                    hasMore: true,
                    nextCursor: 'older'
                };
            return { messages: Array.from({ length: 25 }, (_, n) => message(n + 2)), hasMore: false };
        });
        await w.loadFlowMessages();
        expect(w.flowMessages[0].id).toBe('m2');
        expect(w.flowMessages.at(-1).id).toBe('m76');
        expect(w.flowMessages).toHaveLength(75);
    });
    test('archived group shows receipts without send, retry or period controls', () => {
        const { w, view } = fixture();
        w.selectedFlow.status = 'archived';
        w.flowReadingView = view;
        w.render();
        expect(w.shadowRoot.querySelector('[data-flow-receipt]')).not.toBeNull();
        expect(w.shadowRoot.querySelector('#flow-message-input')).toBeNull();
        w.flowView = 'settings';
        w.render();
        expect(w.shadowRoot.querySelector('[data-flow-interval]')).toBeNull();
        expect(w.shadowRoot.querySelector('[data-reading-retry]')).toBeNull();
    });
    test('switching groups restores each unsent draft and attachments', async () => {
        const { w, view } = fixture();
        w.flowDraftText = 'draft one';
        w.flowAttachments = [{ path: '/fixture/a.txt', name: 'a.txt' }];
        w.render();
        w.call = jest.fn(async (method: string, id: string) => {
            if (method === 'getFlow') return { ...w.selectedFlow, id };
            if (method === 'getFlowReadingView') return { ...view, flowId: id };
            return { messages: [], hasMore: false };
        });
        await w.openFlow('flow2');
        w.flowDraftText = 'draft two';
        await w.openFlow('flow1');
        expect(w.flowDraftText).toBe('draft one');
        expect(w.flowAttachments[0].name).toBe('a.txt');
    });

    test('back-to-list navigation saves the draft before clearing selection', async () => {
        const { w } = fixture();
        w.flowDraftText = 'keep through list';
        w.render();
        w.shadowRoot.querySelector('[data-action="back-flow"]').click();
        expect(w.flowDrafts.get('flow1')?.text).toBe('keep through list');
    });

    test('late reading responses cannot overwrite another group', async () => {
        const { w, view } = fixture();
        let resolve!: (value: unknown) => void;
        w.call = () =>
            new Promise((done) => {
                resolve = done;
            });
        const loading = w.loadFlowReading();
        w.selectedFlow = { ...w.selectedFlow, id: 'flow2' };
        resolve(view);
        await loading;
        expect(w.flowReadingView).toBeUndefined();
    });
});
