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

export const zhCn: Record<string, string> = {
    'app.name': '自动化任务',

    // ========== 通用 ==========
    'renderer.todo.common.create': '创建',
    'renderer.todo.common.save': '保存',
    'renderer.todo.common.cancel': '取消',
    'renderer.todo.common.delete': '删除',
    'renderer.todo.common.edit': '编辑',
    'renderer.todo.common.close': '关闭',
    'renderer.todo.common.more': '更多',
    'renderer.todo.common.expand': '全屏',
    'renderer.todo.common.restore': '恢复',

    // ========== 状态 / 触发类型 ==========
    'status.enabled': '启用中',
    'status.disabled': '未启用',
    'card.type.scheduled.label': '定时任务',
    'card.type.cron.label': '周期任务',
    'card.type.event.label': '按需触发任务',
    'card.type.manual.label': '手动任务',
    'trigger.summary.manual': '手动触发',
    'trigger.summary.scheduled': '定时',
    'trigger.summary.cron': '周期',
    'trigger.summary.unknown': '未知',

    // ========== 日期时间 ==========
    'date.month.1': '1月',
    'date.month.2': '2月',
    'date.month.3': '3月',
    'date.month.4': '4月',
    'date.month.5': '5月',
    'date.month.6': '6月',
    'date.month.7': '7月',
    'date.month.8': '8月',
    'date.month.9': '9月',
    'date.month.10': '10月',
    'date.month.11': '11月',
    'date.month.12': '12月',
    'date.dow.0': '周日',
    'date.dow.1': '周一',
    'date.dow.2': '周二',
    'date.dow.3': '周三',
    'date.dow.4': '周四',
    'date.dow.5': '周五',
    'date.dow.6': '周六',
    'date.format.monthDayTime': '${month}月${day}日 ${time}',
    'date.format.monthYear': '${year}年${monthName}',
    'date.format.fullTime': '${year}年${month}月${day}日 ${time}',

    // ========== Renderer：主界面 ==========
    'renderer.todo.subtitle': '让 Agent 按计划自动执行任务，持续为你处理重复工作',
    'renderer.todo.quickAdd': '一句话创建',
    'renderer.todo.quickAddPromptText': '请在这里描述你需要的自动化任务内容',
    'renderer.todo.templatesTitle': '可以试试从这些常见任务入手',
    'renderer.todo.createdTitle': '已创建的自动化任务',
    'renderer.todo.empty': '暂无自动化任务',
    'renderer.todo.emptyHint': '点击上方模板快速创建',

    // ========== Renderer：卡片 ==========
    'renderer.todo.card.toggle.disableHint': '已启用，点击禁用',
    'renderer.todo.card.toggle.enableHint': '已禁用，点击启用',

    // ========== Renderer：详情 ==========
    'renderer.todo.detail.contentTitle': '任务内容',
    'renderer.todo.detail.attrsTitle': '任务属性',
    'renderer.todo.detail.attr.status': '状态',
    'renderer.todo.detail.attr.triggerType': '触发方式',
    'renderer.todo.detail.attr.cronExpression': 'Cron 表达式',
    'renderer.todo.detail.attr.eventSource': '事件源',
    'renderer.todo.detail.attr.eventName': '事件名',
    'renderer.todo.detail.attr.deliverTarget': '投递目标',
    'renderer.todo.detail.attr.workspace': '工作空间',
    'renderer.todo.detail.attr.createdAt': '创建时间',
    'renderer.todo.detail.attr.updatedAt': '更新时间',
    'renderer.todo.detail.attr.lastTriggered': '上次触发',
    'renderer.todo.detail.attr.disabledAt': '停用时间',
    'renderer.todo.detail.executeNow': '立即执行',

    // ========== Renderer：编辑表单 ==========
    'renderer.todo.edit.newTitle': '新建任务',
    'renderer.todo.edit.editTitle': '编辑任务',
    'renderer.todo.edit.labelTitle': '标题',
    'renderer.todo.edit.placeholderTitle': '任务标题',
    'renderer.todo.edit.labelContent': '内容',
    'renderer.todo.edit.placeholderContent': '详细的任务描述，将发送给 Agent 执行...',
    'renderer.todo.edit.labelStatus': '状态',
    'renderer.todo.edit.labelTriggerType': '触发类型',
    'renderer.todo.edit.triggerType.scheduled': '定时（一次性）',
    'renderer.todo.edit.triggerType.cron': '周期（Cron）',
    'renderer.todo.edit.triggerType.event': '事件触发',
    'renderer.todo.edit.labelWorkspace': '指定工作空间',
    'renderer.todo.edit.labelDeliver': '发送到',
    'renderer.todo.edit.deliverDefault': '默认',
    'renderer.todo.edit.deliverHint': '指定后，任务产生的回复将自动发送到该渠道',
    'renderer.todo.edit.saving': '保存中...',
    'renderer.todo.edit.retry': '重试',

    // ========== Renderer：工作空间 ==========
    'renderer.todo.workspace.default': '默认工作空间',
    'renderer.todo.workspace.isolatedName': '任务独立工作空间',
    'renderer.todo.workspace.isolated': '使用任务独立的工作空间',
    'renderer.todo.workspace.recent': '常用工作空间',
    'renderer.todo.workspace.other': '其他位置...',
    'renderer.todo.workspace.hintDefault': '启动任务时使用当前全局工作空间',
    'renderer.todo.workspace.hintIsolated': '每个任务使用 OpenDesk 数据目录下的独立 job 工作空间',

    // ========== Renderer：投递目标 ==========
    'renderer.todo.deliver.noContacts': '（暂无联系人，请先通过该渠道发一条消息）',
    'renderer.todo.deliver.groupHint': '群',

    // ========== Renderer：日期时间选择器 ==========
    'renderer.todo.datetime.triggerTime': '触发时间',
    'renderer.todo.datetime.time': '时间',
    'renderer.todo.datetime.today': '今天',
    'renderer.todo.datetime.confirm': '确认',
    'renderer.todo.datetime.placeholder': '点击选择日期和时间',
    'renderer.todo.datetime.weekday.1': '一',
    'renderer.todo.datetime.weekday.2': '二',
    'renderer.todo.datetime.weekday.3': '三',
    'renderer.todo.datetime.weekday.4': '四',
    'renderer.todo.datetime.weekday.5': '五',
    'renderer.todo.datetime.weekday.6': '六',
    'renderer.todo.datetime.weekday.7': '日',

    // ========== Renderer：Cron 构建器 ==========
    'renderer.todo.cron.repeatFrequency': '重复频率',
    'renderer.todo.cron.mode.daily': '每天',
    'renderer.todo.cron.mode.weekly': '每周指定日',
    'renderer.todo.cron.mode.monthly': '每月指定日',
    'renderer.todo.cron.mode.custom': '自定义 Cron 表达式',
    'renderer.todo.cron.selectDays': '选择日期',
    'renderer.todo.cron.executeTime': '执行时间',
    'renderer.todo.cron.domOption': '${day}日',
    'renderer.todo.cron.expressionLabel': 'Cron 表达式',
    'renderer.todo.cron.customPlaceholder': '例如: 0 9 * * 1-5（工作日每天9点，使用本地时间）',
    'renderer.todo.cron.helpText': '什么是 Cron 表达式？',
    'renderer.todo.cron.previewEmpty': '请输入 Cron 表达式',
    'renderer.todo.cron.previewInvalid': '格式错误：Cron 表达式需要5个字段（分 时 日 月 周）',
    'renderer.todo.cron.desc.everyDow': '每${days}',
    'renderer.todo.cron.desc.dowRaw': '周(${dow})',
    'renderer.todo.cron.desc.monthlyDom': '每月${day}日',
    'renderer.todo.cron.desc.month': '${month}月',
    'renderer.todo.cron.desc.hourOnly': '${hour}时',
    'renderer.todo.cron.desc.minuteOnly': '每小时第${minute}分',
    'renderer.todo.cron.desc.everyMinute': '每分钟',

    // ========== Renderer：事件选择器 ==========
    'renderer.todo.event.bundleLabel': '事件源应用',
    'renderer.todo.event.selectBundle': '请选择应用...',
    'renderer.todo.event.nameLabel': '事件名称',
    'renderer.todo.event.selectBundleFirst': '请先选择应用...',
    'renderer.todo.event.noEvents': '该应用暂无已注册事件',
    'renderer.todo.event.selectEvent': '请选择事件...',

    // ========== Renderer：删除确认 / 立即执行 ==========
    'renderer.todo.delete.title': '删除任务',
    'renderer.todo.delete.message': '确定要删除任务「<b>${title}</b>」吗？此操作不可撤销。',
    'renderer.todo.execute.triggering': '触发中...',
    'renderer.todo.execute.triggered': '已触发',

    // ========== 工具卡片（GUI / CLI 渲染） ==========
    'tool.getCurrentTime.name': '获取当前时间',
    'tool.getCurrentTime.labelUtc': 'UTC 时间',
    'tool.getCurrentTime.labelLocal': '当地时间',
    'tool.getCurrentTime.labelTimezone': '时区',
    'tool.getCurrentTime.labelTimestamp': '时间戳',
    'tool.todoWrite.cardTitle': '更新任务计划',
    'tool.todoWrite.cardDisabled': '任务计划未启用',
    'tool.todoWrite.itemsCount': '${count} 项',
    'tool.todoWrite.cliSummary': '共 ${total} 个任务',
    'tool.todoWrite.cliEnabled': '启用中 ${count}',
    'tool.todoWrite.cliDisabled': '未启用 ${count}',
    'tool.todoWrite.cliAllCompleted': '所有待办已完成!',
    'tool.card.add': '添加自动化任务',
    'tool.card.update': '更新自动化任务',
    'tool.card.success': '操作成功',
    'tool.card.successWithId': '操作成功（ID: ${id}…）',
    'tool.cli.label.title': '标题: ',
    'tool.cli.label.content': '内容: ',
    'tool.cli.label.trigger': '触发器: ',
    'tool.cli.add.successWithId': '待办已添加，ID: ',
    'tool.cli.add.deliveredTo': '投递到: ',
    'tool.cli.add.success': '待办已添加!',
    'tool.cli.add.cardTitle': '添加全局待办',
    'tool.cli.update.field.title': '标题',
    'tool.cli.update.field.content': '内容',
    'tool.cli.update.field.enabled': '启用状态',
    'tool.cli.update.field.priority': '优先级',
    'tool.cli.update.field.category': '分类',
    'tool.cli.update.field.trigger': '触发器',
    'tool.cli.update.field.removeTrigger': '移除触发器',
    'tool.cli.update.updated': '更新: ',
    'tool.cli.update.success': '待办已更新!',
    'tool.cli.update.cardTitle': '更新全局待办',
    'tool.cli.list.loading': '加载中…',
    'tool.cli.list.empty': '暂无全局待办',
    'tool.cli.list.found': '找到 ${count} 个全局待办:',
    'tool.cli.list.more': '... 还有 ${count} 个',
    'tool.cli.list.success': '已获取待办列表',
    'tool.cli.list.cardTitle': '全局待办列表',
    'tool.cli.delete.success': '待办已删除!',
    'tool.cli.delete.cardTitle': '删除全局待办',
    'tool.cli.events.cardTitle': '获取应用事件清单',
    'tool.deliverTargets.empty': '当前没有可用的消息渠道。请先连接渠道插件。',
    'tool.deliverTargets.online': '在线',
    'tool.deliverTargets.offline': '离线',
    'tool.deliverTargets.noContacts': '暂无联系人；请先通过该渠道收发一条消息。',
    'tool.deliverTargets.group': '群聊',
    'tool.deliverTargets.private': '私聊',
    'tool.events.errorNoRegistry': '错误：未找到ApplicationRegistry，无法获取可用事件',

    // ========== 应用事件描述（GUI 事件选择器 + getSupportedEvents 工具） ==========
    'appEvent.globalTodosUpdated': '全局待办列表更新事件，当添加、删除、更新待办事项时触发',
    'appEvent.taskTodosUpdated':
        '任务级待办更新事件，当 Agent 调用 TodoWrite 创建 / 更新 / 清空任务计划时触发。' +
        '事件参数形如 { taskId, todos }，todos 为最新的任务级待办列表',

    // ========== 工具校验错误 ==========
    'error.workspaceEmpty': 'workspace 不能为空；如不需要指定工作空间，请省略该字段',
    'error.workspaceNotAbsolute': 'workspace 必须是绝对路径，当前值："${workspace}"',
    'error.triggerInvalid':
        '无效的 trigger 格式: ${message}。trigger 应为对象格式，如: {"type": "scheduled", "triggerAt": "2026-03-01T01:00:00Z"}',
    'error.triggerAtMustUtc':
        'scheduled trigger 的 triggerAt 必须使用 UTC 时间（以 Z 结尾），当前值："${triggerAt}"。' +
        '请使用 getCurrentTime 工具获取当前 UTC 时间，并根据需要计算目标时间。' +
        '例如：当地时间 2026-03-01 09:00 (UTC+8) 应转换为 "2026-03-01T01:00:00Z"',
    'error.triggerAtInvalidDate': '无效的日期格式："${triggerAt}"，请使用 ISO 8601 UTC 格式，如 "2026-03-01T01:00:00Z"',

    // ========== 应用助手与触发任务 ==========
    'agent.instruct':
        '你是待办事项管理助手，可以帮助用户查看和管理自动化任务。当前页面展示了所有自动化任务（定时任务、周期任务和按需触发任务）。你可以使用 addGlobalTodo / updateGlobalTodo / deleteGlobalTodo / listGlobalTodos 等工具管理全局待办。',
    'trigger.message.template':
        '\n请执行以下全局待办事项：\n\n- 待办事项ID: ${todoId}\n- 待办事项标题：${todoTitle}\n- 待办事项触发方式：${todoTrigger}\n\n待办事项内容\n---\n\n${todoContent}\n\n注意事项\n---\n1. 这条消息是由待办事项管理器自动创建的，你的回复应当专注于完成用户在待办事项中指定的任务;\n2. 待办事项的所有信息已经告诉你了，不需要尝试获取待办事项的更多信息，你也**不需要**将待办事项标记为已完成；\n3. 如果周期型待办事项无法成功完成，你应当检查过往的执行历史，如果失败次数过多，应当提醒用户取消待办事项；\n',
    'trigger.info.event': '[event] 事件驱动任务，由事件 ${bundle}:${event} 自动触发 ',
    'trigger.info.scheduled': '[scheduled] 定时任务，仅执行一次 ',
    'trigger.info.cron': '[cron] 定时任务, 触发时机为 ${cron} ',

    // ========== Cron 描述（主进程 describeCron 注入文案，dowNames 为裸名称） ==========
    'cron.desc.dowNames.0': '日',
    'cron.desc.dowNames.1': '一',
    'cron.desc.dowNames.2': '二',
    'cron.desc.dowNames.3': '三',
    'cron.desc.dowNames.4': '四',
    'cron.desc.dowNames.5': '五',
    'cron.desc.dowNames.6': '六',
    'cron.desc.everyDow': '每周${day}',
    'cron.desc.dow': '周${day}',
    'cron.desc.monthlyDom': '每月${day}日',
    'cron.desc.month': '${month}月',
    'cron.desc.hourOnly': '${hour}时',
    'cron.desc.minuteOnly': '每小时第${minute}分',
    'cron.desc.everyMinute': '每分钟',

    // ========== 模板 ==========
    'template.tpl-interview-prep.title': '面试准备提醒',
    'template.tpl-interview-prep.description': '工作日每 2 小时提醒你复习大模型面试内容，并生成 3 个模拟题',
    'template.tpl-interview-prep.content':
        '请帮我生成 3 道大模型相关的面试题目，涵盖 Transformer 架构、训练技巧和推理优化，并给出参考答案要点。',
    'template.tpl-meeting-prep.title': '会议前准备',
    'template.tpl-meeting-prep.description': '在会议开始前帮你整理会议议题、目标、待确认问题和关联材料',
    'template.tpl-meeting-prep.content':
        '请帮我整理即将到来的会议准备材料。请列出会议议题清单、每个议题的讨论目标、需要提前确认的问题以及关联的参考资料。',
    'template.tpl-health-checkup.title': '体检预约提醒',
    'template.tpl-health-checkup.description': '在指定时间提醒你预约体检并确认可用时间段',
    'template.tpl-health-checkup.content':
        '请提醒我预约年度体检。请帮我整理体检前的注意事项（如空腹、着装等），并列出需要重点关注的检查项目建议。',
    'template.tpl-daily-ai-news.title': '每日 AI 新闻推送',
    'template.tpl-daily-ai-news.description':
        '关注当天 AI 领域的重要动态，聚焦 AI coding 与具身智能进展，筛选 3-5 条值得关注的新闻',
    'template.tpl-daily-ai-news.content':
        '请搜索并整理今天 AI 领域的最新动态，重点关注 AI coding 和具身智能方向。请筛选 3-5 条最值得关注的新闻，每条包含标题、来源、核心内容摘要和对行业的影响分析。',
    'template.tpl-daily-english.title': '每日 5 个英语单词',
    'template.tpl-daily-english.description': '每天推荐 5 个高频实用英语单词，包含释义、音标、例句和记忆提示',
    'template.tpl-daily-english.content':
        '请推荐 5 个高频实用的英语单词，每个单词包含：中英文含义、音标、2 个使用例句（含中文翻译）和一个记忆技巧提示。难度为中高级。',
    'template.tpl-weekly-report.title': '每周工作周报',
    'template.tpl-weekly-report.description': '每周五汇总 PR 与 Issue 进展，输出关键进度与下周计划',
    'template.tpl-weekly-report.content':
        '请帮我生成本周的工作周报。请汇总本周完成的主要工作、关键进展和遇到的问题，并列出下周的工作计划和优先事项。格式要求清晰分段，适合发送给团队。',
    'template.tpl-daily-question.title': '每日一个为什么',
    'template.tpl-daily-question.description':
        '每天抛出一个有趣问题，先让你思辨解答，语气轻松，适合阅读，答案不超过 200-300 字',
    'template.tpl-daily-question.content':
        '请抛出一个有趣的"为什么"问题（可以是科学、生活、历史等领域的），先让我思考，然后给出 200-300 字以内的解答。语气轻松有趣，适合碎片化阅读。',
    'template.tpl-bedtime-story.title': '每日儿童睡前故事',
    'template.tpl-bedtime-story.description': '生成 3-5 分钟可读完的温馨有趣故事，情节完整',
    'template.tpl-bedtime-story.content':
        '请为 4-8 岁的小朋友创作一个温馨有趣的原创睡前故事。要求：故事时长约 3-5 分钟可读完，情节完整、积极向上，包含一个小小的道理或启发。语言简洁生动，适合家长给孩子朗读。',
    'template.tpl-movie-recommend.title': '经典电影推荐',
    'template.tpl-movie-recommend.description': '推荐一部经典电影，简要介绍剧情和推荐理由，全球不限产地',
    'template.tpl-movie-recommend.content':
        '请推荐一部经典好电影。请简要介绍剧情（不剧透关键情节）、导演和主要演员，说明推荐理由和适合的观影场景。不限国家和年代，每次推荐不同类型。',
    'template.tpl-parent-reminder.title': '父母联系提醒',
    'template.tpl-parent-reminder.description': '每周日 10:00 提醒你给家人打电话或发消息，简单问候拉近距离',
    'template.tpl-parent-reminder.content':
        '今天是联系家人的好时机！请帮我想一些温馨的话题和问候方式，可以是关心健康、分享近况、或者讨论最近的新闻趣事。也帮我想想有没有什么实际可以帮到家人的事情。',
    'template.tpl-history-today.title': '历史上的今天',
    'template.tpl-history-today.description':
        '从科技、文学、电影等领域随机挑选一件今天发生过的历史事件，200-300 字讲清楚',
    'template.tpl-history-today.content':
        '请告诉我"历史上的今天"发生过的一件有趣或重要的事件。从科技、文学、电影、音乐等领域随机挑选，用 200-300 字简洁生动地讲述事件的来龙去脉及其影响。',
    'template.tpl-new-email-summary.title': '新邮件智能摘要',
    'template.tpl-new-email-summary.description': '收到新邮件时自动生成摘要并标注优先级和待办',
    'template.tpl-new-email-summary.content':
        '请对新收到的邮件进行智能摘要处理。提取邮件的核心内容、发件人意图、需要回复或处理的事项，并标注优先级建议。如果邮件中包含截止日期或约会信息，请特别标出。',
    'template.tpl-wallpaper-gen.title': '可爱萌宠手机壁纸',
    'template.tpl-wallpaper-gen.description': '随机从 7 种不同风格中挑选一种，为你生成 9:16 超高清萌宠手机壁纸',
    'template.tpl-wallpaper-gen.content':
        '请帮我生成一张可爱的萌宠手机壁纸。从以下风格中随机挑选一种：水彩画风格、扁平插画、像素风、日系漫画、毛绒写实、低多边形3D、极简线描。壁纸比例为 9:16，画面要温馨可爱，适合作为手机锁屏或桌面。'
};
