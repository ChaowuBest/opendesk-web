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

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Hono, type Context } from 'hono';
import { serve as honoServe } from '@hono/node-server';
import { renderSafeMarkdown } from '../../../renderer/utils/markdown.js';
import { CTRL_KEY_ICON_SVG, ENTER_KEY_ICON_SVG, SHIFT_KEY_ICON_SVG } from '../../../common/utils/keys.js';
import { t } from '../../../locale/index.js';
import { logger } from '../../utils/logger.js';
import { chatPageHtml, type WebPageEmbedOptions } from './webui/chat-page.js';
import { managePageHtml } from './webui/manage-page.js';
import { generateSelfSignedServiceCertificate, type StoredServiceCertificate } from './service-cert.js';
import {
    generateStaffServiceToken,
    normalizeStaffLocalService,
    type HistoryQuery,
    type HistoryResult,
    type SendStaffMessageInput,
    type StaffDefinitionInput,
    type StaffDetail,
    type StaffLocalService,
    type StaffMessage,
    type StaffSkillSummary,
    type StaffUpdateInput
} from './common.js';

/** 远程管理页可用的模型目录摘要（与桌面端选择器一致的最小结构） */
export interface WebChatModelSummary {
    alias: string;
    provider_name: string;
    model_name: string;
}

const MAX_WEB_MESSAGE_LENGTH = 32_000;
const MAX_WEB_MESSAGE_BODY_BYTES = 64 * 1024;
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_MAX_SSE_CLIENTS = 50;
/** 远程上传 Skill 的请求体上限：100MB zip 的 base64 约 133MB，留出余量 */
const MAX_SKILL_BODY_BYTES = 140 * 1024 * 1024;
/** 解码后的 Skill zip 上限，与桌面端 URL 下载上限保持一致 */
const SKILL_ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
/**
 * 页面 CSP：允许外链图片（与桌面端渲染行为一致），其余资源锁同源，内联脚本/样式为页面自身所需。
 * 不发送 frame-ancestors：浏览器对 CSP 拦截只显示默认"拒绝连接"页，无法解释原因；
 * 是否允许 iframe 集成由注入页面的 __OD_WEB__ 标志 + 页面脚本自检实现（未授权嵌入渲染本地化提示）。
 */
const CHAT_PAGE_CSP =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' http: https: data:; media-src 'self' http: https:; font-src 'self'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'";

const CHAT_PAGE_HEADERS: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': CHAT_PAGE_CSP,
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store'
};

/** 令牌缺失/错误时给浏览器展示的极简页面（正文按当前语言本地化） */
function tokenRequiredPageHtml(): string {
    return (
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>OpenDesk</title><style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#eeedeb;` +
        `color:#1c1917;display:grid;place-items:center;height:100dvh;margin:0}p{max-width:26em;text-align:center;` +
        `line-height:1.7;font-size:14px;color:#4a4642}</style></head><body><p>${t('agentoffice.web.tokenRequired')}</p></body></html>`
    );
}

/**
 * 访问级别：manage 持管理令牌（可访问全部端点），chat 持用户令牌或聊天页未设令牌。
 * 管理令牌在启用服务时强制存在（repository 保存时补齐 + apply 兜底），因此 /manage 永远要求令牌。
 */
export type WebAccessLevel = 'manage' | 'chat' | 'none';

/** 以 SHA-256 摘要做等长比较，避免明文长度差与逐字符比较的时序侧信道 */
function tokenMatches(candidate: string, expected: string): boolean {
    const left = crypto.createHash('sha256').update(candidate).digest();
    const right = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(left, right);
}

export function accessLevelFor(config: StaffLocalService, token: string): WebAccessLevel {
    if (token) {
        if (config.manage_token && tokenMatches(token, config.manage_token)) return 'manage';
        if (config.user_token && tokenMatches(token, config.user_token)) return 'chat';
        return 'none';
    }
    return config.user_token ? 'none' : 'chat';
}

/**
 * 允许原样回显给未认证访问者的领域错误文案（均为本地化后的用户提示），
 * 其余未知错误一律返回通用文案，避免向局域网泄露内部路径等实现细节。
 */
const WEB_DOMAIN_ERROR_KEYS = [
    'agentoffice.error.staffDisabled',
    'agentoffice.error.invalidStaffId',
    'agentoffice.error.messageRequired',
    'agentoffice.error.messageTooLong',
    'agentoffice.error.invalidHistoryCursor',
    'agentoffice.error.invalidHistoryLimit',
    'agentoffice.error.invalidHistoryQuery',
    'agentoffice.error.skillUrlInvalid',
    'agentoffice.error.skillDownloadFailed',
    'agentoffice.error.skillDownloadTooLarge'
] as const;

export function isWebDomainError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return WEB_DOMAIN_ERROR_KEYS.some((key) => t(key) === message);
}

function webErrorResponse(c: Context, error: unknown): Response {
    if (isWebDomainError(error)) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    return c.json({ error: t('agentoffice.operationFailed') }, 500);
}

