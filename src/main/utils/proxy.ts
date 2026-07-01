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

import net from 'net';

const COMMON_PROXY_PORTS = [7890, 7897, 1080, 8080, 10808, 10809];

function normalizeHostname(hostname: string): string {
    return hostname
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '')
        .toLowerCase();
}

function parseNoProxyPattern(pattern: string): { host: string; port?: string } {
    let value = pattern.trim().toLowerCase();
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        if (end >= 0) {
            const host = value.slice(1, end);
            const rest = value.slice(end + 1);
            return {
                host,
                port: rest.startsWith(':') ? rest.slice(1) : undefined
            };
        }
    }

    const lastColon = value.lastIndexOf(':');
    if (lastColon > 0 && value.indexOf(':') === lastColon) {
        const maybePort = value.slice(lastColon + 1);
        if (/^\d+$/.test(maybePort)) {
            value = value.slice(0, lastColon);
            return { host: normalizeHostname(value), port: maybePort };
        }
    }

    return { host: normalizeHostname(value) };
}

function hostnameMatchesNoProxyPattern(hostname: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.startsWith('.')) {
        return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    }
    return hostname === pattern || hostname.endsWith('.' + pattern);
}

export function isLoopbackUrl(urlStr: string): boolean {
    try {
        const hostname = normalizeHostname(new URL(urlStr).hostname);
        return (
            hostname === 'localhost' ||
            hostname.endsWith('.localhost') ||
            hostname === '::1' ||
            hostname === '127.0.0.1' ||
            /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
        );
    } catch {
        return false;
    }
}

/**
 * 检查目标 URL 的 hostname 是否匹配 NO_PROXY / no_proxy 环境变量。
 * 支持精确域名、.example.com 后缀匹配、host:port、IPv6 [host]:port、* 通配。
 */
export function isHostInNoProxy(urlStr: string): boolean {
    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    if (!noProxy) return false;

    let url: URL;
    try {
        url = new URL(urlStr);
    } catch {
        return false;
    }

    const hostname = normalizeHostname(url.hostname);
    const port = url.port;
    const patterns = noProxy
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

    return patterns.some((pattern) => {
        const parsed = parseNoProxyPattern(pattern);
        if (parsed.port !== undefined && parsed.port !== port) {
            return false;
        }
        return hostnameMatchesNoProxyPattern(hostname, parsed.host);
    });
}

let cachedProxyUrl: string | null | undefined = undefined;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

/**
 * 从环境变量中获取代理 URL
 */
function getProxyFromEnv(): string | undefined {
    return (
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        undefined
    );
}

/**
 * 快速探测本地端口是否可连接（TCP connect 检测）
 */
function probePort(port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let resolved = false;
        const done = (result: boolean) => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(result);
            }
        };
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false));
        socket.on('error', () => done(false));
        socket.connect(port, '127.0.0.1');
    });
}

/**
 * 探测本地常见代理端口，返回第一个可用的代理 URL
 */
async function probeLocalProxy(): Promise<string | null> {
    const results = await Promise.all(
        COMMON_PROXY_PORTS.map(async (port) => ({
            port,
            ok: await probePort(port)
        }))
    );
    const found = results.find((r) => r.ok);
    return found ? `http://127.0.0.1:${found.port}` : null;
}

/**
 * 获取当前可用的代理 URL（带缓存）
 * 优先级：环境变量 > 本地端口探测
 */
export async function resolveProxyUrl(): Promise<string | null> {
    const envProxy = getProxyFromEnv();
    if (envProxy) return envProxy;

    const now = Date.now();
    if (cachedProxyUrl !== undefined && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedProxyUrl;
    }

    cachedProxyUrl = await probeLocalProxy();
    cacheTimestamp = now;
    return cachedProxyUrl;
}
