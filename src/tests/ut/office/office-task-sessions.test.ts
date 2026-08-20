import { jest } from '@jest/globals';
import { OfficeTaskSessionRegistry } from '../../../main/office/officeTaskSessions.js';

class FakeContents {
    readonly id: number;
    private destroyed = false;
    private readonly destroyedListeners: Array<() => void> = [];

    constructor(id: number) {
        this.id = id;
    }

    isDestroyed(): boolean {
        return this.destroyed;
    }

    once(event: 'destroyed', listener: () => void): void {
        if (event === 'destroyed') this.destroyedListeners.push(listener);
    }

    destroy(): void {
        this.destroyed = true;
        for (const listener of this.destroyedListeners) listener();
    }
}

describe('OfficeTaskSessionRegistry', () => {
    test('routes each task and editor kind to its own web contents', () => {
        const registry = new OfficeTaskSessionRegistry<FakeContents>();
        const first = new FakeContents(11);
        const second = new FakeContents(22);

        registry.bind('slides', 'task-a', '/workspace/a.pptx', first);
        registry.bind('word', 'task-a', '/workspace/a.docx', second);

        expect(registry.get('slides', 'task-a')).toMatchObject({ filePath: '/workspace/a.pptx', contents: first });
        expect(registry.get('word', 'task-a')).toMatchObject({ filePath: '/workspace/a.docx', contents: second });
    });

    test('invalidates replaced and destroyed sessions', () => {
        const registry = new OfficeTaskSessionRegistry<FakeContents>();
        const first = new FakeContents(11);
        const replacement = new FakeContents(12);

        registry.bind('slides', 'task-a', '/workspace/a.pptx', first);
        registry.bind('slides', 'task-a', '/workspace/a-v2.pptx', replacement);
        first.destroy();

        expect(registry.get('slides', 'task-a')).toMatchObject({
            filePath: '/workspace/a-v2.pptx',
            contents: replacement
        });
        replacement.destroy();
        expect(registry.get('slides', 'task-a')).toBeUndefined();
    });

    test('moves one editor session and keeps its current task binding', () => {
        const registry = new OfficeTaskSessionRegistry<FakeContents>();
        const contents = new FakeContents(11);

        registry.bind('slides', 'task-a', '/workspace/a.pptx', contents);
        registry.bind('slides', 'task-b', '/workspace/a.pptx', contents);

        expect(registry.get('slides', 'task-a')).toBeUndefined();
        expect(registry.get('slides', 'task-b')?.contents).toBe(contents);
    });

    test('keeps the current task session when an older editor is rebound later', () => {
        const registry = new OfficeTaskSessionRegistry<FakeContents>();
        const previous = new FakeContents(11);
        const current = new FakeContents(12);

        registry.bind('slides', 'task-a', '/workspace/old.pptx', previous);
        registry.bind('slides', 'task-a', '/workspace/current.pptx', current);
        registry.bind('slides', 'task-b', '/workspace/old.pptx', previous);

        expect(registry.get('slides', 'task-a')?.contents).toBe(current);
        expect(registry.get('slides', 'task-b')?.contents).toBe(previous);
    });

    test('waits for the requested task and file to become bound', async () => {
        jest.useFakeTimers();
        try {
            const registry = new OfficeTaskSessionRegistry<FakeContents>();
            const contents = new FakeContents(11);
            const pending = registry.waitFor('slides', 'task-a', '/workspace/a.pptx', 1_000);

            registry.bind('slides', 'task-b', '/workspace/a.pptx', contents);
            registry.bind('slides', 'task-a', '/workspace/other.pptx', contents);
            registry.bind('slides', 'task-a', '/workspace/a.pptx', contents);

            await expect(pending).resolves.toMatchObject({
                taskId: 'task-a',
                kind: 'slides',
                filePath: '/workspace/a.pptx',
                contents
            });
        } finally {
            jest.useRealTimers();
        }
    });

    test('cancels a pending session wait when the file switch is declined', async () => {
        const registry = new OfficeTaskSessionRegistry<FakeContents>();
        const controller = new AbortController();
        const pending = registry.waitFor('slides', 'task-a', '/workspace/a.pptx', 30_000, controller.signal);

        controller.abort();

        await expect(pending).resolves.toBeUndefined();
    });
});
