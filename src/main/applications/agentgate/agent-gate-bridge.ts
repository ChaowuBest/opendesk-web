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
 * AgentGate Bridge — 在 OpenDesk 主进程中管理 AgentGate + AgentMoss 服务生命周期。
 *
 * 工作原理:
 *   1. app.whenReady() 时 spawn 两个 node 子进程
 *   2. 注入 OpenDesk 的 LLM 配置给 AgentMoss
 *   3. app.will-quit() 时关闭两个子进程
 *   4. 子进程异常退出时自动重启（最多 3 次）
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import fs from 'fs';
import type { Setting } from '../../utils/setting';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { findExecutableInPath, mergeGlobalEnviron, asyncShellExec } from '../../utils/shellExec.js';
import { getOpenDeskAppHost } from '../../../../packages/app-sdk/src/index.js';
import { logger } from '../../utils/logger.js';
import { electron } from '../../../utils/electron.js';
import { t } from '../../../locale/index.js';
import {
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyLocalRuntimeState,
    type HarmonyLocalRuntimeFeatureAvailability
} from '../../../platforms/bridges/harmonyos/local-runtime.js';

const PORT_MOSS_START = 9090;
const PORT_GATE_START = 9100;
const MAX_RESTART = 3;
const EXTENSIONS_DIR_NAME = 'extensions';

