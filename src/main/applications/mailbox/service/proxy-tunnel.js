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
 * 邮件协议（SMTP / IMAP / POP3）的代理隧道。
 *
 * nodemailer / node-imap / node-pop3 都直接用 net/tls 建连，不读取 HTTP_PROXY 环境变量，
 * 因此在需要代理的网络环境下发信收信会直连超时。这里为每个目标邮件服务器启动一个
 * 本地监听端口，把连接经代理隧道（HTTP CONNECT 或 SOCKS5）转发到真实服务器。
 *
 * 调用方只需把建连的 host/port 换成隧道端口，并把真实域名保留为 TLS servername，
 * 从而在不修改第三方库的前提下支持代理。
 */

import net from 'net';
import tls from 'tls';
import { getPlatform } from '../../../../platforms/base.js';
import { getEffectiveSystemProxy } from '../../../../main/utils/proxy-env.js';
import { isHostInNoProxyList } from '../../../../main/utils/proxy.js';
import { logger } from '../../../../main/utils/logger.js';

/** key = `${host}:${port}`，value = 当前代理配置对应的隧道 */
const tunnelEntries = new Map();
/** 进行中的隧道创建，避免并发重复建监听 */
const pendingTunnels = new Map();
/** 已启动的监听，供退出/配置变更时统一关闭 */
const tunnelServers = new Set();
/** 每个监听上仍处于活动状态的本地/代理连接 */
const serverConnections = new Map();
/** 目标当前期望使用的代理签名，用于丢弃配置切换期间完成的旧监听 */
const desiredTunnelSignatures = new Map();

const CONNECT_TIMEOUT_MS = 15000;
/** 代理配置缓存：解析 system 代理要 fork scutil/reg，避免每次建连都执行 */
const PROXY_CACHE_TTL_MS = 30000;
let proxyCache = null;

const ENV_PROXY_KEYS = [
    'ALL_PROXY',
    'all_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'NO_PROXY',
    'no_proxy'
];

function currentEnvProxyKey() {
    return ENV_PROXY_KEYS.map((key) => process.env[key] || '').join(',');
}

/**
 * 解析出当前生效的代理地址。
 * platform 配置优先；平台未提供时退回环境变量代理约定。
 * @returns {Promise<{ url: string, noProxy: string } | null>}
 */
export async function resolveMailProxyConfig() {
    let nc = null;
    try {
        nc = getPlatform().getNetworkConfig?.() ?? null;
    } catch (err) {
        logger.warn(`mailbox: unable to read network config: ${err?.message || err}`);
    }

    const cacheKey = `${JSON.stringify(nc)}|${currentEnvProxyKey()}`;
    if (proxyCache && proxyCache.key === cacheKey && Date.now() - proxyCache.at < PROXY_CACHE_TTL_MS) {
        return proxyCache.value;
    }

    const resolved = await detectMailProxyConfig(nc);
    proxyCache = { key: cacheKey, at: Date.now(), value: resolved };
    return resolved;
}

async function detectMailProxyConfig(nc) {
    const useProxy = nc?.use_proxy ?? null;
    const customProxyAddr = (nc?.custom_proxy_addr || '').trim();
    const noProxy = nc?.no_proxy || '';

    if (useProxy === 'none') return null;

    if (useProxy === 'custom') {
        return customProxyAddr ? { url: customProxyAddr, noProxy } : null;
    }

    // use_proxy=system（或平台未提供）：优先系统代理检测，其次环境变量
    // 设置中的 no_proxy 仅属于自定义代理模式，不覆盖或扩展系统绕过规则。
    try {
        const sys = await getEffectiveSystemProxy();
        if (sys?.url) {
            return { url: sys.url, noProxy: sys.bypassList || '' };
        }
    } catch (err) {
        logger.warn(`mailbox: unable to detect system proxy: ${err?.message || err}`);
    }

    const envProxy =
        process.env.ALL_PROXY ||
        process.env.all_proxy ||
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy;
    if (!envProxy) return null;
    return {
        url: envProxy,
        noProxy: process.env.NO_PROXY || process.env.no_proxy || ''
    };
}

