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

import path from 'node:path';

// Temporary test service. Switch to the no-port HTTPS production URL before release.
export const DEFAULT_UPDATE_FEED_URL = 'http://114.212.84.8:18080/news/';
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const UPDATE_PACKAGE_TRUST_MODE = 'trusted-source' as const;

export function resolveUpdateCacheDirectory(userDataDirectory: string): string {
    return path.join(userDataDirectory, 'Cache');
}
