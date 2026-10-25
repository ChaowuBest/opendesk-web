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

export function shouldUseWasm(): boolean {
    return (process.platform as string) === 'openharmony' || (process.platform === 'win32' && process.arch === 'arm64');
}

type Factory<T> = () => Promise<T>;

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
    if (options.forceWasm ?? shouldUseWasm()) {
        logger.info('[storage-backend] using wasm (platform forced)');
        return wasmFactory();
    }

    try {
        const result = await nativeFactory();
        logger.info('[storage-backend] using native');
        return result;
    } catch (error) {
        if (isNativeSqliteUnavailable(error)) {
            const { code, message } = getNativeSqliteErrorDetails(error);
            logger.warn(`[storage-backend] native unavailable, falling back to wasm: code=${code} message=${message}`);
            return wasmFactory();
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
