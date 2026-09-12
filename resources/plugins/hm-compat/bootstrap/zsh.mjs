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
 * OpenHarmony 开发环境自举（hm-compat 插件的一部分，由 index.mjs 接线）。
 *
 * 安装 Harmonybrew + Python 3.12 + Node（cmd-pkgs 通道）：
 * Python/Node 统一装到 <opendeskDir>/interpreters/cmd-pkgs（顶层 bin/lib
 * 统一结构，install.sh 原生支持多包合并到同一 prefix）；
 * Harmonybrew 装到用户主目录官方默认前缀 /storage/Users/currentUser/.harmonybrew
 * 执行结果写入 <opendeskDir>/ohos-dev-env.json
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { HARMONYBREW_BIN_PATH } from '../environment.mjs';

const HARMONYBREW_INSTALL_URL = 'https://harmonybrew.atomgit.com/install.sh';
const CMD_PKGS_INSTALL_SH_URL = 'https://gitcode.com/OpenHarmonyPCDeveloper/cmd-pkgs/releases/download/pkgs/install.sh';
const PYTHON_VERSION = '3.12.9';
const NODE_VERSION = '24.19.0';

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** shell 单引号转义：嵌入命令字符串的路径/参数统一经过此处包一层 */
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 文件存在且可执行（探测已安装产物的幂等判据） */
function existsExecutable(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function isZshRunnable() {
    const verify = spawnSync('/usr/bin/zsh', ['-c', 'true'], { timeout: 5000 });
    return verify.status === 0 && !verify.error;
}

/** 读取 ~/.zshrc 行数组 */
function readZshrcLines(homeDir) {
    try {
        return fs.readFileSync(path.join(homeDir, '.zshrc'), 'utf8').split('\n');
    } catch {
        return [];
    }
}

/**
 * 经 /bin/sh -c 执行命令（cwd 固定 homeDir：打包版主进程 cwd 为应用沙箱目录，
 * 子进程工具链不可读）。detached + 负 PID 信号确保超时杀掉整个子进程树。
 */
function runShellCommand(homeDir, command, extraEnv) {
    /** 单步超时：探测命令均立即返回，与下载安装统一使用；超时/失败由下次启动幂等重试兜底 */
    const STEP_TIMEOUT_MS = 30 * 60 * 1000;
    return new Promise((resolve, reject) => {
        const proc = spawn('/bin/sh', ['-c', command], {
            cwd: homeDir,
            env: { ...process.env, ...extraEnv },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                process.kill(-proc.pid, 'SIGKILL');
            } catch {
                proc.kill('SIGKILL');
            }
        }, STEP_TIMEOUT_MS);
        proc.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
        proc.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`Command timed out after ${STEP_TIMEOUT_MS}ms: ${command}`));
            } else if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString('utf8');
                const err = new Error(`Command failed with exit code ${code}: ${stderr}`);
                err.code = code;
                reject(err);
            } else {
                resolve({
                    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                    stderr: Buffer.concat(stderrChunks).toString('utf8')
                });
            }
        });
        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

// ── 安装步骤 ────────────────────────────────────────────────────────────────

async function ensureBrew(ctx) {
    if (existsExecutable(HARMONYBREW_BIN_PATH)) {
        return;
    }
    // Harmonybrew 官方要求开发者选项（设置 -> 系统 -> 开发者选项）；
    // 探测失败按未开启处理，本次跳过（下次启动重探）
    let developerMode = '';
    try {
        developerMode = (await ctx.run('param get const.debuggable')).stdout;
    } catch {
        // 命令失败视同未开启
    }
    const lastToken = developerMode.trim().split(/\s+/).pop() ?? '';
    if (lastToken !== '1' && lastToken !== 'true') {
        return;
    }
    // 官方 install.sh，装到主目录默认前缀
    await ctx.run(`zsh -c "$(curl -fsSL ${HARMONYBREW_INSTALL_URL})"`, { NONINTERACTIVE: '1' });
    if (!existsExecutable(HARMONYBREW_BIN_PATH)) {
        throw new Error('harmonybrew install.sh succeeded but brew binary not found');
    }
}

