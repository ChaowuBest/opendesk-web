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
import { getPlatform } from '../../../../platforms/base.js';
import { getEffectiveSystemProxy } from '../../../../main/utils/proxy-env.js';
import { isHostInNoProxyList } from '../../../../main/utils/proxy.js';
import { logger } from '../../../../main/utils/logger.js';

/** key = `${host}:${port}`，value = 隧道本地端口（listen 结果） */
const tunnelPorts = new Map();
/** 进行中的隧道创建，避免并发重复建监听 */
const pendingTunnels = new Map();
/** 已启动的监听，供退出/测试时统一关闭 */
const tunnelServers = new Set();

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
    try {
        const sys = await getEffectiveSystemProxy();
        if (sys?.url) {
            return { url: sys.url, noProxy: noProxy || sys.bypassList || '' };
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
    return { url: envProxy, noProxy: noProxy || process.env.NO_PROXY || process.env.no_proxy || '' };
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
    if (protocol === 'socks5' || protocol === 'socks5h' || protocol === 'socks' || protocol === 'socks4') {
        if (protocol === 'socks4') return null;
        kind = 'socks5';
    } else if (protocol === 'http' || protocol === 'https') {
        kind = 'http';
    } else {
        return null;
    }

    const port = Number(url.port) || (kind === 'socks5' ? 1080 : 8080);
    if (!url.hostname || !port) return null;

    return {
        kind,
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port,
        username: url.username ? decodeURIComponent(url.username) : '',
        password: url.password ? decodeURIComponent(url.password) : ''
    };
}

/** 起一个本地监听，把每个进来的连接经代理转发到 targetHost:targetPort。 */
function createTunnelServer(proxy, targetHost, targetPort) {
    const server = net.createServer((client) => {
        let upstream = null;
        const destroyBoth = (err) => {
            if (err) logger.debug(`mailbox tunnel closed (${targetHost}:${targetPort}): ${err.message}`);
            client.destroy();
            upstream?.destroy();
        };

        client.on('error', destroyBoth);
        client.setTimeout(CONNECT_TIMEOUT_MS, () => destroyBoth(new Error('tunnel client idle timeout')));

        const onEstablished = (socket) => {
            upstream = socket;
            socket.setTimeout(0);
            socket.on('error', destroyBoth);
            client.setTimeout(0);
            socket.pipe(client);
            client.pipe(socket);
        };

        const pending =
            proxy.kind === 'socks5'
                ? openSocks5Tunnel(proxy, targetHost, targetPort)
                : openHttpConnectTunnel(proxy, targetHost, targetPort);
        pending.then(onEstablished, destroyBoth);
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.unref?.();
            resolve(server);
        });
    });
}

