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
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExportDestination, ExportDestinationHost, ExportReceipt, ExportRequest } from '../../common/export.js';
import { buildAtomicWriteTmpPath } from './temp.js';

export interface LocalExportReceipt extends ExportReceipt {
    readonly localPath: string;
}

/** Local filesystem implementation; the caller supplies the host's file chooser. */
export function createLocalExportDestinationHost(
    selectLocalPath: (request: ExportRequest) => Promise<string | null>
): ExportDestinationHost<LocalExportReceipt> {
    type State = {
        localPath: string;
        temporaryPath?: string;
        writeStarted: boolean;
        written: boolean;
        committed: boolean;
    };
    const destinations = new Map<ExportDestination, State>();
    const getState = (destination: ExportDestination): State => {
        const state = destinations.get(destination);
        if (!state) throw new Error('export destination expired');
        return state;
    };

    return {
        async selectDestination(request) {
            const localPath = await selectLocalPath(request);
            if (localPath === null) return null;
            if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
                throw new Error('invalid export file path');
            }
            const destination = Object.freeze({ id: randomUUID(), displayName: path.basename(localPath) });
            destinations.set(destination, { localPath, writeStarted: false, written: false, committed: false });
            return destination;
        },
        async write(destination, content) {
            const state = getState(destination);
            if (state.writeStarted || state.committed) throw new Error('export destination already written');
            state.writeStarted = true;
            state.temporaryPath = buildAtomicWriteTmpPath(state.localPath);
            await mkdir(path.dirname(state.localPath), { recursive: true });
            await writeFile(state.temporaryPath, content);
            state.written = true;
        },
        async commit(destination) {
            const state = getState(destination);
            if (!state.written || !state.temporaryPath || state.committed) {
                throw new Error('export destination is not ready to commit');
            }
            await rename(state.temporaryPath, state.localPath);
            state.committed = true;
            state.temporaryPath = undefined;
            return { displayName: destination.displayName, localPath: state.localPath };
        },
        async release(destination) {
            const state = destinations.get(destination);
            if (!state) return;
            destinations.delete(destination);
            if (state.temporaryPath) await rm(state.temporaryPath, { force: true });
        }
    };
}
