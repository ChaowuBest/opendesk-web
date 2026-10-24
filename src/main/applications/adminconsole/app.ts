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

import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BaseApplication } from '../base.js';
import { BaseToolset } from '../../aikernel/tool';
import { Skill, SkillRegistry } from '../../aikernel/skill.js';
import { getPlatform } from '../../../platforms/base.js';
import { logger } from '../../utils/logger.js';
import {
    fetchAdminDailyStats,
    fetchAdminFeedbackDetail,
    fetchAdminFeedbackList,
    fetchAdminSummaryStats,
    resolveAdminStatsServerUrl,
    type AdminFeedbackDetail,
    type AdminFeedbackList
} from '../../utils/admin-stats.js';
import { AdminTokenStore } from '../../utils/admin-token.js';
import { t } from './locale/index.js';
import {
    DownloadAttachmentTool,
    GetBugDetailsTool,
    GetRequirementDetailsTool,
    ListRecentBugsTool,
    ListRecentRequirementsTool
} from './tools.js';
import { ADMIN_CONSOLE_SKILL } from './skills.js';

const require = createRequire(import.meta.url);

/**
 * 惰性加载 electron 模块：应用类会在非 Electron 运行时（worker / CLI）中被导入，
 * 顶层 import 'electron' 会在这些环境里失败。
 */
function getElectronModule<T>(name: 'app' | 'dialog' | 'safeStorage' | 'BrowserWindow'): T {
    try {
        return require('electron')[name] as T;
    } catch {
        throw new Error(`electron.${name} is not available on this platform`);
    }
}

/** IPC 统一返回结构，renderer 侧据此还原错误码（如 401 → unauthorized） */
type AdminResult<T = unknown> = { status: string; data?: T; code?: string; message?: string };

/**
 * 管理后台：OpenDesk 站点运营数据（活跃设备 / 用户反馈），仅供开发者从「调试」菜单进入。
 * showIcon=false 使其不出现在应用列表，令牌经 safeStorage 加密落盘（不可用时仅会话内有效），
 * 统计与反馈接口在 main 侧经 Platform fetch 请求，以继承代理与 no_ssl 配置并规避 CORS。
 */
export class AdminConsoleApplication extends BaseApplication {
    constructor() {
        super('adminconsole', false);
    }

    getName(): string {
        return t('app.name');
    }

    private tokenStore: AdminTokenStore | null = null;

    private getTokenStore(): AdminTokenStore {
        if (!this.tokenStore) {
            const safeStorage = () => getElectronModule<any>('safeStorage');
            this.tokenStore = new AdminTokenStore(path.join(this.getDataDirectory(), 'admin-token.enc'), {
                available: () => {
                    try {
                        const storage = safeStorage();
                        return typeof storage?.isEncryptionAvailable === 'function' && storage.isEncryptionAvailable();
                    } catch {
                        return false;
                    }
                },
                encrypt: (value) => safeStorage().encryptString(value),
                decrypt: (value) => safeStorage().decryptString(value)
            });
        }
        return this.tokenStore;
    }

    /** 仅本地调试地址直连，生产环境继承代理配置 */
    private isLocalServer(url: string): boolean {
        try {
            const hostname = new URL(url).hostname;
            return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
        } catch {
            return false;
        }
    }

    private fetchImpl = (input: string | URL, init?: RequestInit): Promise<Response> =>
        getPlatform().fetch(input, init, {
            bypassProxy: this.isLocalServer(typeof input === 'string' ? input : input.href)
        });

    private currentToken(serverUrl: string): string | null {
        const store = this.getTokenStore();
        return store.loadSession(serverUrl) ?? store.load(serverUrl);
    }

    /**
     * 请求目标服务器：最近一次授权绑定的服务器优先（授权页可改，本地调试不依赖环境变量），
     * 无历史授权时回退环境变量覆盖值/生产地址。
     */
    private currentServer(): string {
        const store = this.getTokenStore();
        const last = store.lastSessionServer() ?? store.lastPersistedServer() ?? resolveAdminStatsServerUrl();
        // 规范化为带协议的完整地址，便于直接拼接 API 路径
        return /^https?:\/\//.test(last) ? last.replace(/\/+$/, '') : `https://${last}`;
    }

    getServerUrl(): AdminResult<string> {
        return { status: 'ok', data: this.currentServer() };
    }