async function installCmdPkg(ctx, name, version, prefix) {
    const beforeLines = readZshrcLines(ctx.homeDir);
    await ctx.run(`curl -fsSL ${CMD_PKGS_INSTALL_SH_URL} | sh -s -- ${name} ${version} ${shellQuote(prefix)}`);
    // install.sh 无条件追加到 ~/.zshrc 的指纹行，只删本次安装新增的，用户已有内容（含旧指纹行）一律保留
    const afterLines = readZshrcLines(ctx.homeDir);
    const fingerprint = 'export PATH="$HOME/usr/local/bin:$PATH"';
    const beforeSet = new Set(beforeLines);
    const cleaned = afterLines.filter((line) => line !== fingerprint || beforeSet.has(line));
    if (cleaned.length !== afterLines.length) {
        fs.writeFileSync(path.join(ctx.homeDir, '.zshrc'), cleaned.join('\n'), 'utf8');
    }
    // install.sh 的 TMP="$HOME/tmp/..." 会残留空的 $HOME/tmp 父目录，为空时顺手删除
    try {
        fs.rmdirSync(path.join(ctx.homeDir, 'tmp'));
    } catch {
        // 目录非空（用户自有用途）或不存在：保留
    }
}

async function ensurePython(ctx) {
    const pythonBin = path.join(ctx.cmdPkgsPrefix, 'bin', 'python3');
    const pythonOk = async () => {
        try {
            return (await ctx.run(`${shellQuote(pythonBin)} --version`)).stdout.trim().startsWith('Python 3.12');
        } catch {
            return false;
        }
    };
    if (!(await pythonOk())) {
        await installCmdPkg(ctx, 'python', PYTHON_VERSION, ctx.cmdPkgsPrefix);
        if (!(await pythonOk())) {
            throw new Error('cmd-pkgs install.sh succeeded but python 3.12 binary not found');
        }
    }
    // pip 安装
    const pipOk = async () => {
        try {
            await ctx.run(`${shellQuote(pythonBin)} -m pip --version`);
            return true;
        } catch {
            return false;
        }
    };
    if (!(await pipOk())) {
        await ctx.run(`${shellQuote(pythonBin)} -m ensurepip --upgrade`);
        if (!(await pipOk())) {
            throw new Error('ensurepip succeeded but pip module still unavailable');
        }
    }
}

async function ensureNode(ctx) {
    const nodeBin = path.join(ctx.cmdPkgsPrefix, 'bin', 'node');
    if (!existsExecutable(nodeBin)) {
        await installCmdPkg(ctx, 'node', NODE_VERSION, ctx.cmdPkgsPrefix);
        if (!existsExecutable(nodeBin)) {
            throw new Error('cmd-pkgs install.sh succeeded but node binary not found');
        }
    }
    // cmd-pkgs 的 node：bin/ 仅含 node 本体，npm 以 lib/node_modules/npm 形态随包分发，
    // 在 node 同目录补建 npm/npx wrapper（显式用 node 绝对路径执行 cli.js，不依赖 PATH 与 symlink）。
    // wrapper 自愈接入点：探测后（覆盖上次引导 node ok 但 wrapper 修复失败的重试）与安装后
    const binDir = path.dirname(nodeBin);
    const npmWrapper = path.join(binDir, 'npm');
    if (!existsExecutable(npmWrapper)) {
        const npmCliJs = path.resolve(binDir, '../lib/node_modules/npm/bin/npm-cli.js');
        if (fs.existsSync(npmCliJs)) {
            // HMDFS 上覆写已有文件会丢失执行权限，先删后写（对齐 install.sh 的处理）
            fs.rmSync(npmWrapper, { force: true });
            fs.writeFileSync(npmWrapper, `#!/bin/sh\nexec "${nodeBin}" "${npmCliJs}" "$@"\n`, 'utf8');
            fs.chmodSync(npmWrapper, 0o770);
        }
        const npxCliJs = path.resolve(binDir, '../lib/node_modules/npm/bin/npx-cli.js');
        if (fs.existsSync(npxCliJs)) {
            const npxWrapper = path.join(binDir, 'npx');
            fs.rmSync(npxWrapper, { force: true });
            fs.writeFileSync(npxWrapper, `#!/bin/sh\nexec "${nodeBin}" "${npxCliJs}" "$@"\n`, 'utf8');
            fs.chmodSync(npxWrapper, 0o770);
        }
    }
}

