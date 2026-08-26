#!/usr/bin/env node

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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';

function parseArgs(argv) {
    const result = {
        cli: 'dist/cli/opendesk-debug',
        prompt: '',
        timeoutMs: 20_000
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--cli' && argv[i + 1]) {
            result.cli = argv[++i];
        } else if (arg.startsWith('--cli=')) {
            result.cli = arg.slice('--cli='.length);
        } else if (arg === '--prompt' && argv[i + 1]) {
            result.prompt = argv[++i];
        } else if (arg.startsWith('--prompt=')) {
            result.prompt = arg.slice('--prompt='.length);
        } else if (arg === '--timeout-ms' && argv[i + 1]) {
            result.timeoutMs = Number(argv[++i]);
        } else if (arg.startsWith('--timeout-ms=')) {
            result.timeoutMs = Number(arg.slice('--timeout-ms='.length));
        }
    }
    return result;
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function withTimeout(promise, timeoutMs, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

function spawnAcp(cli, env) {
    return spawn(process.execPath, ['--no-warnings', '--enable-source-maps', cli, 'serve', '--mode', 'acp'], {
        cwd: process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe']
    });
}

async function waitForExit(child, timeoutMs) {
    return withTimeout(
        new Promise((resolve) => {
            child.once('exit', (code, signal) => resolve({ code, signal }));
        }),
        timeoutMs,
        'process exit'
    );
}

async function verifyRawStdout(cli, timeoutMs, env) {
    const child = spawnAcp(cli, env);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
    });

    child.stdin.write(
        JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: PROTOCOL_VERSION,
                clientInfo: { name: 'opendesk-acp-smoke', version: '0' },
                clientCapabilities: {}
            }
        }) + '\n'
    );
    child.stdin.end();

    const exit = await waitForExit(child, timeoutMs);
    assert(exit.code === 0, `raw stdio server exited with code=${exit.code} signal=${exit.signal}`);

    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
    assert(lines.length === 1, `expected exactly one JSON-RPC stdout line, got ${lines.length}: ${stdout}`);

    let response;
    try {
        response = JSON.parse(lines[0]);
    } catch (err) {
        throw new Error(`stdout was not valid JSON-RPC JSON: ${lines[0]}`);
    }
    assert(response.id === 1, 'initialize response id mismatch');
    assert(response.result?.agentInfo?.name === 'opendesk', 'initialize response did not identify opendesk');
    assert(stderr.length === 0, `raw stdio server wrote stderr during handshake: ${stderr}`);

    return { stderr };
}

async function verifyErrorResponse(cli, timeoutMs, env) {
    const child = spawnAcp(cli, env);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
    });

    child.stdin.write(
        JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: PROTOCOL_VERSION,
                clientInfo: { name: 'opendesk-acp-smoke', version: '0' },
                clientCapabilities: {}
            }
        }) + '\n'
    );
    child.stdin.write(
        JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/new',
            params: {
                cwd: 'relative-path',
                mcpServers: []
            }
        }) + '\n'
    );
    child.stdin.end();

    const exit = await waitForExit(child, timeoutMs);
    assert(exit.code === 0, `error path server exited with code=${exit.code} signal=${exit.signal}`);

    const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
    assert(lines.length === 2, `expected two JSON-RPC stdout lines on error path, got ${lines.length}: ${stdout}`);

    const responses = lines.map((line) => JSON.parse(line));
    assert(
        responses[0].id === 1 && responses[0].result?.agentInfo?.name === 'opendesk',
        'initialize response mismatch'
    );
    assert(responses[1].id === 2 && responses[1].error, 'invalid session/new did not return JSON-RPC error');
    assert(stderr.length === 0, `error path wrote stderr: ${stderr}`);

    return { stderr };
}

