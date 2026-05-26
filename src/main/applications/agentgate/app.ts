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

    static getConfigSchema() {
        return z.object({
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

    onConfigChanged(): void {
        super.onConfigChanged();
        AgentGateBridge.getInstance().updateConfig(Setting.getInstance());
    }
}

export { AgentGateApplication };
