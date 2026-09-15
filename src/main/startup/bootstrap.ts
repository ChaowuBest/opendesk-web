/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { spawnSync } from 'node:child_process';
import { OPENDESK_V8_HEAP_CONFIGURED_ENV, buildV8HeapRestartArgs, shouldConfigureV8Heap } from './v8-heap.js';

if (shouldConfigureV8Heap(process.argv, process.execArgv, process.env)) {
    const child = spawnSync(process.execPath, buildV8HeapRestartArgs(process.argv), {
        env: { ...process.env, [OPENDESK_V8_HEAP_CONFIGURED_ENV]: '1' },
        stdio: 'inherit'
    });

    if (child.error) {
        console.error(`Failed to restart OpenDesk with the V8 heap limit: ${child.error.message}`);
        process.exit(1);
    }

    process.exit(child.status ?? 1);
}

// Delay the full application import until the restarted process has the requested V8 heap limit.
await import('../main.js');
