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

/**
 * 管理员面板服务端 API 客户端：访问 OpenDesk-Pages 的管理员接口
 * （/api/stats/daily、/api/feedback/list、/api/feedback/attachment/:id）。
 *
 * 放在 main 侧的原因与 feedback.ts 一致：
 *   - renderer 页面以 file:// 加载，跨源请求依赖 CORS；
 *   - 走 getPlatform().fetch 才能继承 OpenDesk 的代理与 no_ssl 网络配置。
 *
 * 服务端约定（见 OpenDesk-Pages src/server/lib/auth.js）：
 *   Authorization: Bearer <token>（或 x-admin-token 头）与 env.ADMIN_TOKEN 一致，
 *   401 = 令牌错误，503 = 服务端未配置令牌或无数据库。
 */

export const ADMIN_STATS_SERVER_URL = 'https://opendesk.matrix.openharmony.cn';

/** 本地调试 Pages 时通过该环境变量覆盖服务地址，如 http://127.0.0.1:8788 */
export const ADMIN_STATS_SERVER_URL_ENV = 'OPENDESK_ADMIN_STATS_SERVER';

/** 管理员令牌（不含 Bearer 前缀） */
export type AdminToken = string;

export function resolveAdminStatsServerUrl(env: NodeJS.ProcessEnv = process.env): string {
    const override = env[ADMIN_STATS_SERVER_URL_ENV];
    if (override && override.trim()) return override.trim().replace(/\/+$/, '');
    return ADMIN_STATS_SERVER_URL;
}

export interface AdminDailyPoint {
    day: string;
    devices: number;
    by_type: Record<string, number>;
}

export interface AdminDailyStats {
    ok: true;
    days: number;
    range: { start: string; end: string; today_start: string };
    points: AdminDailyPoint[];
}

export interface AdminFeedbackItem {
    id: number;
    type: 'feature' | 'bug';
    content: string;
    contact: string | null;
    time: string;
    attachments: Array<{ attachment_id: number; filename: string }>;
}

export interface AdminFeedbackList {
    ok: true;
    items: AdminFeedbackItem[];
    /** 按 type 过滤后的总条数（供分页翻页） */
    total?: number;
    limit?: number;
    offset?: number;
}

export interface AdminFeedbackDetail {
    ok: true;
    item: AdminFeedbackItem;
}

export interface AdminFeedbackListOptions {
    /** 按类型过滤（feature=需求 / bug=缺陷），不传返回全部 */
    type?: 'feature' | 'bug';
    /** 分页偏移，默认 0 */
    offset?: number;
}

export type AdminApiError = { status: number; message: string };

export interface AdminFetchDeps {
    /** 网络实现。main 侧传 getPlatform().fetch 以继承代理与 no_ssl 配置 */
    fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
    /** 是否绕过代理设置（本地调试直连 localhost 时使用） */
    bypassProxy?: boolean;
}

/** 将 fetch 失败归一化为 AdminApiError，401 单独标识以便客户端重新授权 */
export async function adminApiFetch(url: string, token: AdminToken, deps: AdminFetchDeps): Promise<unknown> {
    let response: Response;
    try {
        response = await deps.fetchImpl(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` }
        });
    } catch (error: unknown) {
        throw { status: 0, message: error instanceof Error ? error.message : String(error) };
    }
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const body = (await response.json()) as { error?: string };
            if (body?.error) message = body.error;
        } catch {
            // 非 JSON 错误体时保留 HTTP 状态描述
        }
        throw { status: response.status, message };
    }
    return response.json();
}

export async function fetchAdminDailyStats(
    token: AdminToken,
    days: number,
    serverUrl: string,
    deps: AdminFetchDeps
): Promise<AdminDailyStats> {
    const count = Math.min(Math.max(Number(days) || 7, 1), 90);
    const base = resolveAdminStatsServerUrl({ [ADMIN_STATS_SERVER_URL_ENV]: serverUrl });
    return (await adminApiFetch(`${base}/api/stats/daily?days=${count}`, token, deps)) as AdminDailyStats;
}

export async function fetchAdminFeedbackList(
    token: AdminToken,
    limit: number,
    serverUrl: string,
    deps: AdminFetchDeps,
    options?: AdminFeedbackListOptions
): Promise<AdminFeedbackList> {
    const count = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const params = new URLSearchParams({ limit: String(count) });
    if (options?.type) params.set('type', options.type);
    if (options?.offset) params.set('offset', String(Math.max(0, Math.trunc(options.offset))));
    const base = resolveAdminStatsServerUrl({ [ADMIN_STATS_SERVER_URL_ENV]: serverUrl });
    return (await adminApiFetch(`${base}/api/feedback/list?${params.toString()}`, token, deps)) as AdminFeedbackList;
}

/** 按 id 查询单条反馈详情（服务端 detail 接口，不受列表分页范围限制） */
export async function fetchAdminFeedbackDetail(
    token: AdminToken,
    id: number,
    serverUrl: string,
    deps: AdminFetchDeps
): Promise<AdminFeedbackDetail> {
    const base = resolveAdminStatsServerUrl({ [ADMIN_STATS_SERVER_URL_ENV]: serverUrl });
    return (await adminApiFetch(`${base}/api/feedback/detail/${id}`, token, deps)) as AdminFeedbackDetail;
}

/** /api/stats 汇总：累计/近 1 天/近 7 天去重设备数 */
export interface AdminSummaryStats {
    ok: true;
    total: { devices: number; by_type: Record<string, number> };
    last_1d: { devices: number; by_type: Record<string, number> };
    last_7d: { devices: number; by_type: Record<string, number> };
}

export async function fetchAdminSummaryStats(
    token: AdminToken,
    serverUrl: string,
    deps: AdminFetchDeps
): Promise<AdminSummaryStats> {
    const base = resolveAdminStatsServerUrl({ [ADMIN_STATS_SERVER_URL_ENV]: serverUrl });
    return (await adminApiFetch(`${base}/api/stats`, token, deps)) as AdminSummaryStats;
}
