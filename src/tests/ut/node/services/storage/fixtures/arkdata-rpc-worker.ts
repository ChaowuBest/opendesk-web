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
import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { BaseWorker } from '../../../../../../../packages/app-sdk/src/index.js';
import { WorkerDatabaseKitProxy } from '../../../../../../platforms/bridges/worker.js';
import {
    getLogDirectory,
    getOpendeskDirectory,
    setCustomOpendeskDirectory
} from '../../../../../../main/utils/setting.js';
import path from 'node:path';
import { setArkdataDatabaseKit } from '../../../../../../main/services/storage/arkdata-bridge.js';
import { BaseIndexDBArkdata } from '../../../../../../main/services/storage/base-index-db-arkdata.js';
import { VectorIndexDBArkdata } from '../../../../../../main/services/storage/vector-index-db-arkdata.js';
import { ChunkIndexDBArkdata } from '../../../../../../main/services/storage/chunk-index-db-arkdata.js';

// Shorten only the production 60-second RPC deadline. All messages, request IDs,
// error envelopes, proxy calls and resource session identities remain real.
const timer = globalThis.setTimeout;
let shorten = false;
globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) =>
    timer(fn, shorten && ms === 60_000 ? 5 : ms, ...args)) as typeof setTimeout;
parentPort!.on('message', (message) => {
    if (message.type === 'response') BaseWorker.handleAppResponse(message);
});
const { name, scenario } = workerData;
setCustomOpendeskDirectory(workerData.profile);
assert.equal(getOpendeskDirectory(), workerData.profile);
assert.equal(getLogDirectory(), path.join(workerData.profile, 'logs'));
console.log(JSON.stringify({ workerProfile: getOpendeskDirectory(), logs: getLogDirectory() }));
const worker = new BaseWorker('isolated-rpc-test', workerData.profile);
setArkdataDatabaseKit(new WorkerDatabaseKitProxy(worker));
const schema = {
    columns: { item_id: { type: 'TEXT' as const }, item_type: { type: 'TEXT' as const } },
    needIndexers: {}
};
function create(): any {
    const file = path.join(workerData.profile, 'isolated-rpc-test.db');
    if (name === 'base') return new BaseIndexDBArkdata(file, schema);
    if (name === 'vector') return new VectorIndexDBArkdata(file, 2);
    return new ChunkIndexDBArkdata(file, 2);
}
const db = create();
let other: any;
try {
    let code: string | undefined;
    if (scenario === 'rpc-open-timeout') {
        shorten = true;
        await assert.rejects(db.count(), (error: any) => {
            code = error.code;
            return code === 'rpc_timeout';
        });
    } else {
        await db.count();
        shorten = true;
        await assert.rejects(db.close(), (error: any) => {
            code = error.code;
            return code === 'rpc_timeout';
        });
    }
    shorten = false;
    parentPort!.postMessage({ type: 'timeoutObserved' });
    if (scenario === 'rpc-close-aba') {
        other = create();
        await other.count();
    }
    await db.close();
    if (other) await other.count();
    await other?.close();
    parentPort!.postMessage({ type: 'done', code });
} catch (error) {
    parentPort!.postMessage({ type: 'failure', message: String((error as Error).stack ?? error) });
}
