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

import { setPlatform } from '../platforms/base';
import { CliPlatform } from '../platforms/cli.js';
import { isMainThread } from 'worker_threads';
import { useCliTransport } from './utils/logger.js';
import { initializeRegistry, initializeRegistryWorker } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';
import { GlobalState } from './states/global.js';
import { FULL_CLEAR } from './tui/components/constants';
import { OpenDeskTUI } from './tui/entry.js';

import process from 'process';


function main() {
    setPlatform(new CliPlatform());
    useCliTransport();

    if (!isMainThread) {
        initializeAppWorkers();
        return;
    } else {
        GlobalState.initialize();
        if (process.stdout.isTTY) {
            process.stdout.write(FULL_CLEAR);
        }

        const tui = new OpenDeskTUI();
        tui.start();

        initializeRegistry();
        initializeRegistryWorker();
    }
}

main();