export interface LocalServiceRuntime {
    listening: boolean;
    url?: string;
    error?: string;
}

interface WebTextPart {
    type: 'text';
    text: string;
    html: string;
}

interface WebResourcePart {
    type: 'resource';
    media_type: 'image' | 'video' | 'audio' | 'file';
    mime_type: string;
    name: string;
    url: string;
}

export type WebChatPart = WebTextPart | WebResourcePart;

export interface WebChatMessage {
    id: string;
    role: 'user' | 'assistant';
    task_id: string;
    created_at: string;
    status?: 'sent' | 'failed';
    kind?: 'message' | 'error';
    content: WebChatPart[];
}

export interface WebStaffSummary {
    id: string;
    name: string;
    title: string;
    initial: string;
    enabled: boolean;
    active_task_id?: string;
    portrait?: string;
    specialties: string[];
    /** 与服务配置同步下发：聊天页据此隐藏员工资料，管理页忽略该标记始终展示 */
    hide_staff_info: boolean;
}

/** SSE 连接的最小接口，测试中可用内存实现替换 */
export interface SseClient {
    send: (event: string, data: unknown) => void;
    comment: (text: string) => void;
    close: () => void;
}

export type StaffWebAppDeps = Omit<StaffLocalServiceDeps, 'onStateChange'>;

export interface StaffWebAppParams {
    staffId: string;
    /**
     * 运行期配置对象。apply() 在 host/port/https 不变时会原地更新令牌与显示选项，
     * 因此所有请求处理都必须实时读取该对象，而不是捕获旧快照。
     */
    config: StaffLocalService;
    /** 聊天页 SSE 客户端（/api/events） */
    clients: Set<SseClient>;
    /** 远程管理页 SSE 客户端（/api/manage/events） */
    manageClients: Set<SseClient>;
    deps: StaffWebAppDeps;
    maxSseClients?: number;
}

export interface StaffLocalServiceDeps {
    getStaffDetail(staffId: string): Promise<StaffDetail>;
    getHistory(staffId: string, query: HistoryQuery): Promise<HistoryResult>;
    sendMessage(staffId: string, input: SendStaffMessageInput): Promise<{ task_id: string }>;
    /** 返回可安全下发的文件绝对路径；requested 为 'portrait' 或 'resources/...'，无权限时返回 null */
    getResourceFilePath(staffId: string, requested: string): string | null;
    getLocale(): string;
    /** 读取员工持久化的自签名证书（含签发 host）；缺失或格式不对时返回 null */
    readServiceCertificate?(staffId: string): StoredServiceCertificate | null;
    /** 持久化现场生成的自签名证书，失败可忽略（下次启动会重新生成） */
    writeServiceCertificate?(staffId: string, certificate: StoredServiceCertificate): void;
    /** 远程管理端点：仅允许白名单字段的员工资料更新（定义/指令/MCP） */
    updateStaffProfile?(staffId: string, input: StaffUpdateInput): Promise<StaffDetail>;
    listStaffSkills?(staffId: string): Promise<StaffSkillSummary[]>;
    deleteStaffSkill?(staffId: string, name: string): Promise<unknown>;
    /** 从本地 zip 包安装 Skill（远程管理页上传） */
    addStaffSkill?(staffId: string, zipPath: string): Promise<{ name: string }>;
    /** 从 URL 下载 zip 安装 Skill（服务端代下载） */
    addStaffSkillFromUrl?(staffId: string, sourceUrl: string): Promise<{ name: string }>;
    listChatModelSummaries?(): { default_model: string; models: WebChatModelSummary[] };
    onStateChange?(staffId: string, runtime: LocalServiceRuntime): void;
}

interface RunningService {
    staffId: string;
    config: StaffLocalService;
    url: string;
    server: { close: (callback?: () => void) => void; closeAllConnections?: () => void };
    clients: Set<SseClient>;
    /** /api/manage/events 的长连接：收到变更通知后由管理页自行拉取最新概览 */
    manageClients: Set<SseClient>;
    heartbeat: ReturnType<typeof setInterval>;
}

function mimeTypeFor(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    const known: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8'
    };
    return known[extension] ?? 'application/octet-stream';
}

export function toWebChatMessage(message: StaffMessage): WebChatMessage {
    return {
        id: message.id,
        role: message.role,
        task_id: message.task_id,
        created_at: message.created_at,
        status: message.status,
        kind: message.kind,
        content: message.content.map((part) => {
            if (part.type === 'text') {
                return { type: 'text', text: part.text, html: renderSafeMarkdown(part.text) };
            }
            const encodedPath = part.path
                .split('/')
                .map((segment) => encodeURIComponent(segment))
                .join('/');
            return {
                type: 'resource',
                media_type: part.media_type,
                mime_type: part.mime_type,
                name: part.name,
                url: `/api/resource/${encodedPath}`
            };
        })
    };
}

