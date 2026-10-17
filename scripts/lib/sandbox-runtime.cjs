/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

// Windows 沙箱开发态 runtime 的锁定文件替换工具。
//
// 背景：在 OpenDesk 沙箱内启动调试实例（OPENDESK_DEBUG_MODE=1 + npm run start）
// 时，npm run start 会执行 build-sandbox:windows 更新 runtime/sandbox.exe，而
// 这个 exe 正是当前沙箱进程自身——Windows 的映像映射把运行中的可执行文件锁成
// "禁止覆写、但允许改名腾位"。此时直接 copyFileSync 必然 EBUSY/EPERM，构建
// 中断，调试实例永远起不来。本模块用"改名腾位 + 重试复制"解决：旧映像改名
// 为 <name>.stale-<pid>-<n> 继续被运行中进程映射，新产物落到原路径；遗留的
// stale 文件在旧进程退出后由下次构建清扫。

const fs = require('node:fs');
const path = require('node:path');

const LOCK_ERROR_CODES = ['EBUSY', 'EPERM', 'EACCES'];

/** stale 后缀计数器：同一构建内替换多个文件时避免后缀撞名 */
let staleCounter = 0;

/** 带一次立即重试的改名（对抗杀毒/索引器对文件的瞬时握持） */
function renameWithRetry(source, target) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.renameSync(source, target);
            return;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

/**
 * 把 source 复制为 target；target 被锁定（运行中映像/外部句柄）时改名腾位后
 * 重试。腾位成功返回 true（调用方可提示存在待清扫的 stale 文件），直接覆盖或
 * 首次即成功返回 false。
 *
 * 腾位成功但重试复制失败时回滚（旧文件改名回原位），保证目录不处于"目标缺失"
 * 的损坏状态。Windows 映像语义下回滚几乎不会失败（改名合法、新建同名合法），
 * 仅外部句柄全锁场景可能失手，此时旧文件留在 stale 路径、下次构建清扫。
 */
function replaceLockedFile(source, target) {
    if (!fs.existsSync(target)) {
        fs.copyFileSync(source, target);
        return false;
    }
    try {
        fs.copyFileSync(source, target);
        return false;
    } catch (error) {
        if (!LOCK_ERROR_CODES.includes(error?.code)) throw error;
    }
    const staleTarget = `${target}.stale-${process.pid}-${staleCounter++}`;
    try {
        renameWithRetry(target, staleTarget);
    } catch (renameError) {
        const hint =
            process.platform === 'win32'
                ? `Cannot update the development sandbox because ${target} is in use and cannot be renamed aside ` +
                  '(locked by antivirus, indexer, or another sandbox instance). ' +
                  'Stop the running sandbox process and retry the build.'
                : `Cannot update ${target}: ${renameError?.message ?? renameError}`;
        const wrapped = new Error(hint);
        wrapped.cause = renameError;
        throw wrapped;
    }
    try {
        fs.copyFileSync(source, target);
        return true;
    } catch (copyError) {
        try {
            fs.renameSync(staleTarget, target);
        } catch {
            // 回滚失败：目标暂缺，旧文件留在 stale 路径由下次构建清扫
        }
        throw copyError;
    }
}

/**
 * 清扫目录下 <names>.stale-* 形式的遗留文件（旧 runtime 已退出的场景）。
 * 仍被运行中进程映射的文件删除失败时静默跳过，留给下次构建。同名目录不删。
 */
function cleanupStaleReplaced(directory, ...names) {
    let entries;
    try {
        entries = fs.readdirSync(directory);
    } catch {
        return;
    }
    const prefixes = names.map((name) => `${name}.stale-`);
    for (const entry of entries) {
        if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
        const candidate = path.join(directory, entry);
        try {
            if (fs.statSync(candidate).isFile()) {
                fs.rmSync(candidate, { force: true });
            }
        } catch {
            // 旧 runtime 仍被运行中沙箱映射：无法删除，留给下次清扫
        }
    }
}

module.exports = { replaceLockedFile, cleanupStaleReplaced };
