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
import path from 'path';
import { Hono, type Context } from 'hono';
import { serve as honoServe } from '@hono/node-server';
import { renderSafeMarkdown } from '../../../renderer/utils/markdown.js';
import { CTRL_KEY_ICON_SVG, ENTER_KEY_ICON_SVG, SHIFT_KEY_ICON_SVG } from '../../../common/utils/keys.js';
import { t } from '../../../locale/index.js';
import { logger } from '../../utils/logger.js';
import { CHAT_PAGE_HTML } from './webui/chat-page.js';
import {
    normalizeStaffLocalService,
    type HistoryQuery,
    type HistoryResult,
    type SendStaffMessageInput,
    type StaffDetail,
    type StaffLocalService,
    type StaffMessage
} from './common.js';

const MAX_WEB_MESSAGE_LENGTH = 32_000;
const MAX_WEB_MESSAGE_BODY_BYTES = 64 * 1024;
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_MAX_SSE_CLIENTS = 50;
/** 页面 CSP：允许外链图片（与桌面端渲染行为一致），其余资源锁同源，内联脚本/样式为页面自身所需 */
const CHAT_PAGE_CSP =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' http: https: data:; media-src 'self' http: https:; font-src 'self'; " +
    "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'";

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
    'agentoffice.error.invalidHistoryQuery'
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
}

/** SSE 连接的最小接口，测试中可用内存实现替换 */
export interface SseClient {
    send: (event: string, data: unknown) => void;
    comment: (text: string) => void;
    close: () => void;
}

export interface StaffLocalServiceDeps {
    getStaffDetail(staffId: string): Promise<StaffDetail>;
    getHistory(staffId: string, query: HistoryQuery): Promise<HistoryResult>;
    sendMessage(staffId: string, input: SendStaffMessageInput): Promise<{ task_id: string }>;
    /** 返回可安全下发的文件绝对路径；requested 为 'portrait' 或 'resources/...'，无权限时返回 null */
    getResourceFilePath(staffId: string, requested: string): string | null;
    getLocale(): string;
    onStateChange?(staffId: string, runtime: LocalServiceRuntime): void;
}

interface RunningService {
    staffId: string;
    config: StaffLocalService;
    url: string;
    server: { close: (callback?: () => void) => void; closeAllConnections?: () => void };
    clients: Set<SseClient>;
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

export function webStaffSummary(detail: StaffDetail, hasPortrait: boolean): WebStaffSummary {
    return {
        id: detail.id,
        name: detail.name,
        title: detail.title,
        initial: (detail.name || 'A').slice(0, 1).toUpperCase(),
        enabled: detail.enabled,
        active_task_id: detail.active_task_id,
        portrait: hasPortrait ? '/api/portrait' : undefined,
        specialties: detail.specialties
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
        processing: t('agentoffice.web.processing'),
        copy: t('agentoffice.web.copy'),
        copied: t('agentoffice.web.copied'),
        disconnected: t('agentoffice.web.disconnected')
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
        const existing = this.services.get(staffId);
        if (!wanted.enabled) {
            if (existing) await this.stop(staffId);
            else this.setRuntime(staffId, { listening: false });
            return this.getRuntime(staffId);
        }
        if (existing && existing.config.host === wanted.host && existing.config.port === wanted.port) {
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
            try {
                const detail = await this.deps.getStaffDetail(service.staffId);
                const summary = webStaffSummary(
                    detail,
                    Boolean(this.deps.getResourceFilePath(service.staffId, 'portrait'))
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

    private async start(staffId: string, config: StaffLocalService): Promise<LocalServiceRuntime> {
        const clients = new Set<SseClient>();
        const app = this.createChatApp(staffId, config, clients);
        let server: RunningService['server'];
        try {
            server = await new Promise<RunningService['server']>((resolve, reject) => {
                let settled = false;
                const nodeServer = honoServe(
                    {
                        fetch: app.fetch,
                        hostname: config.host,
                        port: config.port
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

        const url = `http://${config.host}:${config.port}`;
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
            heartbeat
        });
        logger.info(`AgentOffice: local web service for staff ${staffId} listening on ${url}`);
        const runtime: LocalServiceRuntime = { listening: true, url };
        this.setRuntime(staffId, runtime);
        return runtime;
    }

    private createChatApp(staffId: string, config: StaffLocalService, clients: Set<SseClient>): Hono {
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

        app.get('/', (c) =>
            c.html(CHAT_PAGE_HTML, 200, {
                'x-content-type-options': 'nosniff',
                'content-security-policy': CHAT_PAGE_CSP,
                'referrer-policy': 'no-referrer'
            })
        );

        app.get('/api/session', async (c) => {
            try {
                const detail = await this.deps.getStaffDetail(staffId);
                return c.json(
                    {
                        staff: webStaffSummary(detail, Boolean(this.deps.getResourceFilePath(staffId, 'portrait'))),
                        locale: this.deps.getLocale(),
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
                const result = await this.deps.getHistory(staffId, query);
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
                const result = await this.deps.sendMessage(staffId, { text });
                return c.json(result, 200, { 'x-content-type-options': 'nosniff' });
            } catch (error) {
                return webErrorResponse(c, error);
            }
        });

        app.get('/api/portrait', (c) => {
            const filePath = this.deps.getResourceFilePath(staffId, 'portrait');
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
            const filePath = this.deps.getResourceFilePath(staffId, decoded);
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
            if (clients.size >= this.maxSseClients) {
                return _c.text('Too many connections', 429);
            }
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
                        client.send('hello', { staff_id: staffId });
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
        });

        return app;
    }
}
