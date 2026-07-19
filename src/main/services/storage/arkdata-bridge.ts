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

import type { DatabaseKit } from '../../../platforms/bridges/common.js';

let _kit: DatabaseKit | null = null;

export function setArkdataDatabaseKit(kit: DatabaseKit | null): DatabaseKit | null {
    const previous = _kit;
    _kit = kit;
    return previous;
}

export function getArkdataDatabaseKit(): DatabaseKit {
    if (!_kit) {
        throw new Error(
            'ArkData DatabaseKit not initialized. ' +
                'Worker must call setArkdataDatabaseKit() in initialize() before constructing ArkData IndexDB.'
        );
    }
    return _kit;
}
