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

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { t } from '../../locale/index.js';
import {
    OfficeTaskSessionRegistry,
    type OfficeSessionContents,
    type OfficeTaskSessionKind
} from './officeTaskSessions.js';

export interface OfficeTaskFileOpenResult {
    status: 'opened' | 'not_opened';
    filePath: string;
    message?: string;
}
export interface OfficeTaskFileRequest {
    requestId: string;
    kind: OfficeTaskSessionKind;
    taskId: string;
    filePath: string;
}
type OfficeTaskFileRendererResult = 'not_opened' | 'failed';

/** Shared file validation and open/ready/cancel semantics; hosts only deliver the request. */
export class OfficeTaskFileOpener<C extends OfficeSessionContents> {
    private readonly pending = new Map<string, (status: OfficeTaskFileRendererResult) => void>();
    constructor(
        private readonly sessions: OfficeTaskSessionRegistry<C>,
        private readonly host: { send(request: OfficeTaskFileRequest): boolean },
        private readonly timeoutMs = 30_000
    ) {}
    report(requestId: string, status: unknown): void {
        if (status === 'not_opened' || status === 'failed') this.pending.get(requestId)?.(status);
    }
    async open(kind: OfficeTaskSessionKind, taskId: string, filePath: string): Promise<OfficeTaskFileOpenResult> {
        const extension = { slides: '.pptx', word: '.docx', sheets: '.xlsx', pdf: '.pdf' }[kind];
        const resolvedPath = path.resolve(filePath);
        if (path.extname(resolvedPath).toLowerCase() !== extension) {
            throw new Error(t('office.error.unsupportedFile'));
        }

        let isFile = false;
        try {
            isFile = existsSync(resolvedPath) && statSync(resolvedPath).isFile();
        } catch {
            isFile = false;
        }
        if (!isFile) throw new Error(t('office.error.fileNotFound'));

        const current = this.sessions.get(kind, taskId);
        if (current && path.resolve(current.filePath) === resolvedPath) {
            return { status: 'opened', filePath: resolvedPath };
        }
        const requestId = randomUUID();
        const waitController = new AbortController();
        const waitSignal = AbortSignal.any([waitController.signal, AbortSignal.timeout(this.timeoutMs)]);
        const rendererResult = new Promise<OfficeTaskFileRendererResult>((resolve) => {
            this.pending.set(requestId, resolve);
        });

        try {
            if (!this.host.send({ requestId, kind, taskId, filePath: resolvedPath })) {
                throw new Error(t('office.error.windowUnavailable'));
            }

            const outcome = await Promise.race([
                this.sessions
                    .waitFor(kind, taskId, resolvedPath, waitSignal)
                    .then((session) => ({ type: 'session' as const, session })),
                rendererResult.then((status) => ({ type: 'renderer' as const, status }))
            ]);
            if (outcome.type === 'renderer') {
                if (outcome.status === 'not_opened') {
                    return {
                        status: 'not_opened',
                        filePath: resolvedPath,
                        message: t('office.open.notCompleted')
                    };
                }
                throw new Error(t('office.error.routeUnavailable'));
            }
            if (!outcome.session) throw new Error(t('office.error.openTimeout'));
            return { status: 'opened', filePath: resolvedPath };
        } finally {
            waitController.abort();
            this.pending.delete(requestId);
        }
    }
}
