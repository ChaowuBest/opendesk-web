/**
 * AgentGate Bridge — 在 OpenDesk 主进程中管理 AgentGate + AgentMoss 服务生命周期。
 *
 * 工作原理:
 *   1. app.whenReady() 时 fork 两个 child_process
 *   2. 注入 OpenDesk 的 LLM 配置给 AgentMoss
 *   3. app.will-quit() 时关闭两个子进程
 *   4. 子进程异常退出时自动重启（最多 3 次）
 */

import { fork, type ChildProcess } from 'child_process';
import { execSync } from 'child_process';
import { createServer } from 'net';
import path from 'path';
import fs from 'fs';
import type { Setting } from '../utils/setting';

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

class AgentGateBridge {
    private static instance: AgentGateBridge | null = null;

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

    /** 解析 npm 包 bundle 路径 */
    private resolveBundle(packageName: string): string {
        return path.resolve(process.cwd(), 'node_modules', packageName, 'dist/cli.js');
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

    start(settingInstance?: Setting): void {
        // 解析 AgentMoss bundle
        this.mossState.bundlePath = this.resolveBundle('@kenhkl/agent-moss');

        // 解析 AgentGate bundle
        this.gateState.bundlePath = this.resolveBundle('@kenhkl/agent-gate');

        // 确保 linked 本地包的原生模块兼容 Electron ABI
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

    private launchService(state: ServiceState, settingInstance?: Setting): void {
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

        state.process = fork(
            state.bundlePath,
            state.name === 'agent-gate' ? gateArgs : ['server', '--port', String(state.port), '--host', '127.0.0.1'],
            {
                cwd: path.dirname(state.bundlePath),
                env: {
                    ...process.env,
                    ...extraEnv,
                    ...(state.name === 'agent-gate' ? { MOSS_URL: `http://127.0.0.1:${this.mossState.port}` } : {})
                },
                stdio: ['ipc', 'pipe', 'pipe']
            }
        );

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
                state.process.kill();
                state.process = null;
            }
        });
        console.log('[AgentGateBridge] All services stopped');
    }
}

export { AgentGateBridge };
