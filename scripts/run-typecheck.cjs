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
 * 类型检查门禁：运行 `tsc --noEmit`，过滤范围外的噪音后，任何错误都使命令失败。
 *
 * 为什么需要这层包装而不是在 npm script 里直接跑 `tsc --noEmit`：
 * - node_modules 下的第三方包会携带原始 TS 源码（如 @bitclub.ai/opendesk-office
 *   的 dist/vendor，当前有数百条内部错误），tsconfig 的 exclude 只作用于初始
 *   文件集，被 import 拉进来的文件仍会被检查，必须在这里按路径过滤；
 * - 测试目录（src/tests、embedBrowserUse/__tests__）有独立的宽松 ts-jest 配置，
 *   不按主 tsconfig 的口径计入门禁。
 *
 * 历史上这里还有一套"存量基线差集"机制（渐进式采纳 tsc），在存量错误清零后
 * 已移除；如今任何过滤范围之外的类型错误都会直接失败（issue #148 那类
 * "未定义标识符"从此在合入前被拦住）。
 *
 * 增量缓存：--incremental 把各文件的检查结果写入 node_modules/.cache 下的
 * tsbuildinfo，未变更文件（含其依赖闭包）跳过重查。tsc 会校验缓存与文件
 * 内容、tsconfig 选项的一致性，不一致时自动退回全量检查，无需手动失效。
 * 缓存放在 node_modules 下避免入库，npm ci 后首次运行自动重建。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TSBUILDINFO = path.join(ROOT, 'node_modules', '.cache', 'typecheck', 'tsconfig.tsbuildinfo');

fs.mkdirSync(path.dirname(TSBUILDINFO), { recursive: true });

const tscEntry = require.resolve('typescript/bin/tsc');
const res = spawnSync(
    process.execPath,
    [tscEntry, '--noEmit', '--incremental', `--tsBuildInfoFile`, TSBUILDINFO, '--pretty', 'false'],
    {
        cwd: ROOT,
        encoding: 'utf-8',
        maxBuffer: 256 * 1024 * 1024
    }
);
if (res.error) {
    console.error(`[typecheck] 无法启动 tsc: ${res.error.message}`);
    process.exit(2);
}

const rootNorm = ROOT.replace(/\\/g, '/');
const errorRe = /^(.+?)\((\d+),(\d+)\): (error TS\d+): (.*)$/;
const errors = [];
for (const line of `${res.stdout || ''}\n${res.stderr || ''}`.split(/\r?\n/)) {
    const m = errorRe.exec(line.trim());
    if (!m) continue;
    const file = m[1].replace(/\\/g, '/');
    // node_modules（第三方包携带原始 TS 源码）与测试目录不计入门禁，
    // 详见仓库 tsconfig.json 的 exclude
    if (/(^|\/)node_modules\//.test(file)) continue;
    if (file.startsWith('src/tests/') || file.includes('/__tests__/')) continue;
    // 展示用：剔除消息中内嵌的仓库绝对路径，输出与机器无关
    errors.push(line.trim().split(rootNorm).join(''));
}

console.log(`[typecheck] 本项目错误 ${errors.length} 条（不含 node_modules / 测试目录）`);

if (errors.length > 0) {
    console.error('[typecheck] 发现类型错误，请在合入前修复：');
    for (const line of errors) console.error(`  ${line}`);
    process.exit(1);
}