export function webStaffSummary(detail: StaffDetail, hasPortrait: boolean, hideStaffInfo = false): WebStaffSummary {
    return {
        id: detail.id,
        name: detail.name,
        title: detail.title,
        initial: (detail.name || 'A').slice(0, 1).toUpperCase(),
        enabled: detail.enabled,
        active_task_id: detail.active_task_id,
        portrait: hasPortrait ? '/api/portrait' : undefined,
        specialties: detail.specialties,
        hide_staff_info: Boolean(hideStaffInfo)
    };
}

/** 桌面端输入区 placeholder 中的按键图标占位符对网页无意义，直接剥掉 */
export function plainComposerPlaceholder(template: string): string {
    return template.replaceAll('{iconEnter}', '').replaceAll('{iconShift}', '').replaceAll('{iconCtrl}', '').trim();
}

/** 桌面端占位符里的按键图标占位符替换为键帽 SVG，与办公室输入区的富占位符观感一致 */
function richComposerPlaceholder(template: string): string {
    const icon = (svg: string) => `<span class="composer-placeholder-icon">${svg}</span>`;
    return template
        .replaceAll('{iconEnter}', icon(ENTER_KEY_ICON_SVG))
        .replaceAll('{iconShift}', icon(SHIFT_KEY_ICON_SVG))
        .replaceAll('{iconCtrl}', icon(CTRL_KEY_ICON_SVG));
}

export function webChatStrings(): Record<string, string> {
    return {
        you: t('agentoffice.you'),
        placeholder: plainComposerPlaceholder(t('agentoffice.messagePlaceholder')),
        placeholderHtml: richComposerPlaceholder(t('agentoffice.messagePlaceholder')),
        placeholderCtrlHtml: richComposerPlaceholder(t('agentoffice.messagePlaceholder.ctrlEnter')),
        ctrlEnterSend: t('agentoffice.ctrlEnterSend'),
        attach: t('agentoffice.attach'),
        sendOptions: t('agentoffice.sendOptions'),
        send: t('agentoffice.send'),
        noMessages: t('agentoffice.noMessages'),
        loading: t('agentoffice.loading'),
        loadOlder: t('agentoffice.loadOlder'),
        sendFailed: t('agentoffice.operationFailed'),
        enabled: t('agentoffice.enabled'),
        disabled: t('agentoffice.disabled'),
        running: t('agentoffice.running'),
        poweredBy: t('agentoffice.web.poweredBy'),
        manageBadge: t('agentoffice.web.manageBadge'),
        processing: t('agentoffice.web.processing'),
        copy: t('agentoffice.web.copy'),
        copied: t('agentoffice.web.copied'),
        disconnected: t('agentoffice.web.disconnected')
    };
}

/** 远程员工管理页（/manage）所需的本地化文案，键名与页面脚本约定一致 */
export function manageWebStrings(): Record<string, unknown> {
    return {
        poweredBy: t('agentoffice.web.poweredBy'),
        manageBadge: t('agentoffice.web.manageBadge'),
        tabBasic: t('agentoffice.basic'),
        tabSkills: t('agentoffice.skills'),
        tabMcp: t('agentoffice.mcp'),
        statsSection: t('agentoffice.statsSection'),
        profileSection: t('agentoffice.profileSection'),
        messagesStat: t('agentoffice.messagesStat'),
        tasksStat: t('agentoffice.tasksStat'),
        tokensStat: t('agentoffice.tokensStat'),
        hiredAt: t('agentoffice.hiredAt'),
        nameLabel: t('agentoffice.nameLabel'),
        vendorLabel: t('agentoffice.vendorLabel'),
        titleLabel: t('agentoffice.titleLabel'),
        specialtiesLabel: t('agentoffice.specialtiesLabel'),
        triggerIntervalLabel: t('agentoffice.triggerIntervalLabel'),
        triggerIntervalHint: t('agentoffice.triggerIntervalHint'),
        triggers: {
            '5m': t('agentoffice.triggerInterval.5m'),
            '10m': t('agentoffice.triggerInterval.10m'),
            '15m': t('agentoffice.triggerInterval.15m'),
            '30m': t('agentoffice.triggerInterval.30m'),
            '1h': t('agentoffice.triggerInterval.1h'),
            never: t('agentoffice.triggerInterval.never')
        },
        modelLabel: t('agentoffice.modelLabel'),
        modelHint: t('agentoffice.modelHint'),
        modelGlobalDefault: t('agentoffice.modelGlobalDefault'),
        instructionsLabel: t('agentoffice.instructionsLabel'),
        save: t('agentoffice.save'),
        saved: t('agentoffice.autoSaveSaved'),
        fieldRequired: t('agentoffice.fieldRequired'),
        mcpJsonHint: t('agentoffice.mcpJsonHint'),
        mcpInvalidJson: t('agentoffice.mcpInvalidJson'),
        mcpServersArray: t('agentoffice.mcpServersArray'),
        noSkills: t('agentoffice.noSkills'),
        delete: t('agentoffice.delete'),
        loading: t('agentoffice.loading'),
        enabled: t('agentoffice.enabled'),
        disabled: t('agentoffice.disabled'),
        operationFailed: t('agentoffice.operationFailed'),
        addSkill: t('agentoffice.addSkill'),
        addSkillFromZip: t('agentoffice.addSkillFromZip'),
        addSkillFromZipHint: t('agentoffice.addSkillFromZipHint'),
        addSkillFromUrl: t('agentoffice.addSkillFromUrl'),
        skillUrlLabel: t('agentoffice.skillUrlLabel'),
        skillUrlInvalid: t('agentoffice.error.skillUrlInvalid'),
        cancel: t('agentoffice.cancel')
    };
}

