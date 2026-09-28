#!/usr/bin/env node

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
 * 沙箱热路径静态状态守卫 (OpenDesk)
 *
 * 背景：2026-09-27 曾因在 MirrorFs 的 CreateFile 热路径加入非线程安全的
 * 静态 Stopwatch + 静态数组累加插桩（ProfileAdd），导致 Dokan 多线程并发
 * 回调竞争返回 STATUS_INVALID_PARAMETER (0xc000000d)，驱动进入不可恢复的
 * 坏卷状态（挂载成功但卷不可访问，sc stop Dokan2 卡 STOP_PENDING），只能
 * 重启系统恢复。
 *
 * 本脚本扫描沙箱源码：
 * 1. 回调方法（Dokan 驱动的并发派发入口）内禁止出现计时/计数器插桩残留
 *    （Stopwatch、ProfileAdd、静态数组累加等）；
 * 2. 回调方法内禁止写任何非 ConcurrentDictionary 的静态共享可变状态。
 *
 * 运行：node scripts/check-sandbox-hotpath.cjs
 */

const fs = require('fs');
const path = require('path');

const SANDBOX_DIR = path.resolve(process.cwd(), 'native', 'windows', 'sandbox', 'src', 'Dynobox');

// Dokan 回调由驱动多线程并发派发（SingleThread=false），此列表内的方法
// 不得引入任何非线程安全的共享可变状态。
const CALLBACK_METHODS = [
    'CreateFile',
    'GetFileInformation',
    'ReadFile',
    'WriteFile',
    'Cleanup',
    'CloseFile',
    'FindFiles',
    'FindFilesWithPattern',
    'SetFileAttributes',
    'SetFileTime',
    'SetEndOfFile',
    'DeleteFile',
    'DeleteDirectory',
    'MoveFile',
    'FlushFileBuffers'
];

// 已知插桩残留标识符：任何出现即失败（历史事故产物）
const BANNED_IDENTIFIERS = ['ProfileAdd', 'ProfileTicks', '_profileCount', 'ProfileMax', 'Stopwatch'];

// 热路径内禁止写非 ConcurrentDictionary 的静态可变字段
// （static readonly 的字典/不可变类型允许；static 可变数组/标量/Stopwatch 禁止）
const STATIC_MUTABLE_FIELD =
    /private\s+static\s+(?!readonly\s+ConcurrentDictionary)(?!readonly\s+Immutable)[^;]*\b(?:long\[\]|int\[\]|long|int|DateTime|TimeSpan|Stopwatch)\b/;

function scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const errors = [];

    // 注释行过滤：历史事故的说明/警示注释会合法地提及这些标识符（如
    // MirrorFs.cs 的稳定性红线注释），只检查真实代码。
    const isCommentLine = (line) => /^\s*\/\//.test(line) || /^\s*\/\*\*/.test(line) || /^\s*\*/.test(line);

    // 1. 全局禁止的插桩标识符（仅真实代码行）
    for (const ident of BANNED_IDENTIFIERS) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (isCommentLine(lines[i])) continue;
            if (lines[i].includes(ident)) {
                errors.push(
                    `${path.basename(filePath)}:${i + 1}: 发现插桩残留标识符 "${ident}"（热路径静态状态，历史曾致 Dokan 驱动坏卷，必须删除）`
                );
            }
        }
    }

    // 2. 回调方法体内禁止写静态可变字段
    for (const method of CALLBACK_METHODS) {
        const methodRe = new RegExp(`public\\s+(NtStatus|void)\\s+${method}\\s*\\(`);
        let m;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            m = methodRe.exec(lines[i]);
            if (!m) continue;
            // 方法体：统计大括号平衡，直到方法结束
            let depth = 0;
            const bodyStart = i;
            for (let j = i; j < lines.length; j++) {
                depth += (lines[j].match(/\{/g) || []).length;
                depth -= (lines[j].match(/\}/g) || []).length;
                if (depth <= 0 && j > i) {
                    // 方法体 = lines[bodyStart+1 .. j]
                    for (let k = bodyStart + 1; k < j; k++) {
                        const line = lines[k];
                        if (isCommentLine(line)) continue;
                        // 回调体内写静态字段（= / += / ++ 且字段声明是 static 非只读）
                        if (STATIC_MUTABLE_FIELD.test(line)) {
                            errors.push(
                                `${path.basename(filePath)}:${k + 1}: 回调 ${method} 内出现静态可变字段（${line.trim()}）——Dokan 并发回调禁止共享可变状态`
                            );
                        }
                        // 防御性：Stopwatch 出现在回调体内（BANNED 已覆盖，双保险）
                        if (/Stopwatch/.test(line) && !/Log\./.test(line)) {
                            errors.push(
                                `${path.basename(filePath)}:${k + 1}: 回调 ${method} 内出现 Stopwatch（禁止在热路径计时）`
                            );
                        }
                    }
                    break;
                }
            }
        }
    }

    return errors;
}

function main() {
    if (!fs.existsSync(SANDBOX_DIR)) {
        console.error(`沙箱源码目录不存在: ${SANDBOX_DIR}`);
        process.exit(2);
    }
    const allErrors = [];
    for (const f of fs.readdirSync(SANDBOX_DIR)) {
        if (f.endsWith('.cs')) {
            allErrors.push(...scanFile(path.join(SANDBOX_DIR, f)));
        }
    }
    if (allErrors.length > 0) {
        console.error('沙箱热路径静态状态守卫失败：');
        for (const e of allErrors) console.error(`  ✖ ${e}`);
        console.error('\n回调热路径严禁任何非线程安全静态状态（详见 MirrorFs.cs 稳定性红线注释）。');
        process.exit(1);
    }
    console.log('✓ 沙箱热路径静态状态守卫通过（无插桩残留/无回调静态可变状态）');
}

main();
