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
 * Web 模式 HTTP 服务：
 *   /                         renderer 静态页面（HTML 注入 web preload）
 *   /__opendesk/ws            IPC over WebSocket
 *   /__opendesk/fs/<path>     本机文件（file:// 的替身）
 *   /__opendesk/proto/<s>/... 自定义协议（opendesk-app:// 等）经 net.fetch 代理
 *   /__opendesk/upload        浏览器拖入/选择的文件落盘，供 agent 按路径读取
 *   /__opendesk/list|mkdir    web 文件对话框的目录浏览
 *   /__opendesk/health        存活探针（免认证）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { net } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeIpcValue, encodeIpcValue } from '../../common/web/ipc-codec.js';
import {
    WEB_FS_PATH,
    WEB_HEALTH_PATH,
    WEB_LIST_PATH,
    WEB_LOGIN_PATH,
    WEB_MKDIR_PATH,
    WEB_PRELOAD_PATH,
    WEB_PROTO_PATH,
    WEB_UPLOAD_PATH,
    WEB_WS_PATH,
    UPLOAD_ID_PATTERN,
    sanitizeUploadName,
    type ClientMessage,
    type DirectoryListing,
    type ServerMessage,
    type WebBootConfig
} from '../../common/web/protocol.js';
import { logger } from '../utils/logger.js';
import type { WebModeConfig } from './config.js';
import { WebIpcClient, dispatchInvoke, dispatchSend } from './ipc-bridge.js';

const TOKEN_COOKIE = 'opendesk_web_token';
const WS_PING_INTERVAL_MS = 25_000;

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg'
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|wasm)|image\/svg)/;

export interface WebServerOptions {
    config: WebModeConfig;
    /** dist/renderer */
    rendererDir: string;
    /** dist/web/preload.js */
    webPreloadPath: string;
    /** 可经 /__opendesk/proto 代理的自定义协议 */
    schemes: string[];
}

