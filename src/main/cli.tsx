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
import { setPlatform } from '../platforms/base';
import { CliPlatform } from '../platforms/cli.js';
import { isMainThread } from 'worker_threads';
import { useCliTransport } from './utils/logger.js';
import { initializeRegistry, initializeRegistryWorker } from './applications/registry';
import { initializeAppWorkers } from './applications/worker';
import { GlobalState } from './states/global.js';
import { AgentCLI } from './tui/Entry';


function main() {
    setPlatform(new CliPlatform());
    useCliTransport();

    if (!isMainThread) {
        initializeAppWorkers();
        return;
    } else {
        GlobalState.initialize();
        // 使用备用缓冲区实现全屏 CLI：进入时切换并清屏，退出时恢复原缓冲区
        if (process.stdout.isTTY) {
            process.stdout.write('\x1b[?1049h'); // 进入 alternate screen buffer
            process.stdout.write('\x1b[2J\x1b[H'); // 清屏并光标置顶
            process.once('exit', () => {
                process.stdout.write('\x1b[?1049l'); // 退出时恢复原 buffer
            });
        }
        const instance = render(<AgentCLI />);
        instance.waitUntilExit().then(() => {
            if (process.stdout.isTTY) {
                process.stdout.write('\x1b[?1049l');
            }
        }).catch(() => {});

        initializeRegistry();
        initializeRegistryWorker();
    }
}

main();
