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
async function startTargetServer(banner = 'TARGET') {
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
        socket.write(banner);
        // echo，便于验证双向转发
        socket.on('data', (chunk) => socket.write(chunk));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
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
async function startHttpProxy() {
    const stats = { connections: 0 };
    const server = net.createServer((client) => {
        stats.connections += 1;
        const reader = createReader(client);
        client.on('error', () => undefined);
        reader.readUntil('\r\n\r\n').then((head) => {
            const firstLine = head.toString('latin1').split('\r\n')[0];
            const [, authority] = firstLine.split(' ');
            const [host, port] = authority.split(':');
            const upstream = net.connect(Number(port), host);
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
