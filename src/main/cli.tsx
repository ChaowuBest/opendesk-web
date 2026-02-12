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

import React from 'react';
import { render } from 'ink';
import process from 'node:process';
import { setPlatform } from '../platforms/base';
import { CliPlatform } from '../platforms/cli.js';
import { isMainThread } from 'worker_threads';
import { useCliTransport } from './utils/logger.js';
import { initializeRegistry, initializeRegistryWorker } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';
import { GlobalState } from './states/global.js';
import { AgentCLI } from './tui/Entry';
import { CLEAR_SCREEN, CURSOR_HOME } from './tui/Constants.js';


function main() {
    setPlatform(new CliPlatform());
    useCliTransport();

    if (!isMainThread) {
        initializeAppWorkers();
        return;
    } else {
        GlobalState.initialize();
        if (process.stdout.isTTY) {
            process.stdout.write(CLEAR_SCREEN);
            process.stdout.write(CURSOR_HOME);
        }
        render(<AgentCLI />);
        initializeRegistry();
        initializeRegistryWorker();
    }
}

main();
