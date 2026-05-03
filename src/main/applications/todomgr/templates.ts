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

export interface TodoTemplate {
    id: string;
    title: string;
    description: string;
    icon: string;
    triggerType: 'scheduled' | 'cron' | 'event';
    defaultContent: string;
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
        title: '面试准备提醒',
        description: '工作日每 2 小时提醒你复习大模型面试内容，并生成 3 个模拟题',
        icon: 'fa-user-tie',
        triggerType: 'scheduled',
        defaultContent:
            '请帮我生成 3 道大模型相关的面试题目，涵盖 Transformer 架构、训练技巧和推理优化，并给出参考答案要点。',
        defaultPriority: 'high',
        defaultCategory: '学习'
    },
    {
        id: 'tpl-meeting-prep',
        title: '会议前准备',
        description: '在会议开始前帮你整理会议议题、目标、待确认问题和关联材料',
        icon: 'fa-handshake',
        triggerType: 'scheduled',
        defaultContent:
            '请帮我整理即将到来的会议准备材料。请列出会议议题清单、每个议题的讨论目标、需要提前确认的问题以及关联的参考资料。',
        defaultPriority: 'medium',
        defaultCategory: '工作'
    },
    {
        id: 'tpl-health-checkup',
        title: '体检预约提醒',
        description: '在指定时间提醒你预约体检并确认可用时间段',
        icon: 'fa-stethoscope',
        triggerType: 'scheduled',
        defaultContent:
            '请提醒我预约年度体检。请帮我整理体检前的注意事项（如空腹、着装等），并列出需要重点关注的检查项目建议。',
        defaultPriority: 'medium',
        defaultCategory: '生活'
    },

    // ========== 周期任务 (cron) ==========
    {
        id: 'tpl-daily-ai-news',
        title: '每日 AI 新闻推送',
        description: '关注当天 AI 领域的重要动态，聚焦 AI coding 与具身智能进展，筛选 3-5 条值得关注的新闻',
        icon: 'fa-newspaper',
        triggerType: 'cron',
        defaultContent:
            '请搜索并整理今天 AI 领域的最新动态，重点关注 AI coding 和具身智能方向。请筛选 3-5 条最值得关注的新闻，每条包含标题、来源、核心内容摘要和对行业的影响分析。',
        defaultPriority: 'medium',
        defaultCategory: '资讯',
        defaultCronMode: 'daily',
        defaultLocalHour: 8,
        defaultLocalMinute: 30
    },
    {
        id: 'tpl-daily-english',
        title: '每日 5 个英语单词',
        description: '每天推荐 5 个高频实用英语单词，包含义、音标、例句和记忆提示',
        icon: 'fa-spell-check',
        triggerType: 'cron',
        defaultContent:
            '请推荐 5 个高频实用的英语单词，每个单词包含：中英文含义、音标、2 个使用例句（含中文翻译）和一个记忆技巧提示。难度为中高级。',
        defaultPriority: 'low',
        defaultCategory: '学习',
        defaultCronMode: 'daily',
        defaultLocalHour: 7,
        defaultLocalMinute: 0
    },
    {
        id: 'tpl-weekly-report',
        title: '每周工作周报',
        description: '每周五汇总 PR 与 Issue 进展，输出关键进度与下周计划',
        icon: 'fa-chart-pie',
        triggerType: 'cron',
        defaultContent:
            '请帮我生成本周的工作周报。请汇总本周完成的主要工作、关键进展和遇到的问题，并列出下周的工作计划和优先事项。格式要求清晰分段，适合发送给团队。',
        defaultPriority: 'medium',
        defaultCategory: '工作',
        defaultCronMode: 'weekly',
        defaultLocalHour: 17,
        defaultLocalMinute: 0,
        defaultDows: [5]
    },
    {
        id: 'tpl-daily-question',
        title: '每日一个为什么',
        description: '每天抛出一个有趣问题，先让你思辨解答，语气轻松，适合阅读，答案不超过 200-300 字',
        icon: 'fa-circle-question',
        triggerType: 'cron',
        defaultContent:
            '请抛出一个有趣的"为什么"问题（可以是科学、生活、历史等领域的），先让我思考，然后给出 200-300 字以内的解答。语气轻松有趣，适合碎片化阅读。',
        defaultPriority: 'low',
        defaultCategory: '趣味',
        defaultCronMode: 'daily',
        defaultLocalHour: 9,
        defaultLocalMinute: 0
    },
    {
        id: 'tpl-bedtime-story',
        title: '每日儿童睡前故事',
        description: '生成 3-5 分钟可读的温阳有趣的故事，情节完整开朗而短暂',
        icon: 'fa-book-open',
        triggerType: 'cron',
        defaultContent:
            '请为 4-8 岁的小朋友创作一个温馨有趣的原创睡前故事。要求：故事时长约 3-5 分钟可读完，情节完整、积极向上，包含一个小小的道理或启发。语言简洁生动，适合家长给孩子朗读。',
        defaultPriority: 'low',
        defaultCategory: '生活',
        defaultCronMode: 'daily',
        defaultLocalHour: 20,
        defaultLocalMinute: 30
    },
    {
        id: 'tpl-movie-recommend',
        title: '经典电影推荐',
        description: '推荐一部两人经典电影，简要介绍剧情和推荐理由，全球不限产地',
        icon: 'fa-film',
        triggerType: 'cron',
        defaultContent:
            '请推荐一部经典好电影。请简要介绍剧情（不剧透关键情节）、导演和主要演员，说明推荐理由和适合的观影场景。不限国家和年代，每次推荐不同类型。',
        defaultPriority: 'low',
        defaultCategory: '生活',
        defaultCronMode: 'weekly',
        defaultLocalHour: 19,
        defaultLocalMinute: 0,
        defaultDows: [5]
    },
    {
        id: 'tpl-parent-reminder',
        title: '父母联系提醒',
        description: '每周日 10:00 提醒你给家人打电话或发消息，简单问候拉近距离',
        icon: 'fa-heart',
        triggerType: 'cron',
        defaultContent:
            '今天是联系家人的好时机！请帮我想一些温馨的话题和问候方式，可以是关心健康、分享近况、或者讨论最近的新闻趣事。也帮我想想有没有什么实际可以帮到家人的事情。',
        defaultPriority: 'medium',
        defaultCategory: '生活',
        defaultCronMode: 'weekly',
        defaultLocalHour: 10,
        defaultLocalMinute: 0,
        defaultDows: [0]
    },
    {
        id: 'tpl-history-today',
        title: '历史上的今天',
        description: '从科技、文学、电影等领域随机挑选一件今天发生过的历史事件，200-300 字讲清楚',
        icon: 'fa-landmark',
        triggerType: 'cron',
        defaultContent:
            '请告诉我"历史上的今天"发生过的一件有趣或重要的事件。从科技、文学、电影、音乐等领域随机挑选，用 200-300 字简洁生动地讲述事件的来龙去脉及其影响。',
        defaultPriority: 'low',
        defaultCategory: '资讯',
        defaultCronMode: 'daily',
        defaultLocalHour: 8,
        defaultLocalMinute: 0
    },

    // ========== 按需触发任务 (event) ==========
    {
        id: 'tpl-new-email-summary',
        title: '新邮件智能摘要',
        description: '收到新邮件时自动生成摘要并标注优先级和待办',
        icon: 'fa-envelope-open-text',
        triggerType: 'event',
        defaultContent:
            '请对新收到的邮件进行智能摘要处理。提取邮件的核心内容、发件人意图、需要回复或处理的事项，并标注优先级建议。如果邮件中包含截止日期或约会信息，请特别标出。',
        defaultPriority: 'medium',
        defaultCategory: '工作',
        defaultBundleName: 'mailbox',
        defaultEventName: 'newEmailCountsUpdated'
    },
    {
        id: 'tpl-wallpaper-gen',
        title: '可爱萌宠手机壁纸',
        description: '随机从 7 种不同风格中挑选一种，为你生成 9:16 超高清萌宠手机壁纸',
        icon: 'fa-image',
        triggerType: 'event',
        defaultContent:
            '请帮我生成一张可爱的萌宠手机壁纸。从以下风格中随机挑选一种：水彩画风格、扁平插画、像素风、日系漫画、毛绒写实、低多边形3D、极简线描。壁纸比例为 9:16，画面要温馨可爱，适合作为手机锁屏或桌面。',
        defaultPriority: 'low',
        defaultCategory: '创意'
    }
];