/** HTTP(S) 代理：标准 CONNECT 隧道，支持 Basic 认证。 */
function openHttpConnectTunnel(proxy, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, proxy.host);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`proxy CONNECT timeout (${proxy.host}:${proxy.port})`));
        }, CONNECT_TIMEOUT_MS);

        const lines = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`];
        if (proxy.username || proxy.password) {
            const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
            lines.push(`Proxy-Authorization: Basic ${token}`);
        }
        const request = lines.join('\r\n') + '\r\n\r\n';

        let buffer = Buffer.alloc(0);
        const onError = (err) => {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error(`proxy connect failed: ${err.message}`));
        };

        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const marker = buffer.indexOf('\r\n\r\n');
            if (marker === -1) {
                if (buffer.length > 16384) onError(new Error('proxy response too large'));
                return;
            }
            const head = buffer.subarray(0, marker).toString('latin1');
            const rest = buffer.subarray(marker + 4);
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            clearTimeout(timer);

            const statusLine = head.split('\r\n')[0] || '';
            if (!/^HTTP\/1\.[01] 2\d\d/.test(statusLine)) {
                socket.destroy();
                reject(new Error(`proxy refused CONNECT ${targetHost}:${targetPort}: ${statusLine}`));
                return;
            }
            if (rest.length > 0) socket.unshift(rest);
            resolve(socket);
        };

        socket.on('error', onError);
        socket.on('data', onData);
        socket.once('connect', () => socket.write(request));
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
async function openSocks5Tunnel(proxy, targetHost, targetPort) {
    const socket = net.connect(proxy.port, proxy.host);
    const state = { buffer: Buffer.alloc(0) };

    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`socks5 connect timeout (${proxy.host}:${proxy.port})`));
            }, CONNECT_TIMEOUT_MS);
            socket.once('connect', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const useAuth = Boolean(proxy.username || proxy.password);
        socket.write(Buffer.from(useAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
        const methodReply = await readExactly(socket, state, 2);
        if (methodReply[0] !== 0x05) throw new Error('socks5: invalid version in method reply');
        const method = methodReply[1];
        if (method === 0x02) {
            const user = Buffer.from(proxy.username, 'utf8');
            const pass = Buffer.from(proxy.password, 'utf8');
            socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
            const authReply = await readExactly(socket, state, 2);
            if (authReply[1] !== 0x00) throw new Error('socks5: authentication failed');
        } else if (method !== 0x00) {
            throw new Error(`socks5: unsupported auth method ${method}`);
        }

        const hostBuffer = Buffer.from(targetHost, 'utf8');
        const portBuffer = Buffer.alloc(2);
        portBuffer.writeUInt16BE(targetPort, 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]), hostBuffer, portBuffer]));

        const head = await readExactly(socket, state, 4);
        if (head[0] !== 0x05) throw new Error('socks5: invalid version in connect reply');
        if (head[1] !== 0x00) throw new Error(`socks5: connect failed with code ${head[1]}`);
        const addressType = head[3];
        const addressLength = addressType === 0x01 ? 4 : addressType === 0x04 ? 16 : 0x01;
        if (addressType === 0x03) {
            const lengthByte = await readExactly(socket, state, 1);
            await readExactly(socket, state, lengthByte[0] + 2);
        } else {
            await readExactly(socket, state, addressLength + 2);
        }

        if (state.buffer.length > 0) socket.unshift(state.buffer);
        return socket;
    } catch (err) {
        socket.destroy();
        throw new Error(`socks5 tunnel failed: ${err.message}`);
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
    if (!proxyConfig) return null;
    if (isHostInNoProxyList(host, port, proxyConfig.noProxy)) return null;

    const proxy = parseProxyUrl(proxyConfig.url);
    if (!proxy) {
        logger.warn(`mailbox: unsupported proxy address ${proxyConfig.url}, fallback to direct connection`);
        return null;
    }

    const key = `${host}:${port}`;
    const cached = tunnelPorts.get(key);
    if (cached !== undefined) {
        return { host: '127.0.0.1', port: cached, servername: host };
    }

    let pending = pendingTunnels.get(key);
    if (!pending) {
        pending = createTunnelServer(proxy, host, port).then((server) => {
            const actualPort = server.address().port;
            tunnelPorts.set(key, actualPort);
            tunnelServers.add(server);
            pendingTunnels.delete(key);
            server.on('error', (err) => {
                logger.warn(`mailbox tunnel server error (${key}): ${err.message}`);
                tunnelPorts.delete(key);
                tunnelServers.delete(server);
            });
            logger.info(`mailbox: ${key} now connects via ${proxy.kind} proxy ${proxy.host}:${proxy.port}`);
            return actualPort;
        });
        pendingTunnels.set(key, pending);
    }

    try {
        const actualPort = await pending;
        return { host: '127.0.0.1', port: actualPort, servername: host };
    } catch (err) {
        pendingTunnels.delete(key);
        logger.warn(`mailbox: failed to create proxy tunnel for ${key}: ${err.message}`);
        return null;
    }
}

/** 进程/线程退出前关闭所有隧道监听，主要供测试使用。 */
export function closeMailTunnels() {
    tunnelPorts.clear();
    pendingTunnels.clear();
    for (const server of tunnelServers) {
        try {
            server.close();
        } catch {
            /* best-effort */
        }
    }
    tunnelServers.clear();
}
