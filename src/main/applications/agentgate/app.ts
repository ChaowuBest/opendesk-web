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
import path from 'path';
import fs from 'fs';
import { BaseApplication } from '../base';
import { AgentGateBridge } from '../../services/agent-gate-bridge';
import { AgentGateEventsCache, type AgentGateEvent } from './events-cache';
import { Setting } from '../../utils/setting';
import { getExtensionsDir } from '../../plugins/manager';

class AgentGateApplication extends BaseApplication {
    constructor() {
        super('agentgate', '安全网关');
    }

    isExperimental(): boolean {
        return true;
    }

    /** 供 renderer 查询 Bridge 运行状态与最近错误（用于在界面上显示启动失败原因） */
    getBridgeStatus() {
        return AgentGateBridge.getInstance().getStatus();
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
                .describe('自定义安全规则'),
            storageType: z
                .enum(['sqlite', 'json'])
                .default('sqlite')
                .describe('存储类型：sqlite 或 json（鸿蒙默认 json）'),
            dbPath: z.string().default('').describe('SQLite 数据库路径（空则使用默认值）'),
            jsonDataDir: z.string().default('').describe('JSON 文件存储目录（空则使用默认值）'),
            floatingWindowEnabled: z.boolean().default(false).describe('浮窗显示开关'),
            floatingWindowOpacity: z.number().min(0.3).max(1.0).default(0.76).describe('浮窗透明度')
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

    /** 获取当前存储类型（未配置时：鸿蒙默认 json，其他默认 sqlite；sqlite 不可用时回退 json） */
    getStorageType(): string {
        const cfg = this.getConfig() as any;
        const configured = cfg?.storageType;
        if (configured === 'json') return 'json';
        if (configured === 'sqlite') {
            // sqlite 模式需要 better-sqlite3，不可用时回退 json
            const check = this.checkSqliteAvailable();
            if (!check.available) return 'json';
            return 'sqlite';
        }
        // 未配置时：鸿蒙默认 json，其他默认 sqlite（但 sqlite 不可用时回退 json）
        if ((process.platform as string) === 'openharmony') return 'json';
        const defaultCheck = this.checkSqliteAvailable();
        if (!defaultCheck.available) return 'json';
        return 'sqlite';
    }

    /** 设置存储类型（触发重启） */
    setStorageType(storageType: string): void {
        this._updateAppConfig({ storageType });
        this._syncBridgeState();
    }

    /** 获取当前 JSON 文件存储目录（未配置时返回默认值） */
    getJsonDataDir(): string {
        const cfg = this.getConfig() as any;
        if (cfg?.jsonDataDir) return cfg.jsonDataDir;
        return AgentGateBridge.getInstance().getAgentGateDataDir();
    }

    /** 设置 JSON 文件存储目录（触发重启） */
    setJsonDataDir(jsonDataDir: string): void {
        this._updateAppConfig({ jsonDataDir });
        this._syncBridgeState();
    }

    /** 检测 SQLite 是否可用（尝试在 agent-gate 安装目录中查找 better-sqlite3） */
    checkSqliteAvailable(): { available: boolean; reason?: string } {
        const extDir = getExtensionsDir();
        const sqlitePaths = [
            path.join(extDir, 'node_modules', '@kenhkl', 'agent-gate', 'node_modules', 'better-sqlite3'),
            path.join(extDir, 'node_modules', 'better-sqlite3')
        ];
        for (const p of sqlitePaths) {
            try {
                if (fs.existsSync(path.join(p, 'package.json'))) {
                    // 检查 native binding 是否存在
                    const prebuildsDir = path.join(p, 'prebuilds');
                    const buildDir = path.join(p, 'build');
                    if (fs.existsSync(prebuildsDir) || fs.existsSync(buildDir)) {
                        return { available: true };
                    }
                    return { available: false, reason: 'better-sqlite3 native binding 未编译' };
                }
            } catch {}
        }
        return { available: false, reason: 'better-sqlite3 模块未安装' };
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

    /** 获取浮窗配置（enabled + opacity） */
    getFloatingWindowConfig(): { enabled: boolean; opacity: number } {
        const cfg = this.getConfig() as any;
        return {
            enabled: cfg?.floatingWindowEnabled === true,
            opacity: cfg?.floatingWindowOpacity ?? 0.76
        };
    }

    /** 设置浮窗显示开关（同步启停 events-cache 轮询） */
    setFloatingWindowEnabled(enabled: boolean): void {
        this._updateAppConfig({ floatingWindowEnabled: enabled });
        this._syncEventsCacheState();
    }

    /** 设置浮窗透明度 */
    setFloatingWindowOpacity(opacity: number): void {
        this._updateAppConfig({ floatingWindowOpacity: opacity });
    }

    /** 获取最近事件列表（供渲染进程一次性获取用于初始化） */
    getRecentEvents(): AgentGateEvent[] {
        return AgentGateEventsCache.getInstance().getRecentEvents();
    }

    /** 获取 AgentGate Dashboard URL（供浮窗跳转） */
    getDashboardUrl(): string {
        const bridge = AgentGateBridge.getInstance();
        const status = bridge.getStatus();
        const gatePort = status.gatePort || 9100;
        return `http://127.0.0.1:${gatePort}/dashboard/`;
    }

    /** 根据浮窗开关与 AgentGate 运行状态启停 events-cache 轮询 */
    private _syncEventsCacheState(): void {
        const shouldPoll = AgentGateEventsCache.shouldPoll();
        const bridge = AgentGateBridge.getInstance();
        const bridgeRunning = bridge.isRunning();
        const cache = AgentGateEventsCache.getInstance();

        if (shouldPoll && bridgeRunning && !cache.isPolling()) {
            cache.startPolling();
        } else if (!(shouldPoll && bridgeRunning) && cache.isPolling()) {
            cache.stopPolling();
        }
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
            // Bridge 启动后，如果浮窗开关已打开，启动 events-cache
            this._syncEventsCacheState();
        } else if (!(expEnabled && agEnabled) && bridge.isRunning()) {
            bridge.stop();
            // Bridge 停止时同步停止 events-cache
            AgentGateEventsCache.getInstance().stopPolling();
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
