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

import type {
    ExportContent,
    ExportDestinationHost,
    ExportReceipt,
    ExportRequest,
    ExportResult
} from '../../common/export.js';
import { logger } from './logger.js';

/** One export transaction for local files and document providers alike. */
export async function withExportDestination<Receipt extends ExportReceipt>(
    host: ExportDestinationHost<Receipt>,
    request: ExportRequest,
    generateContent: () => ExportContent | Promise<ExportContent>
): Promise<ExportResult<Receipt>> {
    const destination = await host.selectDestination(request);
    if (!destination) return { canceled: true };

    try {
        await host.write(destination, await generateContent());
        return { canceled: false, receipt: await host.commit(destination) };
    } finally {
        try {
            await host.release(destination);
        } catch (error) {
            // A cleanup failure must not hide the original write error or turn
            // a completed provider commit into a misleading export failure.
            logger.warn('[export] failed to release destination', error);
        }
    }
}