async function verifySdkClient(cli, timeoutMs, prompt, env) {
    const child = spawnAcp(cli, env);
    let stderr = '';
    const sessionUpdates = [];
    const permissionRequests = [];
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
    });

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const connection = new ClientSideConnection(
        () => ({
            async requestPermission(params) {
                permissionRequests.push(params);
                const allow = params.options.find(
                    (option) => option.kind === 'allow_once' || option.kind === 'allow_always'
                );
                return {
                    outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' }
                };
            },
            async sessionUpdate(params) {
                sessionUpdates.push(params);
            }
        }),
        stream
    );

    try {
        const init = await withTimeout(
            connection.initialize({
                protocolVersion: PROTOCOL_VERSION,
                clientInfo: { name: 'vscode-acp-client', version: 'smoke' },
                clientCapabilities: {
                    fs: {
                        readTextFile: true,
                        writeTextFile: true
                    },
                    terminal: true
                }
            }),
            timeoutMs,
            'initialize'
        );
        assert(init.protocolVersion === PROTOCOL_VERSION, 'protocol version mismatch');
        assert(init.agentInfo?.name === 'opendesk', 'agentInfo.name mismatch');
        assert(init.agentCapabilities?.loadSession === false, 'loadSession capability should be false');
        assert(init.agentCapabilities?.sessionCapabilities?.list, 'session/list capability should be advertised');

        const session = await withTimeout(
            connection.newSession({
                cwd: process.cwd(),
                mcpServers: []
            }),
            timeoutMs,
            'session/new'
        );
        assert(typeof session.sessionId === 'string' && session.sessionId.length > 0, 'missing sessionId');
        assert(session.modes?.currentModeId === 'standard', 'default mode should be standard');
        assert(
            Array.isArray(session.modes?.availableModes) && session.modes.availableModes.length >= 3,
            'available modes missing'
        );
        assert(session.models?.currentModelId === 'smoke-a', 'default model should be smoke-a');
        assert(
            Array.isArray(session.models?.availableModels) && session.models.availableModels.length === 2,
            'available models missing'
        );

        const listed = await withTimeout(
            connection.listSessions({
                cwd: process.cwd()
            }),
            timeoutMs,
            'session/list'
        );
        assert(
            listed.sessions.some((item) => item.sessionId === session.sessionId && item.cwd === process.cwd()),
            'session/list did not include the active session'
        );

        const targetMode =
            session.modes.availableModes.find((mode) => mode.id === 'readonly') ||
            session.modes.availableModes.find((mode) => mode.id !== session.modes.currentModeId);
        assert(targetMode, 'no alternate mode available for session/set_mode');

        await withTimeout(
            connection.setSessionMode({
                sessionId: session.sessionId,
                modeId: targetMode.id
            }),
            timeoutMs,
            'session/set_mode'
        );
        assert(
            sessionUpdates.some(
                (update) =>
                    update.sessionId === session.sessionId &&
                    update.update?.sessionUpdate === 'current_mode_update' &&
                    update.update.currentModeId === targetMode.id
            ),
            'current_mode_update was not observed after session/set_mode'
        );

        await withTimeout(
            connection.unstable_setSessionModel({
                sessionId: session.sessionId,
                modelId: 'smoke-b'
            }),
            timeoutMs,
            'session/set_model'
        );

        if (prompt) {
            const promptResponse = await withTimeout(
                connection.prompt({
                    sessionId: session.sessionId,
                    prompt: [{ type: 'text', text: prompt }]
                }),
                timeoutMs,
                'session/prompt'
            );
            assert(
                promptResponse.stopReason === 'end_turn' || promptResponse.stopReason === 'cancelled',
                `unexpected prompt stopReason: ${promptResponse.stopReason}`
            );
        }

        await withTimeout(
            connection.closeSession({
                sessionId: session.sessionId
            }),
            timeoutMs,
            'session/close'
        );
    } finally {
        child.kill('SIGTERM');
        await Promise.race([
            waitForExit(child, 2_000).catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 2_000))
        ]);
    }

    assert(stderr.length === 0, `SDK client path wrote stderr: ${stderr}`);

    return { stderr, sessionUpdates, permissionRequests };
}

async function prepareSmokeHome() {
    const home = await mkdtemp(path.join(os.tmpdir(), 'opendesk-acp-smoke-'));
    const configDir = path.join(home, '.opendesk');
    await mkdir(configDir, { recursive: true });
    await writeFile(
        path.join(configDir, 'setting.json'),
        JSON.stringify(
            {
                locale: 'en-US',
                default_model: 'smoke-a',
                providers: [
                    {
                        name: 'smoke-provider',
                        provider_type: 'openai',
                        base_url: 'https://example.invalid/v1',
                        api_key: 'smoke',
                        no_proxy: true,
                        enabled: true
                    }
                ],
                models: [
                    {
                        alias: 'smoke-a',
                        provider_name: 'smoke-provider',
                        model_name: 'smoke/model-a',
                        model_type: 'chat',
                        reasoning_effort: ''
                    },
                    {
                        alias: 'smoke-b',
                        provider_name: 'smoke-provider',
                        model_name: 'smoke/model-b',
                        model_type: 'chat',
                        reasoning_effort: ''
                    }
                ]
            },
            null,
            4
        ),
        'utf8'
    );
    return home;
}

async function main() {
    const args = parseArgs(process.argv);
    assert(Number.isFinite(args.timeoutMs) && args.timeoutMs > 0, '--timeout-ms must be a positive number');
    assert(existsSync(args.cli), `${args.cli} does not exist. Run npm run build-cli first.`);

    const smokeHome = await prepareSmokeHome();
    const env = {
        ...process.env,
        HOME: smokeHome,
        APPDATA: ''
    };

    let raw;
    let errorPath;
    let sdk;
    try {
        raw = await verifyRawStdout(args.cli, args.timeoutMs, env);
        errorPath = await verifyErrorResponse(args.cli, args.timeoutMs, env);
        sdk = await verifySdkClient(args.cli, args.timeoutMs, args.prompt, env);
    } finally {
        await rm(smokeHome, { recursive: true, force: true });
    }

    console.log('ACP smoke test passed');
    console.log(
        JSON.stringify(
            {
                cli: args.cli,
                rawStderrBytes: Buffer.byteLength(raw.stderr),
                errorPathStderrBytes: Buffer.byteLength(errorPath.stderr),
                sdkStderrBytes: Buffer.byteLength(sdk.stderr),
                sessionUpdates: sdk.sessionUpdates.length,
                permissionRequests: sdk.permissionRequests.length,
                promptChecked: args.prompt.length > 0
            },
            null,
            2
        )
    );
}

main().catch((err) => {
    console.error(`ACP smoke test failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