/**
 * 解析代理 URL，统一成 { kind, host, port, username, password }。
 * 不带协议前缀时按 http 处理（与常见代理客户端一致）。
 */
export function parseProxyUrl(rawUrl) {
    if (!rawUrl) return null;
    let value = String(rawUrl).trim();
    if (!value) return null;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
        value = `http://${value}`;
    }

    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }

    const protocol = url.protocol.replace(':', '').toLowerCase();
    let kind;
    if (protocol === 'socks5' || protocol === 'socks5h' || protocol === 'socks') {
        kind = 'socks5';
    } else if (protocol === 'http') {
        kind = 'http';
    } else if (protocol === 'https') {
        kind = 'https';
    } else {
        return null;
    }

    // https 代理需要先和代理本身建立 TLS，默认端口也跟着变。
    const defaultPort = kind === 'socks5' ? 1080 : kind === 'https' ? 443 : 8080;
    const port = Number(url.port) || defaultPort;
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;

    try {
        return {
            kind,
            host: url.hostname.replace(/^\[|\]$/g, ''),
            port,
            username: url.username ? decodeURIComponent(url.username) : '',
            password: url.password ? decodeURIComponent(url.password) : ''
        };
    } catch {
        // 非法百分号编码（如 %ZZ）会让 decodeURIComponent 抛错，按无效代理处理
        return null;
    }
}

/** 目标服务器的 CONNECT authority，IPv6 需要保留方括号。 */
function formatTargetAuthority(host, port) {
    const normalizedHost = String(host).replace(/^\[|\]$/g, '');
    return `${normalizedHost.includes(':') ? `[${normalizedHost}]` : normalizedHost}:${port}`;
}

function tunnelKey(host, port) {
    return JSON.stringify([host, port]);
}

function proxySignature(proxy) {
    return JSON.stringify([proxy.kind, proxy.host, proxy.port, proxy.username, proxy.password]);
}

function closeTunnelServer(server) {
    const connections = serverConnections.get(server);
    if (connections) {
        for (const connection of connections) {
            connection.destroy(new Error('mailbox tunnel closed'));
        }
        connections.clear();
        serverConnections.delete(server);
    }
    tunnelServers.delete(server);
    try {
        if (server.listening) server.close();
    } catch {
        /* best-effort */
    }
}

/** 立即关闭单个目标的隧道，并使尚未完成的旧隧道创建失效。 */
function closeMailTunnel(host, port) {
    const key = tunnelKey(host, port);
    desiredTunnelSignatures.delete(key);
    const pendingPrefix = `${key}|`;
    for (const pendingKey of pendingTunnels.keys()) {
        if (pendingKey.startsWith(pendingPrefix)) pendingTunnels.delete(pendingKey);
    }

    const entry = tunnelEntries.get(key);
    if (!entry) return;

    tunnelEntries.delete(key);
    closeTunnelServer(entry.server);
}

