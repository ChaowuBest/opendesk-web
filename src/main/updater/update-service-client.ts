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

import crypto from 'node:crypto';
import net from 'node:net';
import type { ReadyUpdateRecord, UpdateServiceResponse } from './types.js';

const UPDATE_SERVICE_PIPE = '\\\\.\\pipe\\OpenDesk.UpdateService.v1';
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

export interface SubmitUpdateServiceOptions {
    pipePath?: string;
    timeoutMs?: number;
}

interface UpdateServiceRequest {
    protocolVersion: 1;
    requestId: string;
    action: 'submitUpdate' | 'reportHealthy';
    targetVersion: string;
    sourcePath?: string;
    sha256?: string;
    processId?: number;
}

function parseResponse(line: string, requestId: string): UpdateServiceResponse {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        throw new Error('Update service returned an invalid response');
    }
    if (!value || typeof value !== 'object') throw new Error('Update service returned an invalid response');
    const response = value as Record<string, unknown>;
    if (
        response.protocolVersion !== 1 ||
        response.requestId !== requestId ||
        typeof response.status !== 'string' ||
        typeof response.code !== 'string' ||
        typeof response.updatedAtUtc !== 'string'
    ) {
        throw new Error('Update service returned an invalid response');
    }
    return response as unknown as UpdateServiceResponse;
}

function sendRequest(
    request: UpdateServiceRequest,
    options: SubmitUpdateServiceOptions
): Promise<UpdateServiceResponse> {
    const pipePath = options.pipePath ?? UPDATE_SERVICE_PIPE;
    const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS;

    return new Promise<UpdateServiceResponse>((resolve, reject) => {
        const socket = net.createConnection(pipePath);
        let response = '';
        let settled = false;
        const finish = (error?: Error, result?: UpdateServiceResponse) => {
            if (settled) return;
            settled = true;
            socket.removeAllListeners();
            socket.end();
            if (error) reject(error);
            else resolve(result as UpdateServiceResponse);
        };
        socket.setEncoding('utf8');
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on('data', (chunk) => {
            response += chunk;
            const newline = response.indexOf('\n');
            if (newline < 0) return;
            try {
                finish(undefined, parseResponse(response.slice(0, newline), request.requestId));
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
        socket.once('timeout', () => finish(new Error('Timed out waiting for the update service')));
        socket.once('error', (error) => finish(error));
        socket.once('close', () => {
            if (!settled) finish(new Error('Update service closed the connection without a response'));
        });
    });
}

export function submitUpdateToService(
    record: ReadyUpdateRecord,
    options: SubmitUpdateServiceOptions = {}
): Promise<UpdateServiceResponse> {
    return sendRequest(
        {
            protocolVersion: 1,
            requestId: record.requestId,
            action: 'submitUpdate',
            targetVersion: record.version,
            sourcePath: record.installerPath,
            sha256: record.sha256
        },
        options
    );
}

export function reportUpdateHealthToService(
    version: string,
    processId: number,
    options: SubmitUpdateServiceOptions = {}
): Promise<UpdateServiceResponse> {
    return sendRequest(
        {
            protocolVersion: 1,
            requestId: crypto.randomUUID(),
            action: 'reportHealthy',
            targetVersion: version,
            processId
        },
        { timeoutMs: 30_000, ...options }
    );
}
