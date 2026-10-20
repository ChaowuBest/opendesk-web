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

import { ipcMain, powerMonitor, type BrowserWindow } from 'electron';
import { is } from '@electron-toolkit/utils';
import os from 'node:os';
import { getPlatform } from '../../../platforms/base.js';
import { getExecutionNode } from '../devicemgr/execution.js';
import { getOrCreateDeviceId } from '../../utils/reporter.js';
import { logger } from '../../utils/logger.js';
import { Setting } from '../../utils/setting.js';
import { GlobalState } from '../../aikernel/states/global.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { createMobileSessionModelSource } from './acp/mobile/hosts/model-source.js';
import { mobileInteractionRuntime, attachMobileHost, type MobileAccessApplication } from './app.js';
import { getAccountRuntime } from '../account/factory.js';
import { createRegistrationRuntime } from './remote-access/registration-runtime.js';
import { composeRegistrationConnection } from './remote-access/connection-runtime.js';
import { createDesktopNetworkBridge } from './remote-access/webrtc-transport.js';
import { createHostSessionTask } from './acp/mobile/remote-session-service/host-binding.js';
import {
    subscribeMobileTaskUpdates,
    subscribeMobileTaskManagerUpdates
} from './acp/mobile/hosts/task-subscriptions.js';
import {
    startMobileHostComposition,
    type MobileHostCapabilities,
    type StartMobileNetwork
} from './acp/mobile/host-composition.js';
import { createElectronRendererPort } from './acp/mobile/hosts/renderer-port.js';
export { createMobileQuitBarrier } from './acp/mobile/hosts/electron-lifecycle.js';

const mobileRemoteDiagnose = (scope: string, event: unknown): void => {
    // logger 不展开对象实参，直接传 event 只会打出一个空标签。这里压成有限分类
    // 字符串：只取 code/detail/count，不透传正文、凭据、SDP 或原始异常。
    const source = (event ?? {}) as { code?: unknown; detail?: unknown; count?: unknown };
    const summary = [
        typeof source.code === 'string' ? source.code : 'unknown',
        typeof source.detail === 'string' ? `detail=${source.detail}` : null,
        typeof source.count === 'number' ? `count=${source.count}` : null
    ]
        .filter(Boolean)
        .join(' ');
    // logger 只取第一个实参，必须拼成一条完整消息。
    const line = `[MobileSessionDirectory] ${scope} ${summary}`;
    if (scope === 'adapter') logger.error(line);
    else logger.warn(line);
};

function createElectronHostCapabilities(): MobileHostCapabilities {
    const manager = GlobalState.getInstance().taskManagerState;
    return {
        getTaskList: () => manager.getTaskList(),
        getTaskLoadResult: (id) => manager.getTaskLoadResult(id),
        sessionModelSource: createMobileSessionModelSource(),
        publishTaskListUpdate: () => manager.publishTaskListUpdate(),
        getDefaultWorkspace: () => Setting.getInstance().getEffectiveWorkspace(),
        createSessionTask: (input) =>
            createHostSessionTask(input, {
                taskManager: manager,
                getDefaultExecutionNodeId: () => GlobalState.getInstance().getDefaultExecutionNodeId(),
                getExecutionNode,
                diagnose: (event) => mobileRemoteDiagnose('session', event)
            }),
        subscribeTaskUpdates: (task, subscriber) => subscribeMobileTaskUpdates(task as TaskState, subscriber),
        subscribeTaskManagerUpdates: (subscriber) => subscribeMobileTaskManagerUpdates(manager, subscriber)
    };
}

function electronNetwork(getMainWindow: () => BrowserWindow | null): StartMobileNetwork<object> {
    return async ({ signal, openConnection }) => {
        const account = getAccountRuntime().getService();
        const registration = createRegistrationRuntime({
            hostType: 'electron',
            signal,
            getCredential: () => account.getCredential(),
            subscribe: (listener) => account.subscribe(listener),
            fetch: (input, init) => getPlatform().fetch(input, init),
            deviceId: getOrCreateDeviceId(),
            name: os.hostname(),
            diagnose: (event) => mobileRemoteDiagnose('registration', event),
            subscribePower: ({ suspend, resume }) => {
                powerMonitor.on('suspend', suspend);
                powerMonitor.on('resume', resume);
                return () => {
                    powerMonitor.off('suspend', suspend);
                    powerMonitor.off('resume', resume);
                };
            }
        });
        let port: ReturnType<typeof createElectronRendererPort> = null;
        try {
            port = createElectronRendererPort(ipcMain, getMainWindow());
            if (!port) {
                logger.warn('[MobileRemoteNetwork] main window not ready, registration only');
                return registration;
            }
            const rendererPort = port;
            const connection = composeRegistrationConnection({
                registration,
                signal,
                openConnection,
                allowLoopback: is.dev,
                diagnose: (event) => mobileRemoteDiagnose('network', event),
                bridge: createDesktopNetworkBridge({
                    port,
                    diagnose: (event) => mobileRemoteDiagnose('data-channel', event)
                })
            });
            return { close: () => connection.close().finally(rendererPort.dispose) };
        } catch (error) {
            port?.dispose();
            await registration.close();
            throw error;
        }
    };
}

export function startElectronMobileAccess(
    mobile: MobileAccessApplication,
    getMainWindow: () => BrowserWindow | null,
    waitUntilReady: () => Promise<void>
): void {
    mobile[attachMobileHost](
        {
            prepare: async () => (signal) =>
                startMobileHostComposition({
                    signal,
                    hostCapabilities: createElectronHostCapabilities(),
                    interactionRuntime: mobile[mobileInteractionRuntime],
                    startNetwork: electronNetwork(getMainWindow),
                    diagnose: mobileRemoteDiagnose
                }),
            waitUntilReady
        },
        { diagnose: (event) => mobileRemoteDiagnose('lifecycle', event) }
    );
}
