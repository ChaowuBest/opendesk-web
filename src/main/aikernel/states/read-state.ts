export const READ_FILE_STATE_CACHE_MAX_ENTRIES = 100;
export const READ_FILE_STATE_CACHE_MAX_BYTES = 25 * 1024 * 1024;

export interface FileReadState {
    content: string;
    timestamp: number;
    offset?: number;
    limit?: number;
    isPartialView?: boolean;
}

export interface SerializedFileReadStateEntry {
    path: string;
    state: FileReadState;
}

export interface SerializedFileReadStateCache {
    entries: SerializedFileReadStateEntry[];
}

export interface FileReadStateCacheOptions {
    maxEntries?: number;
    maxBytes?: number;
}

interface CacheEntry {
    state: FileReadState;
    bytes: number;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.max(1, Math.floor(value));
}

function normalizeOptionalInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }

    return Math.floor(value);
}

function cloneState(state: FileReadState): FileReadState {
    return {
        content: state.content,
        timestamp: state.timestamp,
        offset: state.offset,
        limit: state.limit,
        isPartialView: state.isPartialView
    };
}

function normalizeState(raw: unknown): FileReadState | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }

    const candidate = raw as {
        content?: unknown;
        timestamp?: unknown;
        offset?: unknown;
        limit?: unknown;
        isPartialView?: unknown;
    };

    if (typeof candidate.content !== 'string') {
        return undefined;
    }

    if (typeof candidate.timestamp !== 'number' || !Number.isFinite(candidate.timestamp)) {
        return undefined;
    }

    const normalized: FileReadState = {
        content: candidate.content,
        timestamp: Math.floor(candidate.timestamp)
    };
    const offset = normalizeOptionalInteger(candidate.offset);
    const limit = normalizeOptionalInteger(candidate.limit);

    if (offset !== undefined) {
        normalized.offset = offset;
    }
    if (limit !== undefined) {
        normalized.limit = limit;
    }
    if (typeof candidate.isPartialView === 'boolean') {
        normalized.isPartialView = candidate.isPartialView;
    }

    return normalized;
}

function getContentBytes(state: FileReadState): number {
    return Buffer.byteLength(state.content, 'utf8');
}

export function normalizeReadStatePath(inputPath: string): string {
    let normalized = inputPath.replace(/\\/g, '/');
    const hasUncPrefix = normalized.startsWith('//');

    normalized = normalized.replace(/\/{2,}/g, '/');
    if (hasUncPrefix && !normalized.startsWith('//')) {
        normalized = `/${normalized}`;
    }

    return normalized.replace(/^([a-zA-Z]):\//, (_, drive: string) => `${drive.toUpperCase()}:/`);
}

export class FileReadStateCache {
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    private entries = new Map<string, CacheEntry>();
    private totalBytes = 0;

    constructor(options: FileReadStateCacheOptions = {}) {
        this.maxEntries = normalizePositiveInteger(options.maxEntries, READ_FILE_STATE_CACHE_MAX_ENTRIES);
        this.maxBytes = normalizePositiveInteger(options.maxBytes, READ_FILE_STATE_CACHE_MAX_BYTES);
    }

    get size(): number {
        return this.entries.size;
    }

    get byteSize(): number {
        return this.totalBytes;
    }

    getMaxEntries(): number {
        return this.maxEntries;
    }

    getMaxBytes(): number {
        return this.maxBytes;
    }

    get(path: string): FileReadState | undefined {
        const key = normalizeReadStatePath(path);
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }

        this.entries.delete(key);
        this.entries.set(key, entry);
        return cloneState(entry.state);
    }

    set(path: string, state: FileReadState): void {
        const key = normalizeReadStatePath(path);
        const normalizedState = normalizeState(state);
        if (!normalizedState) {
            return;
        }

        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= existing.bytes;
            this.entries.delete(key);
        }

        const bytes = getContentBytes(normalizedState);
        this.entries.set(key, {
            state: cloneState(normalizedState),
            bytes
        });
        this.totalBytes += bytes;
        this.evictOverflow();
    }

    has(path: string): boolean {
        return this.entries.has(normalizeReadStatePath(path));
    }

    delete(path: string): boolean {
        const key = normalizeReadStatePath(path);
        const entry = this.entries.get(key);
        if (!entry) {
            return false;
        }

        this.totalBytes -= entry.bytes;
        return this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    toJSON(): SerializedFileReadStateCache {
        return {
            entries: Array.from(this.entries.entries()).map(([path, entry]) => ({
                path,
                state: cloneState(entry.state)
            }))
        };
    }

    static fromJSON(raw: unknown, options: FileReadStateCacheOptions = {}): FileReadStateCache {
        const cache = new FileReadStateCache(options);
        if (!raw || typeof raw !== 'object') {
            return cache;
        }

        const candidate = raw as { entries?: unknown };
        if (!Array.isArray(candidate.entries)) {
            return cache;
        }

        for (const entry of candidate.entries) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }

            const item = entry as { path?: unknown; state?: unknown };
            if (typeof item.path !== 'string') {
                continue;
            }

            const state = normalizeState(item.state);
            if (state) {
                cache.set(item.path, state);
            }
        }

        return cache;
    }

    private evictOverflow(): void {
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const oldestKey = this.entries.keys().next().value as string | undefined;
            if (oldestKey === undefined) {
                return;
            }

            this.delete(oldestKey);
        }
    }
}

export function cloneFileReadStateCache(cache: FileReadStateCache): FileReadStateCache {
    return FileReadStateCache.fromJSON(cache.toJSON(), {
        maxEntries: cache.getMaxEntries(),
        maxBytes: cache.getMaxBytes()
    });
}
