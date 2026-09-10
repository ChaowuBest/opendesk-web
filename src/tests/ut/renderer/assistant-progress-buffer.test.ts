import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AssistantProgressBuffer } from '../../../renderer/utils/assistant-progress-buffer.js';

const timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const text = (value: string, index = 0) => ({
    type: 'assistant',
    task_id: 'task',
    task_status: 'running',
    message_id: 'message',
    last_part_index: index,
    last_part: { type: 'text', rendered: `<p>${value}</p>` }
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    Object.assign(globalThis, timers);
});

describe('AssistantProgressBuffer', () => {
    test('continuous traffic cannot postpone a fixed-window flush indefinitely', () => {
        const render = jest.fn();
        const buffer = new AssistantProgressBuffer(render);
        for (let i = 0; i < 10; i++) {
            buffer.push(text(String(i)));
            jest.advanceTimersByTime(10);
        }
        expect(render.mock.calls.map(([p]) => p.last_part.rendered)).toEqual(['<p>4</p>', '<p>9</p>']);
        expect(jest.getTimerCount()).toBe(0);
    });

    test.each(['last_part_index', 'message_id', 'task_id'] as const)('flushes before a different %s', (field) => {
        const render = jest.fn();
        const buffer = new AssistantProgressBuffer(render);
        const first = text('first');
        const next = { ...text('next'), [field]: field === 'last_part_index' ? 1 : 'other' };
        buffer.push(first);
        buffer.push(next);
        expect(render.mock.calls.map(([p]) => p)).toEqual([first]);
        jest.advanceTimersByTime(50);
        expect(render.mock.calls.map(([p]) => p)).toEqual([first, next]);
    });

    test.each([
        { ...text('done'), task_status: 'stopped' },
        { ...text('tool'), last_part: { type: 'tool_call', rendered: 'tool' } },
        { ...text('reasoning'), last_part: { type: 'reasoning', rendered: 'reasoning' } },
        { ...text('replace'), type: 'assistant_replace' },
        { ...text('provisional'), provisional: 'implicit_think_close_candidate' },
        { ...text('legacy'), last_part_index: undefined },
        { ...text('invalid'), last_part_index: -1 },
        { ...text('unrendered'), last_part: { type: 'text' } }
    ])('does not delay a boundary or unsupported update: %j', (next) => {
        const render = jest.fn();
        const buffer = new AssistantProgressBuffer(render);
        const first = text('pending');
        buffer.push(first);
        buffer.push(next);
        expect(render.mock.calls.map(([p]) => p)).toEqual([first, next]);
        jest.advanceTimersByTime(100);
        expect(render).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('clearing on reload/unmount discards stale content and allows later use', () => {
        const render = jest.fn();
        const buffer = new AssistantProgressBuffer(render);
        buffer.push(text('stale'));
        buffer.clear();
        jest.advanceTimersByTime(100);
        expect(render).not.toHaveBeenCalled();
        buffer.push(text('fresh'));
        buffer.flush();
        buffer.flush();
        expect(render).toHaveBeenCalledTimes(1);
        expect(render).toHaveBeenCalledWith(text('fresh'));
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a render failure leaves no stale timer or snapshot to replay', () => {
        const render = jest.fn().mockImplementationOnce(() => {
            throw new Error('render failed');
        });
        const buffer = new AssistantProgressBuffer(render);
        buffer.push(text('old'));
        expect(() => buffer.flush()).toThrow('render failed');
        expect(jest.getTimerCount()).toBe(0);
        buffer.push(text('new'));
        jest.advanceTimersByTime(50);
        expect(render).toHaveBeenLastCalledWith(text('new'));
    });
});
