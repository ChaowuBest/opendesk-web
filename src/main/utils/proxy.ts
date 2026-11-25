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
    if (pattern.includes('*')) {
        let hostnameIndex = 0;
        let patternIndex = 0;
        let wildcardIndex = -1;
        let wildcardMatchIndex = 0;

        while (hostnameIndex < hostname.length) {
            if (patternIndex < pattern.length && pattern[patternIndex] === hostname[hostnameIndex]) {
                hostnameIndex++;
                patternIndex++;
            } else if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
                wildcardIndex = patternIndex++;
                wildcardMatchIndex = hostnameIndex;
            } else if (wildcardIndex !== -1) {
                patternIndex = wildcardIndex + 1;
                hostnameIndex = ++wildcardMatchIndex;
            } else {
                return false;
            }
        }

        while (patternIndex < pattern.length && pattern[patternIndex] === '*') {
            patternIndex++;
        }
        return patternIndex === pattern.length;
    }
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
 * 判断 host:port 是否命中指定的 NO_PROXY 列表。
 * 与 isHostInNoProxy 使用同一套匹配规则，便于调用方直接传入设置里的 no_proxy。
 */
export function isHostInNoProxyList(hostname: string, port: string | number, noProxy: string): boolean {
    if (!noProxy) return false;
    const normalizedHost = normalizeHostname(hostname);
    const normalizedPort = String(port ?? '');
    const patterns = noProxy
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

    return patterns.some((pattern) => {
        const parsed = parseNoProxyPattern(pattern);
        if (parsed.port !== undefined && parsed.port !== normalizedPort) {
            return false;
        }
        return hostnameMatchesNoProxyPattern(normalizedHost, parsed.host);
    });
}

/**
 * 检查目标 URL 的 hostname 是否匹配 NO_PROXY / no_proxy 环境变量。
 * 支持精确域名、.example.com 后缀匹配、任意位置的 * 通配、host:port、IPv6 [host]:port。
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

    return isHostInNoProxyList(url.hostname, url.port, noProxy);
}

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
 * 获取显式配置的代理 URL。
 * 不自动探测本地代理端口，避免在未设置代理环境变量时出现隐藏网络路径。
 */
export async function resolveProxyUrl(): Promise<string | null> {
    return getProxyFromEnv() ?? null;
}