function mimeType(filePath: string): string {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function parseCookies(header: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const part of (header ?? '').split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendText(res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(text);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
    sendText(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** /__opendesk/fs/<编码后的绝对路径> → 本机路径 */
function decodeFsPath(pathname: string): string {
    const raw = pathname.slice(WEB_FS_PATH.length) || '/';
    const decoded = raw
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
    // Windows 盘符路径（/C:/x）去掉前导斜杠
    return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : path.resolve(decoded);
}

const LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OpenDesk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f7}
form{background:#fff;padding:32px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);display:flex;flex-direction:column;gap:12px;min-width:280px}
input{padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px}button{padding:10px;border:0;border-radius:8px;background:#2f6bff;color:#fff;font-size:14px;cursor:pointer}</style>
</head><body><form method="get" action="/"><strong>OpenDesk</strong><input name="token" type="password" placeholder="Access token" autofocus><button type="submit">Sign in</button></form></body></html>`;

export class OpenDeskWebServer {
    private readonly server: http.Server;
    private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 });
    private readonly gzipCache = new Map<string, { mtimeMs: number; body: Buffer }>();
    private readonly uploadRoot = path.join(os.tmpdir(), 'opendesk-uploads');
    private readonly bootScript: string;

    constructor(private readonly options: WebServerOptions) {
        const boot: WebBootConfig = {
            platform: process.platform,
            homePath: os.homedir(),
            schemes: options.schemes,
            uploadRoot: this.uploadRoot.replace(/\\/g, '/')
        };
        // 转义 <：home 路径等字符串里出现 </script> 时不至于截断内联脚本
        const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
        this.bootScript = `<script>window.__OPENDESK_WEB__=${bootJson};</script><script src="${WEB_PRELOAD_PATH}"></script>`;

        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch((error) => {
                logger.error(`[web] request ${req.method} ${req.url} failed: ${(error as Error)?.stack || error}`);
                if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
                else res.destroy();
            });
        });
        this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    }

    listen(): Promise<void> {
        const { host, port } = this.options.config;
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(port, host, () => {
                this.server.off('error', reject);
                logger.info(`[web] OpenDesk Web UI listening on http://${host}:${port}`);
                if (!this.options.config.token) {
                    logger.warn('[web] OPENDESK_WEB_TOKEN is not set; the Web UI accepts unauthenticated requests');
                }
                resolve();
            });
        });
    }

    close(): void {
        for (const ws of this.wss.clients) ws.terminate();
        this.server.close();
    }

    // ── 认证 ──────────────────────────────────────────────

    /** 返回 true 表示已放行；false 表示已写出 401 / 重定向 */
    private authenticate(req: http.IncomingMessage, res: http.ServerResponse | null, url: URL): boolean {
        const token = this.options.config.token;
        if (!token) return true;

        const queryToken = url.searchParams.get('token') ?? undefined;
        if (res && tokenMatches(queryToken, token)) {
            // 首次带 ?token= 访问：写 Cookie 后跳转到去掉 token 的地址，避免令牌留在地址栏/历史
            url.searchParams.delete('token');
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
            res.writeHead(302, {
                'Set-Cookie': `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}`,
                Location: `${url.pathname}${url.search}`
            });
            res.end();
            return false;
        }

        const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        if (tokenMatches(parseCookies(req.headers.cookie)[TOKEN_COOKIE], token) || tokenMatches(bearer, token)) {
            return true;
        }
        if (res) {
            const wantsHtml = (req.headers.accept ?? '').includes('text/html');
            if (wantsHtml && req.method === 'GET') {
                res.writeHead(302, { Location: WEB_LOGIN_PATH });
                res.end();
            } else {
                sendText(res, 401, 'Unauthorized');
            }
        }
        return false;
    }

    // ── HTTP ─────────────────────────────────────────────

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;

        if (pathname === WEB_HEALTH_PATH) return sendText(res, 200, 'ok');
        if (pathname === WEB_LOGIN_PATH) return sendText(res, 200, LOGIN_PAGE, 'text/html; charset=utf-8');
        if (!this.authenticate(req, res, url)) return;

        if (pathname === WEB_PRELOAD_PATH) return this.serveFile(req, res, this.options.webPreloadPath, false);
        if (pathname === WEB_FS_PATH || pathname.startsWith(`${WEB_FS_PATH}/`)) {
            return this.serveLocalPath(req, res, decodeFsPath(pathname));
        }
        if (pathname.startsWith(`${WEB_PROTO_PATH}/`)) return this.proxyProtocol(req, res, url);
        if (pathname === WEB_UPLOAD_PATH && req.method === 'POST') return this.handleUpload(req, res, url);
        if (pathname === WEB_LIST_PATH) return this.handleList(res, url);
        if (pathname === WEB_MKDIR_PATH && req.method === 'POST') return this.handleMkdir(res, url);

        if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
        return this.serveRenderer(req, res, pathname);
    }

    private async serveRenderer(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestPath: string
    ): Promise<void> {
        let pathname = requestPath;
        // 桌面端没有 favicon；浏览器标签页用应用圆角图标
        if (pathname === '/favicon.ico') pathname = '/images/icon_round.png';
        const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
        const filePath = path.resolve(this.options.rendererDir, relative);
        if (filePath !== this.options.rendererDir && !filePath.startsWith(this.options.rendererDir + path.sep)) {
            return sendText(res, 403, 'Forbidden');
        }
        if (/\.html?$/i.test(filePath)) return this.serveHtml(res, filePath);
        // 带内容哈希的构建产物可长期缓存
        const immutable = relative.startsWith('assets/');
        return this.serveFile(req, res, filePath, immutable);
    }

    private async serveHtml(res: http.ServerResponse, filePath: string): Promise<void> {
        let html: string;
        try {
            html = await fsPromises.readFile(filePath, 'utf8');
        } catch {
            return sendText(res, 404, 'Not Found');
        }
        // web preload 必须先于页面模块脚本执行（对应 Electron preload 的时序）
        const injected = /<head[^>]*>/i.test(html)
            ? html.replace(/<head[^>]*>/i, (match) => `${match}${this.bootScript}`)
            : this.bootScript + html;
        sendText(res, 200, injected, 'text/html; charset=utf-8');
    }

    private async serveFile(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        filePath: string,
        immutable: boolean
    ): Promise<void> {
        let stat: fs.Stats;
        try {
            stat = await fsPromises.stat(filePath);
        } catch {
            return sendText(res, 404, 'Not Found');
        }
        if (!stat.isFile()) return sendText(res, 404, 'Not Found');

        const type = mimeType(filePath);
        const headers: Record<string, string | number> = {
            'Content-Type': type,
            'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
            'Last-Modified': stat.mtime.toUTCString(),
            'Accept-Ranges': 'bytes'
        };

        const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
        if (acceptsGzip && COMPRESSIBLE.test(type) && stat.size > 1024 && stat.size < 64 * 1024 * 1024) {
            const cached = this.gzipCache.get(filePath);
            let body = cached && cached.mtimeMs === stat.mtimeMs ? cached.body : undefined;
            if (!body) {
                body = zlib.gzipSync(await fsPromises.readFile(filePath));
                this.gzipCache.set(filePath, { mtimeMs: stat.mtimeMs, body });
            }
            res.writeHead(200, {
                ...headers,
                'Content-Encoding': 'gzip',
                'Content-Length': body.length,
                Vary: 'Accept-Encoding'
            });
            res.end(req.method === 'HEAD' ? undefined : body);
            return;
        }

        const range = String(req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);
        if (range && stat.size > 0) {
            const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
            const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
            if (start > end || start >= stat.size) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
            }
            res.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Content-Length': end - start + 1
            });
            if (req.method === 'HEAD') return void res.end();
            await pipeline(fs.createReadStream(filePath, { start, end }), res);
            return;
        }

        res.writeHead(200, { ...headers, 'Content-Length': stat.size });
        if (req.method === 'HEAD') return void res.end();
        await pipeline(fs.createReadStream(filePath), res);
    }

    private async serveLocalPath(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): Promise<void> {
        let stat: fs.Stats;
        try {
            stat = await fsPromises.stat(filePath);
        } catch {
            return sendText(res, 404, `Not Found: ${filePath}`);
        }
        if (!stat.isDirectory()) return this.serveFile(req, res, filePath, false);

        const listing = await this.listDirectory(filePath, true);
        const rows = listing.entries
            .map((entry) => {
                const href = `${WEB_FS_PATH}${entry.path.split('/').map(encodeURIComponent).join('/')}`;
                return `<li><a href="${escapeHtml(href)}">${escapeHtml(entry.name)}${entry.directory ? '/' : ''}</a></li>`;
            })
            .join('');
        const parent = listing.parent
            ? `<li><a href="${escapeHtml(WEB_FS_PATH + listing.parent.split('/').map(encodeURIComponent).join('/'))}">../</a></li>`
            : '';
        sendText(
            res,
            200,
            `<!DOCTYPE html><meta charset="utf-8"><title>${escapeHtml(filePath)}</title><h3>${escapeHtml(filePath)}</h3><ul>${parent}${rows}</ul>`,
            'text/html; charset=utf-8'
        );
    }

    private async proxyProtocol(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
        const rest = url.pathname.slice(WEB_PROTO_PATH.length + 1);
        const slash = rest.indexOf('/');
        const scheme = slash === -1 ? rest : rest.slice(0, slash);
        if (!this.options.schemes.includes(scheme)) return sendText(res, 404, `Unknown scheme: ${scheme}`);

        url.searchParams.delete('token');
        const target = `${scheme}://${slash === -1 ? '' : rest.slice(slash + 1)}${url.search}`;
        const response = await net.fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            if (!/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(key)) headers[key] = value;
        });
        headers['Cache-Control'] ??= 'no-cache';
        res.writeHead(response.status, headers);
        if (!response.body || req.method === 'HEAD') return void res.end();
        await pipeline(Readable.fromWeb(response.body as never), res);
    }

    /**
     * 浏览器预先决定落盘路径（webUtils.getPathForFile 是同步 API，必须在上传完成前就能返回路径），
     * 这里按同一规则还原：<uploadRoot>/<id>/<净化后的文件名>
     */
    private async handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
        const id = url.searchParams.get('id') ?? '';
        if (!UPLOAD_ID_PATTERN.test(id)) return sendJson(res, 400, { error: 'invalid upload id' });
        const dir = path.join(this.uploadRoot, id);
        await fsPromises.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, sanitizeUploadName(url.searchParams.get('name') || 'upload'));
        await pipeline(req, fs.createWriteStream(filePath));
        sendJson(res, 200, { path: filePath.replace(/\\/g, '/') });
    }

    private async listDirectory(dirPath: string, includeFiles: boolean): Promise<DirectoryListing> {
        const resolved = path.resolve(dirPath);
        const dirents = await fsPromises.readdir(resolved, { withFileTypes: true });
        const entries: DirectoryListing['entries'] = [];
        for (const dirent of dirents) {
            const entryPath = path.join(resolved, dirent.name);
            let directory = dirent.isDirectory();
            if (dirent.isSymbolicLink()) {
                directory = await fsPromises
                    .stat(entryPath)
                    .then((s) => s.isDirectory())
                    .catch(() => false);
            }
            if (!directory && !includeFiles) continue;
            entries.push({ name: dirent.name, path: entryPath.replace(/\\/g, '/'), directory });
        }
        entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
        const parent = path.dirname(resolved);
        return {
            path: resolved.replace(/\\/g, '/'),
            parent: parent === resolved ? null : parent.replace(/\\/g, '/'),
            entries
        };
    }

    private async handleList(res: http.ServerResponse, url: URL): Promise<void> {
        const target = url.searchParams.get('path') || os.homedir();
        try {
            sendJson(res, 200, await this.listDirectory(target, url.searchParams.get('files') === '1'));
        } catch (error) {
            sendJson(res, 400, { error: (error as Error).message });
        }
    }

    private async handleMkdir(res: http.ServerResponse, url: URL): Promise<void> {
        const target = url.searchParams.get('path');
        if (!target) return sendJson(res, 400, { error: 'path is required' });
        try {
            await fsPromises.mkdir(target, { recursive: true });
            sendJson(res, 200, { path: path.resolve(target).replace(/\\/g, '/') });
        } catch (error) {
            sendJson(res, 400, { error: (error as Error).message });
        }
    }

    // ── WebSocket IPC ────────────────────────────────────

    private handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== WEB_WS_PATH || !this.authenticate(req, null, url)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.attachClient(ws, url.searchParams.get('page') ?? ''));
    }

    private attachClient(ws: WebSocket, pageUrl: string): void {
        const client = new WebIpcClient((message) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        }, pageUrl);
        client.markActive();

        let alive = true;
        ws.on('pong', () => {
            alive = true;
        });
        const pingTimer = setInterval(() => {
            if (!alive) return ws.terminate();
            alive = false;
            ws.ping();
        }, WS_PING_INTERVAL_MS);

        ws.on('message', (data) => {
            let message: ClientMessage;
            try {
                message = JSON.parse(String(data)) as ClientMessage;
            } catch {
                return;
            }
            client.markActive();
            void this.handleClientMessage(client, message);
        });
        ws.on('close', () => {
            clearInterval(pingTimer);
            client.destroy();
        });
        ws.on('error', (error) => logger.warn(`[web] websocket error: ${error.message}`));
    }

    private async handleClientMessage(client: WebIpcClient, message: ClientMessage): Promise<void> {
        switch (message.t) {
            case 'invoke': {
                let reply: ServerMessage;
                try {
                    const value = await dispatchInvoke(client, message.ch, decodeIpcValue(message.a) as unknown[]);
                    reply = { t: 'res', id: message.id, ok: true, v: encodeIpcValue(value) };
                } catch (error) {
                    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                    reply = { t: 'res', id: message.id, ok: false, e: text };
                }
                client.post(reply);
                return;
            }
            case 'send':
                dispatchSend(client, message.ch, decodeIpcValue(message.a) as unknown[]);
                return;
            case 'reply':
                client.resolveRequest(message.id, decodeIpcValue(message.v));
                return;
        }
    }
}

export async function startWebServer(options: WebServerOptions): Promise<OpenDeskWebServer> {
    const server = new OpenDeskWebServer(options);
    await server.listen();
    return server;
}
