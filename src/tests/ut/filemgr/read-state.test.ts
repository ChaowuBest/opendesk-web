import {
    FileReadStateCache,
    cloneFileReadStateCache,
    normalizeReadStatePath
} from '../../../main/aikernel/states/read-state';

describe('FileReadStateCache', () => {
    test('normalizes Windows path separators and drive letter', () => {
        expect(normalizeReadStatePath('c:\\repo\\src\\file.ts')).toBe('C:/repo/src/file.ts');
        expect(normalizeReadStatePath('C:/repo//src///file.ts')).toBe('C:/repo/src/file.ts');
        expect(normalizeReadStatePath('C:/Repo/File.ts')).toBe('C:/Repo/File.ts');
    });

    test('same path with different separators hits the same key', () => {
        const cache = new FileReadStateCache();
        const state = {
            content: 'hello',
            timestamp: 123,
            offset: 1,
            limit: 10,
            isPartialView: false
        };

        cache.set('c:\\repo\\file.ts', state);

        expect(cache.has('C:/repo/file.ts')).toBe(true);
        expect(cache.get('C:/repo/file.ts')).toEqual(state);
    });

    test('get refreshes LRU order', () => {
        const cache = new FileReadStateCache({ maxEntries: 2 });

        cache.set('C:/repo/a.ts', { content: 'a', timestamp: 1 });
        cache.set('C:/repo/b.ts', { content: 'b', timestamp: 2 });
        expect(cache.get('C:/repo/a.ts')).toEqual({ content: 'a', timestamp: 1 });
        cache.set('C:/repo/c.ts', { content: 'c', timestamp: 3 });

        expect(cache.has('C:/repo/a.ts')).toBe(true);
        expect(cache.has('C:/repo/b.ts')).toBe(false);
        expect(cache.has('C:/repo/c.ts')).toBe(true);
    });

    test('evicts least recently used entry when max entries is exceeded', () => {
        const cache = new FileReadStateCache({ maxEntries: 2 });

        cache.set('C:/repo/a.ts', { content: 'a', timestamp: 1 });
        cache.set('C:/repo/b.ts', { content: 'b', timestamp: 2 });
        cache.set('C:/repo/c.ts', { content: 'c', timestamp: 3 });

        expect(cache.size).toBe(2);
        expect(cache.has('C:/repo/a.ts')).toBe(false);
        expect(cache.has('C:/repo/b.ts')).toBe(true);
        expect(cache.has('C:/repo/c.ts')).toBe(true);
    });

    test('evicts least recently used entries when max bytes is exceeded', () => {
        const cache = new FileReadStateCache({ maxBytes: 5 });

        cache.set('C:/repo/a.ts', { content: 'abc', timestamp: 1 });
        cache.set('C:/repo/b.ts', { content: 'de', timestamp: 2 });
        cache.set('C:/repo/c.ts', { content: '三', timestamp: 3 });

        expect(cache.byteSize).toBe(5);
        expect(cache.has('C:/repo/a.ts')).toBe(false);
        expect(cache.has('C:/repo/b.ts')).toBe(true);
        expect(cache.has('C:/repo/c.ts')).toBe(true);
    });

    test('toJSON and fromJSON preserve read state fields', () => {
        const cache = new FileReadStateCache();
        const state = {
            content: 'line 1\nline 2',
            timestamp: 456,
            offset: 2,
            limit: 3,
            isPartialView: true
        };

        cache.set('c:\\repo\\file.ts', state);
        const restored = FileReadStateCache.fromJSON(cache.toJSON());

        expect(restored.get('C:/repo/file.ts')).toEqual(state);
    });

    test('clone creates an independent cache with the same state', () => {
        const cache = new FileReadStateCache({ maxEntries: 3, maxBytes: 20 });
        cache.set('C:/repo/a.ts', { content: 'a', timestamp: 1, offset: 1 });

        const cloned = cloneFileReadStateCache(cache);
        cloned.set('C:/repo/b.ts', { content: 'b', timestamp: 2 });

        expect(cloned.get('C:/repo/a.ts')).toEqual({ content: 'a', timestamp: 1, offset: 1 });
        expect(cache.has('C:/repo/b.ts')).toBe(false);
        expect(cloned.getMaxEntries()).toBe(3);
        expect(cloned.getMaxBytes()).toBe(20);
    });

    test('delete and clear update cache size and byte count', () => {
        const cache = new FileReadStateCache();

        cache.set('C:/repo/a.ts', { content: 'abc', timestamp: 1 });
        cache.set('C:/repo/b.ts', { content: 'de', timestamp: 2 });

        expect(cache.delete('C:/repo/a.ts')).toBe(true);
        expect(cache.byteSize).toBe(2);
        expect(cache.delete('C:/repo/missing.ts')).toBe(false);

        cache.clear();

        expect(cache.size).toBe(0);
        expect(cache.byteSize).toBe(0);
    });
});
