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

import type { AriaPass } from '../cdp/aria.js';
import { normalizeStringsPass } from './normalizeStringsPass.js';
import { normalizeGenericsPass } from './normalizeGenericsPass.js';
import { dedupRedundantNamesPass } from './dedupRedundantNamesPass.js';
import { simplifyTextLeafPass } from './simplifyTextLeafPass.js';
import { collapseRepeatedSiblingsPass } from './collapseRepeatedSiblingsPass.js';

export { normalizeStringsPass } from './normalizeStringsPass.js';
export { normalizeGenericsPass } from './normalizeGenericsPass.js';
export { dedupRedundantNamesPass } from './dedupRedundantNamesPass.js';
export { simplifyTextLeafPass } from './simplifyTextLeafPass.js';
export { collapseRepeatedSiblingsPass } from './collapseRepeatedSiblingsPass.js';
export { pruneOffscreenPass } from './pruneOffscreenPass.js';

/**
 * Default optimization pipeline applied to every captured snapshot.
 * Order matters: normalize strings/generics first, then lift fragmented text
 * leaves (prices, sell-points), then fold long runs of structurally identical
 * siblings (channel grids / product racks) into one representative. The latter
 * is the single biggest source of runaway snapshot size on e-commerce &
 * catalogue pages.
 */
export const DEFAULT_ARIA_PASSES: AriaPass[] = [
    normalizeStringsPass,
    normalizeGenericsPass,
    dedupRedundantNamesPass,
    simplifyTextLeafPass,
    collapseRepeatedSiblingsPass
];
