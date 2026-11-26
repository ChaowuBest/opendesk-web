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

import { createRemoteNetworkRuntime } from './renderer/remote-network-runtime.js';

export function installMobileAccessPreload(ipcRenderer, isMainFrame, isApplicationFrame) {
    // 本文件同时是窗口 preload 和 session 注册的 frame preload，在主 frame 里会被执行
    // 两次。没有这道闸，同一条 remote-network:invoke 会被两个 handler 各处理一遍：create 出两个
    // PeerConnection、answer 应用两次、产生两套 ICE 凭据，第二代的候选会被协调方按
    // ufrag 不匹配拒掉，整个尝试被误杀。标记放在 preload 的隔离世界全局上，两次执行
    // 共享同一个上下文。
    const installedFlag = '__opendeskRemoteNetworkRuntimeInstalled';
    if (isMainFrame && !isApplicationFrame && !globalThis[installedFlag]) {
        globalThis[installedFlag] = true;
        createRemoteNetworkRuntime({
            emit: (payload) => ipcRenderer.send('remote-network:event', payload),
            handle: (handler) => {
                ipcRenderer.on('remote-network:invoke', (_event, request) => {
                    const requestId = request && request.requestId;
                    Promise.resolve()
                        .then(() => handler(String(request.method), request.payload ?? {}))
                        .then(
                            (result) => ipcRenderer.send('remote-network:result', { requestId, ok: true, result }),
                            (error) =>
                                // 只回有限文本，不透传原生异常对象、地址或业务正文。
                                ipcRenderer.send('remote-network:result', {
                                    requestId,
                                    ok: false,
                                    error:
                                        error && typeof error.message === 'string'
                                            ? error.message
                                            : 'remote network error'
                                })
                        );
                });
            }
        });
    }
}
