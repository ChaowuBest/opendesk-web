import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { setPlatform } from '../../../../platforms/base.js';
import {
    closeMailTunnels,
    parseProxyUrl,
    resolveMailEndpoint
} from '../../../../main/applications/mailbox/service/proxy-tunnel.js';

function useNetworkConfig(networkConfig) {
    setPlatform({ getNetworkConfig: () => networkConfig });
}

function baseConfig(overrides = {}) {
    return {
        no_ssl: false,
        use_proxy: 'none',
        custom_proxy_addr: '',
        no_proxy: '',
        ...overrides
    };
}

/** 目标邮件服务器替身：连接后主动发送一个标识字节。 */
async function startTargetServer(banner = 'TARGET', closeOnData = false) {
    const sockets = new Set();
    const stats = { connections: 0, received: [] };
    const server = net.createServer((socket) => {
        stats.connections += 1;
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
        socket.write(banner);
        // echo，便于验证双向转发
        socket.on('data', (chunk) => {
            stats.received.push(chunk);
            if (closeOnData) socket.destroy();
            else socket.write(chunk);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        stats,
        close() {
            for (const socket of sockets) socket.destroy();
            server.close();
        }
    };
}

/** 按行读取 socket 数据的小工具 */
function createReader(socket) {
    let buffer = Buffer.alloc(0);
    const waiters = [];
    let failure = null;

    const failAll = (error) => {
        failure = error;
        while (waiters.length > 0) {
            waiters.shift().reject(error);
        }
    };

    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        flush();
    });
    socket.on('error', (error) => failAll(error));
    socket.on('close', () => failAll(new Error('socket closed before enough data arrived')));

    function flush() {
        while (waiters.length > 0) {
            const waiter = waiters[0];
            if (buffer.length >= waiter.length) {
                const out = buffer.subarray(0, waiter.length);
                buffer = buffer.subarray(waiter.length);
                waiters.shift();
                waiter.resolve(out);
                continue;
            }
            const text = buffer.toString('latin1');
            const marker = text.indexOf(waiter.delimiter);
            if (marker !== -1) {
                const end = Buffer.byteLength(text.slice(0, marker + waiter.delimiter.length), 'latin1');
                const out = buffer.subarray(0, end);
                buffer = buffer.subarray(end);
                waiters.shift();
                waiter.resolve(out);
                continue;
            }
            break;
        }
    }
    return {
        readBytes(length) {
            return new Promise((resolve, reject) => {
                if (failure) return reject(failure);
                waiters.push({ length, resolve, reject });
                flush();
            });
        },
        readUntil(delimiter) {
            return new Promise((resolve, reject) => {
                if (failure) return reject(failure);
                waiters.push({ delimiter, resolve, reject });
                flush();
            });
        }
    };
}

/** 最小 HTTP CONNECT 代理，转发到真实目标，并统计收到的隧道连接数。 */
async function startHttpProxy(targetHostOverride) {
    const stats = { connections: 0 };
    const server = net.createServer((client) => {
        stats.connections += 1;
        const reader = createReader(client);
        client.on('error', () => undefined);
        reader.readUntil('\r\n\r\n').then((head) => {
            const firstLine = head.toString('latin1').split('\r\n')[0];
            const [, authority] = firstLine.split(' ');
            const [host, port] = authority.split(':');
            const upstream = net.connect(Number(port), targetHostOverride || host);
            upstream.on('connect', () => {
                client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                upstream.pipe(client);
                client.pipe(upstream);
            });
            upstream.on('error', () => client.destroy());
            client.on('close', () => upstream.destroy());
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, stats, close: () => server.close() };
}

/** 只收 CONNECT 但永不响应的代理，用于模拟挂起的代理和验证连接清理。 */
async function startStallingHttpProxy() {
    const sockets = new Set();
    const server = net.createServer((client) => {
        sockets.add(client);
        client.on('error', () => undefined);
        client.on('close', () => sockets.delete(client));
        client.on('data', () => undefined);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        get activeConnections() {
            return sockets.size;
        },
        close() {
            for (const socket of sockets) socket.destroy();
            server.close();
        }
    };
}

async function waitFor(predicate, message) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** 最小 SOCKS5 代理（无认证），转发到真实目标。 */
async function startSocks5Proxy() {
    const server = net.createServer((client) => {
        const reader = createReader(client);
        client.on('error', () => undefined);
        (async () => {
            const greeting = await reader.readBytes(2);
            const methods = await reader.readBytes(greeting[1]);
            assert.ok(methods.includes(0x00), 'client should offer no-auth');
            client.write(Buffer.from([0x05, 0x00]));

            const request = await reader.readBytes(4);
            const addressType = request[3];
            let host;
            if (addressType === 0x03) {
                const length = await reader.readBytes(1);
                host = (await reader.readBytes(length[0])).toString('utf8');
            } else if (addressType === 0x01) {
                host = Array.from(await reader.readBytes(4)).join('.');
            } else {
                throw new Error(`unsupported address type ${addressType}`);
            }
            const portBuffer = await reader.readBytes(2);
            const port = portBuffer.readUInt16BE(0);

            const upstream = net.connect(port, host);
            upstream.on('connect', () => {
                client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                upstream.pipe(client);
                client.pipe(upstream);
            });
            upstream.on('error', () => client.destroy());
            client.on('close', () => upstream.destroy());
        })().catch(() => client.destroy());
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, close: () => server.close() };
}

/** 通过隧道端口建立连接并读回目标服务器 banner。 */
async function readBannerViaEndpoint(endpoint) {
    const socket = net.connect(endpoint.port, endpoint.host);
    try {
        socket.on('error', () => undefined);
        const reader = createReader(socket);
        const banner = await reader.readBytes(6);
        return banner.toString('utf8');
    } finally {
        socket.destroy();
    }
}

test('parseProxyUrl normalizes scheme-less, http and socks5 addresses', () => {
    assert.deepEqual(parseProxyUrl('127.0.0.1:8118'), {
        kind: 'http',
        host: '127.0.0.1',
        port: 8118,
        username: '',
        password: ''
    });
    assert.deepEqual(parseProxyUrl('http://user:pa%40ss@proxy.local:3128'), {
        kind: 'http',
        host: 'proxy.local',
        port: 3128,
        username: 'user',
        password: 'pa@ss'
    });
    assert.equal(parseProxyUrl('socks5://127.0.0.1:1080').kind, 'socks5');
    assert.equal(parseProxyUrl(''), null);
    assert.equal(parseProxyUrl('socks4://127.0.0.1:1080'), null);
});

test('resolveMailEndpoint returns null when proxy is disabled or target is in no_proxy', async () => {
    useNetworkConfig(baseConfig({ use_proxy: 'none' }));
    assert.equal(await resolveMailEndpoint('imap.example.com', 993), null);

    useNetworkConfig(
        baseConfig({ use_proxy: 'custom', custom_proxy_addr: 'http://127.0.0.1:1', no_proxy: '.example.com' })
    );
    assert.equal(await resolveMailEndpoint('imap.example.com', 993), null);
});

test('resolveMailEndpoint tunnels IMAP through an HTTP CONNECT proxy', async () => {
    const target = await startTargetServer('IMAPOK');
    const proxy = await startHttpProxy();
    useNetworkConfig(baseConfig({ use_proxy: 'custom', custom_proxy_addr: `http://127.0.0.1:${proxy.port}` }));

    try {
        const endpoint = await resolveMailEndpoint('127.0.0.1', target.port);
        assert.ok(endpoint, 'endpoint should be returned when proxy is configured');
        assert.equal(endpoint.host, '127.0.0.1');
        assert.equal(endpoint.servername, '127.0.0.1', 'TLS servername must keep the real mail host');

        const banner = await readBannerViaEndpoint(endpoint);
        assert.equal(banner, 'IMAPOK');

        // 同一目标复用同一隧道端口
        const again = await resolveMailEndpoint('127.0.0.1', target.port);
        assert.equal(again.port, endpoint.port);
    } finally {
        closeMailTunnels();
        proxy.close();
        target.close();
    }
});

test('resolveMailEndpoint tunnels SMTP through a SOCKS5 proxy', async () => {
    const target = await startTargetServer('SMTPOK');
    const proxy = await startSocks5Proxy();
    useNetworkConfig(baseConfig({ use_proxy: 'custom', custom_proxy_addr: `socks5://127.0.0.1:${proxy.port}` }));

    try {
        const endpoint = await resolveMailEndpoint('127.0.0.1', target.port);
        assert.ok(endpoint);
        const banner = await readBannerViaEndpoint(endpoint);
        assert.equal(banner, 'SMTPOK');
    } finally {
        closeMailTunnels();
        proxy.close();
        target.close();
    }
});

test('unreachable proxy keeps the tunnel endpoint and fails the connection instead of going direct', async () => {
    useNetworkConfig(baseConfig({ use_proxy: 'custom', custom_proxy_addr: 'http://127.0.0.1:9' }));

    const target = await startTargetServer('DIRECT');
    try {
        const endpoint = await resolveMailEndpoint('127.0.0.1', target.port);
        assert.ok(endpoint, 'tunnel listener itself is created lazily and does not need the proxy to be up-front');
        await assert.rejects(async () => readBannerViaEndpoint(endpoint));
    } finally {
        closeMailTunnels();
        target.close();
    }
});

test('parseProxyUrl keeps https proxies distinct and tolerates malformed credentials', () => {
    assert.deepEqual(parseProxyUrl('https://proxy.example'), {
        kind: 'https',
        host: 'proxy.example',
        port: 443,
        username: '',
        password: ''
    });
    assert.equal(parseProxyUrl('https://proxy.example:8443').kind, 'https');
    // 非法百分号编码不应该抛异常，按无效代理处理
    assert.equal(parseProxyUrl('http://user:%ZZ@proxy.example:8080'), null);
});

test('resolveMailEndpoint rebuilds the tunnel when the configured proxy changes', async () => {
    const target = await startTargetServer('SWITCH');
    const proxyA = await startHttpProxy();
    const proxyB = await startHttpProxy();
    const config = baseConfig({ use_proxy: 'custom', custom_proxy_addr: `http://127.0.0.1:${proxyA.port}` });
    useNetworkConfig(config);

    try {
        const first = await resolveMailEndpoint('127.0.0.1', target.port);
        assert.equal(await readBannerViaEndpoint(first), 'SWITCH');
        assert.equal(proxyA.stats.connections, 1);

        config.custom_proxy_addr = `http://127.0.0.1:${proxyB.port}`;
        const second = await resolveMailEndpoint('127.0.0.1', target.port);
        assert.notEqual(second.port, first.port, '切换代理后必须换用新的隧道端口');
        assert.equal(await readBannerViaEndpoint(second), 'SWITCH');
        assert.equal(proxyB.stats.connections, 1, '新连接必须经新代理转发');
        assert.equal(proxyA.stats.connections, 1, '旧代理不应再收到新连接');

        // 旧监听必须被关闭，避免继续经旧代理转发
        await assert.rejects(async () => readBannerViaEndpoint(first), 'old tunnel should be closed');
    } finally {
        closeMailTunnels();
        proxyA.close();
        proxyB.close();
        target.close();
    }
});

test('client disconnect during CONNECT handshake releases the proxy socket', async () => {
    const proxy = await startStallingHttpProxy();
    useNetworkConfig(baseConfig({ use_proxy: 'custom', custom_proxy_addr: `http://127.0.0.1:${proxy.port}` }));

    try {
        const endpoint = await resolveMailEndpoint('mail.example.test', 993);
        const socket = net.connect(endpoint.port, endpoint.host);
        try {
            await new Promise((resolve) => socket.once('connect', resolve));
            await waitFor(() => proxy.activeConnections === 1, 'proxy should see the tunnel connection');
            socket.destroy();
            await waitFor(() => proxy.activeConnections === 0, 'proxy socket must be released after client disconnect');
        } finally {
            socket.destroy();
        }
    } finally {
        closeMailTunnels();
        proxy.close();
    }
});

/** 用本地服务器模拟“公网 IP 经企业路由直达”，不访问真实外网。 */
async function automaticMailSetup(t, directMode = 'connect', closeOnData = false) {
    const target = await startTargetServer('MAILOK', closeOnData);
    const proxy = await startHttpProxy('127.0.0.1');
    const originalPlatform = process.platform;
    const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
    const savedEnv = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    const config = baseConfig({ use_proxy: 'system' });
    useNetworkConfig(config);
    const originalConnect = net.connect;
    const stats = { directAttempts: 0, directSockets: [], directMode };
    t.mock.method(net, 'connect', (...args) => {
        const host = typeof args[0] === 'object' ? args[0].host : args[1];
        const port = typeof args[0] === 'object' ? args[0].port : args[0];
        if (host !== '203.0.113.10' || port !== target.port) return originalConnect.apply(net, args);
        stats.directAttempts += 1;
        const socket = stats.directMode === 'connect' ? originalConnect(target.port, '127.0.0.1') : new net.Socket();
        stats.directSockets.push(socket);
        if (stats.directMode === 'refuse') {
            process.nextTick(() => socket.destroy(new Error('ECONNREFUSED')));
        }
        return socket;
    });
    t.after(() => {
        closeMailTunnels();
        proxy.close();
        target.close();
        for (const socket of stats.directSockets) socket.destroy();
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        for (const key of proxyKeys) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });
    return {
        target,
        proxy,
        config,
        stats,
        endpoint: () => resolveMailEndpoint('203.0.113.10', target.port)
    };
}

test('system proxy uses a reachable public-IP mail server directly without a whitelist or extra probe', async (t) => {
    const { endpoint, proxy, target, stats } = await automaticMailSetup(t);
    const resolved = await endpoint();
    assert.equal(resolved.servername, '203.0.113.10');
    assert.equal(await readBannerViaEndpoint(resolved), 'MAILOK');
    assert.equal(stats.directAttempts, 1);
    assert.equal(target.stats.connections, 1, 'reuse the connection for mail instead of probing and reconnecting');
    assert.equal(proxy.stats.connections, 0);
});

test('system proxy falls back after direct refusal and briefly remembers the proxy route', async (t) => {
    const { endpoint, proxy, stats } = await automaticMailSetup(t, 'refuse');
    const resolved = await endpoint();
    assert.equal(await readBannerViaEndpoint(resolved), 'MAILOK');
    assert.equal(await readBannerViaEndpoint(resolved), 'MAILOK');
    assert.equal(stats.directAttempts, 1, 'avoid retrying an unavailable direct route on every mail operation');
    assert.equal(proxy.stats.connections, 2);
    assert.equal(stats.directSockets[0].destroyed, true);
});

test('system proxy falls back after direct timeout and closes the abandoned connection', async (t) => {
    const { endpoint, proxy, stats } = await automaticMailSetup(t, 'stall');
    assert.equal(await readBannerViaEndpoint(await endpoint()), 'MAILOK');
    assert.equal(stats.directAttempts, 1);
    assert.equal(stats.directSockets[0].destroyed, true);
    assert.equal(proxy.stats.connections, 1);
});

test('system proxy retries the direct route after the short cache expires', async (t) => {
    const { endpoint, proxy, stats } = await automaticMailSetup(t, 'refuse');
    const resolved = await endpoint();
    assert.equal(await readBannerViaEndpoint(resolved), 'MAILOK');
    stats.directMode = 'connect';
    const later = Date.now() + 30001;
    t.mock.method(Date, 'now', () => later);
    assert.equal(await readBannerViaEndpoint(resolved), 'MAILOK');
    assert.equal(stats.directAttempts, 2);
    assert.equal(proxy.stats.connections, 1);
});

test('system proxy cancels a pending direct connection when the mail client disconnects', async (t) => {
    const { endpoint, proxy, stats } = await automaticMailSetup(t, 'stall');
    const resolved = await endpoint();
    const client = net.connect(resolved.port, resolved.host);
    client.on('error', () => undefined);
    t.after(() => client.destroy());
    await waitFor(() => stats.directAttempts === 1, 'direct connection should have started');
    client.destroy();
    await waitFor(() => stats.directSockets[0].destroyed, 'disconnect must release the pending direct socket');
    await new Promise(setImmediate);
    assert.equal(proxy.stats.connections, 0, 'cancellation must not start a fallback connection');
});

test('system proxy does not replay mail data through the proxy after an established direct connection fails', async (t) => {
    const { endpoint, proxy, target } = await automaticMailSetup(t, 'connect', true);
    const resolved = await endpoint();
    const client = net.connect(resolved.port, resolved.host);
    t.after(() => client.destroy());
    const reader = createReader(client);
    assert.equal((await reader.readBytes(6)).toString(), 'MAILOK');
    client.write('SEND');
    await assert.rejects(reader.readBytes(1));
    await new Promise(setImmediate);
    assert.equal(Buffer.concat(target.stats.received).toString(), 'SEND');
    assert.equal(target.stats.connections, 1);
    assert.equal(proxy.stats.connections, 0);
});

test('system proxy automatic routing is replaced when switching to an explicit custom proxy', async (t) => {
    const { endpoint, config, proxy, stats } = await automaticMailSetup(t);
    const first = await endpoint();
    assert.equal(await readBannerViaEndpoint(first), 'MAILOK');
    config.use_proxy = 'custom';
    config.custom_proxy_addr = `http://127.0.0.1:${proxy.port}`;
    const second = await endpoint();
    assert.notEqual(first.port, second.port);
    assert.equal(await readBannerViaEndpoint(second), 'MAILOK');
    assert.equal(stats.directAttempts, 1);
    assert.equal(proxy.stats.connections, 1);
});
