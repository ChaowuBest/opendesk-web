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

import type { TodoStatus, TaskTodo } from '../../aikernel/todos/task-todos.js';
export type { TodoStatus, TaskTodo };
import type { ReasoningEffort } from '../../aikernel/types/reasoning.js';
import type { TodoRecurrence } from './todo-recurrence.js';

// 优先级类型
export type TodoPriority = 'low' | 'medium' | 'high';

import type { Participant } from '../../aikernel/types/index.js';

export interface TodoChatModelSummary {
    alias: string;
    provider_name: string;
    model_name: string;
    vision: boolean;
    reasoningEfforts: ReasoningEffort[];
}

export interface TodoChatModelCatalog {
    default_model: string;
    models: TodoChatModelSummary[];
}

// ========== 触发器类型定义 ==========

export interface EventTriggerConfig {
    type: 'event';
    bundleName: string; // 触发事件的应用标识
    eventName: string; // 事件名称
}

export interface ScheduledTriggerConfig {
    type: 'scheduled';
    /**
     * UTC 时间（ISO 8601 格式，以 Z 结尾），仅触发一次。
     * 例如：当地时间 2026-03-01 09:00 (UTC+8) 应存储为 "2026-03-01T01:00:00Z"
     */
    triggerAt: string;
    /** 输入和展示时间使用的 IANA 时区，新建默认使用系统时区；triggerAt 始终保存 UTC 绝对时间 */
    timezone?: string;
}

export interface CronTriggerConfig {
    type: 'cron';
    cronExpression: string; // crontab 表达式: "分 时 日 月 周"
    /** cron 字段所属的 IANA 时区，新建默认使用系统时区；旧数据未设置时沿用 UTC 语义 */
    timezone?: string;
    /** 可视化周期/间隔规则。存在时由规则执行，cronExpression 仅作兼容字段。 */
    recurrence?: TodoRecurrence;
}

export type TodoTrigger = EventTriggerConfig | ScheduledTriggerConfig | CronTriggerConfig;

export type TodoWorkspaceConfig = { type: 'default' } | { type: 'isolated' } | { type: 'path'; path: string };

// 全局待办项（持久化，跨任务共享）
export interface GlobalTodo {
    id: string;
    title: string; // 待办标题（简短描述）
    content: string; // 待办内容（详细描述，发送给 Agent 执行）
    priority: TodoPriority;
    category?: string; // 分类标签，如 "bug", "feature", "idea"
    source_task_id?: string; // 来源任务ID（可选）
    trigger?: TodoTrigger; // 触发器配置
    /** 回复投递目标，可显式指定；未指定时可继承创建该待办的任务 origin */
    deliver?: Participant | null;
    /** 自动化任务启动时使用的工作空间配置。未设置时使用当前全局工作空间 */
    workspace?: TodoWorkspaceConfig;
    /** 自动化任务使用的聊天模型别名。未设置时触发时使用全局默认模型 */
    model?: string;
    /** 自动化任务使用的推理档位。空字符串或未设置时使用模型默认档位 */
    reasoningEffort?: ReasoningEffort;
    /** 是否启用，默认 true。禁用后不会按触发器自动执行，但仍可手动触发；一次性任务执行后自动设为 false */
    enabled?: boolean;
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
    id?: string; // 可选，更新时使用
    title?: string; // 可选，待办标题；缺省时由 handleExecute 用 content 兜底
    content: string; // 待办内容（详细描述，发送给 Agent 执行。Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中）
    status: TodoStatus;
}
