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
import os from 'os';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { findExecutableInPath } from '../../utils/shellExec.js';
import { BaseApplication } from '../base';
import { AgentGateBridge } from '../../services/agent-gate-bridge';
import { AgentGateEventsCache, type AgentGateEvent } from './events-cache';
import { Setting } from '../../utils/setting';
import { getExtensionsDir } from '../../plugins/manager';
import { logger } from '../../utils/logger.js';

// 依赖 agent-gate@0.5.4 的存储格式：tool_calls 表 / tool_calls/<session>.json 文件布局。

/**
 * 纯 node 子进程删除脚本（内联，运行时写入临时文件执行）。
 * 主进程是 Electron，加载了 canvas，其旧 libstdc++.so.6 劫持 better-sqlite3 native binding
 * 依赖解析（GLIBCXX_3.4.29 not found）。纯 node 子进程不加载 canvas，能正常加载 better-sqlite3。
 * 脚本枚举多个 binding 路径，逐个尝试 process.dlopen，绕过 bindings 模块的 ABI 自动选择
 * （binding 可能放错目录）。输出 JSON 到 stdout：{ ok, deleted, binding?, error? }
 */
const DELETE_HELPER_SCRIPT = `'use strict';
const args = process.argv.slice(2);
const dbPath = args[0];
const idsJson = args[1] || '[]';
const bsDir = args[2] || '';
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
if (!dbPath) out({ ok: false, deleted: 0, error: 'missing dbPath' });
let ids;
try { ids = JSON.parse(idsJson); } catch (e) { out({ ok: false, deleted: 0, error: 'bad ids' }); }
const deleteAll = !Array.isArray(ids) || ids.length === 0;
const cleanIds = deleteAll ? [] : Array.from(new Set(ids.map(Number).filter((n) => Number.isInteger(n))));
const fs = require('fs');
const path = require('path');
if (!fs.existsSync(dbPath)) out({ ok: false, deleted: 0, error: 'db not found' });
// 候选 better-sqlite3 包入口（走 JS 包装层，不要直接 dlopen .node——会跳过 Database 类的校验逻辑）。
// 优先 agent-moss nested（版本 11，ABI 可能与系统 node 匹配），再 OpenDesk 根（版本 12，Electron ABI）。
const pkgCandidates = [];
if (bsDir) {
  // bsDir = .../node_modules/better-sqlite3；dirname 上跳到 node_modules 层
  const nmDir = path.dirname(path.dirname(bsDir));
  pkgCandidates.push(path.join(nmDir, '@kenhkl', 'agent-moss', 'node_modules', 'better-sqlite3', 'lib', 'index.js'));
  pkgCandidates.push(path.join(bsDir, 'lib', 'index.js'));
}
// 也试标准 require（让 node 自己解析）
pkgCandidates.push('better-sqlite3');
let DatabaseCtor = null, loadedFrom = '', lastErr = '';
for (const c of pkgCandidates) {
  try {
    const mod = c === 'better-sqlite3' ? require('better-sqlite3') : require(c);
    // better-sqlite3 导出 Database 类本身（函数），可能附加 .SqliteError
    const Ctor = typeof mod === 'function' ? mod : (mod && mod.Database);
    if (typeof Ctor === 'function') { DatabaseCtor = Ctor; loadedFrom = c; break; }
    lastErr = 'no Database ctor in ' + c;
  } catch (e) { lastErr = String(e).split(String.fromCharCode(10))[0]; continue; }
}
if (!DatabaseCtor) out({ ok: false, deleted: 0, error: 'no usable better-sqlite3: ' + lastErr });
let db = null;
try {
  db = new DatabaseCtor(dbPath);
  let r;
  if (deleteAll) r = db.prepare('DELETE FROM tool_calls').run();
  else { const ph = cleanIds.map(() => '?').join(','); r = db.prepare('DELETE FROM tool_calls WHERE id IN (' + ph + ')').run(...cleanIds); }
  out({ ok: true, deleted: Number(r.changes || 0), binding: loadedFrom });
} catch (e) { out({ ok: false, deleted: 0, error: 'db op: ' + String(e).split(String.fromCharCode(10))[0], binding: loadedFrom }); }
finally { try { db && db.close(); } catch (e) {} }
`;

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

    /**
     * 删除指定 id 的 tool_call 记录（真实从 sqlite/json 删除）。
     * 直接操作 agent-gate 的存储（依赖 agent-gate@0.5.4 存储格式）。
     * 返回实际删除条数。
     *
     * sqlite 删除走 spawn 纯 node 子进程：主进程是 Electron，加载了 canvas，其自带旧
     * libstdc++.so.6 劫持 better-sqlite3 native binding 依赖解析（GLIBCXX_3.4.29 not found）。
     * 改用 Electron-as-node 子进程（ABI 匹配 binding + 纯 node 模式不加载 canvas）执行删除。
     * json 删除是纯文件操作，主进程直接做。两边都试，合并命中数。
     */
    async deleteToolCalls(ids: number[]): Promise<number> {
        if (!Array.isArray(ids) || ids.length === 0) return 0;
        const clean = Array.from(new Set(ids.map(Number).filter((n) => Number.isInteger(n))));
        if (clean.length === 0) return 0;
        let deleted = 0;
        try {
            deleted += await this._deleteSqliteViaSpawn(clean);
        } catch (e) {
            logger.warn(`[AgentGate] deleteToolCalls sqlite threw: ${String(e)}`);
        }
        deleted += this._deleteToolCallsJson(clean);
        logger.info(`[AgentGate] deleteToolCalls ids=${JSON.stringify(clean)} deleted=${deleted}`);
        return deleted;
    }

    /**
     * 删除全部 tool_call 记录（真实从 sqlite/json 删除）。两边都尝试。
     */
    async deleteAllToolCalls(): Promise<number> {
        let deleted = 0;
        try {
            deleted += await this._deleteSqliteViaSpawn([]);
        } catch (e) {
            logger.warn(`[AgentGate] deleteAllToolCalls sqlite threw: ${String(e)}`);
        }
        deleted += this._deleteAllToolCallsJson();
        logger.info(`[AgentGate] deleteAllToolCalls deleted=${deleted}`);
        return deleted;
    }

    /**
     * spawn 纯 node 子进程执行 sqlite 删除（绕开主进程 canvas libstdc++ 冲突）。
     * ids 为空数组表示删除全部。返回实际删除条数。
     */
    private _deleteSqliteViaSpawn(ids: number[]): Promise<number> {
        const dbPath = this.getDbPath();
        if (!fs.existsSync(dbPath)) return Promise.resolve(0);
        const idsJson = JSON.stringify(ids);
        // 解析 OpenDesk 根 better-sqlite3 目录，传给子进程作为 binding 搜索起点
        let bsDir = '';
        try {
            const req = createRequire(import.meta.url);
            bsDir = path.dirname(req.resolve('better-sqlite3/package.json'));
        } catch {
            bsDir = '';
        }
        return this._spawnNodeDelete(dbPath, idsJson, bsDir).then((result) => {
            if (!result.ok) {
                logger.warn(`[AgentGate] delete-helper failed: ${result.error || 'unknown'}`);
                return 0;
            }
            return Number(result.deleted || 0);
        });
    }

    /**
     * spawn 一个纯 node 子进程跑内联删除脚本，解析其 stdout JSON 输出。
     *
     * node 选择：better-sqlite3 的 binding 都是 Electron ABI（140/141），系统 node（ABI 137）
     * 一个都加载不了，所以必须用 Electron-as-node（ELECTRON_RUN_AS_NODE=1，ABI 141 匹配）。
     * Electron-as-node 是纯 node 模式，不初始化 Chromium/不加载 canvas，无 GLIBCXX 冲突。
     * 系统 node 仅作备选（理论上加载不了任何 binding，但保留以防 ABI 重新编译过）。
     */
    private _spawnNodeDelete(dbPath: string, idsJson: string, bsDir: string): Promise<any> {
        return new Promise((resolve) => {
            // 写内联脚本到临时文件
            let helperPath = '';
            try {
                helperPath = path.join(os.tmpdir(), `ag-delete-${process.pid}-${Date.now()}.js`);
                fs.writeFileSync(helperPath, DELETE_HELPER_SCRIPT, 'utf-8');
            } catch (e) {
                resolve({ ok: false, deleted: 0, error: `write helper failed: ${String(e)}` });
                return;
            }
            const cleanup = () => {
                try {
                    fs.unlinkSync(helperPath);
                } catch {}
            };
            // 候选 node：Electron-as-node 优先（ABI 匹配 binding），系统 node 备选
            const nodeCandidates: { path: string; env: Record<string, string> }[] = [];
            if (process.execPath && fs.existsSync(process.execPath)) {
                nodeCandidates.push({ path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
            }
            const sysNode = process.env.NODE_BINARY || findExecutableInPath('node');
            if (sysNode && fs.existsSync(sysNode)) {
                nodeCandidates.push({ path: sysNode, env: {} });
            }
            if (nodeCandidates.length === 0) {
                cleanup();
                resolve({ ok: false, deleted: 0, error: 'no node available' });
                return;
            }
            const tryCandidate = (idx: number) => {
                if (idx >= nodeCandidates.length) {
                    cleanup();
                    resolve({ ok: false, deleted: 0, error: 'all node candidates failed' });
                    return;
                }
                const { path: nodePath, env } = nodeCandidates[idx];
                const isLast = idx === nodeCandidates.length - 1;
                const child = spawn(nodePath, [helperPath, dbPath, idsJson, bsDir], {
                    env: { ...process.env, ...env },
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                let stdout = '';
                let stderr = '';
                child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
                child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
                child.on('error', () => {
                    if (!isLast) tryCandidate(idx + 1);
                    else {
                        cleanup();
                        resolve({ ok: false, deleted: 0, error: 'spawn error' });
                    }
                });
                child.on('close', (code) => {
                    // 脚本成功时 stdout 有 JSON（即使 binding 加载失败也返回 JSON with ok:false）。
                    // 只有 spawn 本身失败（非 0 且无 stdout）才换下一个 node 候选。
                    if (stdout.trim()) {
                        cleanup();
                        try {
                            resolve(JSON.parse(stdout.trim()));
                        } catch (e) {
                            resolve({ ok: false, deleted: 0, error: `parse stdout failed: ${String(e)}` });
                        }
                        return;
                    }
                    if (!isLast) {
                        logger.info(`[AgentGate] delete-helper node ${nodePath} failed, trying next`);
                        tryCandidate(idx + 1);
                    } else {
                        cleanup();
                        resolve({
                            ok: false,
                            deleted: 0,
                            error: `exit ${code} stderr=${stderr.slice(0, 300)}`
                        });
                    }
                });
            };
            tryCandidate(0);
        });
    }

    /** json：扫描 tool_calls/<session>.json，按 id 过滤后原子写回（先 .tmp 再 rename）。 */
    private _deleteToolCallsJson(ids: number[]): number {
        const dir = path.join(this.getJsonDataDir(), 'tool_calls');
        if (!fs.existsSync(dir)) return 0;
        const idSet = new Set(ids);
        let deleted = 0;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
            const fp = path.join(dir, file);
            try {
                const records = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                if (!Array.isArray(records)) continue;
                const after = records.filter((r: any) => !idSet.has(Number(r.id)));
                const removed = records.length - after.length;
                if (removed === 0) continue;
                const tmp = fp + '.tmp';
                fs.writeFileSync(tmp, JSON.stringify(after, null, 2), 'utf-8');
                fs.renameSync(tmp, fp);
                deleted += removed;
            } catch {
                /* 跳过损坏文件 */
            }
        }
        return deleted;
    }

    /** json：把每个 session 文件清空为 []。 */
    private _deleteAllToolCallsJson(): number {
        const dir = path.join(this.getJsonDataDir(), 'tool_calls');
        if (!fs.existsSync(dir)) return 0;
        let deleted = 0;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
            const fp = path.join(dir, file);
            try {
                const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                if (!Array.isArray(arr)) continue;
                deleted += arr.length;
                const tmp = fp + '.tmp';
                fs.writeFileSync(tmp, '[]', 'utf-8');
                fs.renameSync(tmp, fp);
            } catch {
                /* 跳过损坏文件 */
            }
        }
        return deleted;
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
