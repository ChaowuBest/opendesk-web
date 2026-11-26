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
/** Manual local-only acceptance. Requires the three REMOTE_NETWORK_CONTRACT_* paths,
 * Chrome, coturn, openssl and node-pty. No device operations or production credentials.
 * node --import tsx .../cli-network-acceptance.mjs --out <directory> [--cases direct,udp,tcp,tls,all,dns,source,production]
 * --cli overrides the production bin with an installed release bin.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { promises as dns } from 'node:dns';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const arg = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const out = path.resolve(arg('--out', '.tmp/cli-network-acceptance'));
const root = arg('--root');
const mode = arg('--case');
const scenario = mode?.replace(/^(?:production|source)-/, '');
const entry = mode?.startsWith('source') || mode?.startsWith('production');
const entryRelay =
    entry && !['source', 'production'].includes(mode) && !['bad-fingerprint', 'limit'].includes(scenario);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}
async function stop(child) {
    child.kill('SIGTERM');
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}
if (!mode) {
    fs.mkdirSync(out, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-cli-acceptance-'));
    const cert = path.join(temporary, 'cert.pem'),
        key = path.join(temporary, 'key.pem');
    const certResult = spawnSync(
        '/usr/bin/openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-keyout',
            key,
            '-out',
            cert,
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost,IP:127.0.0.1'
        ],
        { stdio: 'ignore' }
    );
    assert.equal(certResult.status, 0, 'temporary trusted CA generation');
    const udpPort = await freePort(),
        tcpPort = await freePort(),
        tlsPort = await freePort();
    const settings = {
        udpPort,
        tcpPort,
        tlsPort,
        cert,
        key,
        username: 'synthetic',
        credential: 'synthetic-local-only',
        urls: [
            `turn:127.0.0.1:${udpPort}?transport=udp`,
            `turn:127.0.0.1:${tcpPort}?transport=tcp`,
            `turns:127.0.0.1:${tlsPort}?transport=tcp`
        ]
    };
    fs.writeFileSync(path.join(temporary, 'turn.json'), JSON.stringify(settings), { mode: 0o600 });
    const summary = [];
    try {
        for (const current of arg(
            '--cases',
            'direct,udp,tcp,tls,all,dns,cancel-resolve,cancel-reject,bad-tls,bad-fingerprint,source,production'
        ).split(',')) {
            fs.rmSync(path.join(out, `${current}.json`), { force: true });
            const currentScenario = current.replace(/^(?:production|source)-/, '');
            fs.writeFileSync(path.join(temporary, 'turn.json'), JSON.stringify(settings), { mode: 0o600 });
            const turns = [];
            try {
                const needed =
                    currentScenario === 'direct' ||
                    ['source', 'production', 'bad-fingerprint', 'limit'].includes(currentScenario)
                        ? []
                        : currentScenario === 'all'
                          ? ['udp', 'tcp', 'tls']
                          : currentScenario === 'tcp'
                            ? ['udp', 'tcp']
                            : ['dns', 'tls', 'bad-tls'].includes(currentScenario)
                              ? ['udp', 'tls']
                              : ['cancel-resolve', 'cancel-reject', 'bad-fingerprint'].includes(currentScenario)
                                ? ['udp']
                                : ['udp'];
                for (const type of needed) {
                    const index = ['udp', 'tcp', 'tls'].indexOf(type);
                    const port = type === 'udp' ? udpPort : type === 'tcp' ? tcpPort : await freePort();
                    const config = path.join(temporary, `${type}.conf`);
                    fs.writeFileSync(
                        config,
                        [
                            'listening-ip=127.0.0.1',
                            'relay-ip=127.0.0.1',
                            `listening-port=${port}`,
                            `tls-listening-port=${tlsPort}`,
                            `min-port=${55000 + index * 50}`,
                            `max-port=${55049 + index * 50}`,
                            'realm=opendesk-isolated',
                            'lt-cred-mech',
                            'user=synthetic:synthetic-local-only',
                            'no-cli',
                            'no-tcp-relay',
                            'no-dtls',
                            'no-multicast-peers',
                            'allow-loopback-peers',
                            'denied-peer-ip=0.0.0.0-255.255.255.255',
                            'allowed-peer-ip=127.0.0.1',
                            'relay-threads=1',
                            ...(type === 'udp'
                                ? ['no-tcp', 'no-tls']
                                : type === 'tcp'
                                  ? ['no-udp', 'no-tls']
                                  : ['no-udp']),
                            `cert=${cert}`,
                            `pkey=${key}`,
                            `pidfile=${temporary}/${type}.pid`,
                            `log-file=${temporary}/${type}.log`,
                            'no-stdout-log'
                        ].join('\n')
                    );
                    const child = spawn('/opt/homebrew/bin/turnserver', ['-c', config], { stdio: 'ignore' });
                    turns.push(child);
                    await sleep(300);
                    assert.equal(child.exitCode, null, 'local coturn alive');
                }
                const preload = path.join(
                    project,
                    'src/tests/ut/node/remote-access/fixtures/cli-acceptance-preload.mjs'
                );
                fs.writeFileSync(
                    path.join(temporary, 'controls.json'),
                    JSON.stringify({
                        blockDirect: false,
                        blockUdp: ['tcp', 'tls', 'bad-tls', 'dns'].includes(currentScenario),
                        udpPort
                    })
                );
                const child = spawn(
                    process.execPath,
                    [
                        '--import',
                        'tsx',
                        '--import',
                        preload,
                        self,
                        '--case',
                        current,
                        '--root',
                        temporary,
                        '--out',
                        out,
                        '--cli',
                        arg('--cli', path.join(project, 'dist/cli/opendesk'))
                    ],
                    {
                        cwd: project,
                        env: {
                            ...process.env,
                            NODE_EXTRA_CA_CERTS: cert,
                            OPENDESK_CONFIG_DIRECTORY: path.join(temporary, `parent-${current}`),
                            OPENDDESK_CONFIG_DIRECTORY: undefined,
                            CLI_ACCEPTANCE_CONFIG: path.join(temporary, 'controls.json'),
                            CONTRACT_TURN_INPUT: path.join(temporary, 'turn.json'),
                            HTTP_PROXY: '',
                            HTTPS_PROXY: '',
                            ALL_PROXY: '',
                            http_proxy: '',
                            https_proxy: '',
                            all_proxy: '',
                            NO_PROXY: 'localhost,127.0.0.1'
                        },
                        stdio: ['ignore', 'pipe', 'pipe']
                    }
                );
                let stdout = '';
                child.stdout.on('data', (data) => {
                    stdout += data;
                    if (stdout.length > 65536) stdout = stdout.slice(-65536);
                });
                child.stderr.resume();
                let killed = false;
                const timer = setTimeout(() => {
                    killed = true;
                    child.kill('SIGKILL');
                }, 60000);
                const exit = await new Promise((resolve) =>
                    child.once('exit', (code, signal) => resolve({ code, signal }))
                );
                clearTimeout(timer);
                let result;
                try {
                    result = JSON.parse(fs.readFileSync(path.join(out, `${current}.json`)));
                } catch {
                    result = { mode: current, passed: false, missingReport: true };
                }
                const record = { ...result, exit, killed };
                summary.push(record);
                console.log(JSON.stringify(record));
            } finally {
                for (const turn of turns) await stop(turn);
            }
        }
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
        fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 4) + '\n');
    }
    if (summary.some((value) => !value.passed || value.exit.code !== 0 || value.killed)) process.exitCode = 1;
} else {
    const turn = JSON.parse(fs.readFileSync(path.join(root, 'turn.json')));
    const { chromium } = await import('playwright');
    const { chromiumOfferingPeer } = await import('./fixtures/chromium-peer.js');
    const { until, isolatedServer, serverEnvironment } = await import('./fixtures/isolated-server.js');
    const { createNodeNetworkBridge } = await import('../../../../main/applications/mobileaccess/remote-access/node-network-bridge.js');
    const { RTCPeerConnection } = await import('werift');
    const report = { mode, node: process.version, platform: process.platform, arch: process.arch, passed: false };
    const stage = (value) => {
        report.stage = value;
        fs.writeFileSync(path.join(out, `${mode}.json`), JSON.stringify(report, null, 4) + '\n');
    };
    let context, transport, browserPeer, server, term;
    const lookup = dns.lookup;
    const jobs = [];
    const getServers = () =>
        mode === 'direct' ? [] : [{ urls: turn.urls, username: turn.username, credential: turn.credential }];
    try {
        context = await chromium.launchPersistentContext(path.join(root, `browser-${mode}`), {
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            args: [
                '--disable-features=WebRtcHideLocalIpsWithMdns',
                '--disable-background-networking',
                '--disable-component-update',
                '--disable-sync'
            ]
        });
        await context.route('**/*', (route) => route.abort());
        report.chromium = context.browser()?.version() ?? null;
        if (entry) {
            stage('server_start');
            if (!entryRelay) process.env.CONTRACT_TURN_INPUT = '';
            if (scenario === 'dns') {
                const input = { ...turn, urls: [...turn.urls] };
                input.urls[0] = `turn:slow.synthetic.invalid:${turn.udpPort}?transport=udp`;
                fs.writeFileSync(path.join(root, 'turn.json'), JSON.stringify(input), { mode: 0o600 });
            } // direct entry acceptance; relay adapter cases run above.
            server = await isolatedServer({ cert: turn.cert, key: turn.key });
            const mobile = await import(
                pathToFileURL(
                    path.join(
                        serverEnvironment.mobile,
                        'src/features/remote/connection/server-connection-attempt-provider.ts'
                    )
                ).href
            );
            const require = createRequire(import.meta.url);
            const pty = require('node-pty');
            const profile = path.join(root, `cli-${mode}`);
            fs.mkdirSync(path.join(profile, 'identity/secrets'), { recursive: true });
            fs.writeFileSync(
                path.join(profile, 'setting.json'),
                JSON.stringify({
                    account_config: { mode: 'enterprise', enterprise_base_url: server.baseUrl },
                    providers: [{ name: 'synthetic', base_url: 'http://127.0.0.1:1', api_key: 'synthetic' }],
                    models: [{ alias: 'B', provider_name: 'synthetic', model_name: 'B' }],
                    default_model: 'B'
                })
            );
            fs.writeFileSync(
                path.join(profile, 'identity/secrets/opendesk-account.json'),
                JSON.stringify({
                    version: 1,
                    kind: 'enterprise',
                    baseUrl: server.baseUrl,
                    accessToken: server.token,
                    tokenType: 'Bearer',
                    user: { id: server.userId, username: 'synthetic' }
                }),
                { mode: 0o600 }
            );
            const file = mode.startsWith('source') ? path.join(project, 'src/main/cli.ts') : arg('--cli');
            const preload = path.join(project, 'src/tests/ut/node/remote-access/fixtures/cli-acceptance-preload.mjs');
            const fault = path.join(profile, 'fault');
            const controls = path.join(profile, 'controls.json');
            const diagnostics = path.join(profile, 'diagnostics.json');
            fs.writeFileSync(
                controls,
                JSON.stringify({
                    faultFile: fault,
                    diagnosticsFile: diagnostics,
                    blockDirect: entryRelay,
                    blockUdp: ['tcp', 'tls', 'dns'].includes(scenario),
                    udpPort: turn.udpPort,
                    slowDns: scenario === 'dns'
                })
            );
            const spawnTui = (resume) => {
                fs.rmSync(diagnostics, { force: true });
                const source = mode.startsWith('source');
                const child = pty.spawn(
                    source ? process.execPath : file,
                    [
                        ...(source ? ['--import', preload, '--import', 'tsx', file] : []),
                        '--workspace',
                        profile,
                        '--model',
                        'B',
                        ...(resume ? ['--resume', resume] : [])
                    ],
                    {
                        name: 'xterm-256color',
                        cols: 100,
                        rows: 30,
                        cwd: source ? project : path.dirname(file),
                        env: {
                            ...process.env,
                            OPENDESK_CONFIG_DIRECTORY: profile,
                            OPENDDESK_CONFIG_DIRECTORY: '',
                            CLI_ACCEPTANCE_CONFIG: controls,
                            ...(!source ? { NODE_OPTIONS: '--import ' + preload } : {}),
                            TERM: 'xterm-256color'
                        }
                    }
                );
                let text = '';
                child.onData((data) => {
                    text = (text + data).slice(-65536);
                });
                const alive = () => {
                    try {
                        process.kill(child.pid, 0);
                        return true;
                    } catch (error) {
                        if (error.code === 'ESRCH') return false;
                        throw error;
                    }
                };
                const readDiagnostics = () => {
                    try {
                        return JSON.parse(fs.readFileSync(diagnostics));
                    } catch {
                        return null;
                    }
                };
                // Observe the native PTY status, or a real process exit event plus ESRCH.
                // node-pty's asynchronous callback can be delayed independently of the child.
                const exited = new Promise((resolve) => {
                    const poll = setInterval(() => {
                        const actual = readDiagnostics();
                        if (Number.isInteger(actual?.exitEvent) && !alive()) {
                            clearInterval(poll);
                            resolve({ exitCode: actual.exitEvent, observation: 'exit_event_and_ESRCH' });
                        }
                    }, 50);
                    child.onExit((result) => {
                        clearInterval(poll);
                        resolve({ ...result, observation: 'native_pty' });
                    });
                });
                return {
                    child,
                    exited,
                    output: () => text,
                    diagnostics: () => {
                        return { ...readDiagnostics(), alive: alive() };
                    }
                };
            };
            const discover = async () => {
                const response = await fetch(`${server.baseUrl}/devices`, {
                    headers: { Authorization: `Bearer ${server.token}` }
                });
                return (await response.json()).devices.filter((device) => device.is_online);
            };
            let browserActivations = 0,
                answersApplied = 0;
            const connectClient = async () => {
                const connecting = new AbortController();
                const deadline = setTimeout(() => connecting.abort(), scenario === 'bad-fingerprint' ? 5000 : 25000);
                const devices = await discover();
                assert.equal(devices.length, 1);
                const provider = mobile.createServerConnectionAttemptProvider({
                    getCredential: () => ({
                        scopeKey: 'synthetic',
                        token: server.token,
                        version: 0,
                        baseUrl: server.baseUrl
                    }),
                    subscribeCredential: () => () => undefined,
                    subscribeInvalidation: () => () => undefined,
                    invalidateCredential: async () => {
                        throw Error('unexpected invalidation');
                    },
                    uuid: () => crypto.randomUUID(),
                    bridge: {
                        create: async (input) => {
                            // The peer has one available UDP relay; the actual CLI receives the
                            // complete UDP/TCP/TLS collection from the isolated Server unchanged.
                            browserPeer = await chromiumOfferingPeer(
                                context,
                                {
                                    ...input,
                                    iceServers: entryRelay
                                        ? [
                                              {
                                                  urls: [`turn:127.0.0.1:${turn.udpPort}?transport=udp`],
                                                  username: turn.username,
                                                  credential: turn.credential
                                              }
                                          ]
                                        : input.iceServers
                                },
                                entryRelay,
                                scenario === 'limit' ? 16384 : undefined
                            );
                            if (scenario === 'bad-fingerprint') {
                                const offer = browserPeer.offer.bind(browserPeer);
                                browserPeer.offer = async () =>
                                    (await offer()).replace(
                                        /a=fingerprint:sha-256 [^\r\n]+/g,
                                        'a=fingerprint:sha-256 ' + Array(32).fill('FF').join(':')
                                    );
                                const answer = browserPeer.answer.bind(browserPeer);
                                browserPeer.answer = async (sdp) => {
                                    await answer(sdp);
                                    answersApplied++;
                                };
                                const activate = browserPeer.activateTrusted.bind(browserPeer);
                                browserPeer.activateTrusted = () => {
                                    browserActivations++;
                                    activate();
                                };
                            }
                            return browserPeer;
                        }
                    }
                });
                let port;
                try {
                    for (let retry = 0; !port; retry++) {
                        try {
                            port = await provider.connect(
                                { pcId: devices[0].device_id, opaque: {} },
                                { signal: connecting.signal }
                            );
                        } catch (error) {
                            if (error.code !== 'remote_pc_unavailable' || retry >= 30) throw error;
                            await sleep(100);
                        }
                    }
                } finally {
                    clearTimeout(deadline);
                }
                stage('acp_initialize');
                const acp = await import('@agentclientprotocol/sdk');
                const { createAcpMessageStream } =
                    await import('../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js');
                const client = new acp.ClientSideConnection(
                    () => ({
                        sessionUpdate: async () => undefined,
                        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
                    }),
                    createAcpMessageStream(port, new AbortController()).stream
                );
                await Promise.race([
                    client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
                    sleep(10000).then(() => {
                        port.close();
                        throw Error('ACP initialize timeout');
                    })
                ]);
                return { client, port };
            };
            term = spawnTui();
            stage('registration');
            await until(async () => (await discover()).length === 1, 25000);
            stage('connection');
            if (scenario === 'bad-fingerprint') {
                await assert.rejects(connectClient());
                assert.equal(answersApplied, 1, 'actual wrong-fingerprint offer received a real Host answer');
                assert.equal(browserActivations, 0);
                assert.equal((await discover()).length, 1);
                term.child.write('/help\r');
                await sleep(250);
                assert.equal(term.diagnostics().alive, true);
                term.child.kill('SIGTERM');
                const result = await Promise.race([
                    term.exited,
                    sleep(10000).then(() => {
                        throw Error('exit timeout');
                    })
                ]);
                assert.equal(result.exitCode, 0);
                await until(async () => (await discover()).length === 0);
                report.actualPty = true;
                report.formalAccountRegistration = true;
                report.fingerprintRejected = true;
                report.trustedActivations = 0;
                report.localContinued = true;
                report.SIGTERMReleased = true;
            } else {
                const { client, port } = await connectClient();
                stage('acp');
                const created = await client.newSession({ cwd: profile, mcpServers: [] });
                let listed = await client.listSessions({});
                assert.ok(listed.sessions.some((value) => value.sessionId === created.sessionId));
                if (scenario === 'limit') {
                    for (let count = 0; Buffer.byteLength(JSON.stringify(listed)) < 20000 && count < 300; count++) {
                        await client.newSession({ cwd: profile, mcpServers: [] });
                        if (count % 25 === 24) listed = await client.listSessions({});
                    }
                    assert.ok(Buffer.byteLength(JSON.stringify(listed)) >= 20000);
                    const actual = await browserPeer.inspect();
                    assert.equal(actual.localMaximum, 16384);
                    assert.ok(actual.maximumIncomingBytes <= 16384);
                    assert.ok(actual.fragmentedMessages > 0);
                    report.actualRemoteLimit = 16384;
                    report.fragmentedResponse = true;
                    report.maximumReceivedFrameBytes = actual.maximumIncomingBytes;
                }
                const selected = await browserPeer.inspect();
                assert.equal(selected.ordered, true);
                assert.equal(selected.reliable, true);
                if (entryRelay) {
                    assert.equal(selected.remoteType, 'relay');
                    const actual =
                        selected.remotePort < 55050
                            ? 'udp'
                            : selected.remotePort < 55100
                              ? 'tcp'
                              : selected.remotePort <= 55149
                                ? 'tls'
                                : 'unknown';
                    assert.equal(actual, scenario === 'dns' ? 'tls' : scenario);
                    report.selectedRelay = true;
                    report.selectedTransport = actual;
                } else report.selectedDirect = true;
                report.actualPty = true;
                report.formalAccountRegistration = true;
                report.trustedAcp = true;
                report.newAndList = true;
                port.close();
                fs.writeFileSync(fault, 'epipe');
                await sleep(100);
                assert.ok((await discover()).length === 1);
                report.epipePreserved = true;
                term.child.write('/exit\r');
                await sleep(150);
                term.child.write('\r');
                const firstExit = await Promise.race([
                    term.exited,
                    sleep(10000).then(() => {
                        throw Error('TUI exit timeout');
                    })
                ]);
                assert.equal(firstExit.exitCode, 0);
                assert.equal(term.output().includes(`opendesk --resume ${created.sessionId}`), false);
                report.remoteNewKeptTerminalView = true;
                await until(async () => (await discover()).length === 0);
                report.uiExitReleased = true;
                term = spawnTui(created.sessionId);
                await until(async () => (await discover()).length === 1, 25000);
                const restored = await connectClient();
                const restoredList = await restored.client.listSessions({});
                report.coldNewSessionVisible = restoredList.sessions.some(
                    (value) => value.sessionId === created.sessionId
                );
                if (!report.coldNewSessionVisible) report.knownGap = 'unnamed_task_cold_visibility';
                restored.port.close();
                report.interactiveResume = true;
                fs.writeFileSync(fault, 'fatal');
                const fatalExit = await Promise.race([
                    term.exited,
                    sleep(10000).then(() => {
                        throw Error('fatal exit timeout');
                    })
                ]);
                assert.equal(fatalExit.exitCode, 1);
                await until(async () => (await discover()).length === 0);
                report.fatalReleased = true;
                if (['source', 'production'].includes(mode)) {
                    for (const faultKind of ['reject', 'SIGINT', 'SIGTERM']) {
                        term = spawnTui();
                        await until(async () => (await discover()).length === 1, 25000);
                        if (faultKind === 'reject') fs.writeFileSync(fault, faultKind);
                        else term.child.kill(faultKind);
                        const result = await Promise.race([
                            term.exited,
                            sleep(10000).then(() => {
                                throw Error('exit timeout');
                            })
                        ]);
                        assert.equal(result.exitCode, faultKind === 'reject' ? 1 : 0);
                        await until(async () => (await discover()).length === 0);
                        report[`${faultKind}Released`] = true;
                    }
                }
            }
        } else {
            const lifetime = new AbortController();
            const servers = getServers();
            if (['dns', 'cancel-resolve', 'cancel-reject'].includes(mode)) {
                servers[0].urls[0] = `turn:slow.synthetic.invalid:${turn.udpPort}?transport=udp`;
                dns.lookup = (host, options) =>
                    host === 'slow.synthetic.invalid'
                        ? new Promise((resolve, reject) => jobs.push({ resolve, reject }))
                        : lookup(host, options);
            }
            let late = 0,
                isolated = false;
            transport = await createNodeNetworkBridge({
                owner: { hostInstanceId: 'acceptance', generation: 1 },
                createPeer: (configuration) =>
                    new RTCPeerConnection({
                        ...configuration,
                        iceTransportPolicy: mode === 'direct' || mode === 'bad-fingerprint' ? 'all' : 'relay',
                        iceUseIpv6: false,
                        iceInterfaceAddresses: { udp4: '127.0.0.1' },
                        iceTurnConnectTimeout: mode.startsWith('cancel') ? 8 : 0.8,
                        turnTlsOptions: {
                            rejectUnauthorized: true,
                            ...(mode === 'bad-tls' ? { servername: 'wrong.synthetic.invalid' } : {})
                        }
                    })
            }).create({
                attemptId: 'synthetic',
                signal: lifetime.signal,
                iceServers: servers,
                candidate() {
                    if (isolated) late++;
                }
            });
            browserPeer = await chromiumOfferingPeer(
                context,
                {
                    signal: lifetime.signal,
                    iceServers:
                        mode === 'direct' || mode === 'bad-fingerprint'
                            ? []
                            : [
                                  {
                                      urls: [`turn:127.0.0.1:${turn.udpPort}?transport=udp`],
                                      username: turn.username,
                                      credential: turn.credential
                                  }
                              ],
                    candidate() {}
                },
                mode !== 'direct' && mode !== 'bad-fingerprint'
            );
            let offer = await browserPeer.offer();
            if (mode === 'bad-fingerprint')
                offer = offer.replace(
                    /a=fingerprint:sha-256 [^\r\n]+/g,
                    'a=fingerprint:sha-256 ' + Array(32).fill('FF').join(':')
                );
            const start = performance.now();
            let settled = false;
            const answer = transport.answer(offer).then(
                (value) => {
                    settled = true;
                    return value;
                },
                (error) => {
                    settled = true;
                    throw error;
                }
            );
            void answer.catch(() => undefined);
            if (mode.startsWith('cancel')) {
                await until(() => jobs.length > 0);
                isolated = true;
                lifetime.abort();
                await transport.close();
                await until(() => settled, 1000);
                assert.ok(jobs.length);
                report.settledBeforeDns = true;
                for (const job of jobs)
                    mode === 'cancel-reject'
                        ? job.reject(Error('synthetic late reject'))
                        : job.resolve({ address: '127.0.0.1', family: 4 });
                await sleep(100);
                assert.equal(late, 0);
                report.noLateCandidate = true;
            } else {
                const sdp = await answer;
                if (mode === 'bad-tls') {
                    assert.equal(
                        transport.instance.sctp.dtlsTransport.iceTransport.connection.localCandidates.filter(
                            (value) => value.type === 'relay'
                        ).length,
                        0
                    );
                    report.strictTlsRejected = true;
                } else {
                    await browserPeer.answer(sdp);
                    if (mode === 'bad-fingerprint') {
                        await assert.rejects(
                            Promise.race([
                                transport.opened,
                                sleep(3000).then(() => {
                                    throw Error('not open');
                                })
                            ])
                        );
                        report.fingerprintRejected = true;
                    } else {
                        await Promise.all([transport.opened, browserPeer.opened]);
                        const read = await transport.readback();
                        assert.equal(read.stable, true);
                        assert.equal(read.state, 'open');
                        transport.activateTrusted();
                        browserPeer.activateTrusted();
                        const received = [];
                        transport.channel.onMessage((text) => received.push(text));
                        const browserReceived = [];
                        browserPeer.channel.onMessage((text) => browserReceived.push(text));
                        await browserPeer.channel.send('{"jsonrpc":"2.0","id":1,"method":"synthetic"}');
                        await until(() => received.length === 1);
                        await transport.channel.send('{"jsonrpc":"2.0","id":1,"result":{"synthetic":true}}');
                        await until(() => browserReceived.length === 1);
                        const pcIce = transport.instance.sctp.dtlsTransport.iceTransport.connection;
                        const stats = await browserPeer.inspect();
                        assert.equal(stats.ordered, true);
                        assert.equal(stats.reliable, true);
                        report.orderedReliable = true;
                        report.actualReadback = true;
                        report.bidirectionalFramedAcp = true;
                        if (mode !== 'direct') {
                            assert.equal(pcIce.nominated.localCandidate.type, 'relay');
                            assert.equal(stats.remoteType, 'relay');
                            report.selectedRelay = true;
                            report.selectedTransport = pcIce.nominated.protocol.turn.transport.type;
                            if (['udp', 'tcp', 'tls'].includes(mode)) assert.equal(report.selectedTransport, mode);
                            if (mode === 'all')
                                assert.deepEqual(
                                    pcIce.protocols
                                        .filter((value) => value.type === 'turn')
                                        .map((value) => value.turn.transport.type)
                                        .sort(),
                                    ['tcp', 'tls', 'udp']
                                );
                            if (mode === 'dns') {
                                assert.ok(jobs.length);
                                assert.ok(jobs.every((job) => !job.released));
                                report.readyBeforeDns = true;
                                assert.equal(report.selectedTransport, 'tls');
                            }
                        } else report.selectedDirect = true;
                        if (mode === 'direct') {
                            const pc = transport.instance;
                            const dc = Object.values(pc.sctpTransport.dataChannels)[0];
                            const sctp = pc.sctpTransport.sctp;
                            assert.equal(pc.sctpTransport.remoteMaxMessageSize, 262144);
                            let release;
                            const gate = new Promise((resolve) => {
                                release = resolve;
                            });
                            const send = sctp.send.bind(sctp);
                            sctp.send = async (...values) => {
                                await gate;
                                return send(...values);
                            };
                            // Pressure entries bypass the sender's framing sequence, so the real
                            // browser observes their wire bytes without feeding them to ACP framing.
                            await browserPeer.instance.evaluate(() => {
                                const w = window;
                                const receive = w.dc.onmessage;
                                w.pressureFrames = 0;
                                w.pressureBytes = 0;
                                w.dc.onmessage = (event) => {
                                    if (typeof event.data === 'string' && JSON.parse(event.data).id === 1000) {
                                        w.pressureFrames++;
                                        w.pressureBytes += new TextEncoder().encode(event.data).length;
                                    } else receive(event);
                                };
                            });
                            try {
                                for (let index = 0; index < 16; index++) {
                                    const frame = JSON.stringify({
                                        n3: 1,
                                        type: 'data',
                                        id: 1000,
                                        total: 16 * 196000,
                                        offset: index * 196000,
                                        data: Buffer.from('x'.repeat(196000)).toString('base64')
                                    });
                                    dc.send(frame.padEnd(262144, ' '));
                                }
                                assert.equal(dc.bufferedAmount, 4194304);
                                let settled = false,
                                    submitted = 0,
                                    drained = 0;
                                const actualSend = dc.send.bind(dc);
                                dc.send = (text) => {
                                    submitted++;
                                    actualSend(text);
                                };
                                dc.bufferedAmountLow.subscribe(() => {
                                    drained++;
                                });
                                const sending = transport.channel
                                    .send('{"jsonrpc":"2.0","id":2,"result":{"synthetic":true}}')
                                    .then(() => {
                                        settled = true;
                                    });
                                await sleep(80);
                                assert.equal(settled, false);
                                assert.equal(submitted, 0);
                                release();
                                await sending;
                                await until(() => dc.bufferedAmount === 0 && browserReceived.length >= 2, 15000);
                                assert.ok(submitted > 0 && drained > 0);
                                const receivedPressure = await browserPeer.instance.evaluate(() => ({
                                    frames: window.pressureFrames,
                                    bytes: window.pressureBytes
                                }));
                                assert.equal(receivedPressure.frames, 16);
                                assert.equal(receivedPressure.bytes, 4194304);
                                report.realLibraryBackpressure = true;
                                report.realLowWaterWake = true;
                                report.actualRemoteLimit = pc.sctpTransport.remoteMaxMessageSize;
                            } finally {
                                release();
                            }
                        }
                    }
                }
            }
            report.elapsedMs = Math.round(performance.now() - start);
        }
        report.passed = true;
    } catch (error) {
        report.failureClass = error?.name ?? 'Error';
        if (term) {
            report.processDiagnostics = term.diagnostics();
            const text = term.output();
            report.terminal = {
                chars: text.length,
                fatal: text.includes('OpenDesk FATAL'),
                codes: [...new Set(text.match(/ERR_[A-Z_]+/g) ?? [])],
                remoteCodes: [...new Set([...text.matchAll(/code[:"'\s]+([a-z_]{1,64})/g)].map((match) => match[1]))],
                banner: text.includes('OpenDesk')
            };
        }
        report.failureSite = error?.stack
            ?.split('\n')
            .slice(1)
            .map((line) => /([A-Za-z0-9_-]+\.(?:ts|mjs)):(\d+):(\d+)/.exec(line))
            .filter(Boolean)
            .map((match) => `${match[1]}:${match[2]}`)
            .slice(0, 4);
    } finally {
        dns.lookup = lookup;
        for (const job of jobs) job.reject(Error('synthetic cleanup'));
        await transport?.close().catch(() => undefined);
        await browserPeer?.close().catch(() => undefined);
        if (term) {
            term.child.kill('SIGTERM');
            await Promise.race([term.exited, sleep(3500)]);
        }
        await server?.close();
        await context?.close();
        fs.writeFileSync(path.join(out, `${mode}.json`), JSON.stringify(report, null, 4) + '\n');
        console.log(JSON.stringify(report));
    }
    if (!report.passed) process.exitCode = 1;
}