/** 起一个本地监听，把每个进来的连接经代理转发到 targetHost:targetPort。 */
function createTunnelServer(proxy, targetHost, targetPort) {
    const connections = new Set();
    const server = net.createServer((client) => {
        const connection = {
            client,
            upstream: null,
            closed: false,
            controller: new AbortController(),
            destroy: null
        };
        const destroyBoth = (err) => {
            if (connection.closed) return;
            connection.closed = true;
            connection.controller.abort();
            connections.delete(connection);
            if (err) logger.debug(`mailbox tunnel closed (${targetHost}:${targetPort}): ${err.message}`);
            client.destroy();
            connection.upstream?.destroy();
        };
        connection.destroy = destroyBoth;
        connections.add(connection);

        client.once('error', destroyBoth);
        client.once('close', () => destroyBoth());
        client.setTimeout(CONNECT_TIMEOUT_MS, () => destroyBoth(new Error('tunnel client idle timeout')));

        const pending =
            proxy.kind === 'socks5'
                ? openSocks5Tunnel(proxy, targetHost, targetPort, connection.controller.signal)
                : openHttpConnectTunnel(proxy, targetHost, targetPort, connection.controller.signal);
        pending.then((socket) => {
            if (connection.closed) {
                socket.destroy();
                return;
            }
            connection.upstream = socket;
            socket.setTimeout(0);
            socket.once('error', destroyBoth);
            socket.once('close', () => destroyBoth());
            client.setTimeout(0);
            socket.pipe(client);
            client.pipe(socket);
        }, destroyBoth);
    });
    serverConnections.set(server, connections);

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.unref?.();
            resolve(server);
        });
    });
}

/** HTTP(S) 代理：标准 CONNECT 隧道，支持 Basic 认证。 */
function openHttpConnectTunnel(proxy, targetHost, targetPort, signal) {
    return new Promise((resolve, reject) => {
        const socket =
            proxy.kind === 'https'
                ? tls.connect({
                      host: proxy.host,
                      port: proxy.port,
                      servername: net.isIP(proxy.host) ? undefined : proxy.host
                  })
                : net.connect(proxy.port, proxy.host);
        const authority = formatTargetAuthority(targetHost, targetPort);
        const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
        if (proxy.username || proxy.password) {
            const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
            lines.push(`Proxy-Authorization: Basic ${token}`);
        }
        const request = lines.join('\r\n') + '\r\n\r\n';
        let buffer = Buffer.alloc(0);
        let settled = false;
        const timer = setTimeout(
            () => fail(new Error(`proxy CONNECT timeout (${proxy.host}:${proxy.port})`)),
            CONNECT_TIMEOUT_MS
        );
        const onAbort = () => fail(new Error('proxy CONNECT aborted'));
        const onError = (err) => fail(new Error(`proxy connect failed: ${err.message}`));
        const onClose = () => fail(new Error('proxy closed the connection during CONNECT'));
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            socket.removeListener('data', onData);
            socket.removeListener('close', onClose);
        };
        const fail = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            socket.destroy();
            reject(err);
        };
        const onReady = () => {
            if (!settled) socket.write(request);
        };
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const marker = buffer.indexOf('\r\n\r\n');
            if (marker === -1) {
                if (buffer.length > 16384) fail(new Error('proxy response too large'));
                return;
            }
            const head = buffer.subarray(0, marker).toString('latin1');
            const rest = buffer.subarray(marker + 4);
            settled = true;
            cleanup();

            const statusLine = head.split('\r\n')[0] || '';
            if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
                socket.destroy();
                reject(new Error(`proxy refused CONNECT ${authority}: ${statusLine}`));
                return;
            }
            if (rest.length > 0) socket.unshift(rest);
            resolve(socket);
        };

        socket.on('error', onError);
        socket.once('close', onClose);
        socket.on('data', onData);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
        } else if (proxy.kind === 'https') {
            socket.once('secureConnect', onReady);
        } else {
            socket.once('connect', onReady);
        }
    });
}

/** 从 socket 读取指定长度，返回剩余缓冲。 */
function readExactly(socket, state, length) {
    return new Promise((resolve, reject) => {
        const tryTake = () => {
            if (state.buffer.length >= length) {
                const out = state.buffer.subarray(0, length);
                state.buffer = state.buffer.subarray(length);
                cleanup();
                resolve(out);
                return true;
            }
            return false;
        };
        const onData = (chunk) => {
            state.buffer = Buffer.concat([state.buffer, chunk]);
            tryTake();
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const onClose = () => {
            cleanup();
            reject(new Error('proxy closed the connection during handshake'));
        };
        const cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
        };

        if (tryTake()) return;
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
    });
}

