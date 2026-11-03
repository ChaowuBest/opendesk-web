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
 * 同步 package.json 版本号到项目中所有硬编码版本位置。
 *
 * npm version 更新 package.json 后会自动运行本脚本（version 生命周期钩子），
 * 也可手动执行：node scripts/sync-version.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 各目标文件中版本号周围的固定文本锚点（捕获组），
 * 替换时保留锚点前缀、仅替换版本号本身，保证只命中目标位置。
 */
export const SYNC_TARGETS = [
    {
        file: 'README.md',
        pattern: /(badge\/版本-)[\d.]+(?=-green)/
    },
    {
        file: 'README_EN.md',
        pattern: /(badge\/Version-)[\d.]+(?=-green)/
    },
    {
        file: 'src/main/applications/agentgate/hook.ts',
        pattern: /(const AGENT_VERSION = ')[\d.]+(?=')/
    },
    {
        file: 'src/main/applications/mailbox/service/worker.js',
        pattern: /(version: ')[\d.]+(?=',)/
    },
    {
        file: 'src/main/utils/version.ts',
        pattern: /(export const OPENDESK_RUNTIME_VERSION = ')[\d.]+(?=')/
    }
];

/**
 * 用新版本替换内容中符合 pattern 的版本号。
 * 要求模式恰好匹配一处，多于或少于一处都抛错，避免误改或静默漏改。
 */
export function replaceVersion(content, pattern, version) {
    const globalRe = new RegExp(pattern.source, `${pattern.flags}g`);
    const count = content.match(globalRe)?.length ?? 0;
    if (count !== 1) {
        throw new Error(`「${pattern}」匹配到 ${count} 处，期望恰好 1 处`);
    }
    return content.replace(pattern, (_, prefix) => `${prefix}${version}`);
}

/** 新版本号来源：此时 package.json 已被 npm version 更新 */
export function resolveNewVersion() {
    return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

function run() {
    const version = resolveNewVersion();
    let changed = 0;
    for (const target of SYNC_TARGETS) {
        const content = readFileSync(target.file, 'utf8');
        const next = replaceVersion(content, target.pattern, version);
        if (next !== content) {
            writeFileSync(target.file, next);
            changed += 1;
            console.log(`  ${target.file} -> v${version}`);
        }
    }
    const message = changed ? `已同步 ${changed} 个文件到 v${version}` : `所有文件均已是 v${version}，无需同步`;
    console.log(message);
}

// 作为模块导入（单元测试）时不执行主流程
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run();
}
