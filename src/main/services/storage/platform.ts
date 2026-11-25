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

/**
 * 平台判断：是否应使用 WASM 实现
 *
 * 已知需要走 WASM 的平台：
 * - openharmony：无 Node.js 原生模块支持
 * - win32 + arm64：better-sqlite3 / classic-level 无 prebuild，编译工具链缺失
 */
import { createRequire } from 'module';
import { logger } from '../../utils/logger.js';
import { getHostRuntime } from '../../../platforms/runtime.js';

export function shouldUseWasm(): boolean {
    const backend = getHostRuntime().sqliteBackend;
    if (backend) return backend === 'wasm';
    return (process.platform as string) === 'openharmony' || (process.platform === 'win32' && process.arch === 'arm64');
}

type Factory<T> = () => Promise<T>;

export interface StorageInitializationCleanup {
    readonly error: unknown;
    close(): void | Promise<void>;
}

export type RetainStorageInitializationCleanup = (cleanup: StorageInitializationCleanup) => void;

// Transfer only cleanup capability to the existing caller; never retain resources globally.
export function handoffStorageInitializationCleanup(
    error: unknown,
    close: StorageInitializationCleanup['close'],
    retain?: RetainStorageInitializationCleanup
): void {
    try {
        retain?.({ error, close });
    } catch (handoffError) {
        recordStorageCleanupFailure(error, handoffError);
    }
}

export interface StorageInitializationFailure {
    indexer?: string;
    backend?: 'native' | 'wasm' | 'arkdata';
    operation?: 'initialize' | 'close' | 'delete';
    cause: unknown;
    cleanupFailures: ReadonlyArray<{ indexer?: string; error: unknown }>;
}

// Keep diagnostic context without replacing (or mutating) the original error.
// Resource ownership and recovery policy stay with their existing callers.
const initializationFailures = new WeakMap<object, StorageInitializationFailure>();

export function getStorageInitializationFailure(error: unknown): Readonly<StorageInitializationFailure> | undefined {
    return error !== null && typeof error === 'object' ? initializationFailures.get(error) : undefined;
}

export function recordStorageInitializationFailure(
    error: unknown,
    source: Pick<StorageInitializationFailure, 'indexer' | 'backend' | 'operation'>
): void {
    if (error === null || typeof error !== 'object') return;
    const previous = initializationFailures.get(error);
    initializationFailures.set(error, {
        cause: (error as { cause?: unknown }).cause ?? error,
        cleanupFailures: previous?.cleanupFailures ?? [],
        ...previous,
        ...source
    });
}

export function recordStorageCleanupFailure(error: unknown, cleanupError: unknown, indexer?: string): void {
    recordStorageInitializationFailure(error, {});
    if (error === null || typeof error !== 'object') return;
    const previous = initializationFailures.get(error)!;
    initializationFailures.set(error, {
        ...previous,
        cleanupFailures: [...previous.cleanupFailures, { indexer, error: cleanupError }]
    });
}

function getNativeSqliteErrorDetails(error: unknown): { code: string; message: string } {
    const err = error as { code?: unknown; message?: unknown } | null | undefined;
    return {
        code: String(err?.code ?? ''),
        message: String(err?.message ?? error ?? '')
    };
}

export class SqliteVecLoadError extends Error {
    constructor(cause: unknown) {
        const { message } = getNativeSqliteErrorDetails(cause);
        // 文案里保留 sqlite-vec：跨 bundle 时 instanceof 可能失效，靠 message 规则兜底。
        super(`Failed to load the sqlite-vec extension: ${message}`, { cause });
        this.name = 'SqliteVecLoadError';
    }
}

export function isNativeSqliteUnavailable(error: unknown): boolean {
    if (error instanceof SqliteVecLoadError) return true;
    const { code, message } = getNativeSqliteErrorDetails(error);
    const lower = message.toLowerCase();

    if (lower.includes('could not locate the bindings file')) return true;
    if (lower.includes('better_sqlite3.node') || lower.includes('better-sqlite3')) return true;
    if (lower.includes('sqlite-vec') || lower.includes('sqlite_vec')) return true;
    if ((code === 'MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED') && lower.includes('sqlite')) return true;
    return false;
}

// 原生与 WASM 实现是同接口的兄弟类而非继承关系，泛型分立后返回联合，
// 由调用方工厂函数以公共接口（如 IBaseIndexDB）收口
export async function createWithNativeSqliteFallback<T, U>(
    nativeFactory: Factory<T>,
    wasmFactory: Factory<U>,
    options: { forceWasm?: boolean } = {}
): Promise<T | U> {
    const createWasm = async () => {
        try {
            return await wasmFactory();
        } catch (error) {
            recordStorageInitializationFailure(error, { backend: 'wasm' });
            throw error;
        }
    };
    if (options.forceWasm ?? shouldUseWasm()) {
        logger.info('[storage-backend] using wasm (platform forced)');
        return createWasm();
    }

    try {
        const result = await nativeFactory();
        logger.info('[storage-backend] using native');
        return result;
    } catch (error) {
        recordStorageInitializationFailure(error, { backend: 'native' });
        if (isNativeSqliteUnavailable(error) && !getStorageInitializationFailure(error)?.cleanupFailures.length) {
            const { code, message } = getNativeSqliteErrorDetails(error);
            logger.warn(`[storage-backend] native unavailable, falling back to wasm: code=${code} message=${message}`);
            return createWasm();
        }
        throw error;
    }
}

export function shouldUseArkData(): boolean {
    return (process.platform as string) === 'openharmony' && process.env.ARKDATA_AVAILABLE === '1';
}

export function resolveSqliteVecExtensionPath(extensionPath: string): string {
    // SQLite loads through the OS, which cannot resolve Electron's virtual ASAR paths.
    return extensionPath.replace(/([/\\])app\.asar([/\\])/, '$1app.asar.unpacked$2');
}

export function loadSqliteVec(db: { loadExtension(extensionPath: string): void }): void {
    try {
        const require = createRequire(import.meta.url);
        const sqliteVec = require('sqlite-vec') as typeof import('sqlite-vec');
        db.loadExtension(resolveSqliteVecExtensionPath(sqliteVec.getLoadablePath()));
    } catch (error) {
        throw new SqliteVecLoadError(error);
    }
}
