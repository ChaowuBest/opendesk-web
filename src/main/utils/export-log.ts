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

import type { ExportDestinationHost, ExportReceipt, ExportResult } from '../../common/export.js';
import { t } from '../../locale/index.js';
import { withExportDestination } from './export-destination.js';
import { LogStream } from './logger.js';

/** Shared log selection, naming and serialization; hosts only supply destination access. */
export async function exportLogEntries<Receipt extends ExportReceipt>(
    options: unknown,
    host: ExportDestinationHost<Receipt>
): Promise<ExportResult<Receipt>> {
    const input = options as { scope?: unknown; filter?: unknown } | null | undefined;
    const scope = input?.scope === 'filtered' ? 'filtered' : 'all';
    const filter = scope === 'filtered' ? String(input?.filter || '').trim() : '';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const suggestedName =
        scope === 'filtered' ? `opendesk-filtered-logs-${timestamp}.txt` : `opendesk-logs-${timestamp}.txt`;

    return withExportDestination(
        host,
        { title: t('main.log.export.title'), suggestedName, mimeType: 'text/plain', extensions: ['txt'] },
        () => LogStream.getStream().formatEntries({ filter })
    );
}