function dispatchSse(clients: Set<SseClient>, action: (client: SseClient) => void): void {
    for (const client of [...clients]) {
        try {
            action(client);
        } catch {
            clients.delete(client);
        }
    }
}

/** 创建 SSE 响应流并把客户端登记进集合；聊天页与远程管理页共用 */
function createSseStream(clients: Set<SseClient>, onHello: (client: SseClient) => void): Response {
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const writeChunk = (chunk: Uint8Array): void => {
        const controller = controllerRef;
        if (!controller) throw new Error('stream not ready');
        controller.enqueue(chunk);
    };
    const client: SseClient = {
        send: (event, data) => writeChunk(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
        comment: (text) => writeChunk(encoder.encode(`: ${text}\n\n`)),
        close: () => {
            const controller = controllerRef;
            controllerRef = undefined;
            try {
                controller?.close();
            } catch {
                // 流已被客户端断开时 close 会抛错，忽略即可
            }
        }
    };
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controllerRef = controller;
            clients.add(client);
            try {
                onHello(client);
            } catch {
                clients.delete(client);
            }
        },
        cancel() {
            clients.delete(client);
        }
    });
    return new Response(stream, {
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
        }
    });
}

export class StaffLocalServiceManager {
    private readonly services = new Map<string, RunningService>();
    private readonly runtimes = new Map<string, LocalServiceRuntime>();

    constructor(
        private readonly deps: StaffLocalServiceDeps,
        private readonly options: { maxSseClients?: number } = {}
    ) {}

    private get maxSseClients(): number {
        return this.options.maxSseClients ?? DEFAULT_MAX_SSE_CLIENTS;
    }

    getRuntime(staffId: string): LocalServiceRuntime {
        return this.runtimes.get(staffId) ?? { listening: false };
    }

    /** 按目标配置收敛该员工的服务状态：停启、迁移端口都由这里统一裁决 */
    async apply(staffId: string, config: StaffLocalService): Promise<LocalServiceRuntime> {
        const wanted = normalizeStaffLocalService(config);
        // 兜底：管理端点必须持令牌访问。正常路径由 repository 在保存时补齐，
        // 这里覆盖绕过持久层的调用方（如历史配置热恢复），仅作用于运行期。
        if (wanted.enabled && !wanted.manage_token) {
            wanted.manage_token = generateStaffServiceToken();
            logger.warn(`AgentOffice: generated an ephemeral manage token for staff ${staffId}`);
        }
        const existing = this.services.get(staffId);
        if (!wanted.enabled) {
            if (existing) await this.stop(staffId);
            else this.setRuntime(staffId, { listening: false });
            return this.getRuntime(staffId);
        }
        if (
            existing &&
            existing.config.host === wanted.host &&
            existing.config.port === wanted.port &&
            existing.config.https === wanted.https
        ) {
            // 令牌/隐藏员工信息等字段原地生效：不重启服务、不断开 SSE，下个请求即刻按新配置鉴权
            Object.assign(existing.config, wanted);
            const runtime: LocalServiceRuntime = { listening: true, url: existing.url };
            this.setRuntime(staffId, runtime);
            return runtime;
        }
        await this.stop(staffId);
        return await this.start(staffId, wanted);
    }

