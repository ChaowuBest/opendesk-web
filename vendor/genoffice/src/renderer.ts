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

interface SlidesBootstrapApi {
    openPptxPath(path: string, fitWidthPx: number): Promise<unknown>;
}

export interface GenOfficeSlidesBootstrapOptions {
    filePath?: string | null;
    fitWidthPx?: number;
}

export async function bootstrapGenOfficeSlidesEditor(
    options: GenOfficeSlidesBootstrapOptions = {}
): Promise<void> {
    const filePath = options.filePath ?? new URLSearchParams(window.location.search).get('file');
    const fitWidthPx = options.fitWidthPx ?? 1280;
    const api = (window as unknown as { slidesApi?: SlidesBootstrapApi }).slidesApi;

    if (filePath && api) {
        try {
            await api.openPptxPath(filePath, fitWidthPx);
        } catch {
            // The upstream editor recovers to a blank deck when no session can be consumed.
        }
    }

    await import('../apps/slides/src/renderer/main.js');
}
