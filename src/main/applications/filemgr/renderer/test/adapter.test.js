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
import { test } from 'node:test';
import { subscribeStatus } from '../adapter.js';

test.afterEach(() => {
    delete globalThis.window;
});

test('subscribeStatus unwraps proxy event payload arrays', async () => {
    let handler = null;
    globalThis.window = {
        applicationAPI: {
            subscribe: async (_eventName, cb) => {
                handler = cb;
            },
            unsubscribe: async () => {}
        }
    };
    const received = [];

    const unsubscribe = subscribeStatus((snapshot) => {
        received.push(snapshot);
    });
    await Promise.resolve();

    handler([
        {
            reason: 'tick',
            snapshot: {
                status: 'running',
                sources: [{ root: '/workspace' }]
            }
        }
    ]);

    unsubscribe();
    assert.deepEqual(received, [
        {
            status: 'running',
            sources: [{ root: '/workspace' }]
        }
    ]);
});
