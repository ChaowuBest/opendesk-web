import fs from 'node:fs';
import dgram from 'node:dgram';
import { promises as dns } from 'node:dns';
import { isMainThread } from 'node:worker_threads';
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
    const value = new URL(typeof url === 'string' ? url : url.url ?? url);
    if (!['127.0.0.1', 'localhost'].includes(value.hostname)) return Promise.reject(Error('isolated_external_fetch_blocked'));
    return originalFetch(url, ...args);
};
const settings = JSON.parse(fs.readFileSync(process.env.CLI_ACCEPTANCE_CONFIG));
if (isMainThread && settings.diagnosticsFile) {
    const counts = { exit: [], budgetTimers: 0, budgetFired: 0, faults: [] };
    const save = () => fs.writeFileSync(settings.diagnosticsFile, JSON.stringify(counts));
    const exit = process.exit;
    process.exit = function (code) { counts.exit.push(code); save(); return exit.call(this, code); };
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = function (callback, ms, ...args) {
        if (ms !== 3000) return schedule(callback, ms, ...args);
        counts.budgetTimers++; save();
        return schedule((...values) => { counts.budgetFired++; save(); callback(...values); }, ms, ...args);
    };
    process.on('uncaughtExceptionMonitor', (error) => { counts.faults.push(error?.code === 'EPIPE' ? 'EPIPE' : 'fatal'); save(); });
    process.once('exit', (code) => { counts.exitEvent = code; save(); });
}
if (settings.blockDirect || settings.blockUdp) {
    const send = dgram.Socket.prototype.send;
    dgram.Socket.prototype.send = function (...args) {
        const port = args.find((value, index) => typeof value === 'number' && typeof args[index + 1] === 'string');
        const blocked = settings.blockDirect && port >= 55000 && port <= 55149 || settings.blockUdp && port === settings.udpPort;
        if (blocked) {
            const callback = args.at(-1);
            if (typeof callback === 'function') queueMicrotask(() => callback(null));
            return this;
        }
        return send.apply(this, args);
    };
}
if (settings.slowDns) {
    const lookup = dns.lookup;
    dns.lookup = (host, options) => host === 'slow.synthetic.invalid' ? new Promise(() => {}) : lookup(host, options);
}
if (isMainThread && settings.faultFile) {
    const timer = setInterval(() => {
        if (!fs.existsSync(settings.faultFile)) return;
        const fault = fs.readFileSync(settings.faultFile, 'utf8'); fs.unlinkSync(settings.faultFile);
        if (fault === 'epipe') process.emit('uncaughtException', Object.assign(Error('synthetic EPIPE'), { code: 'EPIPE' }), 'uncaughtException');
        if (fault === 'fatal') throw Error('synthetic fatal');
        if (fault === 'reject') void Promise.reject(Error('synthetic rejection'));
        if (fault === 'stop') process.kill(process.pid, 'SIGTERM');
    }, 20);
    timer.unref();
}