    loadToken(serverUrl: string): AdminResult<{ token: string | null; canPersist: boolean }> {
        try {
            const store = this.getTokenStore();
            return {
                status: 'ok',
                data: {
                    token: this.currentToken(
                        typeof serverUrl === 'string' && serverUrl ? serverUrl : this.currentServer()
                    ),
                    canPersist: store.canPersist()
                }
            };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }

    async verifyToken(serverUrl: string, token: string): Promise<AdminResult> {
        try {
            let server = typeof serverUrl === 'string' && serverUrl ? serverUrl.trim() : this.currentServer();
            if (!/^https?:\/\//.test(server)) server = `https://${server}`;
            server = server.replace(/\/+$/, '');
            const trimmed = String(token ?? '').trim();
            if (!trimmed) return { status: 'error', code: 'invalid', message: 'empty token' };
            await fetchAdminSummaryStats(trimmed, server, { fetchImpl: this.fetchImpl });
            const store = this.getTokenStore();
            store.setSession(server, trimmed);
            try {
                store.save(server, trimmed);
            } catch (persistError: any) {
                logger.warn('persisting admin token failed', persistError);
            }
            this.notifySkillRegistryChanged();
            return { status: 'ok' };
        } catch (error: any) {
            const status = error && typeof error === 'object' && 'status' in error ? error.status : 0;
            return {
                status: 'error',
                code: status === 401 ? 'unauthorized' : 'server_error',
                message: error?.message ?? String(error)
            };
        }
    }

    clearToken(): AdminResult {
        try {
            const store = this.getTokenStore();
            store.clear();
            store.clearSession();
            this.notifySkillRegistryChanged();
            return { status: 'ok' };
        } catch (error: any) {
            logger.error('clearing admin token failed', error);
            return { status: 'error', message: error.message };
        }
    }

    /** 统一的带令牌请求入口：未授权直接返回 unauthorized，401 归一化为 unauthorized */
    private async withAdminApi(handler: (serverUrl: string, token: string) => Promise<unknown>): Promise<AdminResult> {
        const serverUrl = this.currentServer();
        const token = this.currentToken(serverUrl);
        if (!token) {
            return { status: 'error', code: 'unauthorized', message: 'admin token is not authorized' };
        }
        try {
            return { status: 'ok', data: await handler(serverUrl, token) };
        } catch (error: any) {
            if (error && typeof error === 'object' && 'status' in error) {
                return {
                    status: 'error',
                    code: error.status === 401 ? 'unauthorized' : error.status === 404 ? 'not_found' : 'server_error',
                    message: error.message
                };
            }
            logger.error('admin api request failed', error);
            return { status: 'error', code: 'unknown', message: error?.message ?? String(error) };
        }
    }

    getDailyStats(days: number): Promise<AdminResult> {
        return this.withAdminApi((serverUrl, token) =>
            fetchAdminDailyStats(token, days, serverUrl, { fetchImpl: this.fetchImpl })
        );
    }

    getSummaryStats(): Promise<AdminResult> {
        return this.withAdminApi((serverUrl, token) =>
            fetchAdminSummaryStats(token, serverUrl, { fetchImpl: this.fetchImpl })
        );
    }

    getFeedbackList(limit: number): Promise<AdminResult> {
        return this.withAdminApi((serverUrl, token) =>
            fetchAdminFeedbackList(token, limit, serverUrl, { fetchImpl: this.fetchImpl })
        );
    }

    /**
     * 需求（feature）/ 缺陷（bug）分页列表：类型过滤与分页均由服务端完成，
     * total 为过滤后的总条数，客户端翻页用 offset += limit 直到取满 total。
     */
    async listFeedbackByType(type: 'feature' | 'bug', limit: number, offset = 0): Promise<AdminResult> {
        const count = Math.max(1, Math.min(Math.trunc(Number(limit)) || 20, 100));
        const page = Math.max(0, Math.trunc(Number(offset)) || 0);
        const result = await this.withAdminApi((serverUrl, token) =>
            fetchAdminFeedbackList(token, count, serverUrl, { fetchImpl: this.fetchImpl }, { type, offset: page })
        );
        if (result.status !== 'ok') return result;
        const data = result.data as AdminFeedbackList;
        // 旧版服务端会忽略 type 参数返回混合类型，客户端兜底过滤保证结果始终与 type 一致
        const items = (data.items ?? []).filter((item) => item.type === type);
        return {
            status: 'ok',
            data: { type, count: items.length, total: data.total ?? items.length, offset: page, items }
        };
    }

    /** 按 id 查询单条反馈详情：走服务端 detail 接口，不受列表分页范围限制 */
    async getFeedbackDetail(type: 'feature' | 'bug', id: number): Promise<AdminResult> {
        const result = await this.withAdminApi((serverUrl, token) =>
            fetchAdminFeedbackDetail(token, id, serverUrl, { fetchImpl: this.fetchImpl })
        );
        if (result.status !== 'ok') return result;
        const item = (result.data as AdminFeedbackDetail).item;
        if (item.type !== type) {
            return {
                status: 'error',
                code: 'type_mismatch',
                message: `feedback #${id} is type '${item.type}', not '${type}'`
            };
        }
        return { status: 'ok', data: item };
    }

    /** /admin 技能捆绑的工具集，agent 加载技能后才暴露给模型 */
    private buildAgentToolset(): BaseToolset {
        const toolset = new BaseToolset('adminconsole');
        toolset.addTools(
            new ListRecentRequirementsTool(this),
            new GetRequirementDetailsTool(this),
            new ListRecentBugsTool(this),
            new GetBugDetailsTool(this),
            new DownloadAttachmentTool(this)
        );
        return toolset;
    }

    /**
     * 仅在登录态（最近一次授权服务器存在合法 admin token，令牌在 verifyToken 时已校验通过）时
     * 注册 /admin 技能，未授权时不注册，避免 agent 触发必然 unauthorized 的调用。
     * 授权状态变化时需调用 notifySkillRegistryChanged 失效技能列表缓存。
     */
    async getSkills(): Promise<Skill[]> {
        if (!this.currentToken(this.currentServer())) return [];
        const skill = Skill.parseMd(ADMIN_CONSOLE_SKILL);
        skill.toolsets = [this.buildAgentToolset()];
        return [skill];
    }

    /** 授权状态变化后失效技能注册表缓存，使 /admin 技能立即可见或消失 */
    private notifySkillRegistryChanged(): void {
        try {
            SkillRegistry.getInstance().clearCache(this.bundleName);
        } catch (error: any) {
            logger.warn('clearing adminconsole skill cache failed', error);
        }
    }

    /** 附件含敏感数据且下载地址需要令牌，故由 main 携带令牌下载后经系统保存对话框落盘，
     * 不向 renderer 暴露可独立访问的 URL。 */
    async downloadAttachment(attachmentId: number, filename: string): Promise<AdminResult> {
        try {
            const serverUrl = this.currentServer();
            const token = this.currentToken(serverUrl);
            if (!token) return { status: 'error', code: 'unauthorized', message: 'admin token is not authorized' };
            const id = Number(attachmentId);
            if (!Number.isInteger(id) || id <= 0) return { status: 'error', message: 'invalid attachment id' };
            const url = `${serverUrl.replace(/\/+$/, '')}/api/feedback/attachment/${id}`;
            const dialog = getElectronModule<Electron.Dialog>('dialog');
            const dialogOptions: Electron.SaveDialogOptions = {
                defaultPath: path.join(
                    getElectronModule<Electron.App>('app').getPath('downloads'),
                    typeof filename === 'string' && filename ? filename : 'attachment'
                )
            };
            const parent = getElectronModule<typeof import('electron').BrowserWindow>('BrowserWindow')
                .getAllWindows()
                .find((win) => !win.isDestroyed());
            const result = parent
                ? await dialog.showSaveDialog(parent, dialogOptions)
                : await dialog.showSaveDialog(dialogOptions);
            if (result.canceled || !result.filePath) {
                return { status: 'ok', data: { canceled: true } };
            }
            const response = await this.fetchImpl(url, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!response.ok) return { status: 'error', message: `HTTP ${response.status}` };
            const buffer = Buffer.from(await response.arrayBuffer());
            await fsPromises.writeFile(result.filePath, buffer);
            return { status: 'ok', data: { canceled: false, filePath: result.filePath } };
        } catch (error: any) {
            logger.error('downloading admin attachment failed', error);
            return { status: 'error', message: error.message };
        }
    }

    /**
     * agent 工具的下载通道：直接落盘到调用方给定的绝对路径（写权限由工具权限审批把关），
     * 与面向 renderer 面板的 downloadAttachment（交互式保存对话框）区分开。
     */
    async downloadAttachmentToFile(attachmentId: number, destPath: string): Promise<AdminResult> {
        try {
            const serverUrl = this.currentServer();
            const token = this.currentToken(serverUrl);
            if (!token) return { status: 'error', code: 'unauthorized', message: 'admin token is not authorized' };
            const id = Number(attachmentId);
            if (!Number.isInteger(id) || id <= 0) return { status: 'error', message: 'invalid attachment id' };
            if (!destPath) return { status: 'error', message: 'dest path is required' };
            const url = `${serverUrl.replace(/\/+$/, '')}/api/feedback/attachment/${id}`;
            const response = await this.fetchImpl(url, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!response.ok) return { status: 'error', message: `HTTP ${response.status}` };
            const buffer = Buffer.from(await response.arrayBuffer());
            await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
            await fsPromises.writeFile(destPath, buffer);
            return {
                status: 'ok',
                data: { filePath: destPath, size: buffer.length, contentType: response.headers.get('content-type') }
            };
        } catch (error: any) {
            logger.error('downloading admin attachment to file failed', error);
            return { status: 'error', message: error.message };
        }
    }
}