// ── 引导状态文件（简化版） ──────────────────────────────────────────────────

/** 引导结果记录：各步骤 ok/failed 与失败步骤的报错信息及时间戳（settings.json 同级） */
function writeBootstrapState(opendeskDir, results) {
    try {
        fs.writeFileSync(
            path.join(opendeskDir, 'ohos-dev-env.json'),
            `${JSON.stringify({ steps: results, updatedAt: new Date().toISOString() }, null, 4)}\n`,
            'utf8'
        );
    } catch {
        // 仅作记录用途，写失败不影响引导本身（探测幂等兜底）
    }
}

function bumpDevEnvRevision(env) {
    const current = Number.parseInt(env.OPENDESK_HARMONY_DEV_ENV_REVISION ?? '0', 10);
    const next = String(Number.isFinite(current) ? current + 1 : 1);
    env.OPENDESK_HARMONY_DEV_ENV_REVISION = next;
    process.env.OPENDESK_HARMONY_DEV_ENV_REVISION = next;
}

// ── 引导入口 ────────────────────────────────────────────────────────────────

export async function ensure(options = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'openharmony' || !isZshRunnable()) {
        return {};
    }
    const env = options.env ?? process.env;
    const opendeskDir = options.opendeskDir ?? env.OPENDESK_HARMONY_APP_DATA_DIR ?? null;
    if (!opendeskDir) {
        return;
    }
    /** OpenHarmony 上用户主目录兜底（process.env.HOME 由宿主序列化注入） */
    const DEFAULT_HOME_DIR = '/storage/Users/currentUser';
    const homeDir = options.homeDir ?? env.HOME ?? DEFAULT_HOME_DIR;
    const ctx = {
        homeDir,
        interpretersDir: path.join(opendeskDir, 'interpreters'),
        // python/node 统一安装前缀：cmd-pkgs 顶层 bin/lib 直接作为统一结构，多包经
        // install.sh 合并（tarball 均 flat 结构且无 symlink 成员，合并无冲突）
        cmdPkgsPrefix: path.join(opendeskDir, 'interpreters', 'cmd-pkgs'),
        run: (command, extraEnv) => runShellCommand(homeDir, command, extraEnv)
    };
    const steps = [
        { key: 'harmonybrew', run: ensureBrew },
        { key: 'python', run: ensurePython },
        { key: 'node', run: ensureNode }
    ];
    const results = {};
    for (const step of steps) {
        try {
            await step.run(ctx);
            results[step.key] = { status: 'ok' };
        } catch (err) {
            results[step.key] = {
                status: 'failed',
                error: String(err?.message ?? err),
                at: new Date().toISOString()
            };
        }
        bumpDevEnvRevision(env);
        // 每步落盘：进程中途被杀时已完成步骤的结果不丢失
        writeBootstrapState(opendeskDir, results);
    }
    return results;
}

let bootstrapPromise = null;

/**
 * 同一进程内只执行一轮引导：并发调用共享同一个 promise，等待方（测试、未来需要
 * python/npm 就绪的调用方）await 即可拿到各步骤最终状态（与 ohos-dev-env.json 的
 * steps 同构）；中途进度经每步落盘的状态文件感知。失败后进程内不自动重试——兜底为
 * 下次启动的幂等探测，以及插件 reload 产生的新模块实例重新走 ensure。
 */
export function runBootstrapOnce(options = {}) {
    bootstrapPromise ??= ensure(options);
    return bootstrapPromise;
}
