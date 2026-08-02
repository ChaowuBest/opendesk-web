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
import { t } from './locale/index.js';
import { AgentGateBridge } from './agent-gate-bridge';
import { AgentGateEventsCache, type AgentGateEvent } from './events-cache';
import { attributeBatchInterceptions, confidenceWeight, sortByConfidenceDesc } from './skillAttribution.js';
import { readInterceptionRecords } from '../skillmgr/blacklist.js';
import { HookRegistry } from '../../aikernel/hooks.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { Setting } from '../../utils/setting';
import { logger } from '../../utils/logger.js';
import AgentGateWorker from './worker';

// 依赖 agent-gate@0.5.4 的存储格式：tool_calls 表 / tool_calls/<session>.json 文件布局。

class AgentGateApplication extends BaseApplication {
    constructor() {
        super('agentgate');
    }

    getName(): string {
        return t('app.name');
    }

    static getWorkerClass() {
        return AgentGateWorker;
    }

    isExperimental(): boolean {
        return false;
    }

    /** 供 renderer 查询 Bridge 运行状态与最近错误（用于在界面上显示启动失败原因） */
    getBridgeStatus() {
        return AgentGateBridge.getInstance().getStatus();
    }

    static getConfigSchema() {
        return z.object({
            enabled: z.boolean().default(false).describe('安全网关总开关'),
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
            floatingWindowEnabled: z.boolean().default(true).describe('浮窗显示开关'),
            floatingWindowOpacity: z.number().min(0.3).max(1.0).default(0.76).describe('浮窗透明度'),
            maliciousSkillDetection: z
                .boolean()
                .default(true)
                .describe('恶意技能检测：拦截归因 + 会话结束弹窗 + 加入黑名单（不影响已存在的黑名单条目）')
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

    /** 获取用户配置的存储类型（不做回退判断，纯读配置） */
    getStorageTypeConfigured(): string {
        const cfg = this.getConfig() as any;
        if (cfg?.storageType) return cfg.storageType;
        // 未配置时：鸿蒙默认 json，其他默认 sqlite
        if ((process.platform as string) === 'openharmony') return 'json';
        return 'sqlite';
    }

    /** 获取实际生效的存储类型（考虑回退：sqlite 不可用时返回 json） */
    getStorageType(): string {
        const configured = this.getStorageTypeConfigured();
        if (configured === 'json') return 'json';
        // sqlite 模式需要 better-sqlite3，不可用时回退 json
        const check = this.checkSqliteAvailable();
        if (!check.available) return 'json';
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

    /**
     * 检测 SQLite 是否可用 —— 复用 AgentGateBridge 的判定，与子进程实际加载行为一致。
     *
     * 之前此方法只搜 extensions 目录且未 import fs（fs 永远 undefined → 抛错被吞 →
     * 永远返回不可用），导致 UI 误报"SQLite 模块不可用"并把"（当前）"标到 JSON，
     * 与后端真实状态（Storage: SQLite）矛盾。
     * 现统一走 bridge.isSqliteAvailable()：搜项目 node_modules + extensions 候选，
     * 判 better-sqlite3 包与 native binding 是否就绪。
     */
    checkSqliteAvailable(): { available: boolean; reason?: string } {
        const available = AgentGateBridge.getInstance().isSqliteAvailable();
        return available
            ? { available: true }
            : { available: false, reason: 'better-sqlite3 模块未安装或 native binding 未编译' };
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
        return cfg?.enabled === true;
    }

    /** 设置安全网关总开关 */
    setEnabled(enabled: boolean): void {
        this._updateAppConfig({ enabled });
        // 实时启动/停止安全网关服务
        this._syncBridgeState();
    }

    /** 获取恶意技能检测开关（拦截归因 + 弹窗 + 黑名单），默认 true */
    getMaliciousSkillDetection(): boolean {
        const cfg = this.getConfig() as any;
        return cfg?.maliciousSkillDetection !== false;
    }

    /** 设置恶意技能检测开关（不启停服务，仅控制恶意 skill 分析链路） */
    setMaliciousSkillDetection(enabled: boolean): void {
        this._updateAppConfig({ maliciousSkillDetection: enabled });
    }

    /**
     * 会话结束后的恶意 skill 归因分析 + 弹窗推送。
     *
     * 流程：终止状态过滤 → 开关判定 → 读取拦截记录 → 确定性归因 → LLM 批量归因 →
     * 补充上下文嫌疑 skill → 按置信度排序 → 推送黑名单弹窗。
     *
     * 主窗口事件推送（attributionStart/End、blacklistPrompt）由调用方通过回调注入，
     * 因为只有 main.ts 持有 globalMainWindow；本方法只負責歸因計算與時機判定。
     *
     * @param task  当前会话的 TaskState
     * @param hooks  可选的事件回调：归因开始/结束/弹窗
     * @param terminationState  beforeFinishTurn 阶段计算的终止状态
     */
    async analyzeAndPromptMaliciousSkills(
        task: TaskState,
        hooks: {
            onAttributionStart?: (taskId: string) => void;
            onAttributionEnd?: (taskId: string) => void;
            onPrompt?: (taskId: string, skills: object[]) => void;
        } = {},
        terminationState?: 'finished' | 'interrupted' | 'question' | null
    ): Promise<void> {
        // 仅在会话真正结束时触发（finished / 用户主动停止），
        // 跳过 question（等待用户回复）和 interrupted（被截断需继续）等中间态
        const ts = terminationState || 'finished';
        if (ts === 'question' || ts === 'interrupted') {
            logger.info(`[AgentGate] Skipping malicious skill detection: session not ended (terminationState=${ts})`);
            return;
        }
        // 恶意技能检测开关关闭时不弹窗（拦截归因在 hook.ts 已被门控，interceptions 不会有新记录，
        // 这里二次校验防止历史记录或开关切换时序导致的误弹）
        if (!this.getMaliciousSkillDetection()) return;

        const allRecords = readInterceptionRecords(task.task_id);
        if (allRecords.length === 0) return;

        // 会话结束时分析整个会话的所有拦截记录，排除 AgentMoss 超时/服务不可用导致的 fail-closed 记录
        const records = allRecords.filter(
            (r) => r.riskType !== 'analysis_timeout' && r.riskType !== 'service_unavailable'
        );
        if (records.length === 0) return;

        // 整理拦截记录中的有归因的 skill 列表
        // 同时收集每个 skill 关联的拦截详情（用于弹窗可折叠展示）
        const skillMap = new Map<
            string,
            {
                reason: string;
                evidence: string;
                confidence: string;
                interceptions: Array<{ toolName: string; reason: string; riskLevel: string }>;
            }
        >();

        // 第一步：确定性归因（CallSkillTool 路径）——直接从记录中读取
        for (const rec of records) {
            const interceptions = [{ toolName: rec.toolName, reason: rec.reason, riskLevel: rec.riskLevel }];
            for (const c of rec.certain || []) {
                const key = `${c.bundleName}/${c.skillName}`;
                if (!skillMap.has(key)) {
                    skillMap.set(key, {
                        reason: rec.reason,
                        evidence: `确定性: 该 skill 的 CallSkillTool 调用被拦截（${rec.toolName}）`,
                        confidence: 'certain',
                        interceptions: []
                    });
                }
                skillMap.get(key)!.interceptions.push(...interceptions);
            }
        }

        // 第二步：LLM 批量归因——将所有拦截记录一次性送入 LLM
        const loadedSkills = task.getLoadedSkillsFromContext();
        const maxInterceptTurn = Math.max(...records.map((r) => r.turn));
        // 加载 turn > 最大拦截 turn 的 skill 不可能驱动任何拦截，完全不传给 LLM（不提、不传内容）
        const llmSkills = loadedSkills.filter((s) => typeof s.bundleName === 'string' && s.turn <= maxInterceptTurn);
        if (llmSkills.length > 0) {
            // 通知 renderer 显示归因分析状态
            hooks.onAttributionStart?.(task.task_id);
            const batchResult = await attributeBatchInterceptions(
                records.map((r) => ({
                    toolName: r.toolName,
                    command: r.command,
                    reason: r.reason,
                    riskLevel: r.riskLevel,
                    turn: r.turn
                })),
                llmSkills.map((s) => ({ bundleName: s.bundleName, skillName: s.skillName, turn: s.turn })),
                task
            );

            // 将批量归因结果写入 skillMap，同时基于 coveredIndices 建立拦截→skill 的精确映射
            const indexToSkillKeys = new Map<number, string[]>(); // 拦截索引 → 哪些 skill 的 key 覆盖了它
            for (const c of batchResult.candidates) {
                const key = `${c.bundleName}/${c.skillName}`;
                const existing = skillMap.get(key);
                if (!existing || confidenceWeight(c.confidence) > confidenceWeight(existing.confidence)) {
                    skillMap.set(key, {
                        reason: `AgentGate 拦截报告`,
                        evidence: c.evidence,
                        confidence: c.confidence,
                        interceptions: existing?.interceptions || []
                    });
                } else if (existing) {
                    // 置信度相同或更低，只累积证据
                    if (c.evidence && !existing.evidence.includes(c.evidence)) {
                        existing.evidence += '\n' + c.evidence;
                    }
                }
                // 记录覆盖关系：coveredIndices 中每条拦截都关联到该 skill
                for (const idx of c.coveredIndices) {
                    const keys = indexToSkillKeys.get(idx);
                    if (keys) {
                        keys.push(key);
                    } else {
                        indexToSkillKeys.set(idx, [key]);
                    }
                }
            }

            // 第三步：基于 coveredIndices 精确关联拦截记录到对应的 skill
            // 确定性归因的 skill 保留第一步已关联的拦截
            // LLM 归因的 skill 只关联 coveredIndices 指定的拦截
            // 未被任何 skill 覆盖的拦截，兜底关联到最高置信度的 skill
            const highestConfidenceKey =
                batchResult.candidates.length > 0
                    ? `${batchResult.candidates[0].bundleName}/${batchResult.candidates[0].skillName}`
                    : null;

            for (let i = 0; i < records.length; i++) {
                const rec = records[i];
                const interception = { toolName: rec.toolName, reason: rec.reason, riskLevel: rec.riskLevel };
                const coveringKeys = indexToSkillKeys.get(i);

                if (coveringKeys && coveringKeys.length > 0) {
                    // 该拦截被 LLM 明确归因到某些 skill
                    for (const key of coveringKeys) {
                        const entry = skillMap.get(key);
                        if (entry && entry.confidence !== 'contextual') {
                            entry.interceptions.push(interception);
                        }
                    }
                } else if (highestConfidenceKey) {
                    // 未被覆盖的拦截，兜底关联到最高置信度的 skill
                    const entry = skillMap.get(highestConfidenceKey);
                    if (entry) {
                        entry.interceptions.push(interception);
                    }
                }
            }
        }

        if (skillMap.size === 0) return;

        // 补充上下文关联嫌疑 skill：本会话已加载、且加载 turn 不晚于拦截 turn 的 skill
        const loadedKeys = new Set(
            loadedSkills.filter((s) => s.turn <= maxInterceptTurn).map((s) => `${s.bundleName}/${s.skillName}`)
        );
        const coveredKeys = new Set(skillMap.keys());
        for (const key of loadedKeys) {
            if (!coveredKeys.has(key)) {
                skillMap.set(key, {
                    reason: '',
                    evidence: '该 skill 在本会话中加载，可能作为攻击前驱参与',
                    confidence: 'contextual',
                    interceptions: []
                });
            }
        }

        const entries = Array.from(skillMap.entries()).map(([key, val]) => ({
            key,
            bundleName: key.split('/')[0],
            skillName: key.split('/')[1],
            ...val
        }));
        // 按置信度排序：certain > high > medium > low > contextual
        sortByConfidenceDesc(entries);

        // 通知 renderer 归因分析结束
        hooks.onAttributionEnd?.(task.task_id);

        // 发送到 renderer 显示弹窗
        hooks.onPrompt?.(
            task.task_id,
            entries.map((e) => ({
                bundleName: e.bundleName,
                skillName: e.skillName,
                confidence: e.confidence,
                evidence: e.evidence,
                reason: e.reason,
                interceptions: e.interceptions
            }))
        );
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

    /** 获取 LLM 深度分析开关状态（默认 true） */
    getEnableLLM(): boolean {
        const cfg = this.getConfig() as any;
        return cfg?.enableLLM !== false;
    }

    /** 启用/禁用 LLM 分析 */
    setEnableLLM(enabled: boolean): void {
        this._updateAppConfig({ enableLLM: enabled });
    }

    /** 获取 LLM 分析模型 alias（空字符串表示用全局默认模型） */
    getLLMModel(): string {
        const cfg = this.getConfig() as any;
        return cfg?.llmModel || '';
    }

    /** 设置 LLM 分析模型 alias（空字符串恢复为全局默认模型） */
    setLLMModel(model: string): void {
        this._updateAppConfig({ llmModel: model || '' });
    }

    /** 获取 LLM 超时（秒），默认 300 */
    getLLMTimeout(): number {
        const cfg = this.getConfig() as any;
        const t = cfg?.llmTimeout;
        return typeof t === 'number' && t >= 10 ? t : 300;
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

    /**
     * 删除指定 id 的 tool_call 记录（真实从 sqlite/json 删除）。
     * 实际删除链路迁至 AgentGateWorker（spawn 子进程 + better-sqlite3 阻塞 IO 不在主进程跑）。
     * 这里只负责收集 dbPath/jsonDataDir 喂给 Worker。
     */
    async deleteToolCalls(ids: number[]): Promise<number> {
        if (!Array.isArray(ids) || ids.length === 0) return 0;
        const clean = Array.from(new Set(ids.map(Number).filter((n) => Number.isInteger(n))));
        if (clean.length === 0) return 0;
        return await this.callWorker('deleteToolCalls', clean, {
            dbPath: this.getDbPath(),
            jsonDataDir: this.getJsonDataDir()
        });
    }

    /**
     * 删除全部 tool_call 记录（真实从 sqlite/json 删除）。委托 Worker。
     */
    async deleteAllToolCalls(): Promise<number> {
        return await this.callWorker('deleteAllToolCalls', {
            dbPath: this.getDbPath(),
            jsonDataDir: this.getJsonDataDir()
        });
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

    /** 根据当前总开关状态启动/停止 bridge */
    private _syncBridgeState(): void {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const agEnabled = data?.applications?.agentgate?.enabled === true;
        const bridge = AgentGateBridge.getInstance();
        if (agEnabled && !bridge.isRunning()) {
            bridge.start(setting);
            // Bridge 启动后，如果浮窗开关已打开，启动 events-cache
            this._syncEventsCacheState();
        } else if (!agEnabled && bridge.isRunning()) {
            bridge.stop();
            // Bridge 停止时同步停止 events-cache
            AgentGateEventsCache.getInstance().stopPolling();
        }
    }

    // ── 主进程生命周期入口（供 main.ts 在 app.whenReady / will-quit / 设置变更时调用） ──
    // 这组方法让主框架不再直接持有 AgentGateBridge / AgentGateEventsCache 单例，
    // 仅经 application 实例方法驱动安全网关运行时。

    /**
     * 启动安全网关运行时（bridge + events-cache 轮询）。
     * 由 main.ts 在 app.whenReady 后调用；是否真正启停由当前配置决定（见 _syncBridgeState）。
     * @param pushCallback  事件推送回调，由调用方注入（main.ts 持有主窗口 webContents）。
     *                       仅在首次启动时设置一次，运行期由缓存内部循环调用。
     */
    startRuntime(
        pushCallback?: (
            events: AgentGateEvent[],
            counts: { totalCount: number; denyCount: number; allowCount: number }
        ) => void
    ): void {
        if (pushCallback) {
            AgentGateEventsCache.getInstance().setPushCallback(pushCallback);
        }
        this._syncBridgeState();
        this._syncEventsCacheState();
    }

    /**
     * 根据当前配置同步安全网关运行时状态（bridge + events-cache）。
     * 由 onConfigChanged 在安全网关配置变更时调用，等价于让 application 读取最新配置决定启停。
     */
    syncRuntimeState(): void {
        this._syncBridgeState();
        this._syncEventsCacheState();
    }

    /**
     * 停止安全网关运行时（bridge 子进程 + events-cache 轮询）。
     * 由 main.ts 在 app.will-quit 时调用，best-effort。
     */
    stopRuntime(): void {
        try {
            AgentGateBridge.getInstance().stop();
        } catch {
            /* best-effort */
        }
        try {
            AgentGateEventsCache.getInstance().stopPolling();
        } catch {
            /* best-effort */
        }
    }

    onConfigChanged(): void {
        super.onConfigChanged();
        AgentGateBridge.getInstance().updateConfig(Setting.getInstance());
        // 配置变更时同步 bridge + events-cache 运行时状态（启停由 _syncBridgeState 根据 enabled 决定）
        this.syncRuntimeState();
    }

    async beforeExit(): Promise<void> {
        this.stopRuntime();
    }

    // ── 平台钩子注册（GUI / CLI 各自调用，将 afterFinishTurn 逻辑收拢到 application 内） ──

    /**
     * 注册 GUI 侧的 afterFinishTurn 钩子：会话结束时做恶意 skill 归因分析并推送弹窗事件。
     * @param notify  IPC 事件推送函数，由 main.ts 注入（持有 globalMainWindow）
     */
    registerGuiHooks(notify: (channel: string, payload: object) => void): void {
        HookRegistry.afterFinishTurn(async (task) => {
            if (task.task_status !== 'stopped') return;
            await this.analyzeAndPromptMaliciousSkills(task, {
                onAttributionStart: (taskId: string) => notify('agentgate:attributionStart', { taskId }),
                onAttributionEnd: (taskId: string) => notify('agentgate:attributionEnd', { taskId }),
                onPrompt: (taskId: string, skills: object[]) => notify('skill:blacklistPrompt', { taskId, skills })
            });
        });
    }

    /**
     * 注册 CLI 侧的 afterFinishTurn 钩子：每次 turn 结束展示本 turn 产生的拦截告警。
     * CLI 无 GUI 弹窗通道，仅做轻量级文本输出。
     */
    registerCliHooks(): void {
        HookRegistry.afterFinishTurn(async (task) => {
            if (task.task_status !== 'stopped') return;
            const allRecords = readInterceptionRecords(task.task_id);
            if (allRecords.length === 0) return;

            // 只取本 turn 新增的拦截记录
            const currentTurn = task.getTurnGeneration ? task.getTurnGeneration() : 0;
            const records = allRecords.filter((r) => r.turn === currentTurn);
            if (records.length === 0) return;

            // 整理 skill 列表（confidenceWeight 与 GUI 侧归因共用，避免散落重复定义）
            const skillMap = new Map<string, { reason: string; evidence: string; confidence: string }>();
            for (const rec of records) {
                for (const c of rec.certain || []) {
                    const key = `${c.bundleName}/${c.skillName}`;
                    if (!skillMap.has(key)) {
                        skillMap.set(key, {
                            reason: rec.reason,
                            evidence: `确定性归因: ${rec.toolName} 被拦截`,
                            confidence: 'certain'
                        });
                    }
                }
                for (const s of rec.suspected || []) {
                    const key = `${s.bundleName}/${s.skillName}`;
                    const existing = skillMap.get(key);
                    if (!existing || confidenceWeight(s.confidence) > confidenceWeight(existing.confidence)) {
                        skillMap.set(key, { reason: rec.reason, evidence: s.evidence, confidence: s.confidence });
                    }
                }
            }

            if (skillMap.size === 0) return;

            // 补充上下文关联嫌疑 skill
            const loadedKeys = new Set(task.getLoadedSkillsFromContext().map((s) => `${s.bundleName}/${s.skillName}`));
            const coveredKeys = new Set(skillMap.keys());
            for (const key of loadedKeys) {
                if (!coveredKeys.has(key)) {
                    skillMap.set(key, {
                        reason: '',
                        evidence: '该 skill 在本会话中加载，可能作为攻击前驱参与',
                        confidence: 'contextual'
                    });
                }
            }

            const entries = Array.from(skillMap.entries()).sort(
                (a, b) => confidenceWeight(b[1].confidence) - confidenceWeight(a[1].confidence)
            );

            console.warn('\n⚠️  检测到疑似恶意技能');
            console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            for (const [key, val] of entries) {
                const tag =
                    val.confidence === 'certain'
                        ? '【确定】'
                        : val.confidence === 'high'
                          ? '【高置信】'
                          : val.confidence === 'medium'
                            ? '【中置信】'
                            : val.confidence === 'contextual'
                              ? '【上下文】'
                              : '【低置信】';
                console.warn(`  ${tag} ${key}`);
                console.warn(`     ${val.evidence}`);
            }
            console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.warn('💡 如需查看详情或管理黑名单，请使用 GUI 模式或访问 skill 管理中心。\n');
        });
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
