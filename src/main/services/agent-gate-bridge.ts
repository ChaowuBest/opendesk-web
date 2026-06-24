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
import type { Setting } from '../utils/setting';
import { findExecutableInPath, mergeGlobalEnviron } from '../utils/shellExec.js';
import { getOpenDeskAppHost } from '../../../packages/appsdk/src/index.js';
import { getExtensionsDir } from '../plugins/index.js';

const PORT_MOSS_START = 9090;
const PORT_GATE_START = 9100;
const MAX_RESTART = 3;

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

    static getInstance(): AgentGateBridge {
        if (!AgentGateBridge.instance) {
            AgentGateBridge.instance = new AgentGateBridge();
        }
        return AgentGateBridge.instance;
    }

    /** 供 renderer 查询 Bridge 运行状态与最近错误 */
    getStatus(): BridgeStatus {
        return {
            running: this._running,
            lastError: this._lastError,
            mossPort: this.mossState.port,
            gatePort: this.gateState.port,
            mossRunning: !!this.mossState.process && !this.mossState.process.killed,
            gateRunning: !!this.gateState.process && !this.gateState.process.killed
        };
    }

    /** 获取 AgentGate 的存储目录（BaseApplication.getDataDirectory + storage 子目录） */
    private getAgentGateDataDir(): string {
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
        const bundlePath = path.join(getExtensionsDir(), 'node_modules', packageName, 'dist', 'cli.js');
        if (fs.existsSync(bundlePath)) {
            console.log(`[AgentGateBridge] ${packageName} found in extensions`);
            return;
        }

        // 回退：检查项目 node_modules（本地开发 npm link）
        const localPath = path.resolve(process.cwd(), 'node_modules', packageName, 'dist', 'cli.js');
        if (fs.existsSync(localPath)) {
            console.log(`[AgentGateBridge] ${packageName} found in project node_modules (dev mode)`);
            return;
        }

        // 直接 npm install 到 extensions 目录（不写 plugins.json，不走 installPlugin）
        const extensionsDir = getExtensionsDir();
        const spec = `${packageName}@${version}`;
        console.log(`[AgentGateBridge] Installing ${spec} to extensions...`);

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

        try {
            execSync(
                `npm install --prefix "${extensionsDir}" ${spec} --ignore-scripts --no-bin-links --no-optional --prefer-offline --audit=false`,
                { cwd: extensionsDir, timeout: 180000, stdio: 'pipe' }
            );
            console.log(`[AgentGateBridge] ${spec} installed successfully`);
        } catch (err: any) {
            const errMsg = err?.stderr?.toString() || err?.message || String(err);
            console.error(`[AgentGateBridge] Failed to install ${spec}: ${errMsg}`);
            throw new Error(`Failed to install ${spec}: ${errMsg}`);
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
            console.log(
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
            await this.ensureInstalled('@kenhkl/agent-moss', '0.6.0');
            await this.ensureInstalled('@kenhkl/agent-gate', '0.5.0');
        } catch (err) {
            console.error('[AgentGateBridge] Failed to ensure plugins:', err);
            this._lastError = String(err);
            this._running = false;
            return;
        }

        // 解析 bundle 路径
        this.mossState.bundlePath = this.resolveBundle('@kenhkl/agent-moss');
        this.gateState.bundlePath = this.resolveBundle('@kenhkl/agent-gate');

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
                    console.log(`[AgentGateBridge] Port ${startPort} in use, using ${port} instead`);
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
        const candidates = [process.env.NODE_BINARY, findExecutableInPath('node')].filter(Boolean) as string[];
        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate)) {
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
                return {
                    nodePath: process.execPath,
                    env: { ELECTRON_RUN_AS_NODE: '1' }
                };
            }
        } catch {
            /* continue */
        }
        return null;
    }

    private launchService(state: ServiceState, settingInstance?: Setting): void {
        const node = this.resolveNodeCommand();
        if (!node) {
            const msg =
                `无可用的 node 可执行文件（process.execPath=${process.execPath}）。` +
                `请安装 node 或设置 NODE_BINARY 环境变量。`;
            this._lastError = `[${state.name}] ${msg}`;
            console.error(`[AgentGateBridge] ${msg}`);
            this._running = false;
            return;
        }

        console.log(`[AgentGateBridge] Starting ${state.name} on port ${state.port}: ${state.bundlePath}`);

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
                const model = defaultModel ? models.find((m: any) => m.alias === defaultModel) : models[0];
                const provider = model ? providers.find((p: any) => p.name === model.provider_name) : providers[0];
                if (provider?.base_url) extraEnv['AGENT_MOSS_LLM_BASE_URL'] = provider.base_url;
                if (provider?.api_key) extraEnv['AGENT_MOSS_LLM_API_KEY'] = provider.api_key;
                if (model?.model_name) extraEnv['AGENT_MOSS_LLM_MODEL'] = model.model_name;
                // 同时设置 OPENAI_* 环境变量，确保 OpenAI SDK 任何版本都能找到凭据
                if (provider?.api_key) extraEnv['OPENAI_API_KEY'] = provider.api_key;
                if (provider?.base_url) extraEnv['OPENAI_BASE_URL'] = provider.base_url;
                // AgentGate app config: enableLLM toggle + timeout + custom rules + db path
                const appCfg = data.applications?.agentgate;
                if (appCfg) {
                    if (appCfg.enableLLM === false) extraEnv['AGENT_MOSS_DISABLE_LLM'] = '1';
                    if (appCfg.llmTimeout && appCfg.llmTimeout >= 10)
                        extraEnv['AGENT_MOSS_LLM_TIMEOUT'] = String(appCfg.llmTimeout);
                    if (appCfg.customRules && Array.isArray(appCfg.customRules)) {
                        extraEnv['AGENT_MOSS_CUSTOM_RULES'] = JSON.stringify(appCfg.customRules);
                    }
                    if (appCfg.dbPath) gateArgs.push('--db-path', appCfg.dbPath);
                }
                console.log(
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
                ? {
                      MOSS_URL: `http://127.0.0.1:${this.mossState.port}`,
                      AGENT_GATE_STORAGE: 'json',
                      AGENT_GATE_DATA_DIR: this.getAgentGateDataDir()
                  }
                : {})
        });

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
            console.error(`[AgentGateBridge] ${msg}`);
            state.process = null;
            this._running = false;
            return;
        }

        // 捕获 spawn 错误（如可执行文件不存在），避免抛出 uncaught exception
        state.process.on('error', (err: NodeJS.ErrnoException) => {
            const msg = `${state.name} 进程错误: ${err.message || String(err)}`;
            this._lastError = msg;
            console.error(`[AgentGateBridge] ${msg}`);
            state.process = null;
            this._running = false;

            // spawn 失败时 exit 事件不会触发，需手动触发重启逻辑
            if (state.restartCount < MAX_RESTART) {
                state.restartCount++;
                console.log(`[AgentGateBridge] Restarting ${state.name} (${state.restartCount}/${MAX_RESTART})`);
                setTimeout(() => this.launchService(state, this._currentSetting), 1500);
            }
        });

        state.process.stdout?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) console.log(`[${state.name}] ${msg}`);
        });

        state.process.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) console.error(`[${state.name}] ${msg}`);
        });

        state.process.on('exit', (code) => {
            console.log(`[AgentGateBridge] ${state.name} exited with code ${code}`);
            if (state.restartCount < MAX_RESTART) {
                state.restartCount++;
                console.log(`[AgentGateBridge] Restarting ${state.name} (${state.restartCount}/${MAX_RESTART})`);
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
        console.log('[AgentGateBridge] All services stopped');
    }

    isRunning(): boolean {
        return this._running;
    }
}

export { AgentGateBridge, type BridgeStatus };
