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

import { z } from 'zod';

const CalendarItemSchema = z.object({
    uid: z.string(),
    subject: z.string(),
    startTime: z.number(),
    endTime: z.number(),
    location: z.string().default(''),
    isAllDay: z.boolean().default(false),
    isCancelled: z.boolean().default(false),
    type: z.string().default('')
});

export { CalendarItemSchema };
