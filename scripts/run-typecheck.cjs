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
 *
 * 引擎选择（--fast）：tsc 的增量缓存对"被广泛 import 的模块"几乎无效——改一个
 * 被几百个文件依赖的模块，反向依赖闭包≈全量，实测仍要 ~23s；只改叶子文件则
 * ~7s。--fast 在已安装 @typescript/native-preview（TypeScript 7 原生实现，bin
 * 名 tsgo）时改用它：全量 ~3s、热缓存 ~1.4s，都远低于 tsc 的 ~26s / ~7s。
 * 未安装时静默回退 tsc，因此不装该包也能正常工作。两种引擎的 tsbuildinfo
 * 互不兼容，各用各的缓存文件。
 *
 * 默认入口 `npm run typecheck` 走 --fast；需要官方编译器口径时用
 * `npm run typecheck:tsc`（等价于 --tsc），或设置环境变量
 * OPENDESK_TYPECHECK_ENGINE=tsc|tsgo 临时锁定引擎。优先级：--tsc 高于环境变量，
 * 环境变量高于 --fast（CI 靠它在装了 @typescript/native-preview 的机器上强制回
 * 官方 tsc，见 Jenkinsfile 的 build-cli 阶段）。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'typecheck');
const TSGO_ENTRY = path.join(ROOT, 'node_modules', '@typescript', 'native-preview', 'bin', 'tsgo');
const FAST = process.argv.includes('--fast');
const FORCE_TSC = process.argv.includes('--tsc');

function resolveEngine() {
    // 显式 CLI 参数优先：`npm run typecheck:tsc` 不应被遗留的环境变量改成 tsgo
    if (FORCE_TSC) return 'tsc';
    const forced = process.env.OPENDESK_TYPECHECK_ENGINE;
    if (forced === 'tsgo' || forced === 'tsc') return forced;
    if (!FAST) return 'tsc';
    return fs.existsSync(TSGO_ENTRY) ? 'tsgo' : 'tsc';
}

const engine = resolveEngine();
// 缓存文件名分开，两个引擎的 tsbuildinfo 格式不互通
const TSBUILDINFO = path.join(CACHE_DIR, engine === 'tsgo' ? 'tsgo.tsbuildinfo' : 'tsconfig.tsbuildinfo');

fs.mkdirSync(CACHE_DIR, { recursive: true });

const tscEntry = engine === 'tsgo' ? TSGO_ENTRY : require.resolve('typescript/bin/tsc');
const startedAt = Date.now();
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
    console.error(`[typecheck] 无法启动 ${engine}: ${res.error.message}`);
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

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`[typecheck:${engine}] 本项目错误 ${errors.length} 条（不含 node_modules / 测试目录），耗时 ${elapsed}s`);

if (errors.length > 0) {
    console.error('[typecheck] 发现类型错误，请在合入前修复：');
    for (const line of errors) console.error(`  ${line}`);
    process.exit(1);
}
