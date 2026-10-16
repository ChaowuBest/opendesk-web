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

import type { TaskSearchResponse } from '../../../common/task-search.js';

export type TaskSearchRequest =
    { type: 'refresh' } | { type: 'search'; id: number; query: string; limit: number; clientId: number };

export type TaskSearchMessage =
    | { type: 'changed' }
    | { type: 'result'; id: number; data: TaskSearchResponse }
    | { type: 'error'; id?: number; message: string };