    async stop(staffId: string): Promise<void> {
        const service = this.services.get(staffId);
        if (!service) return;
        this.services.delete(staffId);
        clearInterval(service.heartbeat);
        dispatchSse(service.clients, (client) => client.close());
        service.clients.clear();
        dispatchSse(service.manageClients, (client) => client.close());
        service.manageClients.clear();
        await new Promise<void>((resolve) => {
            // SSE 长连接会让 close() 一直等待，必须主动断开存量连接
            service.server.close(() => resolve());
            service.server.closeAllConnections?.();
        });
        this.setRuntime(staffId, { listening: false });
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.services.keys()].map((staffId) => this.stop(staffId)));
    }

    notifyMessagesChanged(staffId: string): void {
        const service = this.services.get(staffId);
        if (!service) return;
        dispatchSse(service.clients, (client) => client.send('messages', { staff_id: staffId }));
    }

    async notifyStaffsChanged(): Promise<void> {
        for (const service of [...this.services.values()]) {
            // 管理页只需“有变化”的信号，自行重新拉取概览（资料/Skills/MCP 变更都走 staffsChanged）
            dispatchSse(service.manageClients, (client) => client.send('changed', { staff_id: service.staffId }));
            try {
                const detail = await this.deps.getStaffDetail(service.staffId);
                const summary = webStaffSummary(
                    detail,
                    Boolean(this.deps.getResourceFilePath(service.staffId, 'portrait')),
                    service.config.hide_staff_info
                );
                dispatchSse(service.clients, (client) => client.send('staff', summary));
            } catch (error) {
                logger.warn(`AgentOffice: failed to push staff summary to web clients: ${error}`);
            }
        }
    }

    private setRuntime(staffId: string, runtime: LocalServiceRuntime): void {
        this.runtimes.set(staffId, runtime);
        this.deps.onStateChange?.(staffId, runtime);
    }

    /**
     * 取 HTTPS 用的自签名证书：优先复用持久化的；缺失或监听地址已变化时
     * 现场重新生成一张并尝试持久化（失败只影响下次启动，不影响本次使用）
     */
    private resolveServiceCertificate(staffId: string, host: string): { key: string; cert: string } {
        const stored = this.deps.readServiceCertificate?.(staffId);
        if (stored && stored.host === host && stored.key && stored.cert) {
            return stored;
        }
        const generated: StoredServiceCertificate = { host, ...generateSelfSignedServiceCertificate(host) };
        try {
            this.deps.writeServiceCertificate?.(staffId, generated);
        } catch (error) {
            logger.warn(`AgentOffice: failed to persist local service certificate for staff ${staffId}: ${error}`);
        }
        return generated;
    }

    private async start(staffId: string, config: StaffLocalService): Promise<LocalServiceRuntime> {
        const clients = new Set<SseClient>();
        const manageClients = new Set<SseClient>();
        const app = createStaffWebApp({
            staffId,
            config,
            clients,
            manageClients,
            deps: this.deps,
            maxSseClients: this.maxSseClients
        });
        const tlsOptions = config.https ? this.resolveServiceCertificate(staffId, config.host) : undefined;
        let server: RunningService['server'];
        try {
            server = await new Promise<RunningService['server']>((resolve, reject) => {
                let settled = false;
                const nodeServer = honoServe(
                    {
                        fetch: app.fetch,
                        hostname: config.host,
                        port: config.port,
                        // HTTPS 模式用现场生成的自签名证书创建 TLS 服务器，否则用默认 HTTP。
                        // 注意 hono 以 (serverOptions, requestListener) 两个参数调用该工厂，
                        // 不能只接收监听器，否则会创建一个没有请求处理器的服务器
                        createServer: (serverOptions, requestListener) =>
                            tlsOptions
                                ? (createHttpsServer(
                                      { ...tlsOptions, ...serverOptions },
                                      requestListener
                                  ) as unknown as HttpServer)
                                : createHttpServer(serverOptions, requestListener)
                    },
                    () => {
                        if (settled) return;
                        settled = true;
                        resolve(nodeServer as unknown as RunningService['server']);
                    }
                );
                nodeServer.on('error', (error) => {
                    if (settled) return;
                    settled = true;
                    reject(error);
                });
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const runtime: LocalServiceRuntime = {
                listening: false,
                error: t('agentoffice.localService.error.start', { message })
            };
            this.setRuntime(staffId, runtime);
            return runtime;
        }

        const url = `${config.https ? 'https' : 'http'}://${config.host}:${config.port}`;
        const heartbeat = setInterval(() => {
            dispatchSse(clients, (client) => client.comment('ping'));
        }, SSE_HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();
        this.services.set(staffId, {
            staffId,
            config,
            url,
            server,
            clients,
            manageClients,
            heartbeat
        });
        logger.info(`AgentOffice: local web service for staff ${staffId} listening on ${url}`);
        const runtime: LocalServiceRuntime = { listening: true, url };
        this.setRuntime(staffId, runtime);
        return runtime;
    }
}

/** 拒绝未通过令牌校验的页面请求：返回本地化的极简提示页而非空白 4xx */
function denyPageRequest(c: Context): Response {
    return c.html(tokenRequiredPageHtml(), 401, CHAT_PAGE_HEADERS);
}

/** 拒绝未通过令牌校验的 API 请求 */
function denyApiRequest(c: Context): Response {
    return c.json({ error: t('agentoffice.web.tokenRequired') }, 401, { 'cache-control': 'no-store' });
}

/**
 * 组装单员工本地网络服务的 Hono 应用。独立导出以便测试直接用 app.request() 驱动，
 * 无需真实监听端口。
 *
 * 访问模型：
 * - `/chat` 与全部 `/api/*`：持管理令牌或用户令牌；用户令牌留空时聊天端点免鉴权；
 * - `/manage`：仅持管理令牌（启用服务时管理令牌强制存在，见 apply/repository）。
 * 令牌一律经 URL 的 token 参数传递并由页面脚本透传给后续 API/SSE 请求。
 */
export function createStaffWebApp(params: StaffWebAppParams): Hono {
    const { staffId, config, clients, manageClients, deps } = params;
    const maxSseClients = params.maxSseClients ?? DEFAULT_MAX_SSE_CLIENTS;
    const app = new Hono();

    // DNS rebinding 防护：只接受监听地址本身（127.0.0.1 时额外放行 localhost）作为 Host，
    // 外部域名解析到内网 IP 的跨源请求一律拒绝
    const allowedHosts = new Set([`${config.host.toLowerCase()}:${config.port}`]);
    if (config.host === '127.0.0.1') allowedHosts.add(`localhost:${config.port}`);
    app.use('*', async (c, next) => {
        const hostHeader = (c.req.header('host') ?? '').toLowerCase();
        if (!allowedHosts.has(hostHeader)) {
            return c.text('Forbidden', 403);
        }
        await next();
    });

    app.onError((error, c) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`AgentOffice: local web service error for staff ${staffId}: ${message}`);
        return webErrorResponse(c, error);
    });

    const token = (c: Context): string => c.req.query('token') ?? '';

    /** 实时读取运行期配置：iframe 集成开关原地生效（apply() 热更新 config），无需重启服务 */
    const webPageEmbedOptions = (): WebPageEmbedOptions => ({
        allowIframeEmbedding: config.allow_iframe_embedding,
        iframeBlockedMessage: t('agentoffice.web.iframeBlocked')
    });

    app.get('/', (c) => {
        // 旧入口兼容：重定向到 /chat 并透传 token 参数
        const query = token(c) ? `?token=${encodeURIComponent(token(c))}` : '';
        return c.redirect(`/chat${query}`, 302);
    });

    app.get('/chat', (c) => {
        if (accessLevelFor(config, token(c)) === 'none') return denyPageRequest(c);
        return c.html(chatPageHtml(webPageEmbedOptions()), 200, CHAT_PAGE_HEADERS);
    });

    app.get('/manage', (c) => {
        if (accessLevelFor(config, token(c)) !== 'manage') return denyPageRequest(c);
        return c.html(managePageHtml(webPageEmbedOptions()), 200, CHAT_PAGE_HEADERS);
    });

    app.use('/api/*', async (c, next) => {
        if (accessLevelFor(config, token(c)) === 'none') return denyApiRequest(c);
        await next();
    });

    app.get('/api/session', async (c) => {
        try {
            const detail = await deps.getStaffDetail(staffId);
            return c.json(
                {
                    staff: webStaffSummary(
                        detail,
                        Boolean(deps.getResourceFilePath(staffId, 'portrait')),
                        config.hide_staff_info
                    ),
                    locale: deps.getLocale(),
                    strings: webChatStrings()
                },
                200,
                { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
            );
        } catch (error) {
            return webErrorResponse(c, error);
        }
    });

    app.get('/api/messages', async (c) => {
        try {
            const rawLimit = Number(c.req.query('limit') ?? '50');
            const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
            const cursor = c.req.query('cursor') || undefined;
            const query: HistoryQuery = { mode: 'recent', limit, cursor };
            const result = await deps.getHistory(staffId, query);
            return c.json(
                {
                    messages: result.messages.map(toWebChatMessage),
                    has_more: result.has_more,
                    next_cursor: result.next_cursor
                },
                200,
                { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
            );
        } catch (error) {
            return webErrorResponse(c, error);
        }
    });

    app.post('/api/messages', async (c) => {
        // 只接受 application/json：跨站简单请求无法携带该 Content-Type，
        // 浏览器会先发预检从而被拦截（无 CORS 头即失败），阻断恶意网页驱动的 CSRF
        const contentType = c.req.header('content-type') ?? '';
        if (!contentType.toLowerCase().includes('application/json')) {
            return c.json({ error: t('agentoffice.error.messageRequired') }, 415);
        }
        // 必须携带 content-length：否则 chunked 编码可绕过请求体上限
        const declaredLengthHeader = c.req.header('content-length');
        if (declaredLengthHeader === undefined) {
            return c.json({ error: t('agentoffice.error.messageTooLong') }, 411);
        }
        const declaredLength = Number(declaredLengthHeader);
        if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_WEB_MESSAGE_BODY_BYTES) {
            return c.json({ error: t('agentoffice.error.messageTooLong') }, 413);
        }
        let body: { text?: unknown };
        try {
            body = (await c.req.json()) as { text?: unknown };
        } catch {
            return c.json({ error: t('agentoffice.error.messageRequired') }, 400);
        }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) return c.json({ error: t('agentoffice.error.messageRequired') }, 400);
        if (text.length > MAX_WEB_MESSAGE_LENGTH) {
            return c.json({ error: t('agentoffice.error.messageTooLong') }, 400);
        }
        try {
            const result = await deps.sendMessage(staffId, { text });
            return c.json(result, 200, { 'x-content-type-options': 'nosniff' });
        } catch (error) {
            return webErrorResponse(c, error);
        }
    });

    // ---------- 远程管理端点（/api/manage/*，仅管理令牌） ----------
    // 面向远程管理的白名单视图：绝不外泄 local_service/permission/tasks 等本机敏感配置
    const manageOverview = async (): Promise<Record<string, unknown>> => {
        const detail = await deps.getStaffDetail(staffId);
        const skills = (await deps.listStaffSkills?.(staffId)) ?? [];
        return {
            staff: {
                id: detail.id,
                name: detail.name,
                vendor_name: detail.vendor_name,
                title: detail.title,
                specialties: detail.specialties,
                trigger_interval: detail.trigger_interval ?? 'never',
                model: detail.model,
                hired_at: detail.hired_at,
                enabled: detail.enabled,
                message_count: detail.message_count,
                task_count: detail.task_count,
                total_tokens: detail.usage_summary?.total_tokens ?? 0,
                agents_md: detail.agents_md,
                mcp: detail.mcp,
                portrait: deps.getResourceFilePath(staffId, 'portrait') ? '/api/portrait' : undefined
            },
            skills: skills.map((skill) => ({
                name: skill.name,
                directory_name: skill.directory_name,
                description: skill.description
            })),
            models: deps.listChatModelSummaries?.() ?? { default_model: '', models: [] },
            locale: deps.getLocale(),
            strings: manageWebStrings()
        };
    };

    const requireManageAccess = (c: Context): Response | null => {
        if (accessLevelFor(config, token(c)) !== 'manage') return denyApiRequest(c);
        return null;
    };

    const NO_STORE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

    app.get('/api/manage/staff', async (c) => {
        const denied = requireManageAccess(c);
        if (denied) return denied;
        try {
            return c.json(await manageOverview(), 200, NO_STORE_HEADERS);
        } catch (error) {
            return webErrorResponse(c, error);
        }
    });

    app.post('/api/manage/staff', async (c) => {
        const denied = requireManageAccess(c);
        if (denied) return denied;
        let body: Record<string, unknown>;
        try {
            body = (await c.req.json()) as Record<string, unknown>;
        } catch {
            return c.json({ error: t('agentoffice.error.messageRequired') }, 400);
        }
        // 远程管理只允许改资料/指令/MCP；enabled、local_service、permission 等一律忽略
        const input: StaffUpdateInput = {};
        if (body.definition !== undefined) {
            const raw = (body.definition ?? {}) as Record<string, unknown>;
            const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
            const name = asText(raw.name);
            const vendorName = asText(raw.vendor_name);
            const title = asText(raw.title);
            if (!name || !vendorName || !title) {
                return c.json({ error: t('agentoffice.fieldRequired') }, 400, NO_STORE_HEADERS);
            }
            const specialties = Array.isArray(raw.specialties)
                ? raw.specialties
                      .filter((item): item is string => typeof item === 'string')
                      .map((item) => item.trim())
                      .filter(Boolean)
                : [];
            const allowedIntervals = ['5m', '10m', '15m', '30m', '1h', 'never'];
            const interval = asText(raw.trigger_interval);
            input.definition = {
                name,
                vendor_name: vendorName,
                title,
                specialties,
                trigger_interval: (allowedIntervals.includes(interval)
                    ? interval
                    : 'never') as StaffDefinitionInput['trigger_interval']
            };
        }
        if (body.agents_md !== undefined) {
            if (typeof body.agents_md !== 'string') {
                return c.json({ error: t('agentoffice.fieldRequired') }, 400, NO_STORE_HEADERS);
            }
            input.agents_md = body.agents_md;
        }
        if (body.mcp !== undefined) {
            const mcp = body.mcp as { servers?: unknown } | null;
            if (!mcp || typeof mcp !== 'object' || !Array.isArray(mcp.servers)) {
                return c.json({ error: t('agentoffice.mcpServersArray') }, 400, NO_STORE_HEADERS);
            }
            input.mcp = { servers: mcp.servers };
        }
        try {
            if (Object.keys(input).length > 0) {
                await deps.updateStaffProfile?.(staffId, input);
            }
            return c.json(await manageOverview(), 200, NO_STORE_HEADERS);
        } catch (error) {
            return webErrorResponse(c, error);
        }
    });

    app.delete('/api/manage/skills/:name', async (c) => {
        const denied = requireManageAccess(c);
        if (denied) return denied;
        const name = c.req.param('name');
        if (!name) return c.json({ error: t('agentoffice.error.invalidStaffId') }, 400, NO_STORE_HEADERS);
        let decoded: string;
        try {
            decoded = decodeURIComponent(name);
        } catch {
            return c.text('Bad request', 400);
        }
        try {
            await deps.deleteStaffSkill?.(staffId, decoded);
            return c.json(await manageOverview(), 200, NO_STORE_HEADERS);
        } catch (error) {
            return webErrorResponse(c, error);
        }
    });

    // 远程添加 Skill：目录/批量扫描依赖本机文件系统选择器，无法通过远程网页完成，
    // 这里提供等价的 ZIP 上传（浏览器选择本地 zip）与 URL 代下载两条路径
    app.post('/api/manage/skills/upload', async (c) => {
        const denied = requireManageAccess(c);
        if (denied) return denied;
        if (!deps.addStaffSkill) {
            return c.json({ error: t('agentoffice.operationFailed') }, 501, NO_STORE_HEADERS);
        }
        const declaredLength = Number(c.req.header('content-length') || 0);
        if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > MAX_SKILL_BODY_BYTES) {
            return c.json({ error: t('agentoffice.error.skillDownloadTooLarge') }, 413, NO_STORE_HEADERS);
        }
        let body: { name?: unknown; data?: unknown };
        try {
            body = (await c.req.json()) as { name?: unknown; data?: unknown };
        } catch {
            return c.json({ error: t('agentoffice.error.messageRequired') }, 400, NO_STORE_HEADERS);
        }
        const dataUri = typeof body.data === 'string' ? body.data : '';
        const match = /^data:application\/(zip|x-zip-compressed);base64,([a-z0-9+/]+={0,2})$/i.exec(dataUri);
        if (!match) {
            return c.json({ error: t('agentoffice.error.skillMissingManifest') }, 400, NO_STORE_HEADERS);
        }
        const archive = Buffer.from(match[2], 'base64');
        if (archive.byteLength === 0 || archive.byteLength > SKILL_ARCHIVE_MAX_BYTES) {
            return c.json({ error: t('agentoffice.error.skillDownloadTooLarge') }, 413, NO_STORE_HEADERS);
        }
        const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-web-skill-'));
        try {
            const archivePath = path.join(temporaryDirectory, 'skill.zip');
            fs.writeFileSync(archivePath, archive);
            await deps.addStaffSkill(staffId, archivePath);
            return c.json(await manageOverview(), 200, NO_STORE_HEADERS);
        } catch (error) {
            return webErrorResponse(c, error);
        } finally {
            fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
    });

    app.post('/api/manage/skills/url', async (c) => {
        const denied = requireManageAccess(c);
        if (denied) return denied;
        if (!deps.addStaffSkillFromUrl) {
            return c.json({ error: t('agentoffice.operationFailed') }, 501, NO_STORE_HEADERS);
        }
        let body: { url?: unknown };
        try {
            body = (await c.req.json()) as { url?: unknown };
        } catch {
            return c.json({ error: t('agentoffice.error.messageRequired') }, 400, NO_STORE_HEADERS);
        }
        const sourceUrl = typeof body.url === 'string' ? body.url.trim() : '';
        if (!/^https?:\/\//i.test(sourceUrl)) {
            return c.json({ error: t('agentoffice.error.skillUrlInvalid') }, 400, NO_STORE_HEADERS);
        }
        try {
            await deps.addStaffSkillFromUrl(staffId, sourceUrl);
            return c.json(await manageOverview(), 200, NO_STORE_HEADERS);
        } catch (error) {
            return webErrorResponse(c, error);
        }
    });

    // 管理页 SSE：只发“有变化”信号，页面收到后重新拉取概览，避免推送大 payload
    app.get('/api/manage/events', (_c) => {
        if (accessLevelFor(config, token(_c)) !== 'manage') {
            return _c.json({ error: t('agentoffice.web.tokenRequired') }, 401, { 'cache-control': 'no-store' });
        }
        if (manageClients.size >= maxSseClients) {
            return _c.text('Too many connections', 429);
        }
        return createSseStream(manageClients, () => {
            // 连接建立即视为存活；变更信号由 notifyStaffsChanged 统一广播
        });
    });
    app.get('/api/portrait', (c) => {
        const filePath = deps.getResourceFilePath(staffId, 'portrait');
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return c.text('Not found', 404);
        }
        return new Response(fs.readFileSync(filePath), {
            headers: {
                'content-type': 'image/png',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff'
            }
        });
    });

    app.get('/api/resource/*', (c) => {
        const requested = c.req.path.replace(/^\/api\/resource\//, '');
        let decoded: string;
        try {
            decoded = requested
                .split('/')
                .map((segment) => decodeURIComponent(segment))
                .join('/');
        } catch {
            // 非法百分号编码（如 %zz）按坏请求处理，而不是落进 500
            return c.text('Bad request', 400);
        }
        const filePath = deps.getResourceFilePath(staffId, decoded);
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return c.text('Not found', 404);
        }
        return new Response(fs.readFileSync(filePath), {
            headers: {
                'content-type': mimeTypeFor(filePath),
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff'
            }
        });
    });

    app.get('/api/events', (_c) => {
        // 限制单员工服务的并发长连接数，避免局域网内被无限挂连接拖垮
        if (clients.size >= maxSseClients) {
            return _c.text('Too many connections', 429);
        }
        return createSseStream(clients, (client) => {
            client.send('hello', { staff_id: staffId });
        });
    });

    return app;
}
