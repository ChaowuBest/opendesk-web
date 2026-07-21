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

import { spawn, type ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import fs from 'fs';
import type { Setting } from '../../utils/setting';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { findExecutableInPath, mergeGlobalEnviron, asyncShellExec } from '../../utils/shellExec.js';
import { getOpenDeskAppHost } from '../../../../packages/appsdk/src/index.js';
import { logger } from '../../utils/logger.js';

const PORT_MOSS_START = 9090;
const PORT_GATE_START = 9100;
const MAX_RESTART = 3;
const EXTENSIONS_DIR_NAME = 'extensions';

/** 获取 extensions 目录路径（与 plugins/manager.ts 的 getExtensionsDir 一致） */
function getExtensionsDir(): string {
    const dir = path.join(getOpendeskDirectory(), EXTENSIONS_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * 从 OpenDesk 自身 package.json 读取依赖版本（单一来源，避免散落硬编码）。
 * 查找顺序：process.cwd()/package.json → 向上逐层查找（覆盖 dev 与打包场景）。
 * 结果缓存，进程内只读一次盘。
 */
const _depVersionCache = new Map<string, string>();
function getDependencyVersion(packageName: string): string {
    const cached = _depVersionCache.get(packageName);
    if (cached) return cached;

    const candidates: string[] = [];
    if (process.cwd()) candidates.push(path.resolve(process.cwd(), 'package.json'));
    // 从本文件向上找（dev: src/main/services → 仓库根；打包: dist/main/... → app 根）
    // 用 import.meta.dirname 而非 __dirname，ESM 模块下 __dirname 不可用
    let dir = import.meta.dirname;
    for (let i = 0; i < 8 && dir; i++) {
        candidates.push(path.join(dir, 'package.json'));
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
            const version = pkg?.dependencies?.[packageName] || pkg?.devDependencies?.[packageName];
            if (typeof version === 'string' && version.length > 0) {
                // 去掉 ^ ~ 等前缀，ensureInstalled 需要精确版本做相等比较
                const clean = version.replace(/^[\^~>=< ]+/, '');
                if (clean) {
                    _depVersionCache.set(packageName, clean);
                    return clean;
                }
            }
        } catch {
            // 继续尝试下一个候选
        }
    }
    // 读不到时回退到一个已知版本，保证启动不中断（但日志告警）
    logger.warn(`[AgentGateBridge] 无法从 package.json 读取 ${packageName} 版本，使用回退值`);
    return '';
}

interface ServiceState {
    process: ChildProcess | null;
    restartCount: number;
    port: number;
    bundlePath: string;
    name: string;
}

interface BridgeStatus {
    running: boolean;
    lastError: string | null;
    mossPort: number;
    gatePort: number;
    mossRunning: boolean;
    gateRunning: boolean;
    llmAvailable: boolean;
}

class AgentGateBridge {
    private static instance: AgentGateBridge | null = null;
    private _running = false;
    /** 最近一次启动/运行错误，供 UI 显示 */
    private _lastError: string | null = null;

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
            running: this._running,
            lastError: this._lastError,
            mossPort: this.mossState.port,
            gatePort: this.gateState.port,
            mossRunning,
            gateRunning,
            llmAvailable
        };
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
     * 解析 npm 包 bundle 路径。
     * 优先从插件目录（~/.opendesk/extensions/node_modules/）加载，
     * 回退到项目 node_modules/（本地开发 npm link 场景）。
     */
    private resolveBundle(packageName: string): string {
        // 1. 插件目录
        const extBundle = path.join(getExtensionsDir(), 'node_modules', packageName, 'dist', 'cli.js');
        if (fs.existsSync(extBundle)) return extBundle;

        // 2. 项目 node_modules（本地开发 / npm link）
        const localBundle = path.resolve(process.cwd(), 'node_modules', packageName, 'dist', 'cli.js');
        if (fs.existsSync(localBundle)) return localBundle;

        return extBundle; // 返回默认路径，后续 start() 会自动安装
    }

    /**
     * 确保包已安装到 extensions 目录。
     * 直接使用 npm install，不写入 plugins.json（避免 loadPlugins 扫描到），
     * 因为 agent-gate/agent-moss 是 bridge 通过 spawn() 启动的子进程，不是 OpenClaw 插件。
     */
    private async ensureInstalled(packageName: string, version: string): Promise<void> {
        const extensionsDir = getExtensionsDir();

        // 版本号为空（无法从 package.json 读取）时：已装则沿用，不触发安装，
        // 避免 npm install `<pkg>@` 这种非法 spec 报错
        if (!version) {
            const installedPkgJson0 = path.join(extensionsDir, 'node_modules', packageName, 'package.json');
            if (fs.existsSync(installedPkgJson0)) {
                try {
                    const installed = JSON.parse(fs.readFileSync(installedPkgJson0, 'utf-8'));
                    logger.warn(
                        `[AgentGateBridge] ${packageName} 版本未知，沿用 extensions 已装 @${installed.version}`
                    );
                    return;
                } catch {}
            }
        }

        // 检查 extensions 目录已安装的版本
        const installedPkgJson = path.join(extensionsDir, 'node_modules', packageName, 'package.json');
        if (fs.existsSync(installedPkgJson)) {
            try {
                const installed = JSON.parse(fs.readFileSync(installedPkgJson, 'utf-8'));
                if (installed.version === version) {
                    logger.info(`[AgentGateBridge] ${packageName}@${installed.version} found in extensions`);
                    return;
                }
                logger.info(
                    `[AgentGateBridge] ${packageName}@${installed.version} found but expected @${version}, upgrading...`
                );
            } catch {
                logger.info(`[AgentGateBridge] ${packageName} package.json unreadable, reinstalling...`);
            }
            // 版本不匹配：fall through 执行 npm install
        } else {
            // extensions 无安装：检查项目 node_modules（本地开发 npm link）
            const localPath = path.resolve(process.cwd(), 'node_modules', packageName, 'dist', 'cli.js');
            if (fs.existsSync(localPath)) {
                logger.info(`[AgentGateBridge] ${packageName} found in project node_modules (dev mode)`);
                return;
            }
        }

        // 直接 npm install 到 extensions 目录（不写 plugins.json，不走 installPlugin）
        const spec = `${packageName}@${version}`;
        logger.info(`[AgentGateBridge] Installing ${spec} to extensions...`);

        // 确保 node_modules 存在，阻止 npm 向上遍历
        const nmDir = path.join(extensionsDir, 'node_modules');
        if (!fs.existsSync(nmDir)) fs.mkdirSync(nmDir, { recursive: true });

        // 确保 package.json 存在（npm --prefix 需要）
        const pkgJsonPath = path.join(extensionsDir, 'package.json');
        if (!fs.existsSync(pkgJsonPath)) {
            fs.writeFileSync(
                pkgJsonPath,
                JSON.stringify(
                    {
                        name: 'opendesk-extensions',
                        version: '1.0.0',
                        private: true,
                        description: 'OpenDesk extension dependencies'
                    },
                    null,
                    2
                )
            );
        }

        // 确保 .npmrc 存在，阻止 npm 向上查找 .npmrc（与 plugins/manager.ts 一致）
        const npmrcPath = path.join(extensionsDir, '.npmrc');
        if (!fs.existsSync(npmrcPath)) {
            fs.writeFileSync(npmrcPath, '', 'utf-8');
        }

        // npm 子进程环境变量（与 plugins/manager.ts 的 buildNpmEnv 一致）
        // 注意：鸿蒙上 npm 由 HNP node 执行，必须保留 --jitless（移除会导致 V8 JIT native crash），
        // 所以不要在 npmEnv 中覆盖 NODE_OPTIONS，让 mergeGlobalEnviron 自然保留平台注入的 --jitless。
        const npmEnv: NodeJS.ProcessEnv = {
            npm_config_fund: 'false',
            npm_config_userconfig: npmrcPath,
            npm_config_cache: path.join(
                // 优先使用 XDG_CACHE_HOME，避免写入 /tmp 时的权限问题
                process.env.XDG_CACHE_HOME ||
                    path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.cache'),
                'opendesk-npm-cache'
            )
        };

        try {
            // 使用 asyncShellExec + mergeGlobalEnviron，确保鸿蒙等平台的 PATH 和 NODE_OPTIONS 正确注入
            await asyncShellExec(
                `npm install --prefix "${extensionsDir}" ${spec} --ignore-scripts --no-bin-links --no-optional --audit=false`,
                { cwd: extensionsDir, timeout: 180000, env: npmEnv }
            );
            logger.info(`[AgentGateBridge] ${spec} installed successfully`);

            // agent-gate 安装后，尝试编译 better-sqlite3 native binding（支持 sqlite 存储模式）
            // 如果编译失败（鸿蒙等平台缺少工具链），则回退到 json 存储
            if (packageName === '@kenhkl/agent-gate') {
                await this.tryBuildSqliteNative(extensionsDir);
            }
        } catch (err: any) {
            const errMsg = err?.stderr || err?.message || String(err);
            logger.warn(`[AgentGateBridge] Failed to install ${spec}: ${errMsg}`);
            throw new Error(`Failed to install ${spec}: ${errMsg}`);
        }
    }

    /**
     * 尝试编译 better-sqlite3 native binding（使 sqlite 存储模式可用）。
     * --ignore-scripts 安装跳过了 native binding 编译，需要手动执行。
     * 编译成功：sqlite 可用；编译失败：回退 json。
     * 鸿蒙平台不支持 native module 编译，直接跳过。
     */
    private async tryBuildSqliteNative(extensionsDir: string): Promise<void> {
        // 鸿蒙平台不支持 native module 编译（无 C++ 工具链、ABI 不同），直接跳过
        if ((process.platform as string) === 'openharmony') {
            logger.info(
                '[AgentGateBridge] Skipping better-sqlite3 build on OpenHarmony (no native toolchain), using JSON storage'
            );
            return;
        }
        // 查找 better-sqlite3 目录（hoisted 到顶层或嵌套在 agent-gate 内）
        const sqliteDirs = [
            path.join(extensionsDir, 'node_modules', 'better-sqlite3'),
            path.join(extensionsDir, 'node_modules', '@kenhkl', 'agent-gate', 'node_modules', 'better-sqlite3')
        ];
        let sqliteDir = '';
        for (const d of sqliteDirs) {
            if (fs.existsSync(path.join(d, 'package.json'))) {
                sqliteDir = d;
                break;
            }
        }
        if (!sqliteDir) {
            // better-sqlite3 未被安装（可能 npm hoisting 后依赖树中没有）
            // 尝试显式安装
            logger.info('[AgentGateBridge] better-sqlite3 not found, attempting to install...');
            try {
                await asyncShellExec(
                    `npm install --prefix "${extensionsDir}" better-sqlite3 --ignore-scripts --no-bin-links --audit=false`,
                    { cwd: extensionsDir, timeout: 120000, env: {} }
                );
                // 安装后重新查找
                for (const d of sqliteDirs) {
                    if (fs.existsSync(path.join(d, 'package.json'))) {
                        sqliteDir = d;
                        break;
                    }
                }
                if (!sqliteDir) {
                    logger.warn(
                        '[AgentGateBridge] better-sqlite3 install succeeded but package not found, using JSON storage'
                    );
                    return;
                }
            } catch (err: any) {
                logger.warn(
                    `[AgentGateBridge] better-sqlite3 install failed: ${err?.message || err}, using JSON storage`
                );
                return;
            }
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
                `npx --yes prebuild-install --runtime node --target ${nodeVersion} --arch ${process.arch}`,
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

    /**
     * 检测并修复 linked 本地包的 native modules（Electron ABI 兼容）。
     * 仅对 symlink 的本地开发目录生效，不影响正式 npm 包。
     */
    private ensureNativeModules(packageName: string): void {
        const pkgDir = path.resolve(process.cwd(), 'node_modules', packageName);
        try {
            if (!fs.lstatSync(pkgDir).isSymbolicLink()) return; // 正式包，跳过
        } catch {
            return;
        }

        // 找 Electron 版本
        let electronVersion = '';
        for (let dir = process.cwd(); dir !== path.dirname(dir); dir = path.dirname(dir)) {
            const p = path.join(dir, 'node_modules', 'electron', 'package.json');
            try {
                if (fs.existsSync(p)) {
                    electronVersion = JSON.parse(fs.readFileSync(p, 'utf-8')).version;
                    break;
                }
            } catch {
                /* continue */
            }
        }
        if (!electronVersion) return;

        // 找 better-sqlite3 所在的 node_modules 目录
        const realPkgDir = fs.realpathSync(pkgDir);
        const nativeDir = path.join(realPkgDir, 'node_modules', 'better-sqlite3');
        try {
            if (!fs.existsSync(path.join(nativeDir, 'package.json'))) return;
            logger.info(
                `[AgentGateBridge] Rebuilding better-sqlite3 for Electron ${electronVersion} (local dev: ${packageName})`
            );
            execSync(`npx --yes prebuild-install --runtime electron --target ${electronVersion} --arch x64`, {
                cwd: nativeDir,
                stdio: 'pipe',
                timeout: 30000
            });
        } catch {
            /* better-sqlite3 is not a dep of this package, skip */
        }
    }

    async start(settingInstance?: Setting): Promise<void> {
        if (this._running) return;
        this._running = true;
        this._lastError = null;

        try {
            // 确保插件已安装（未安装则自动下载）
            // 版本号从 OpenDesk 自身 package.json 读取（单一来源），避免散落硬编码
            await this.ensureInstalled('@kenhkl/agent-moss', getDependencyVersion('@kenhkl/agent-moss'));
            await this.ensureInstalled('@kenhkl/agent-gate', getDependencyVersion('@kenhkl/agent-gate'));
        } catch (err) {
            logger.warn('[AgentGateBridge] Failed to ensure plugins:', err);
            this._lastError = String(err);
            this._running = false;
            return;
        }

        // 如果配置为 sqlite 模式但 better-sqlite3 未安装/未编译，尝试编译 native binding
        // （ensureInstalled 用 --ignore-scripts 跳过了编译，已安装的包也不会重新安装）
        const extDir = getExtensionsDir();
        const sqliteInstalled =
            fs.existsSync(path.join(extDir, 'node_modules', 'better-sqlite3', 'package.json')) ||
            fs.existsSync(
                path.join(
                    extDir,
                    'node_modules',
                    '@kenhkl',
                    'agent-gate',
                    'node_modules',
                    'better-sqlite3',
                    'package.json'
                )
            );
        if (!sqliteInstalled) {
            // better-sqlite3 未安装到 node_modules，尝试安装+编译
            await this.tryBuildSqliteNative(extDir);
        } else {
            // better-sqlite3 已安装但 native binding 可能未编译（--ignore-scripts 跳过了）
            const sqliteDir = fs.existsSync(path.join(extDir, 'node_modules', 'better-sqlite3', 'package.json'))
                ? path.join(extDir, 'node_modules', 'better-sqlite3')
                : path.join(extDir, 'node_modules', '@kenhkl', 'agent-gate', 'node_modules', 'better-sqlite3');
            const hasBuild =
                fs.existsSync(path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node')) ||
                fs.existsSync(path.join(sqliteDir, 'prebuilds', process.arch + '-electron.pkg'));
            if (!hasBuild) {
                // package.json 存在但 native binding 未编译，尝试编译
                logger.info(
                    '[AgentGateBridge] better-sqlite3 package found but native binding missing, attempting build...'
                );
                await this.tryBuildSqliteNative(extDir);
            }
        }

        // 解析 bundle 路径
        this.mossState.bundlePath = this.resolveBundle('@kenhkl/agent-moss');
        this.gateState.bundlePath = this.resolveBundle('@kenhkl/agent-gate');

        // [DEBUG-LOG] 鸿蒙诊断：打印安装路径和数据目录，部署验证后删除此行
        logger.info(
            `[AgentGateBridge] Diagnostics: mossBundle=${this.mossState.bundlePath}, gateBundle=${this.gateState.bundlePath}, extensionsDir=${getExtensionsDir()}, dataDir=${this.getAgentGateDataDir()}`
        );

        // 确保 linked 本地包的原生模块兼容 Electron ABI（仅本地开发）
        this.ensureNativeModules('@kenhkl/agent-moss');
        this.ensureNativeModules('@kenhkl/agent-gate');

        // 找到空闲端口后并行启动
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
     * 在鸿蒙等平台上该路径可能不存在或无法作为 node 使用，因此优先查找
     * 系统中真正的 node 二进制。
     *
     * 查找顺序：
     *   1. NODE_BINARY 环境变量（允许用户显式指定）
     *   2. PATH 中的 node 可执行文件
     *   3. process.execPath（Electron 内置 Node 运行时，配合 ELECTRON_RUN_AS_NODE=1）
     *
     * 返回 node 可执行文件路径与需要额外注入的环境变量。
     */
    private resolveNodeCommand(): { nodePath: string; env: Record<string, string> } | null {
        // 鸿蒙平台上 PATH 可能不包含 HNP 路径，显式追加确保能找到 node
        const ohosHnpBin = '/data/service/hnp/bin';
        if (
            (process.platform as string) === 'openharmony' &&
            process.env.PATH &&
            !process.env.PATH.includes(ohosHnpBin)
        ) {
            process.env.PATH = `${process.env.PATH}:${ohosHnpBin}`;
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
                      // sqlite 模式需要 better-sqlite3，检测是否可用，不可用时自动回退到 json
                      if (storageType === 'sqlite') {
                          const extDir = getExtensionsDir();
                          const sqliteAvailable =
                              fs.existsSync(path.join(extDir, 'node_modules', 'better-sqlite3', 'package.json')) ||
                              fs.existsSync(
                                  path.join(
                                      extDir,
                                      'node_modules',
                                      '@kenhkl',
                                      'agent-gate',
                                      'node_modules',
                                      'better-sqlite3',
                                      'package.json'
                                  )
                              );
                          if (!sqliteAvailable) {
                              logger.warn(
                                  '[AgentGateBridge] better-sqlite3 not installed, falling back to JSON storage'
                              );
                              storageType = 'json';
                          }
                      }
                      if (storageType === 'json') {
                          gateEnv['AGENT_GATE_STORAGE'] = 'json';
                          // JSON 数据目录：用户自定义 > 默认 getAgentGateDataDir()
                          gateEnv['AGENT_GATE_DATA_DIR'] = appCfg?.jsonDataDir || this.getAgentGateDataDir();
                      }
                      // sqlite 模式不设 AGENT_GATE_STORAGE（agent-gate 默认 sqlite）
                      // --db-path 已在上方的 gateArgs 中添加
                      logger.info(
                          `[AgentGateBridge] Storage: ${storageType}, data dir: ${gateEnv['AGENT_GATE_DATA_DIR'] || '(sqlite default)'}`
                      );
                      return gateEnv;
                  })()
                : {})
        });

        // 鸿蒙平台：HNP node 的 V8 JIT 存在 native crash 问题，
        // --jitless 禁用 JIT 是所有 HNP node 子进程（包括 npm、agent-gate、agent-moss）的必要保护。
        // agent-moss 在 --jitless 下性能受限，但这是 OHOS 上唯一稳定的运行方式。

        try {
            // 直接 spawn node 进程，避免 shell 字符串解析问题（尤其是 PowerShell）
            state.process = spawn(node.nodePath, spawnArgs, {
                cwd: path.dirname(state.bundlePath),
                env: mergedEnv,
                stdio: ['pipe', 'pipe', 'pipe']
            });
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
                setTimeout(() => this.launchService(state, this._currentSetting), 1500);
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
                setTimeout(() => this.launchService(state, this._currentSetting), 1500);
            }
        });
    }

    private _currentSetting: Setting | undefined;

    /** 配置变更时重启 AgentMoss + AgentGate（延迟等端口释放，由 exit 回调触发） */
    updateConfig(setting: Setting): void {
        this._currentSetting = setting;
        [this.mossState, this.gateState].forEach((state) => {
            if (state.process) {
                state.process.removeAllListeners('exit');
                state.process.on('exit', () => {
                    state.restartCount = 0;
                    setTimeout(() => this.launchService(state, this._currentSetting), 1500);
                });
                state.process.kill();
            }
        });
    }

    stop(): void {
        [this.mossState, this.gateState].forEach((state) => {
            if (state.process) {
                state.process.removeAllListeners('exit');
                state.process.kill();
                state.process = null;
            }
        });
        this._running = false;
        this._lastError = null;
        logger.info('[AgentGateBridge] All services stopped');
    }

    isRunning(): boolean {
        return this._running;
    }
}

export { AgentGateBridge, type BridgeStatus };
