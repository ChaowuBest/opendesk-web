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

import { z } from 'zod';
import { BaseApplication } from '../base';
import { AgentGateBridge } from '../../services/agent-gate-bridge';
import { Setting } from '../../utils/setting';

class AgentGateApplication extends BaseApplication {
    constructor() {
        super('agentgate', '安全网关');
    }

    isExperimental(): boolean {
        return true;
    }

    static getConfigSchema() {
        return z.object({
            enabled: z.boolean().default(true).describe('安全网关总开关'),
            securityLevel: z.enum(['low', 'medium', 'high']).default('medium').describe('安全拦截程度'),
            enableLLM: z.boolean().default(true).describe('启用 LLM 深度分析（Layer 3）'),
            llmModel: z.string().default('').describe('分析模型（留空使用默认模型）'),
            customRules: z
                .array(
                    z.object({
                        pattern: z.string().describe('匹配模式（正则表达式）'),
                        action: z.enum(['Allow', 'Deny']).describe('匹配后执行的动作'),
                        severity: z.enum(['low', 'medium', 'high', 'critical']).describe('风险等级')
                    })
                )
                .default([])
                .describe('自定义安全规则')
        });
    }

    /** 供 renderer 通过 callMainWorld 获取可用 LLM 模型列表 */
    getModels(): { alias: string; name: string }[] {
        const data = Setting.getInstance().getData();
        const models: any[] = data.models || [];
        return models.map((m: any) => ({ alias: m.alias, name: m.model_name }));
    }

    /** 供 renderer 保存自定义规则到 App 配置 */
    getCustomRules(): { pattern: string; action: string; severity: string }[] {
        const cfg = this.getConfig() as any;
        return cfg?.customRules || [];
    }

    saveCustomRules(rules: { pattern: string; action: string; severity: string }[]): void {
        this._updateAppConfig({ customRules: rules });
    }

    /** 获取当前数据库路径（未配置时返回 AgentGate 默认路径） */
    getDbPath(): string {
        const cfg = this.getConfig() as any;
        if (cfg?.dbPath) return cfg.dbPath;
        const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
        const xdg = process.env.XDG_DATA_HOME || `${home}/.local/share`;
        return `${xdg}/agent_gate/agent_gate_ts.db`;
    }

    /** 修改数据库路径（触发重启） */
    setDbPath(dbPath: string): void {
        this._updateAppConfig({ dbPath });
    }

    /** 获取安全网关总开关状态 */
    getEnabled(): boolean {
        const cfg = this.getConfig() as any;
        return cfg?.enabled !== false;
    }

    /** 设置安全网关总开关 */
    setEnabled(enabled: boolean): void {
        this._updateAppConfig({ enabled });
        // 实时启动/停止安全网关服务
        this._syncBridgeState();
    }

    /** 获取安全拦截级别 */
    getSecurityLevel(): string {
        const cfg = this.getConfig() as any;
        return cfg?.securityLevel || 'medium';
    }

    /** 设置安全拦截级别 */
    setSecurityLevel(level: 'low' | 'medium' | 'high'): void {
        this._updateAppConfig({ securityLevel: level });
    }

    /** 启用/禁用 LLM 分析 */
    setEnableLLM(enabled: boolean): void {
        this._updateAppConfig({ enableLLM: enabled });
    }

    /** 设置 LLM 超时 */
    setLLMTimeout(timeout: number): void {
        this._updateAppConfig({ llmTimeout: timeout });
    }

    private _updateAppConfig(patch: Record<string, any>): void {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const apps = data.applications || {};
        apps[this.bundleName] = { ...(apps[this.bundleName] || {}), ...patch };
        setting.setData({ ...data, applications: apps });
    }

    /** 根据当前总开关和试验性功能状态启动/停止 bridge */
    private _syncBridgeState(): void {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const expEnabled = !!data?.debug?.experimental_feature;
        const agEnabled = data?.applications?.agentgate?.enabled !== false;
        const bridge = AgentGateBridge.getInstance();
        if (expEnabled && agEnabled && !bridge.isRunning()) {
            bridge.start(setting);
        } else if (!(expEnabled && agEnabled) && bridge.isRunning()) {
            bridge.stop();
        }
    }

    onConfigChanged(): void {
        super.onConfigChanged();
        AgentGateBridge.getInstance().updateConfig(Setting.getInstance());
    }

    /** 获取当前界面语言，供 renderer 使用 */
    getLocale(): string {
        const data = Setting.getInstance().getData() as any;
        const saved = data?.locale || 'auto';
        if (saved === 'auto') {
            const lang = Intl.DateTimeFormat().resolvedOptions().locale;
            return lang.startsWith('zh') ? 'zh-CN' : 'en-US';
        }
        return saved;
    }
}

export { AgentGateApplication };
