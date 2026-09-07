import { describe, expect, test } from '@jest/globals';
import { BrowserAutoRevealState } from '../../../renderer/browserAutoRevealState.js';

describe('browser auto reveal state', () => {
    test('allows automatic layout activation only once per task within a session', () => {
        const state = new BrowserAutoRevealState();

        expect(state.consume('task-1')).toBe(true);
        expect(state.consume('task-1')).toBe(false);
        expect(state.consume('task-2')).toBe(true);
    });

    test('re-grants the reveal opportunity to a new session after OpenDesk restarts', () => {
        const firstSession = new BrowserAutoRevealState();
        expect(firstSession.consume('task-1')).toBe(true);

        // 重启后 renderer 重新创建状态实例：不持久化历史，机会重新可用。
        const restartedSession = new BrowserAutoRevealState();
        expect(restartedSession.consume('task-1')).toBe(true);
    });

    test('applies a pending reveal exactly once when the task becomes visible', () => {
        const state = new BrowserAutoRevealState();

        expect(state.takePendingReveal('task-1')).toBe(false);
        state.markPendingReveal('task-1');
        expect(state.takePendingReveal('task-1')).toBe(true);
        expect(state.takePendingReveal('task-1')).toBe(false);
    });

    test('keeps pending reveal scoped to its own task', () => {
        const state = new BrowserAutoRevealState();

        state.markPendingReveal('task-1');
        expect(state.takePendingReveal('task-2')).toBe(false);
        expect(state.takePendingReveal('task-1')).toBe(true);
    });

    test('discards a pending reveal when the browser is fully destroyed', () => {
        const state = new BrowserAutoRevealState();

        state.markPendingReveal('task-1');
        state.clearPendingReveal('task-1');
        expect(state.takePendingReveal('task-1')).toBe(false);
    });

    test('pending reveal survives across sessions but claim does not re-consume it', () => {
        // pending 是运行中的任务状态（跟随进程），claim 是会话机会（重启即重置）。
        const state = new BrowserAutoRevealState();
        state.markPendingReveal('task-1');
        expect(state.consume('task-1')).toBe(true);
        expect(state.consume('task-1')).toBe(false);
        expect(state.takePendingReveal('task-1')).toBe(true);
    });

    test('ignores unidentified tasks', () => {
        const state = new BrowserAutoRevealState();

        expect(state.consume('')).toBe(false);
        state.markPendingReveal('');
        expect(state.takePendingReveal('')).toBe(false);
        state.clearPendingReveal('');
    });
});
