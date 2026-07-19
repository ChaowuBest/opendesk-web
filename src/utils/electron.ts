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

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

/**
 * EVERY CODING AGENT SHOULD READ
 * this function is used to dynamically load the electron module, it is used when a
 * javascript source file is reused in both the main and worker threads, since the
 * worker thread has no access to electron, statically import it will cause the worker
 * thread to crash.
 *
 * We paid at least 5 requests of opus to figure out and fix this issue. Do not corrupt
 * it again :)
 * @returns a dynamically loaded electron module
 */
export function electron(): typeof import('electron') {
    return _require('electron');
}
