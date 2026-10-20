import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { isolatedServer, serverEnvironment } from './fixtures/isolated-server.js';

test(
    'old Server rejects a healthy CLI current without promoting Electron; release restores Electron',
    {
        skip: !serverEnvironment.root || !serverEnvironment.python ? 'requires isolated Server/Python paths' : false,
        timeout: 20000
    },
    async () => {
        const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-old-server-boundary-'));
        const sockets: WebSocket[] = [];
        let server: Awaited<ReturnType<typeof isolatedServer>> | undefined;
        try {
            fs.cpSync(path.join(serverEnvironment.root!, 'app'), path.join(snapshot, 'app'), {
                recursive: true,
                filter: (file) => !file.split(path.sep).includes('__pycache__')
            });
            fs.mkdirSync(path.join(snapshot, 'test'));
            fs.copyFileSync(
                path.join(serverEnvironment.root!, 'test/remote_network_contract_server.py'),
                path.join(snapshot, 'test/remote_network_contract_server.py')
            );
            const baseline = spawnSync(
                'git',
                ['show', 'd009de318e5dbde5ef41d30cbf8fb843a52fc41b:backend/app/services/connection_coordinator.py'],
                {
                    cwd: path.dirname(serverEnvironment.root!),
                    encoding: 'utf8'
                }
            );
            assert.equal(baseline.status, 0);
            fs.writeFileSync(path.join(snapshot, 'app/services/connection_coordinator.py'), baseline.stdout);
            server = await isolatedServer(undefined, snapshot);
            const call = async (action: string, payload: unknown) => {
                const response = await fetch(`${server!.baseUrl}/devices/${action}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${server!.token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                assert.equal(response.status, 200);
                return response.json();
            };
            const device_id = 'synthetic-shared-pc',
                cli = randomUUID(),
                electron = randomUUID();
            assert.equal(
                (await call('register', { device_id, run_id: cli, host_type: 'cli', name: 'Synthetic' })).role,
                'current'
            );
            assert.equal(
                (await call('register', { device_id, run_id: electron, host_type: 'electron', name: 'Synthetic' }))
                    .role,
                'standby'
            );
            const bind = async (run_id: string) =>
                new Promise<string>((resolve, reject) => {
                    const socket = new WebSocket(server!.baseUrl.replace('http:', 'ws:') + '/remote-network/ws');
                    sockets.push(socket);
                    const timer = setTimeout(() => reject(Error('old boundary bind timeout')), 3000);
                    socket.once('open', () =>
                        socket.send(
                            JSON.stringify({
                                version: 1,
                                type: 'auth',
                                payload: {
                                    role: 'pc',
                                    access_token: server!.token,
                                    credential_version: 0,
                                    device_id,
                                    run_id
                                }
                            })
                        )
                    );
                    socket.once('message', (raw) => {
                        clearTimeout(timer);
                        const frame = JSON.parse(raw.toString());
                        resolve(frame.type === 'error' ? frame.payload.code : frame.type);
                    });
                    socket.once('error', () => {
                        clearTimeout(timer);
                        reject(Error('isolated WS failed'));
                    });
                });
            assert.equal(await bind(cli), 'remote_pc_unavailable');
            assert.equal((await call('heartbeat', { device_id, run_id: cli })).role, 'current');
            assert.equal((await call('heartbeat', { device_id, run_id: electron })).role, 'standby');
            await call('unregister', { device_id, run_id: cli });
            assert.equal((await call('heartbeat', { device_id, run_id: electron })).role, 'current');
            assert.equal(await bind(electron), 'auth_ok');
        } finally {
            for (const socket of sockets) socket.terminate();
            await server?.close();
            fs.rmSync(snapshot, { recursive: true, force: true });
        }
    }
);