/** 获取 extensions 目录路径（AgentGate 服务加载插件 CLI bundle 用） */
function getExtensionsDir(): string {
    const dir = path.join(getOpendeskDirectory(), EXTENSIONS_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

interface ServiceState {
    process: ChildProcess | null;
    restartCount: number;
    port: number;
    bundlePath: string;
    name: string;
}

interface BridgeStatus {
    available: boolean;
    unavailableReason: HarmonyLocalRuntimeFeatureAvailability['reason'];
    missingRuntimes: HarmonyLocalRuntimeFeatureAvailability['missing'];
    running: boolean;
    lastError: string | null;
    mossPort: number;
    gatePort: number;
    mossRunning: boolean;
    gateRunning: boolean;
    llmAvailable: boolean;
}

function getLocalRuntimeUnavailableMessage(availability: HarmonyLocalRuntimeFeatureAvailability): string {
    return availability.reason === 'tablet-local-runtime-disabled'
        ? t('harmony.localRuntime.tabletUnavailable')
        : t('harmony.localRuntime.pcMissing', { capabilities: availability.missing.join(', ') });
}

class AgentGateBridge {
    private static instance: AgentGateBridge | null = null;
    private _running = false;
    /** 最近一次启动/运行错误，供 UI 显示 */
    private _lastError: string | null = null;
    /** 待执行的重启定时器（stop 时全部清除，防止进程退出后的延迟重启绕过 enabled 检查） */
    private _restartTimers: ReturnType<typeof setTimeout>[] = [];

    private mossState: ServiceState = {
        process: null,
        restartCount: 0,
        port: 0, // auto-assigned
        bundlePath: '',
        name: 'agent-moss'
    };

    private gateState: ServiceState = {
        process: null,
        restartCount: 0,
        port: 0, // auto-assigned
        bundlePath: '',
        name: 'agent-gate'
    };

    /** LLM 是否已配置（启动时检测 API key 是否有效） */
    private _llmConfigured = false;
    /** agent-moss HTTP 健康状态缓存（运行时实时探测） */
    private _mossHealthy: boolean | null = null;
    private _lastMossHealthCheck = 0;

    static getInstance(): AgentGateBridge {
        if (!AgentGateBridge.instance) {
            AgentGateBridge.instance = new AgentGateBridge();
        }
        return AgentGateBridge.instance;
    }

    /** 供 renderer 查询 Bridge 运行状态与最近错误 */
    getStatus(): BridgeStatus {
        const availability = getHarmonyLocalRuntimeFeatureAvailability('agentgate');
        const mossRunning = !!this.mossState.process && !this.mossState.process.killed;
        const gateRunning = !!this.gateState.process && !this.gateState.process.killed;
        // 实时探测 agent-moss HTTP 健康状态（缓存 10 秒）
        const now = Date.now();
        if (mossRunning && now - this._lastMossHealthCheck > 10000) {
            this._lastMossHealthCheck = now;
            this._probeMossHealth();
        }
        // 🟢 绿 = agent-gate 运行正常；🟡 黄 = gate 运行但 agent-moss 不健康；🔴 红 = gate 挂了
        const llmAvailable = !gateRunning ? false : mossRunning ? this._mossHealthy !== false : true;
        return {
            available: availability.available,
            unavailableReason: availability.reason,
            missingRuntimes: availability.missing,
            running: this._running,
            lastError: availability.available ? this._lastError : getLocalRuntimeUnavailableMessage(availability),
            mossPort: this.mossState.port,
            gatePort: this.gateState.port,
            mossRunning,
            gateRunning,
            llmAvailable
        };
    }

    setLocalRuntimeUnavailable(availability: HarmonyLocalRuntimeFeatureAvailability): void {
        if (availability.available) return;
        this._running = false;
        this._lastError = getLocalRuntimeUnavailableMessage(availability);
    }

    /** 异步探测 agent-moss HTTP 健康端点，更新缓存 */
    private async _probeMossHealth(): Promise<void> {
        try {
            const port = this.mossState.port;
            if (!port) return;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
                signal: controller.signal
            });
            clearTimeout(timer);
            this._mossHealthy = res.ok;
        } catch {
            this._mossHealthy = false;
        }
    }

    /** 获取 AgentGate 的存储目录（BaseApplication.getDataDirectory + storage 子目录） */
    getAgentGateDataDir(): string {
        const base = getOpenDeskAppHost()?.getDataDirectory?.('agentgate') ?? '';
        return path.join(base, 'storage');
    }

    /**
     * 解析应用根目录（node_modules 所在位置）。
     * 打包环境下 app.getAppPath() 返回 app 资源目录；
     * CLI 模式下回退到 process.cwd()（项目根目录）。
     */
    private getProjectRoot(): string {
        // 1. Electron 打包环境：app.getAppPath() 返回 app 资源目录
        try {
            const { app } = electron();
            const appPath = app?.getAppPath?.();
            if (appPath) {
                const resolved = path.resolve(appPath);
                if (fs.existsSync(path.join(resolved, 'node_modules'))) {
                    return resolved;
                }
            }
        } catch {
            /* CLI 模式或 worker 线程中 electron 不可用 */
        }
        // 2. import.meta.dirname 回退：编译产物位于 dist/main/ 下，
        //    上溯 1 级即 app 根目录（打包和 CLI 开发模式均适用）
        try {
            const rootFromDirname = path.resolve(import.meta.dirname, '..');
            if (fs.existsSync(path.join(rootFromDirname, 'node_modules'))) {
                return rootFromDirname;
            }
        } catch {
            /* import.meta.dirname 不可用 */
        }
        // 3. CLI 模式：process.cwd() 是项目根目录
        return path.resolve(process.cwd());
    }

    /**
     * 解析 npm 包 bundle 路径。
     * 优先从插件目录（~/.opendesk/extensions/node_modules/）加载，
     * 回退到项目 node_modules/（本地开发 npm link 场景）。
     */
    private resolveBundle(packageName: string): string {
        // CLI 产物路径：agent-gate 用 dist/v1/cli.js（V1 薄包装，只复用 createApp + server，
        // 不打包 node-pty/proxy/gateway/pty 模块；OpenDesk 只需 HTTP server，对接 V1 即够，
        // 也让鸿蒙等无 C++ 工具链平台离线安装时依赖树彻底不含 node-pty）。
        // agent-moss 在 dist/cli.js。
        const cliRel = packageName === '@kenhkl/agent-gate' ? 'dist/v1/cli.js' : 'dist/cli.js';
        // 1. 项目 node_modules（预装依赖，优先）
        const localBundle = path.resolve(this.getProjectRoot(), 'node_modules', packageName, cliRel);
        if (fs.existsSync(localBundle)) return localBundle;

        // 2. 旧版 extensions 目录（兼容历史安装）
        const extBundle = path.join(getExtensionsDir(), 'node_modules', packageName, cliRel);
        if (fs.existsSync(extBundle)) return extBundle;

        return localBundle; // 返回预装路径，不存在时 start() 会预装校验报错
    }

    /**
     * 尝试编译 better-sqlite3 native binding（使 sqlite 存储模式可用）。
     * --ignore-scripts 安装跳过了 native binding 编译，需要手动执行。
     * 编译成功：sqlite 可用；编译失败：回退 json。
     * 鸿蒙平台不支持 native module 编译，直接跳过。
     */
    /**
     * 查找预装位置（node_modules）的 better-sqlite3 目录候选。
     * 候选：① agent-gate 子包自带的（@kenhkl/agent-gate/node_modules/better-sqlite3）
     *       ② npm hoist 到根的（node_modules/better-sqlite3）
     */
    private _findSqliteDirs(): string[] {
        const projectRoot = this.getProjectRoot();
        return [
            path.join(projectRoot, 'node_modules', '@kenhkl', 'agent-gate', 'node_modules', 'better-sqlite3'),
            path.join(projectRoot, 'node_modules', 'better-sqlite3')
        ];
    }

    /**
     * 同步判定 SQLite 是否可用 —— 供 UI（app.ts#checkSqliteAvailable）查询。
     *
     * 与子进程实际加载行为保持一致：搜索 _findSqliteDirs() 的候选路径，找到
     * better-sqlite3 包后判 native binding 是否就绪。binding 可能落在三个位置：
     *   1. prebuilds/                     — prebuild-install 下载的预编译二进制
     *   2. build/Release/better_sqlite3.node — node-gyp 编译产物
     *   3. lib/binding/node-v{abi}-{platform}-{arch}/better_sqlite3.node
     *      — OpenDesk setup-native-modules.cjs 的 dual-ABI 方案：postinstall 把
     *        系统 node 与 Electron 两个 ABI 的 binding 分别存到 lib/binding/ 下，
     *        再删掉 build/Release/，运行时由 bindings 库按 process.versions.modules
     *        自动选对应 ABI。故 build/Release/ 在 OpenDesk 下恒为空，必须查 lib/binding/。
     * 鸿蒙不支持 native module 编译，永远返回 false（走 JSON）。
     *
     * 注：此方法只做"文件存在性"快速判定，不 spawn 子进程探测 ABI 兼容性
     * （ABI 探测仅在 start() 启动时做一次并按需重新编译）。
     * 如果 binding 文件在但 ABI 不匹配，子进程启动时会自行暴露错误并触发回退，
     * 此处保守返回 true 让 UI 不误判。
     */
    isSqliteAvailable(): boolean {
        if ((process.platform as string) === 'openharmony') {
            return false;
        }
        const sqliteDir = this._findSqliteDirs().find((d) => fs.existsSync(path.join(d, 'package.json')));
        if (!sqliteDir) return false;
        // 1/2: prebuilds 或 build/Release 编译产物
        if (
            fs.existsSync(path.join(sqliteDir, 'prebuilds')) ||
            fs.existsSync(path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node'))
        ) {
            return true;
        }
        // 3: OpenDesk dual-ABI 方案 — lib/binding/node-v{abi}-{platform}-{arch}/
        // process.versions.modules 是当前进程的 node ABI；子进程用系统 node，
        // bridge resolveNodeCommand 找的就是系统 node，ABI 一致，故此处用当前 ABI 判定正确。
        const abiBinding = path.join(
            sqliteDir,
            'lib',
            'binding',
            `node-v${process.versions.modules}-${process.platform}-${process.arch}`,
            'better_sqlite3.node'
        );
        return fs.existsSync(abiBinding);
    }

    /**
     * 检测 better-sqlite3 的 native binding 是否存在且 ABI 兼容子进程将使用的系统 node。
     * 实现：spawn 子进程尝试 `require('better-sqlite3')` 并打开一个 :memory: db。
     * 子进程 exit 0 视为兼容；非 0（含 ABI 不匹配的 ERR_DLOPEN_FAILED）视为不兼容。
     *
     * 不能在主进程内直接 require 探测——主进程加载了 canvas，旧 libstdc++.so.6 缺
     * GLIBCXX_3.4.29 会劫持动态链接器，better-sqlite3 dlopen 失败（误报 ABI 不兼容）。
     * spawn 干净的子进程探测才能真实反映子进程运行时的可用性。
     */
    private async _checkSqliteAbiCompatible(sqliteDir: string): Promise<boolean> {
        // 鸿蒙不支持 native binding，永远返回 false（走 json）
        if ((process.platform as string) === 'openharmony') {
            return false;
        }
        // 文件都不在，肯定不兼容
        const bindingPath = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
        if (!fs.existsSync(bindingPath)) {
            return false;
        }
        const nodeCmd = this.resolveNodeCommand();
        if (!nodeCmd) {
            // 找不到 node 无法探测，保守起见返回 true（让子进程启动时自行暴露错误）
            return true;
        }
        // 子进程内尝试加载 binding 并开关 :memory: db
        // 注意：better-sqlite3 用 bindings 库按 NODE_MODULE_VERSION 解析，ABI 不匹配会抛
        // ERR_DLOPEN_FAILED，被我们 catch 后 exit 1
        const probeScript = `try {
            const D = require('${sqliteDir.replace(/'/g, "\\'")}');
            const db = new D(':memory:');
            db.exec('CREATE TABLE t(x INTEGER)');
            db.close();
            process.exit(0);
        } catch (e) {
            process.stderr.write(String(e && e.message || e));
            process.exit(1);
        }`;
        return new Promise((resolve) => {
            try {
                const child = spawn(nodeCmd.nodePath, ['-e', probeScript], {
                    env: { ...process.env, ...nodeCmd.env },
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                let stderr = '';
                child.stderr.on('data', (chunk: Buffer) => {
                    stderr += chunk.toString();
                });
                child.on('error', () => resolve(false));
                child.on('exit', (code: number | null) => {
                    if (code === 0) {
                        resolve(true);
                    } else {
                        logger.info(
                            `[AgentGateBridge] better-sqlite3 ABI incompatible with ${nodeCmd.nodePath}: ${stderr.trim().slice(0, 200)}`
                        );
                        resolve(false);
                    }
                });
            } catch {
                resolve(false);
            }
        });
    }

    private async tryBuildSqliteNative(sqliteDir: string): Promise<void> {
        // 鸿蒙平台不支持 native module 编译（无 C++ 工具链、ABI 不同），直接跳过
        if ((process.platform as string) === 'openharmony') {
            logger.info(
                '[AgentGateBridge] Skipping better-sqlite3 build on OpenHarmony (no native toolchain), using JSON storage'
            );
            return;
        }
        if (!fs.existsSync(path.join(sqliteDir, 'package.json'))) {
            logger.warn(`[AgentGateBridge] better-sqlite3 not found at ${sqliteDir}, using JSON storage`);
            return;
        }

        // 尝试编译 native binding
        // agent-gate 子进程使用系统 node 运行（不是 Electron），所以必须为系统 node ABI 编译
        // 先尝试 prebuild-install（下载预编译二进制），失败则 node-gyp rebuild

        // 获取 agent-gate 子进程实际使用的 node 版本号
        let nodeVersion = '';
        try {
            const nodeCmd = this.resolveNodeCommand();
            if (nodeCmd) {
                const result = execSync(`${nodeCmd.nodePath} --version`, { encoding: 'utf-8', timeout: 5000 });
                nodeVersion = result.trim().replace(/^v/, '');
            }
        } catch {}
        if (!nodeVersion) {
            nodeVersion = process.versions.node; // fallback: 使用当前进程的 node 版本
        }
        logger.info(`[AgentGateBridge] Building better-sqlite3 for Node.js ${nodeVersion} (agent-gate subprocess)...`);

        try {
            await asyncShellExec(
                `npx --yes prebuild-install --runtime node --target ${nodeVersion} --arch ${process.arch} --force`,
                { cwd: sqliteDir, timeout: 60000, env: {} }
            );
            logger.info('[AgentGateBridge] better-sqlite3 native binding built successfully, sqlite storage available');
        } catch (prebuildErr: any) {
            // prebuild-install 失败（没有预编译二进制），尝试 node-gyp rebuild
            logger.info(`[AgentGateBridge] prebuild-install failed, trying node-gyp rebuild...`);
            try {
                await asyncShellExec(`npx --yes node-gyp rebuild`, { cwd: sqliteDir, timeout: 120000, env: {} });
                logger.info(
                    '[AgentGateBridge] better-sqlite3 native binding built successfully (node-gyp), sqlite storage available'
                );
            } catch (gypErr: any) {
                logger.warn(
                    `[AgentGateBridge] better-sqlite3 native build failed (prebuild: ${prebuildErr?.message || prebuildErr}, gyp: ${gypErr?.message || gypErr}), falling back to JSON storage`
                );
            }
        }
    }

    async start(settingInstance?: Setting): Promise<void> {
        if (this._running) return;
        const availability = getHarmonyLocalRuntimeFeatureAvailability('agentgate');
        if (!availability.available) {
            this.setLocalRuntimeUnavailable(availability);
            logger.warn(`[AgentGateBridge] ${this._lastError}`);
            return;
        }
        this._running = true;
        this._lastError = null;
        // 保存当前配置，供崩溃/退出后的自动重启（exit/spawn error 回调）读取 enabled 状态
        this._currentSetting = settingInstance;

        // 包已作为 OpenDesk 的 dependencies 预装到 node_modules（离线 npm install 一次即就绪），
        // 不再运行时 npm install 到 extensions 目录。仅做存在性校验。
        const projectRoot = this.getProjectRoot();
        const gatePkg = path.join(projectRoot, 'node_modules', '@kenhkl', 'agent-gate', 'package.json');
        if (!fs.existsSync(gatePkg)) {
            logger.warn('[AgentGateBridge] @kenhkl/agent-gate 未在 node_modules 中预装，安全网关无法启动');
            this._lastError = '@kenhkl/agent-gate 未预装';
            this._running = false;
            return;
        }

        // 如果配置为 sqlite 模式但 better-sqlite3 的 native binding 缺失或 ABI 不匹配系统 node，尝试编译
        // （npm install 时 prebuild-install 通常已下好预编译 binding，此处兜底处理异常情况）
        // 重要：不能只检查文件存在——binding 可能是为旧 Node ABI 编的（如 v24→ABI140），
        // 系统 node 升级后（如 v25→ABI141）加载会失败。必须实际尝试加载探测 ABI 兼容性。
        const sqliteDirs = this._findSqliteDirs();
        const sqliteDir = sqliteDirs.find((d) => fs.existsSync(path.join(d, 'package.json')));
        if (sqliteDir) {
            const abiCompatible = await this._checkSqliteAbiCompatible(sqliteDir);
            if (!abiCompatible) {
                logger.info(
                    '[AgentGateBridge] better-sqlite3 native binding missing or ABI mismatch, attempting build...'
                );
                await this.tryBuildSqliteNative(sqliteDir);
            }
        }

        // 解析 bundle 路径
        this.mossState.bundlePath = this.resolveBundle('@kenhkl/agent-moss');
        this.gateState.bundlePath = this.resolveBundle('@kenhkl/agent-gate');

        // 找到空闲端口后并行启动
        // 注：不调用 ensureNativeModules——spawn 子进程方案下子进程用系统 node 跑，
        // binding 已由 tryBuildSqliteNative 编为系统 node ABI。
        // ensureNativeModules 会把 binding 覆盖成 Electron ABI，与子进程需求相反。
        this.findFreePort(PORT_MOSS_START)
            .then((mossPort) => {
                this.mossState.port = mossPort;
                return this.findFreePort(PORT_GATE_START);
            })
            .then((gatePort) => {
                this.gateState.port = gatePort;
                this.launchService(this.mossState, settingInstance);
                this.launchService(this.gateState, settingInstance);
            });
    }

    /** 从 startPort 开始找到第一个可用端口 */
    private async findFreePort(startPort: number): Promise<number> {
        for (let port = startPort; port < startPort + 100; port++) {
            const free = await new Promise<boolean>((resolve) => {
                const server = createServer();
                server.listen(port, '127.0.0.1', () => {
                    server.close(() => resolve(true));
                });
                server.on('error', () => resolve(false));
            });
            if (free) {
                if (port !== startPort) {
                    logger.info(`[AgentGateBridge] Port ${startPort} in use, using ${port} instead`);
                }
                return port;
            }
        }
        return startPort; // fallback
    }

    /**
     * 解析用于启动 node 子进程的可执行文件路径。
     *
     * AgentGate/AgentMoss 是纯 Node.js 服务，不应使用 Electron 二进制启动。
     * 在 Electron 运行时下 process.execPath 指向 electron 可执行文件，
     * OpenHarmony 只使用启动时已经验证并传给 Worker 的 HNP node 快照；
     * 其他平台继续按显式配置、PATH、Electron-as-node 的顺序查找。
     *
     * 查找顺序：
     *   1. NODE_BINARY 环境变量（允许用户显式指定）
     *   2. PATH 中的 node 可执行文件
     *   3. process.execPath（Electron 内置 Node 运行时，配合 ELECTRON_RUN_AS_NODE=1）
     *
     * 返回 node 可执行文件路径与需要额外注入的环境变量。
     */
    private resolveNodeCommand(): { nodePath: string; env: Record<string, string> } | null {
        if ((process.platform as string) === 'openharmony') {
            const state = getHarmonyLocalRuntimeState();
            const nodePath = state?.commands.node;
            return nodePath ? { nodePath, env: {} } : null;
        }

        const candidates = [process.env.NODE_BINARY, findExecutableInPath('node')].filter(Boolean) as string[];
        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate)) {
                    logger.info(`[AgentGateBridge] Using node: ${candidate}`);
                    return {
                        nodePath: candidate,
                        env: {}
                    };
                }
            } catch {
                /* continue */
            }
        }

        // 回退到 process.execPath（Electron 内置 Node），需设置 ELECTRON_RUN_AS_NODE=1
        // 让 electron 进程以纯 node 模式运行
        try {
            if (process.execPath && fs.existsSync(process.execPath)) {
                logger.info(`[AgentGateBridge] Using Electron as node: ${process.execPath}`);
                return {
                    nodePath: process.execPath,
                    env: { ELECTRON_RUN_AS_NODE: '1' }
                };
            }
        } catch {
            /* continue */
        }

        logger.warn(
            `[AgentGateBridge] No node found (NODE_BINARY=${process.env.NODE_BINARY}, PATH=${process.env.PATH}, execPath=${process.execPath})`
        );
        return null;
    }

    private launchService(state: ServiceState, settingInstance?: Setting): void {
        // 启动前检查 enabled -- 防止重启定时器在用户关闭后仍触发启动
        if (!this._isEnabled(settingInstance)) {
            logger.info(`[AgentGateBridge] ${state.name} launch skipped: agentgate disabled`);
            return;
        }
        const node = this.resolveNodeCommand();
        if (!node) {
            const msg =
                `无可用的 node 可执行文件（process.execPath=${process.execPath}）。` +
                `请安装 node 或设置 NODE_BINARY 环境变量。`;
            this._lastError = `[${state.name}] ${msg}`;
            logger.warn(`[AgentGateBridge] ${msg}`);
            this._running = false;
            return;
        }

        logger.info(`[AgentGateBridge] Starting ${state.name} on port ${state.port}: ${state.bundlePath}`);

        // Build env: LLM + custom rules for AgentMoss
        const extraEnv: Record<string, string> = { NODE_ENV: 'production' };
        // 归属实例标识：health 端点返回 instance 字段。同机多套 agentmoss 并存时，
        // 第三方探测（如 xiaoO install.sh / bridge.py 扫 9090-9095）按 instance 过滤，
        // 避免把 OpenDesk 的 agent-moss 当成自己的服务误停/误连。xiaoO 期望 xiaoo，
        // 这里注入 opendesk 使两者区分。
        if (state.name === 'agent-moss') {
            extraEnv['AGENT_MOSS_INSTANCE'] = 'opendesk';
        }
        const gateArgs: string[] = ['server', '--port', String(state.port), '--host', '127.0.0.1'];
        if (settingInstance) {
            extraEnv['AGENT_MOSS_LLM_BASE_URL'] = '';
            extraEnv['AGENT_MOSS_LLM_API_KEY'] = '';
            extraEnv['AGENT_MOSS_LLM_MODEL'] = '';
            extraEnv['AGENT_MOSS_LLM_TIMEOUT'] = '300';
            extraEnv['AGENT_MOSS_DISABLE_LLM'] = '0';
            extraEnv['AGENT_MOSS_CUSTOM_RULES'] = '[]';
            try {
                const data = (settingInstance as any).getData?.() || {};
                const providers: any[] = data.providers || [];
                const models: any[] = data.models || [];
                const defaultModel = data.default_model || '';
                // 模型选择优先级：appCfg.llmModel（安全网关设置页选择）> 全局 default_model > 第一个
                const appCfg0 = data.applications?.agentgate || {};
                const chosenAlias = appCfg0.llmModel || defaultModel || '';
                const model = chosenAlias ? models.find((m: any) => m.alias === chosenAlias) : models[0];
                const provider = model ? providers.find((p: any) => p.name === model.provider_name) : providers[0];
                if (provider?.base_url) extraEnv['AGENT_MOSS_LLM_BASE_URL'] = provider.base_url;
                if (provider?.api_key) extraEnv['AGENT_MOSS_LLM_API_KEY'] = provider.api_key;
                if (model?.model_name) extraEnv['AGENT_MOSS_LLM_MODEL'] = model.model_name;
                // 同时设置 OPENAI_* 环境变量，确保 OpenAI SDK 任何版本都能找到凭据
                if (provider?.api_key) extraEnv['OPENAI_API_KEY'] = provider.api_key;
                if (provider?.base_url) extraEnv['OPENAI_BASE_URL'] = provider.base_url;
                // 记录 LLM 配置状态（仅 agent-moss 启动时设置，避免被 agent-gate 覆盖）
                if (state.name === 'agent-moss') {
                    this._llmConfigured = !!provider?.api_key;
                }
                // AgentGate app config: enableLLM toggle + timeout + custom rules + storage + paths
                const appCfg = data.applications?.agentgate;
                if (appCfg) {
                    if (appCfg.enableLLM === false) extraEnv['AGENT_MOSS_DISABLE_LLM'] = '1';
                    if (appCfg.llmTimeout && appCfg.llmTimeout >= 10)
                        extraEnv['AGENT_MOSS_LLM_TIMEOUT'] = String(appCfg.llmTimeout);
                    if (appCfg.customRules && Array.isArray(appCfg.customRules)) {
                        extraEnv['AGENT_MOSS_CUSTOM_RULES'] = JSON.stringify(appCfg.customRules);
                    }
                    // 存储类型：sqlite 时传 --db-path，json 时传环境变量
                    // 未配置时：鸿蒙默认 json，其他默认 sqlite
                    const storageType =
                        appCfg.storageType || ((process.platform as string) === 'openharmony' ? 'json' : 'sqlite');
                    if (storageType === 'sqlite') {
                        if (appCfg.dbPath) gateArgs.push('--db-path', appCfg.dbPath);
                    }
                    // json 类型的环境变量将在下方 agent-gate 专属 env 中设置
                }
                logger.info(
                    `[AgentGateBridge] LLM: ${provider?.name || 'none'} / ${model?.model_name || 'none'}, enabled: ${extraEnv['AGENT_MOSS_DISABLE_LLM'] !== '1'}, rules: ${appCfg?.customRules?.length || 0}`
                );
            } catch {}
        } else {
            extraEnv['AGENT_MOSS_LLM_BASE_URL'] = '';
            extraEnv['AGENT_MOSS_LLM_API_KEY'] = '';
            extraEnv['AGENT_MOSS_LLM_MODEL'] = '';
            extraEnv['AGENT_MOSS_LLM_TIMEOUT'] = '300';
            extraEnv['AGENT_MOSS_DISABLE_LLM'] = '0';
            extraEnv['AGENT_MOSS_CUSTOM_RULES'] = '[]';
        }

        // 构造子进程参数：node bundlePath [args...]
        const serviceArgs =
            state.name === 'agent-gate' ? gateArgs : ['server', '--port', String(state.port), '--host', '127.0.0.1'];
        const spawnArgs = [state.bundlePath, ...serviceArgs];

        const mergedEnv = mergeGlobalEnviron({
            ...extraEnv,
            ...node.env,
            ...(state.name === 'agent-gate'
                ? (() => {
                      const gateEnv: Record<string, string> = {
                          MOSS_URL: `http://127.0.0.1:${this.mossState.port}`
                      };
                      // 根据配置决定存储类型：sqlite 或 json
                      const appCfg = settingInstance
                          ? ((settingInstance as any).getData?.() || {}).applications?.agentgate
                          : undefined;
                      let storageType =
                          appCfg?.storageType || ((process.platform as string) === 'openharmony' ? 'json' : 'sqlite');
                      // sqlite 模式需要 better-sqlite3，检测是否真正可用（含鸿蒙强制 json），
                      // 不可用时自动回退到 json；ABI 兼容性兜底已在 start() 的 tryBuildSqliteNative 处理
                      if (storageType === 'sqlite' && !this.isSqliteAvailable()) {
                          logger.warn('[AgentGateBridge] better-sqlite3 not available, falling back to JSON storage');
                          storageType = 'json';
                      }
                      if (storageType === 'json') {
                          gateEnv['AGENT_GATE_STORAGE'] = 'json';
                          // JSON 数据目录：用户自定义 > 默认 getAgentGateDataDir()
                          gateEnv['AGENT_GATE_DATA_DIR'] = appCfg?.jsonDataDir || this.getAgentGateDataDir();
                      }
                      // sqlite 模式不设 AGENT_GATE_STORAGE（agent-gate 默认 sqlite）
                      // --db-path 已在上方的 gateArgs 中添加
                      // 多 session 分析开关：agent-gate 据此组装跨会话 session_history
                      // 并控制 stateful_incremental 注入（见 AgentGate ts/src/shared/normalizer.ts）。
                      // 关闭时不传（缺省单 session），开启时设 1。
                      if (appCfg?.multiSessionAnalysis === true) {
                          gateEnv['AGENT_GATE_MULTI_SESSION'] = '1';
                      }
                      logger.info(
                          `[AgentGateBridge] Storage: ${storageType}, data dir: ${gateEnv['AGENT_GATE_DATA_DIR'] || '(sqlite default)'}, multiSession: ${appCfg?.multiSessionAnalysis === true ? 'on' : 'off'}`
                      );
                      return gateEnv;
                  })()
                : {})
        });

        try {
            // 直接 spawn node 进程，避免 shell 字符串解析问题（尤其是 PowerShell）
            state.process = spawn(node.nodePath, spawnArgs, {
                cwd: path.dirname(state.bundlePath),
                env: mergedEnv,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            // spawn 成功，清理已消费的重启定时器引用
            this._restartTimers = [];
        } catch (err) {
            const msg = `启动 ${state.name} 子进程失败: ${err instanceof Error ? err.message : String(err)}`;
            this._lastError = msg;
            logger.warn(`[AgentGateBridge] ${msg}`);
            state.process = null;
            this._running = false;
            return;
        }

        // 捕获 spawn 错误（如可执行文件不存在），避免抛出 uncaught exception
        state.process.on('error', (err: NodeJS.ErrnoException) => {
            const msg = `${state.name} 进程错误: ${err.message || String(err)}`;
            this._lastError = msg;
            logger.warn(`[AgentGateBridge] ${msg}`);
            state.process = null;
            this._running = false;

            // spawn 失败时 exit 事件不会触发，需手动触发重启逻辑
            if (state.restartCount < MAX_RESTART) {
                state.restartCount++;
                logger.info(`[AgentGateBridge] Restarting ${state.name} (${state.restartCount}/${MAX_RESTART})`);
                const timer = setTimeout(() => this.launchService(state, this._currentSetting), 1500);
                this._restartTimers.push(timer);
            }
        });

        state.process.stdout?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) logger.info(`[${state.name}] ${msg}`);
        });

        state.process.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) logger.warn(`[${state.name}] ${msg}`);
        });

        state.process.on('exit', (code) => {
            logger.info(`[AgentGateBridge] ${state.name} exited with code ${code}`);
            if (state.restartCount < MAX_RESTART) {
                state.restartCount++;
                logger.info(`[AgentGateBridge] Restarting ${state.name} (${state.restartCount}/${MAX_RESTART})`);
                const timer = setTimeout(() => this.launchService(state, this._currentSetting), 1500);
                this._restartTimers.push(timer);
            }
        });
    }

    private _currentSetting: Setting | undefined;

    /** 配置变更时重启 AgentMoss + AgentGate（延迟等端口释放，由 exit 回调触发） */
    updateConfig(setting: Setting): void {
        // enabled 关闭时不重启，由调用方通过 stop() 停止服务
        if (!this._isEnabled(setting)) return;
        this._currentSetting = setting;
        [this.mossState, this.gateState].forEach((state) => {
            if (state.process) {
                state.process.removeAllListeners('exit');
                state.process.on('exit', () => {
                    state.restartCount = 0;
                    const timer = setTimeout(() => this.launchService(state, this._currentSetting), 1500);
                    this._restartTimers.push(timer);
                });
                state.process.kill();
            }
        });
    }

    stop(): void {
        // 清除所有待执行的重启定时器，防止 stop 后延迟重启绕过 enabled 检查
        for (const timer of this._restartTimers) {
            clearTimeout(timer);
        }
        this._restartTimers = [];

        [this.mossState, this.gateState].forEach((state) => {
            if (state.process) {
                state.process.removeAllListeners('exit');
                state.process.kill();
                state.process = null;
            }
            state.restartCount = 0;
        });
        this._running = false;
        this._lastError = null;
        logger.info('[AgentGateBridge] All services stopped');
    }

    isRunning(): boolean {
        return this._running;
    }

    /** 检查配置中 agentgate.enabled 是否为 true */
    private _isEnabled(settingInstance?: Setting): boolean {
        try {
            const setting = settingInstance ?? this._currentSetting;
            if (!setting) return false;
            const data = setting.getData() as any;
            return data?.applications?.agentgate?.enabled === true;
        } catch {
            return false;
        }
    }
}

export { AgentGateBridge, type BridgeStatus };
