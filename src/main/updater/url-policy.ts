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

const TEMPORARY_HTTP_UPDATE_ORIGINS = new Set(['http://114.212.84.8', 'http://114.212.84.8:18080']);

export function validateUpdateUrl(value: string | URL, label: string): URL {
    const url = value instanceof URL ? value : new URL(value);
    if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
    if (url.protocol === 'https:' || TEMPORARY_HTTP_UPDATE_ORIGINS.has(url.origin)) return url;
    throw new Error(`${label} must use HTTPS`);
}
