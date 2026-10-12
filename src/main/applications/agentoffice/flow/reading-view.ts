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

export interface FlowReadingReceipt {
    read: number;
    total: number;
    members: Array<{ staffId: string; status: 'unread' | 'reading' | 'read' | 'failed' }>;
}

export interface FlowReadingView {
    flowId: string;
    mode: 'immediate' | 'aligned';
    deleting: boolean;
    members: Array<{
        staffId: string;
        name?: string;
        availability: 'active' | 'disabled' | 'missing' | 'left';
        intervalMinutes: number;
        nextTriggerAt?: string;
        retryBatchId?: string;
    }>;
    receipts: Record<string, FlowReadingReceipt>;
}
