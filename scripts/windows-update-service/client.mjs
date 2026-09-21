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

import { randomUUID } from 'node:crypto';
import net from 'node:net';

const pipePath = '\\\\.\\pipe\\OpenDesk.UpdateService.v1';

function option(name) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
        throw new Error(`Missing --${name}`);
    }
    return process.argv[index + 1];
}

function optionalOption(name) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing --${name}`);
    return process.argv[index + 1];
}

function createRequest() {
    const action = process.argv[2];
    const request = {
        protocolVersion: 1,
        requestId: optionalOption('request-id') ?? randomUUID()
    };
    if (action === 'query') return { ...request, action: 'queryStatus' };
    if (action === 'submit') {
        return {
            ...request,
            action: 'submitUpdate',
            targetVersion: option('version'),
            sourcePath: option('path'),
            sha256: option('sha256')
        };
    }
    if (action === 'healthy') {
        return {
            ...request,
            action: 'reportHealthy',
            targetVersion: option('version'),
            processId: Number.parseInt(option('pid'), 10)
        };
    }
    throw new Error(
        'Usage: client.mjs query | submit --version <x.y.z> --path <setup.exe> --sha256 <hash> | healthy --version <x.y.z> --pid <pid>'
    );
}

const request = createRequest();
const socket = net.createConnection(pipePath);
socket.setEncoding('utf8');
const timeoutMilliseconds = process.argv[2] === 'submit' ? 30 * 60 * 1000 : 30000;
socket.setTimeout(timeoutMilliseconds);

let response = '';
socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
socket.on('data', (chunk) => {
    response += chunk;
    const newline = response.indexOf('\n');
    if (newline < 0) return;
    process.stdout.write(`${response.slice(0, newline)}\n`);
    socket.end();
});
socket.on('timeout', () => socket.destroy(new Error('Timed out waiting for the update service')));
socket.on('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
