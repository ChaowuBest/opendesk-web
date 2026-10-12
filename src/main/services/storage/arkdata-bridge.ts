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
import { toArkDataDbPath } from './arkdata-path.js';
import type { ArkDataOpenStoreOptions, DatabaseKit } from '../../../platforms/bridges/common.js';

let _kit: DatabaseKit | null = null;

export function setArkdataDatabaseKit(kit: DatabaseKit | null): DatabaseKit | null {
    const previous = _kit;
    _kit = kit;
    return previous;
}

export function getArkdataDatabaseKit(): DatabaseKit {
    if (!_kit) {
        throw new Error(
            'ArkData DatabaseKit not initialized. ' +
                'Worker must call setArkdataDatabaseKit() in initialize() before constructing ArkData IndexDB.'
        );
    }
    return _kit;
}

// Failed temporary releases retain an owner here. Later storage use retries the
// same session, rather than acquiring an extra reference and losing the old one.
const pendingReleases = new Set<ArkDataStoreSession>();

export class ArkDataStoreSession {
    private readonly sessionId = randomUUID();
    private opening: Promise<void> | null = null;
    private closing: Promise<void> | null = null;
    private released = false;
    private acquisitionStarted = false;
    private openFailed = false;
    private openUncertain = false;
    private closeUncertain = false;

    constructor(
        private readonly kit: DatabaseKit,
        private readonly storeId: string,
        private readonly options: ArkDataOpenStoreOptions,
        private readonly temporary = false
    ) {}

    async open(): Promise<void> {
        if (this.released || this.closeUncertain) {
            throw new Error('ArkData store session must finish releasing before reopening');
        }
        if (!this.opening) {
            this.opening = (async () => {
                for (const owner of [...pendingReleases]) {
                    if (owner !== this && owner.kit === this.kit && owner.storeId === this.storeId) await owner.close();
                }
                this.acquisitionStarted = true;
                try {
                    await this.kit.openStore(this.storeId, { ...this.options, sessionId: this.sessionId });
                } catch (error) {
                    const code = (error as { code?: string }).code;
                    this.openFailed =
                        code !== 'operation_timeout' &&
                        code !== 'rpc_timeout' &&
                        code !== 'envelope_parse_failed' &&
                        code !== 'operation_unresolved';
                    this.openUncertain = !this.openFailed;
                    throw error;
                }
            })();
        }
        await this.opening;
    }

    matches(kit: DatabaseKit | null, paths: Set<string>): boolean {
        return this.kit === kit && this.options.path !== undefined && paths.has(this.options.path);
    }

    needsReplacement(): boolean {
        return this.released || this.closeUncertain || this.openUncertain;
    }

    close(): Promise<void> {
        if (this.released || !this.acquisitionStarted || this.openFailed) {
            this.released = true;
            pendingReleases.delete(this);
            return Promise.resolve();
        }
        if (this.closing) return this.closing;
        // Ask the main bridge to release even when open timed out. Its stable
        // session owns the accepted operation and settles late SDK/RPC results.
        const closing = this.kit
            .closeStore(this.storeId, { sessionId: this.sessionId })
            .then(() => {
                this.released = true;
                pendingReleases.delete(this);
            })
            .catch((error) => {
                const code = (error as { code?: string }).code;
                this.closeUncertain =
                    code === 'operation_timeout' ||
                    code === 'rpc_timeout' ||
                    code === 'operation_unresolved' ||
                    code === 'envelope_parse_failed';
                if (this.temporary) pendingReleases.add(this);
                throw error;
            })
            .finally(() => {
                if (this.closing === closing) this.closing = null;
            });
        this.closing = closing;
        return closing;
    }
}

/** Retry retained probe/drop owners for these logical database paths only. */
export async function retryArkdataStoreReleases(dbPaths: string[]): Promise<void> {
    const paths = new Set(dbPaths.map(toArkDataDbPath));
    const owners = [...pendingReleases].filter((owner) => owner.matches(_kit, paths));
    const results = await Promise.allSettled(owners.map((owner) => owner.close()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
}
