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

import os from 'os';
import fs from 'fs';
import { getHarmonyHomeDirectory, getHarmonyRuntimeEnvironment } from '../../platforms/bridges/harmonyos/runtime.js';

/**
 * 初始化临时目录。
 * 非 HarmonyOS 平台无需操作；HarmonyOS 使用 ArkTS 提供的应用沙箱临时目录。
 */
export function initTempDir(): void {
    const runtime = getHarmonyRuntimeEnvironment();
    if (!runtime) return;
    fs.mkdirSync(runtime.tempDir, { recursive: true });
}

/**
 * 清理临时目录。
 * HarmonyOS 的 tempDir 由系统管理，应用退出时不得删除该目录本身。
 */
export function closeTempDir(): void {
    // Intentionally empty. Callers still use this hook for other platforms.
}

/**
 * 获取系统临时目录。
 * 非 HarmonyOS 返回 os.tmpdir()；HarmonyOS 返回应用沙箱 Context.tempDir。
 */
export function getTempDir(): string {
    const runtime = getHarmonyRuntimeEnvironment();
    if (!runtime) {
        return os.tmpdir();
    }
    if (!fs.existsSync(runtime.tempDir)) {
        fs.mkdirSync(runtime.tempDir, { recursive: true });
    }
    return runtime.tempDir;
}

/**
 * 获取用户家目录（跨平台）。
 * HarmonyOS PC 返回 userHomeDir；tablet 返回 appDataDir，避免暴露或写入 PC 家目录。
 * 其它平台使用 os.homedir()。
 */
export function getHomeDir(): string {
    const runtime = getHarmonyRuntimeEnvironment();
    if (runtime) {
        return getHarmonyHomeDirectory(runtime);
    }
    return os.homedir();
}

/**
 * 为原子写入生成一次调用内唯一的临时文件路径。
 * 固定临时文件名会让并发写同一目标文件的多个进程/写协程互相覆盖或
 * "偷走"对方的 .tmp（rename 报 ENOENT），甚至把交错写入的残缺内容
 * rename 成正式文件；按调用唯一命名从根上消除该竞态。
 */
export function buildAtomicWriteTmpPath(filePath: string): string {
    return `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

/**
 * 原子写入文件：先写入临时文件，再 rename 覆盖目标文件。
 * 防止进程崩溃时产生残缺/损坏的 JSON 文件。
 *
 * Windows 上并发 rename 同一目标时，目标文件会被另一次 rename 短暂占住，
 * 失败方报 EPERM/EACCES；对这类瞬时锁错误做有界随机退避重试即可收敛，
 * 重试写入的是同一段内容，结果等价于"最后写入者获胜"。
 */
const ATOMIC_WRITE_MAX_RETRIES = 5;
const ATOMIC_WRITE_RETRY_BASE_DELAY_MS = 10;

function isTransientFileLockError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
    for (let attempt = 0; attempt < ATOMIC_WRITE_MAX_RETRIES; attempt++) {
        const tmpPath = buildAtomicWriteTmpPath(filePath);
        try {
            await fs.promises.writeFile(tmpPath, content, 'utf8');
            await fs.promises.rename(tmpPath, filePath);
            return;
        } catch (err) {
            // 写入失败时清理残留临时文件，避免垃圾文件堆积
            await fs.promises.unlink(tmpPath).catch(() => {});
            if (!isTransientFileLockError(err) || attempt === ATOMIC_WRITE_MAX_RETRIES - 1) {
                throw err;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, ATOMIC_WRITE_RETRY_BASE_DELAY_MS * (attempt + 1) + Math.random() * 10)
            );
        }
    }
}

export function atomicWriteFileSync(filePath: string, content: string): void {
    const tmpPath = buildAtomicWriteTmpPath(filePath);
    try {
        fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        } catch {
            /* 清理失败无需处理：临时文件只会成为残留垃圾，不会被误认为任务文件 */
        }
        throw err;
    }
}

/**
 * 获取所有应被视为"临时目录"的路径列表（去重）。
 *
 * 除 getTempDir()（os.tmpdir()）外，还包含系统级临时目录：
 * - macOS: /tmp（符号链接）和 /private/tmp（实际路径）
 * - Linux: /tmp
 * - Windows: 无额外路径（os.tmpdir() 已覆盖 %TEMP%/%TMP%）
 *
 * 用于权限引擎将所有临时目录标记为始终允许。
 */
export function getAllTempDirs(): string[] {
    const dirs: string[] = [getTempDir()];

    if (process.platform === 'darwin') {
        dirs.push('/tmp', '/private/tmp');
    } else if ((process.platform as string) !== 'openharmony' && process.platform !== 'win32') {
        dirs.push('/tmp');
    }

    // 去重（规范化后比较）
    const seen = new Set<string>();
    const result: string[] = [];
    for (const dir of dirs) {
        const norm = dir.replace(/\\/g, '/');
        if (!seen.has(norm)) {
            seen.add(norm);
            result.push(norm);
        }
    }
    return result;
}