/** SOCKS5 代理：握手 + CONNECT 命令（支持无认证与用户名密码认证）。 */
async function openSocks5Tunnel(proxy, targetHost, targetPort, signal) {
    const socket = net.connect(proxy.port, proxy.host);
    const state = { buffer: Buffer.alloc(0) };
    const onAbort = () => socket.destroy(new Error('socks5 tunnel aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        await new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(
                () => fail(new Error(`socks5 connect timeout (${proxy.host}:${proxy.port})`)),
                CONNECT_TIMEOUT_MS
            );
            const cleanup = () => {
                clearTimeout(timer);
                socket.removeListener('connect', onConnect);
                socket.removeListener('error', onError);
                socket.removeListener('close', onClose);
            };
            const fail = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                socket.destroy();
                reject(err);
            };
            const onConnect = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            const onError = (err) => fail(err);
            const onClose = () => fail(new Error('proxy closed before SOCKS5 connect'));
            socket.once('connect', onConnect);
            socket.once('error', onError);
            socket.once('close', onClose);
        });

        const handshakeTimer = setTimeout(
            () => socket.destroy(new Error('socks5 handshake timeout')),
            CONNECT_TIMEOUT_MS
        );
        try {
            const useAuth = Boolean(proxy.username || proxy.password);
            const user = Buffer.from(proxy.username, 'utf8');
            const pass = Buffer.from(proxy.password, 'utf8');
            if (user.length > 255 || pass.length > 255) {
                throw new Error('socks5: username or password is too long');
            }
            socket.write(Buffer.from(useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
            const methodReply = await readExactly(socket, state, 2);
            if (methodReply[0] !== 0x05) throw new Error('socks5: invalid version in method reply');
            const method = methodReply[1];
            if (method === 0x02) {
                socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
                const authReply = await readExactly(socket, state, 2);
                if (authReply[1] !== 0x00) throw new Error('socks5: authentication failed');
            } else if (method !== 0x00) {
                throw new Error(`socks5: unsupported auth method ${method}`);
            }

            const normalizedTargetHost = String(targetHost).replace(/^\[|\]$/g, '');
            const targetIpVersion = net.isIP(normalizedTargetHost);
            const hostBuffer = Buffer.from(normalizedTargetHost, 'utf8');
            if (!targetIpVersion && hostBuffer.length > 255) throw new Error('socks5: target host is too long');
            if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
                throw new Error('socks5: invalid target port');
            }
            const portBuffer = Buffer.alloc(2);
            portBuffer.writeUInt16BE(targetPort, 0);
            const address =
                targetIpVersion === 4
                    ? Buffer.concat([Buffer.from([0x01]), Buffer.from(normalizedTargetHost.split('.').map(Number))])
                    : targetIpVersion === 6
                      ? Buffer.concat([
                            Buffer.from([0x04]),
                            Buffer.from(
                                normalizedTargetHost
                                    .replace(/:/g, '')
                                    .match(/.{1,2}/g)
                                    .map((part) => parseInt(part, 16))
                            )
                        ])
                      : Buffer.concat([Buffer.from([0x03, hostBuffer.length]), hostBuffer]);
            socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, portBuffer]));

            const head = await readExactly(socket, state, 4);
            if (head[0] !== 0x05) throw new Error('socks5: invalid version in connect reply');
            if (head[1] !== 0x00) throw new Error(`socks5: connect failed with code ${head[1]}`);
            const addressType = head[3];
            if (![0x01, 0x03, 0x04].includes(addressType)) {
                throw new Error(`socks5: unsupported reply address type ${addressType}`);
            }
            if (addressType === 0x03) {
                const lengthByte = await readExactly(socket, state, 1);
                await readExactly(socket, state, lengthByte[0] + 2);
            } else {
                await readExactly(socket, state, (addressType === 0x01 ? 4 : 16) + 2);
            }
        } finally {
            clearTimeout(handshakeTimer);
        }

        if (state.buffer.length > 0) socket.unshift(state.buffer);
        return socket;
    } catch (err) {
        socket.destroy();
        throw new Error(`socks5 tunnel failed: ${err.message}`);
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * 获取某个邮件服务器的连接端点。
 *
 * @param {string} host 真实邮件服务器域名
 * @param {number} port 真实端口
 * @returns {Promise<{ host: string, port: number, servername: string } | null>}
 *          无需代理时返回 null，调用方应保持直连。
 */
export async function resolveMailEndpoint(host, port) {
    if (!host || !port) return null;

    const proxyConfig = await resolveMailProxyConfig();
    if (!proxyConfig) {
        // 代理被关闭后不再保留任何隧道，避免下次开启时复用旧代理
        closeMailTunnels();
        return null;
    }
    if (isHostInNoProxyList(host, port, proxyConfig.noProxy)) {
        closeMailTunnel(host, port);
        return null;
    }

    const proxy = parseProxyUrl(proxyConfig.url);
    if (!proxy) {
        logger.warn(`mailbox: unsupported proxy address ${proxyConfig.url}, fallback to direct connection`);
        return null;
    }

    const key = tunnelKey(host, port);
    const signature = proxySignature(proxy);
    desiredTunnelSignatures.set(key, signature);

    const entry = tunnelEntries.get(key);
    if (entry && entry.signature === signature) {
        return { host: '127.0.0.1', port: entry.port, servername: host };
    }
    if (entry) {
        // 代理配置已变化：旧监听仍闭包持有旧代理，必须立即停用
        tunnelEntries.delete(key);
        closeTunnelServer(entry.server);
    }
    // 其余目标上由旧代理建立的隧道也一并淘汰，避免同一时刻存在两套代理
    for (const [otherKey, otherEntry] of tunnelEntries) {
        if (otherEntry.signature !== signature) {
            tunnelEntries.delete(otherKey);
            closeTunnelServer(otherEntry.server);
        }
    }

    const pendingKey = `${key}|${signature}`;
    let pending = pendingTunnels.get(pendingKey);
    if (!pending) {
        pending = createTunnelServer(proxy, host, port)
            .then((server) => {
                const actualPort = server.address().port;
                // 创建期间配置变化或目标被绕过：即使恢复了同一代理，也不能复用已失效的旧创建。
                if (desiredTunnelSignatures.get(key) !== signature || pendingTunnels.get(pendingKey) !== pending) {
                    closeTunnelServer(server);
                    throw new Error('proxy configuration changed while creating tunnel');
                }
                tunnelServers.add(server);
                server.on('error', (err) => {
                    logger.warn(`mailbox tunnel server error (${host}:${port}): ${err.message}`);
                    if (tunnelEntries.get(key)?.server === server) tunnelEntries.delete(key);
                    closeTunnelServer(server);
                });
                tunnelEntries.set(key, { signature, port: actualPort, server });
                logger.info(
                    `mailbox: ${host}:${port} now connects via ${proxy.kind} proxy ${proxy.host}:${proxy.port}`
                );
                return actualPort;
            })
            .finally(() => {
                if (pendingTunnels.get(pendingKey) === pending) pendingTunnels.delete(pendingKey);
            });
        pendingTunnels.set(pendingKey, pending);
    }

    try {
        const actualPort = await pending;
        return { host: '127.0.0.1', port: actualPort, servername: host };
    } catch (err) {
        logger.warn(`mailbox: failed to create proxy tunnel for ${host}:${port}: ${err.message}`);
        return null;
    }
}

/** 关闭所有隧道监听及其活动连接，主要供测试与代理关闭时使用。 */
export function closeMailTunnels() {
    tunnelEntries.clear();
    desiredTunnelSignatures.clear();
    pendingTunnels.clear();
    for (const server of [...tunnelServers]) {
        closeTunnelServer(server);
    }
    tunnelServers.clear();
}
