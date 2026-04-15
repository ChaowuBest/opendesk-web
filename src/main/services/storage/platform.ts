/**
 * 平台判断：是否应使用 WASM 实现
 *
 * 已知需要走 WASM 的平台：
 * - openharmony：无 Node.js 原生模块支持
 * - win32 + arm64：better-sqlite3 / classic-level 无 prebuild，编译工具链缺失
 */
export function shouldUseWasm(): boolean {
    return (process.platform as string) === 'openharmony' || (process.platform === 'win32' && process.arch === 'arm64');
}
