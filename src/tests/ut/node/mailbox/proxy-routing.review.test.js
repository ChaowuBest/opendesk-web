import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { performance as performanceClock } from 'node:perf_hooks';
import nodemailer from 'nodemailer';
import Imap from 'node-imap';
import { setPlatform } from '../../../../platforms/base.js';
import { closeMailTunnels, resolveMailEndpoint } from '../../../../main/applications/mailbox/service/proxy-tunnel.js';

// Review-only regression tests. All network traffic stays on loopback.
async function setup(t, { protocol = 'smtp', delay = 0, direct = 'stall' } = {}) {
    const sockets = new Set();
    const timers = new Set();
    const stats = { direct: 0, proxy: 0, directBytes: 0 };
    const track = (socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => sockets.delete(socket));
        return socket;
    };
    const rejectedDirect = net.createServer((socket) => {
        track(socket);
        socket.on('data', (data) => {
            stats.directBytes += data.length;
        });
        setImmediate(() => socket.destroy());
    });
    await new Promise((resolve) => rejectedDirect.listen(0, '127.0.0.1', resolve));
    const proxy = net.createServer((socket) => {
        stats.proxy += 1;
        track(socket);
        let buffer = '';
        let connected = false;
        socket.on('data', (data) => {
            buffer += data.toString();
            if (!connected) {
                if (!buffer.includes('\r\n\r\n')) return;
                buffer = '';
                connected = true;
                const timer = setTimeout(() => {
                    timers.delete(timer);
                    if (socket.destroyed) return;
                    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    const bannerTimer = setTimeout(() => {
                        timers.delete(bannerTimer);
                        if (!socket.destroyed)
                            socket.write(
                                protocol === 'imap'
                                    ? '* OK [CAPABILITY IMAP4rev1] ready\r\n'
                                    : '220 mail.test ESMTP ready\r\n'
                            );
                    }, 20);
                    timers.add(bannerTimer);
                }, delay);
                timers.add(timer);
                return;
            }
            while (buffer.includes('\r\n')) {
                const end = buffer.indexOf('\r\n');
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (protocol === 'imap') {
                    const [tag, command] = line.split(' ');
                    if (command === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1\r\n');
                    socket.write(`${tag} OK done\r\n`);
                } else if (/^EHLO|^HELO/.test(line)) {
                    socket.write('250 mail.test\r\n');
                } else if (/^QUIT/.test(line)) {
                    socket.end('221 bye\r\n');
                }
            }
        });
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const config = { use_proxy: 'system', custom_proxy_addr: `http://127.0.0.1:${proxy.address().port}`, no_proxy: '' };
    const oldPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const keys = [
        'ALL_PROXY',
        'all_proxy',
        'HTTP_PROXY',
        'http_proxy',
        'HTTPS_PROXY',
        'https_proxy',
        'NO_PROXY',
        'no_proxy'
    ];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.HTTP_PROXY = config.custom_proxy_addr;
    setPlatform({ getNetworkConfig: () => config });
    const originalConnect = net.connect;
    t.mock.method(net, 'connect', (...args) => {
        const host = typeof args[0] === 'object' ? args[0].host : args[1];
        if (host !== 'mail.example.test') return originalConnect.apply(net, args);
        stats.direct += 1;
        return track(
            direct === 'reset' ? originalConnect(rejectedDirect.address().port, '127.0.0.1') : new net.Socket()
        );
    });
    t.after(() => {
        closeMailTunnels();
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        proxy.close();
        rejectedDirect.close();
        Object.defineProperty(process, 'platform', { value: oldPlatform, configurable: true });
        for (const key of keys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });
    const verify = async (mode) => {
        closeMailTunnels();
        config.use_proxy = mode;
        const endpoint = await resolveMailEndpoint('mail.example.test', protocol === 'imap' ? 143 : 587);
        const start = performanceClock.now();
        try {
            if (protocol === 'imap') {
                const imap = new Imap({
                    host: endpoint.host,
                    port: endpoint.port,
                    tls: false,
                    keepalive: false,
                    user: 'test-user',
                    password: 'test-password'
                });
                try {
                    await new Promise((resolve, reject) => {
                        imap.once('ready', resolve);
                        imap.on('error', reject);
                        imap.once('close', () => reject(new Error('closed before ready')));
                        imap.connect();
                    });
                } finally {
                    imap.destroy();
                }
            } else {
                const transport = nodemailer.createTransport({
                    host: endpoint.host,
                    port: endpoint.port,
                    secure: false,
                    ignoreTLS: true,
                    connectionTimeout: 15000,
                    greetingTimeout: 10000
                });
                try {
                    await transport.verify();
                } finally {
                    transport.close();
                }
            }
            return { ok: true, ms: Math.round(performanceClock.now() - start) };
        } catch (error) {
            return { ok: false, error: error.message, ms: Math.round(performanceClock.now() - start) };
        }
    };
    return { verify, stats };
}

test('automatic route should recover a direct reset before any SMTP bytes are sent', async (t) => {
    const { verify, stats } = await setup(t, { direct: 'reset' });
    const automatic = await verify('system');
    const control = await verify('custom');
    t.diagnostic(JSON.stringify({ automatic, control, stats }));
    assert.equal(control.ok, true);
    assert.equal(stats.directBytes, 0);
    assert.equal(automatic.ok, true);
});

test('automatic route should preserve the existing SMTP verification timeout budget', async (t) => {
    const { verify, stats } = await setup(t, { delay: 8500 });
    const automatic = await verify('system');
    const control = await verify('custom');
    t.diagnostic(JSON.stringify({ automatic, control, stats }));
    assert.equal(control.ok, true);
    assert.equal(automatic.ok, true);
});

test('automatic route should preserve node-imap default authentication budget', async (t) => {
    const { verify, stats } = await setup(t, { protocol: 'imap', delay: 3500 });
    const automatic = await verify('system');
    const control = await verify('custom');
    t.diagnostic(JSON.stringify({ automatic, control, stats }));
    assert.equal(control.ok, true);
    assert.equal(automatic.ok, true);
});
