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
import { createServer } from 'net';
import path from 'path';
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

    /** 解析 npm 包 bundle 路径或使用本地仓库路径 */
    private resolveBundle(packageName: string, fallbackRelative: string): string {
        // 优先使用 npm 安装的包（生产环境）
        const npmPath = path.resolve(process.cwd(), 'node_modules', packageName, 'dist/cli.js');
        try {
            const { existsSync } = require('fs');
            if (existsSync(npmPath)) return npmPath;
        } catch {}
        // 尝试本地仓库路径
        return path.resolve(process.cwd(), fallbackRelative);
    }

    start(settingInstance?: Setting): void {
        // 解析 AgentMoss bundle
        this.mossState.bundlePath = this.resolveBundle('@kenhkl/agent-moss', '../AgentMoss/ts/dist/cli.js');

        // 解析 AgentGate bundle
        this.gateState.bundlePath = this.resolveBundle('@kenhkl/agent-gate', '../AgentGate/ts/dist/cli.js');

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
