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
 * 自动化任务模板的结构化定义。标题 / 描述 / 默认内容属于用户可见文案，
 * 统一放在 locale 的 template.<id>.title / .description / .content 词条中，
 * renderer 通过翻译器按模板 id 取词。
 */

export interface TodoTemplate {
    id: string;
    icon: string;
    triggerType: 'scheduled' | 'cron' | 'event';
    defaultPriority: 'low' | 'medium' | 'high';
    defaultCategory?: string;
    /** cron 类型的默认 cron 表达式 (UTC) */
    defaultCronExpression?: string;
    /** cron builder 的默认模式 */
    defaultCronMode?: string;
    /** cron builder 的默认本地时间（小时） */
    defaultLocalHour?: number;
    /** cron builder 的默认本地时间（分钟） */
    defaultLocalMinute?: number;
    /** cron builder 的默认星期选择 (0=日, 1=一, ..., 6=六) */
    defaultDows?: number[];
    /** event 类型的默认 bundleName */
    defaultBundleName?: string;
    /** event 类型的默认 eventName */
    defaultEventName?: string;
}

export const TODO_TEMPLATES: TodoTemplate[] = [
    // ========== 定时任务 (scheduled) ==========
    {
        id: 'tpl-interview-prep',
        icon: 'fa-user-tie',
        triggerType: 'scheduled',
        defaultPriority: 'high',
        defaultCategory: '学习'
    },
    {
        id: 'tpl-meeting-prep',
        icon: 'fa-handshake',
        triggerType: 'scheduled',
        defaultPriority: 'medium',
        defaultCategory: '工作'
    },
    {
        id: 'tpl-health-checkup',
        icon: 'fa-stethoscope',
        triggerType: 'scheduled',
        defaultPriority: 'medium',
        defaultCategory: '生活'
    },

    // ========== 周期任务 (cron) ==========
    {
        id: 'tpl-daily-ai-news',
        icon: 'fa-newspaper',
        triggerType: 'cron',
        defaultPriority: 'medium',
        defaultCategory: '资讯',
        defaultCronMode: 'daily',
        defaultLocalHour: 8,
        defaultLocalMinute: 30
    },
    {
        id: 'tpl-daily-english',
        icon: 'fa-spell-check',
        triggerType: 'cron',
        defaultPriority: 'low',
        defaultCategory: '学习',
        defaultCronMode: 'daily',
        defaultLocalHour: 7,
        defaultLocalMinute: 0
    },
    {
        id: 'tpl-weekly-report',
        icon: 'fa-chart-pie',
        triggerType: 'cron',
        defaultPriority: 'medium',
        defaultCategory: '工作',
        defaultCronMode: 'weekly',
        defaultLocalHour: 17,
        defaultLocalMinute: 0,
        defaultDows: [5]
    },
    {
        id: 'tpl-daily-question',
        icon: 'fa-circle-question',
        triggerType: 'cron',
        defaultPriority: 'low',
        defaultCategory: '趣味',
        defaultCronMode: 'daily',
        defaultLocalHour: 9,
        defaultLocalMinute: 0
    },
    {
        id: 'tpl-bedtime-story',
        icon: 'fa-book-open',
        triggerType: 'cron',
        defaultPriority: 'low',
        defaultCategory: '生活',
        defaultCronMode: 'daily',
        defaultLocalHour: 20,
        defaultLocalMinute: 30
    },
    {
        id: 'tpl-movie-recommend',
        icon: 'fa-film',
        triggerType: 'cron',
        defaultPriority: 'low',
        defaultCategory: '生活',
        defaultCronMode: 'weekly',
        defaultLocalHour: 19,
        defaultLocalMinute: 0,
        defaultDows: [5]
    },
    {
        id: 'tpl-parent-reminder',
        icon: 'fa-heart',
        triggerType: 'cron',
        defaultPriority: 'medium',
        defaultCategory: '生活',
        defaultCronMode: 'weekly',
        defaultLocalHour: 10,
        defaultLocalMinute: 0,
        defaultDows: [0]
    },
    {
        id: 'tpl-history-today',
        icon: 'fa-landmark',
        triggerType: 'cron',
        defaultPriority: 'low',
        defaultCategory: '资讯',
        defaultCronMode: 'daily',
        defaultLocalHour: 8,
        defaultLocalMinute: 0
    },

    // ========== 按需触发任务 (event) ==========
    {
        id: 'tpl-new-email-summary',
        icon: 'fa-envelope-open-text',
        triggerType: 'event',
        defaultPriority: 'medium',
        defaultCategory: '工作',
        defaultBundleName: 'mailbox',
        defaultEventName: 'newEmailCountsUpdated'
    },
    {
        id: 'tpl-wallpaper-gen',
        icon: 'fa-image',
        triggerType: 'event',
        defaultPriority: 'low',
        defaultCategory: '创意'
    }
];
