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

import type { TaskState } from '../states/tasks.js';

export interface SubTaskConfig {
    /** 任务标题，主要方便在主任务界面中向用户显示 */
    title: string;
    /** 详细任务目标 */
    objective: string;
    /** 任务要求，或者说对任务结果的判断标准 */
    criteria: string;
    /** 是否为异步任务，异步任务立刻返回子任务ID */
    isAsync: boolean;
    /** 指定执行此任务的 Agent 名称（如 'explore'），留空使用默认子任务执行器 */
    agentName?: string;
}

export interface SubTaskResult {
    subtask_id: string;
    success: boolean;
    /**
     * 结果状态:
     * - success: 成功
     * - fail: 失败
     * - ask: 需要补充信息或向用户提问
     */
    status?: 'success' | 'fail' | 'ask';
    result: string;
}

export interface SubTaskProgressInfo {
    tools: Array<{ name: string; status: string }>;
    lastText: string | null;
}

export interface PendingSubTask {
    promise: Promise<SubTaskResult>;
    taskState?: TaskState;
}
