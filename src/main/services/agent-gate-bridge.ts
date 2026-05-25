/**
 * AgentGate Bridge — 在 OpenDesk 主进程中管理 AgentGate + AgentMoss 服务生命周期。
 *
 * 工作原理:
 *   1. app.whenReady() 时启动两个 utilityProcess
 *   2. 注入 OpenDesk 的 LLM 配置给 AgentMoss
 *   3. app.will-quit() 时关闭两个子进程
 *   4. 子进程异常退出时自动重启（最多 3 次）
 */

import { utilityProcess } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Setting } from '../utils/setting';

const PORT_MOSS = 9090;
const PORT_GATE = 9100;
const MAX_RESTART = 3;

interface ServiceState {
    process: Electron.UtilityProcess | null;
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
        port: PORT_MOSS,
        bundlePath: '',
        name: 'agent-moss'
    };

    private gateState: ServiceState = {
        process: null,
        restartCount: 0,
        port: PORT_GATE,
        bundlePath: '',
        name: 'agent-gate'
    };

    static getInstance(): AgentGateBridge {
        if (!AgentGateBridge.instance) {
            AgentGateBridge.instance = new AgentGateBridge();
        }
        return AgentGateBridge.instance;
    }

    /** 解析 npm 包 bundle 路径或使用开发环境路径 */
    private resolveBundle(packageName: string, fallbackRelative: string): string {
        try {
            // 优先使用 npm 安装的包（生产环境）
            const { createRequire } = require('module') as any;
            const req = createRequire(import.meta.url || __filename);
            try {
                return req.resolve(`${packageName}/package.json`).replace('package.json', 'dist/cli.js');
            } catch {
                // npm 包未安装，使用开发环境路径
            }
        } catch {}
        // 使用相对于项目根目录的路径
        return path.resolve(process.cwd(), fallbackRelative);
    }

    start(settingInstance?: Setting): void {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));

        // 解析 AgentMoss bundle
        this.mossState.bundlePath = this.resolveBundle(
            '@kenhkl/agent-moss',
            '../../node_modules/@kenhkl/agent-moss/dist/cli.js'
        );

        // 解析 AgentGate bundle
        this.gateState.bundlePath = this.resolveBundle(
            '@kenhkl/agent-gate',
            '../../node_modules/@kenhkl/agent-gate/dist/cli.js'
        );

        // 启动 AgentMoss
        this.launchService(this.mossState, settingInstance);
        // 启动 AgentGate
        this.launchService(this.gateState, settingInstance);

        console.log('[AgentGateBridge] Services launched');
    }

    private launchService(state: ServiceState, settingInstance?: Setting): void {
        state.process = utilityProcess.fork(
            state.bundlePath,
            ['server', '--port', String(state.port), '--host', '127.0.0.1'],
            {
                serviceName: state.name,
                env: {
                    NODE_ENV: 'production',
                    ...(state.name === 'agent-gate' ? { MOSS_URL: `http://127.0.0.1:${PORT_MOSS}` } : {})
                }
            }
        );

        state.process.on('exit', (code) => {
            console.log(`[AgentGateBridge] ${state.name} exited with code ${code}`);
            if (state.restartCount < MAX_RESTART) {
                state.restartCount++;
                console.log(`[AgentGateBridge] Restarting ${state.name} (${state.restartCount}/${MAX_RESTART})`);
                setTimeout(() => this.launchService(state, settingInstance), 1000);
            }
        });

        // 注入 LLM 配置给 AgentMoss
        if (state.name === 'agent-moss' && settingInstance) {
            this.injectLLMConfig(state, settingInstance);
        }
    }

    /** 从 OpenDesk Setting 读取 LLM 配置并注入到 AgentMoss */
    private injectLLMConfig(state: ServiceState, setting: Setting): void {
        try {
            const data = (setting as any).getData?.() || {};
            const providers = data.providers || [];
            const models = data.models || [];
            const defaultModel = data.default_model || '';

            // 找到默认模型的 provider
            const model = models.find((m: any) => m.alias === defaultModel);
            const provider = model ? providers.find((p: any) => p.name === model.provider_name) : providers[0];

            if (provider && model) {
                state.process?.postMessage({
                    type: 'config',
                    llm: {
                        provider: provider.name,
                        baseUrl: provider.base_url,
                        apiKey: provider.api_key,
                        model: model.model_name
                    }
                });
                console.log('[AgentGateBridge] LLM config injected to AgentMoss');
            }
        } catch (err) {
            console.error('[AgentGateBridge] Failed to inject LLM config:', err);
        }
    }

    /** 更新 AgentMoss 配置（用户修改设置时调用） */
    updateConfig(setting: Setting): void {
        this.injectLLMConfig(this.mossState, setting);
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
