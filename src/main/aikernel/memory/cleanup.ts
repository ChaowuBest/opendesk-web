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

import { logger } from '../../utils/logger.js';

export const MEMORY_CLEANUP_INTERVAL_MS = 2 * 60 * 60 * 1000;

export interface MemoryCleanupResult {
    removed: number;
}

export function startMemoryCleanupScheduler(cleanup: () => Promise<MemoryCleanupResult>): () => void {
    let running = false;
    const execute = async (): Promise<void> => {
        if (running) {
            return;
        }
        running = true;
        try {
            const result = await cleanup();
            if (result.removed > 0) {
                logger.info(`Cleaned up ${result.removed} stale memories`);
            }
        } catch (error) {
            logger.warn(`Failed to clean up stale memories: ${error}`);
        } finally {
            running = false;
        }
    };

    void execute();
    const timer = setInterval(() => void execute(), MEMORY_CLEANUP_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}
