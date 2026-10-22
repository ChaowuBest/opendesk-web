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

import { NativeBridge, NaiveNativeBridge, type NativeBridgeOptions } from './common.js';
import { logger } from '../../main/utils/logger.js';
import { ipcMain } from 'electron';
import { getNativeBridge as getOpenHarmonyNativeBridge } from './harmonyos/index.js';
import { getNativeBridge as getDarwinNativeBridge } from './darwin/index.js';

import { getNativeBridge as getWindowsNativeBridge } from './win32/index.js';
import { getNativeBridge as getLinuxNativeBridge } from './linux/index.js';

let registeredBridge: NativeBridge = new NaiveNativeBridge();

function initializeNativeBridge(options: NativeBridgeOptions): void {
    registeredBridge = new NaiveNativeBridge();
    switch (process.platform as string) {
        case 'win32':
            registeredBridge = getWindowsNativeBridge(options);
            break;
        case 'linux':
            registeredBridge = getLinuxNativeBridge(options);
            break;
        case 'darwin': {
            const darwinBridge = getDarwinNativeBridge(options);
            if (darwinBridge) {
                registeredBridge = darwinBridge;
                logger.info('darwin native bridge initialized');
            }
            break;
        }
        case 'openharmony': {
            const bridge = getOpenHarmonyNativeBridge(options);
            if (bridge) {
                registeredBridge = bridge;
                logger.info('openHarmony native bridge initialized');
            }
            break;
        }
    }
}

export function registerNativeBridge(options: NativeBridgeOptions = {}): void {
    logger.info('registering native bridge');
    initializeNativeBridge(options);

    ipcMain.handle('native:call', async (event, method, ...args) => {
        logger.info(`native bridge call: ${method}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`);
        let data: any;
        switch (method) {
            case 'getPlatform':
                data = await registeredBridge.getPlatform();
                break;
            case 'getVariant':
                data = await registeredBridge.getVariant();
                break;
            case 'startupKit:getState':
                data = await registeredBridge.getStartupKit().then((kit) => kit.getState());
                break;
            case 'startupKit:delegateSetting':
                data = await registeredBridge.getStartupKit().then((kit) => kit.delegateSetting(args[0]));
                break;
            case 'speechKit:available':
                data = await registeredBridge.getSpeechKit().then((speechKit) => speechKit.available());
                break;
            case 'speechKit:initialize':
                data = await registeredBridge
                    .getSpeechKit()
                    .then((speechKit) => speechKit.initialize(typeof args[0] === 'string' ? args[0] : null));
                break;
            case 'speechKit:start':
                data = await registeredBridge.getSpeechKit().then((speechKit) => speechKit.start());
                break;
            case 'speechKit:peek':
                data = await registeredBridge.getSpeechKit().then((speechKit) => speechKit.peek());
                break;
            case 'speechKit:stop':
                data = await registeredBridge.getSpeechKit().then((speechKit) => speechKit.stop());
                break;
            case 'speechKit:release':
                data = await registeredBridge.getSpeechKit().then((speechKit) => speechKit.release());
                break;
            case 'databaseKit:available':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.available());
                break;
            case 'databaseKit:execSql':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.execSql(args[0], args[1]));
                break;
            case 'databaseKit:execSqlParams':
                data = await registeredBridge
                    .getDatabaseKit()
                    .then((kit) => kit.execSqlParams(args[0], args[1], args[2]));
                break;
            case 'databaseKit:querySqlShort':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.querySqlShort(args[0], args[1]));
                break;
            case 'databaseKit:openStore':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.openStore(args[0], args[1]));
                break;
            case 'databaseKit:closeStore':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.closeStore(args[0], args[1]));
                break;
            case 'databaseKit:executePrepared':
                data = await registeredBridge
                    .getDatabaseKit()
                    .then((kit) => kit.executePrepared(args[0], args[1], args[2], args[3]));
                break;
            case 'databaseKit:executePreparedMany':
                data = await registeredBridge
                    .getDatabaseKit()
                    .then((kit) => kit.executePreparedMany(args[0], args[1], args[2], args[3]));
                break;
            case 'databaseKit:executePreparedManyBatched':
                data = await registeredBridge
                    .getDatabaseKit()
                    .then((kit) => kit.executePreparedManyBatched(args[0], args[1], args[2], args[3]));
                break;
            case 'databaseKit:queryPrepared':
                data = await registeredBridge
                    .getDatabaseKit()
                    .then((kit) => kit.queryPrepared(args[0], args[1], args[2], args[3]));
                break;
            case 'databaseKit:beginTransaction':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.beginTransaction(args[0]));
                break;
            case 'databaseKit:commitTransaction':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.commitTransaction(args[0], args[1]));
                break;
            case 'databaseKit:rollbackTransaction':
                data = await registeredBridge.getDatabaseKit().then((kit) => kit.rollbackTransaction(args[0], args[1]));
                break;
            case 'accountKit:available':
                data = await registeredBridge.getHuaweiAccountKit().then((kit) => kit.available());
                break;
            case 'accountKit:startLogin':
                data = await registeredBridge.getHuaweiAccountKit().then((kit) => kit.startLogin());
                break;
            case 'accountKit:peekLogin':
                data = await registeredBridge.getHuaweiAccountKit().then((kit) => kit.peekLogin());
                break;
            case 'accountKit:closeLogin':
                data = await registeredBridge.getHuaweiAccountKit().then((kit) => kit.closeLogin());
                break;
            default:
                return { status: 'error', message: `Method not found: ${method}` };
        }

        return { status: 'ok', data };
    });
}

export function resolveNativeBridge(): NativeBridge {
    return registeredBridge;
}
