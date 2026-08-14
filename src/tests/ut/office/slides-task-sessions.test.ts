import { SlidesTaskSessionRegistry } from '../../../main/office/slidesTaskSessions.js';

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

describe('SlidesTaskSessionRegistry', () => {
    test('routes each task to its own slides web contents', () => {
        const registry = new SlidesTaskSessionRegistry<FakeContents>();
        const first = new FakeContents(11);
        const second = new FakeContents(22);

        registry.bind('task-a', '/workspace/a.pptx', first);
        registry.bind('task-b', '/workspace/b.pptx', second);

        expect(registry.get('task-a')).toMatchObject({ filePath: '/workspace/a.pptx', contents: first });
        expect(registry.get('task-b')).toMatchObject({ filePath: '/workspace/b.pptx', contents: second });
    });

    test('invalidates replaced and destroyed sessions', () => {
        const registry = new SlidesTaskSessionRegistry<FakeContents>();
        const first = new FakeContents(11);
        const replacement = new FakeContents(12);

        registry.bind('task-a', '/workspace/a.pptx', first);
        registry.bind('task-a', '/workspace/a-v2.pptx', replacement);
        first.destroy();

        expect(registry.get('task-a')).toMatchObject({ filePath: '/workspace/a-v2.pptx', contents: replacement });
        replacement.destroy();
        expect(registry.get('task-a')).toBeUndefined();
    });

    test('moves one editor session and keeps its current task binding', () => {
        const registry = new SlidesTaskSessionRegistry<FakeContents>();
        const contents = new FakeContents(11);

        registry.bind('task-a', '/workspace/a.pptx', contents);
        registry.bind('task-b', '/workspace/a.pptx', contents);

        expect(registry.get('task-a')).toBeUndefined();
        expect(registry.get('task-b')?.contents).toBe(contents);
    });

    test('keeps the current task session when an older editor is rebound later', () => {
        const registry = new SlidesTaskSessionRegistry<FakeContents>();
        const previous = new FakeContents(11);
        const current = new FakeContents(12);

        registry.bind('task-a', '/workspace/old.pptx', previous);
        registry.bind('task-a', '/workspace/current.pptx', current);
        registry.bind('task-b', '/workspace/old.pptx', previous);

        expect(registry.get('task-a')?.contents).toBe(current);
        expect(registry.get('task-b')?.contents).toBe(previous);
    });
});
