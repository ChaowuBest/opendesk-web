/**
 * 平台判断：是否应使用 WASM 实现
 *
 * 已知需要走 WASM 的平台：
 * - openharmony：无 Node.js 原生模块支持
 * - win32 + arm64：better-sqlite3 / classic-level 无 prebuild，编译工具链缺失
 */
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

export function isNativeSqliteUnavailable(error: unknown): boolean {
    const { code, message } = getNativeSqliteErrorDetails(error);
    const lower = message.toLowerCase();

    if (lower.includes('could not locate the bindings file')) return true;
    if (lower.includes('better_sqlite3.node') || lower.includes('better-sqlite3')) return true;
    if (lower.includes('sqlite-vec') || lower.includes('sqlite_vec')) return true;
    if ((code === 'MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED') && lower.includes('sqlite')) return true;
    return false;
}

export async function createWithNativeSqliteFallback<T>(
    nativeFactory: Factory<T>,
    wasmFactory: Factory<T>,
    options: { forceWasm?: boolean } = {}
): Promise<T> {
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
