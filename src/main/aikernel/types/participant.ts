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

/**
 * 任务来源 / 结果投递目标的公共契约。
 *
 * 该类型同时被 TaskState.origin、任务管理器、channelmgr 与 todomgr 使用，
 * 而 aikernel 不允许反向依赖 applications，因此放在 aikernel/types 这一公共契约层。
 */
export interface Participant {
    type: 'channel';
    /** Channel identifier, e.g. 'feishu', 'slack' */
    channel: string;
    /** Bot's account within the channel (used as accountId in sendText) */
    accountId: string;
    /** Message recipient - senderId for direct messages, groupId for group chats */
    recipientId: string;
}
