/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger.js';
import { isOpenHarmonyPlatform } from './arktsClient.js';
import { createNativeBridgeHandlers } from './handlers.js';

const LOG_TAG = '[services/bridge]';

/** 主进程：注册原生桥 IPC（仅 OpenHarmony） */
export function registerNativeBridge(): void {
    if (!isOpenHarmonyPlatform()) {
        return;
    }

    const handlers = createNativeBridgeHandlers();

    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, ...args) => {
            try {
                return await handler(event, ...args);
            } catch (err) {
                logger.error(`${LOG_TAG} ${channel} failed: ${err}`);
                throw err;
            }
        });
    }

    logger.info(`${LOG_TAG} IPC registered: ${Object.keys(handlers).join(', ')}`);
}
