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

/**
 * 工作线程入口文件
 * 这个文件是Electron平台特有的，用于初始化工作线程。CLI端的工作线程和主进程合并在了同一个文件中
 */

import { initializeAppWorkers } from './applications/worker';
import { setPlatform } from '../platforms/base.js';
import { WorkerPlatform } from '../platforms/worker.js';
import { initAgentGateHook } from './applications/agentgate/hook.js';
import { initializeHarnesses } from './aikernel/harnesses/index.js';
import { logger } from './utils/logger.js';

// 防止 stdout/stderr EPIPE 错误逃逸为 uncaughtException
// 当 IPC 管道断开（如主进程繁忙或休眠恢复）时，写入操作可能触发 EPIPE
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
});
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
});

// Worker 线程全局异常兜底：EPIPE 等可恢复错误不应导致 worker 崩溃
process.on('uncaughtException', (err, origin) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
        logger.warn('EPIPE error in worker thread (IPC channel), ignoring');
        return;
    }
    logger.error(
        `[FATAL] uncaughtException (${origin}) in worker: ${err instanceof Error ? err.stack || err.message : String(err)}`
    );
});

process.on('unhandledRejection', (reason) => {
    const details = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error(`unhandledRejection in worker: ${details}`);
});

setPlatform(new WorkerPlatform());
initAgentGateHook();
initializeHarnesses();
initializeAppWorkers();
