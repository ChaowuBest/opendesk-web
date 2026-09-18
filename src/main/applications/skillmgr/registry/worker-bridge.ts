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
 * worker 线程 → 主进程的 RPC 桥（registry 专用薄封装）。
 *
 * 复用 BaseWorker.callAppWithResponse 的消息协议：worker 侧 post `{type:'callApp',
 * requestId, methodName, args}`，主进程 applications/registry.ts 的 'callApp' 分支
 * 调用应用同名方法并回 `{type:'response', id, status, data}`，响应路由复用
 * BaseWorker.pendingAppRequests。插件贡献的注册表定义（含闭包）只能活在主进程，
 * worker 线程的技能市场搜索/安装路由经此桥回代。
 */

import { parentPort } from 'worker_threads';
import { randomUUID } from 'crypto';
import { BaseWorker } from '../../../../../packages/app-sdk/src/index.js';

/** 当前线程是否为全局 worker 线程（主进程/测试中 parentPort 为 null） */
export function isWorkerThread(): boolean {
    return parentPort !== null;
}

/**
 * 桥接端口：worker 线程下为 parentPort；测试环境可经 setWorkerBridgePortForTests
 * 注入假端口以验证消息协议（与 applications/registry.ts 的 'callApp' 分支对齐）。
 */
let bridgePort: typeof parentPort = parentPort;

/** 测试专用：覆盖桥接端口 */
export function setWorkerBridgePortForTests(port: typeof parentPort): void {
    bridgePort = port;
}

export function callAppFromWorker<R>(methodName: string, ...args: unknown[]): Promise<R> {
    if (!bridgePort) {
        return Promise.reject(new Error('callAppFromWorker is only available in the worker thread'));
    }
    const requestId = randomUUID();
    const promise = new Promise<R>((resolve, reject) => {
        const timer = setTimeout(() => {
            BaseWorker.pendingAppRequests.delete(requestId);
            reject(new Error(`callAppFromWorker ${methodName} timed out after 60000ms`));
        }, 60000);
        BaseWorker.pendingAppRequests.set(requestId, {
            resolve: resolve as (value: unknown) => void,
            reject,
            timer
        });
        timer.unref?.();
    });
    bridgePort.postMessage({
        type: 'callApp',
        bundleName: 'skillmgr',
        requestId,
        methodName,
        args
    });
    return promise;
}
