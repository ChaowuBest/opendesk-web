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

// 待办状态类型
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

// 优先级类型
export type TodoPriority = 'low' | 'medium' | 'high';

import type { Participant } from '../../aikernel/plugins/types.js';

// ========== 触发器类型定义 ==========

export interface EventTriggerConfig {
    type: 'event';
    bundleName: string;       // 触发事件的应用标识
    eventName: string;        // 事件名称
}

export interface ScheduledTriggerConfig {
    type: 'scheduled';
    /**
     * UTC 时间（ISO 8601 格式，以 Z 结尾），仅触发一次。
     * 例如：当地时间 2026-03-01 09:00 (UTC+8) 应存储为 "2026-03-01T01:00:00Z"
     */
    triggerAt: string;
}

export interface CronTriggerConfig {
    type: 'cron';
    cronExpression: string;   // crontab 表达式: "分 时 日 月 周"
}

export type TodoTrigger = EventTriggerConfig | ScheduledTriggerConfig | CronTriggerConfig;

// 任务级待办项（会话级，任务结束后不保留）
export interface TaskTodo {
    id: string;
    task_id: string;        // 关联的任务ID
    title: string;            // 待办标题（简短描述）
    content: string;          // 待办内容（详细描述，发送给 Agent 执行）
    status: TodoStatus;
    created_at: string;
    updated_at: string;
    completed_at?: string;
}

// 全局待办项（持久化，跨任务共享）
export interface GlobalTodo {
    id: string;
    title: string;            // 待办标题（简短描述）
    content: string;          // 待办内容（详细描述，发送给 Agent 执行）
    status: TodoStatus;
    priority: TodoPriority;
    category?: string;        // 分类标签，如 "bug", "feature", "idea"
    source_task_id?: string;  // 来源任务ID（可选）
    trigger?: TodoTrigger;    // 触发器配置
    /** 回复投递目标，继承自创建该待办的任务 origin（如飞书发起的会话） */
    deliver?: Participant;
    last_triggered_at?: string; // 上次触发时间
    created_at: string;
    updated_at: string;
    completed_at?: string;
}

// 全局待办存储结构
export interface GlobalTodoStorage {
    version: string;
    todos: GlobalTodo[];
    last_updated: string;
}

// TodoWrite 工具的待办参数
export interface TodoWriteTodoParam {
    id?: string;              // 可选，更新时使用
    title: string;            // 待办标题（简短描述，用于列表展示）
    content: string;          // 待办内容（详细描述，发送给 Agent 执行。Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中）
    status: TodoStatus;
}
