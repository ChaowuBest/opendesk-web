import { describe, expect, test } from '@jest/globals';
import { BrowserAutoRevealState } from '../../../renderer/browserAutoRevealState.js';

class MemoryStorage {
    private readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
}

describe('browser auto reveal state', () => {
    test('allows automatic layout activation only once per task', () => {
        const storage = new MemoryStorage();
        const state = new BrowserAutoRevealState();

        expect(state.consume('task-1', storage)).toBe(true);
        expect(state.consume('task-1', storage)).toBe(false);
        expect(state.consume('task-2', storage)).toBe(true);
    });

    test('persists the consumed state across renderer state recreation', () => {
        const storage = new MemoryStorage();
        const initialState = new BrowserAutoRevealState();

        expect(initialState.consume('task-1', storage)).toBe(true);

        const recreatedState = new BrowserAutoRevealState();
        expect(recreatedState.consume('task-1', storage)).toBe(false);
    });

    test('falls back to process memory when storage is unavailable', () => {
        const unavailableStorage = {
            getItem: () => {
                throw new Error('storage unavailable');
            },
            setItem: () => {
                throw new Error('storage unavailable');
            }
        };
        const state = new BrowserAutoRevealState();

        expect(state.consume('task-1', unavailableStorage)).toBe(true);
        expect(state.consume('task-1', unavailableStorage)).toBe(false);
    });

    test('does not consume an unidentified task', () => {
        const storage = new MemoryStorage();
        const state = new BrowserAutoRevealState();

        expect(state.consume('', storage)).toBe(false);
    });
});
