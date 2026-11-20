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

import type { HostCapability } from './host-capabilities.js';

export interface HostViewportRect {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

/** Optional ports installed by a renderer host before the shared UI is loaded. */
export interface RendererHostAPI {
    readonly capabilities?: Readonly<Partial<Record<HostCapability, boolean>>>;
    readonly clipboard?: { writeText(text: string): Promise<void> };
    readonly viewport?: {
        /** The visible rectangle in CSS viewport coordinates, after any native occlusion. */
        getVisibleRect(): HostViewportRect | undefined;
        subscribe?(listener: () => void): () => void;
    };
    readonly settings?: { readonly progressiveLoading?: boolean };
}
