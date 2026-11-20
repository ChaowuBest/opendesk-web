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

import { NativeBridge, NaiveNativeBridge } from './common.js';
import { dispatchNativeBridgeCall } from './dispatcher.js';
import { logger } from '../../main/utils/logger.js';
import { app, ipcMain } from 'electron';
import { getNativeBridge as getOpenHarmonyNativeBridge } from './harmonyos/index.js';
import { getNativeBridge as getDarwinNativeBridge } from './darwin/index.js';

import { getNativeBridge as getWindowsNativeBridge } from './win32/index.js';
import { getNativeBridge as getLinuxNativeBridge } from './linux/index.js';

let registeredBridge: NativeBridge = new NaiveNativeBridge();

function initializeNativeBridge(): void {
    registeredBridge = new NaiveNativeBridge();
    switch (process.platform as string) {
        case 'win32':
            registeredBridge = getWindowsNativeBridge();
            break;
        case 'linux':
            registeredBridge = getLinuxNativeBridge();
            break;
        case 'darwin': {
            const darwinBridge = getDarwinNativeBridge();
            if (darwinBridge) {
                registeredBridge = darwinBridge;
                logger.info('darwin native bridge initialized');
            }
            break;
        }
        case 'openharmony': {
            const bridge = getOpenHarmonyNativeBridge();
            if (bridge) {
                registeredBridge = bridge;
                logger.info('openHarmony native bridge initialized');
            }
            break;
        }
    }
}

export function registerNativeBridge(): void {
    logger.info('registering native bridge');
    initializeNativeBridge();

    ipcMain.handle('native:call', async (event, method, ...args) => {
        logger.info(`native bridge call: ${method}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`);
        // Unpackaged Electron would register its bare executable without the dev app entrypoint.
        // Keep removal available so existing development startup entries can be cleaned up.
        // The internal IPC error token is translated into a localized notice by the renderer.
        if (method === 'startupKit:delegateSetting' && args[0] === true && !app.isPackaged) {
            throw new Error('STARTUP_DEV_MODE');
        }
        return dispatchNativeBridgeCall(registeredBridge, method, args);
    });
}

export function resolveNativeBridge(): NativeBridge {
    return registeredBridge;
}
