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

export const enUs: Record<string, string> = {
    'app.name': 'Automation',

    // ========== 通用 ==========
    'renderer.todo.common.create': 'Create',
    'renderer.todo.common.save': 'Save',
    'renderer.todo.common.cancel': 'Cancel',
    'renderer.todo.common.delete': 'Delete',
    'renderer.todo.common.edit': 'Edit',
    'renderer.todo.common.close': 'Close',
    'renderer.todo.common.more': 'More',
    'renderer.todo.common.expand': 'Expand',
    'renderer.todo.common.restore': 'Restore',

    // ========== 状态 / 触发类型 ==========
    'status.enabled': 'Enabled',
    'status.disabled': 'Disabled',
    'card.type.scheduled.label': 'Scheduled',
    'card.type.cron.label': 'Recurring',
    'card.type.event.label': 'Event-triggered',
    'card.type.manual.label': 'Manual',
    'trigger.summary.manual': 'Manual trigger',
    'trigger.summary.scheduled': 'Scheduled',
    'trigger.summary.cron': 'Recurring',
    'trigger.summary.unknown': 'Unknown',

    // ========== 日期时间 ==========
    'date.month.1': 'Jan',
    'date.month.2': 'Feb',
    'date.month.3': 'Mar',
    'date.month.4': 'Apr',
    'date.month.5': 'May',
    'date.month.6': 'Jun',
    'date.month.7': 'Jul',
    'date.month.8': 'Aug',
    'date.month.9': 'Sep',
    'date.month.10': 'Oct',
    'date.month.11': 'Nov',
    'date.month.12': 'Dec',
    'date.dow.0': 'Sun',
    'date.dow.1': 'Mon',
    'date.dow.2': 'Tue',
    'date.dow.3': 'Wed',
    'date.dow.4': 'Thu',
    'date.dow.5': 'Fri',
    'date.dow.6': 'Sat',
    'date.format.monthDayTime': '${monthName} ${day}, ${time}',
    'date.format.monthYear': '${monthName} ${year}',
    'date.format.fullTime': '${monthName} ${day}, ${year} ${time}',

    // ========== Renderer：主界面 ==========
    'renderer.todo.subtitle': 'Let your Agent run tasks on schedule and handle repetitive work for you',
    'renderer.todo.quickAdd': 'Quick Create',
    'renderer.todo.quickAddPromptText': 'Describe what you want to automate',
    'renderer.todo.templatesTitle': 'Get started with these common tasks',
    'renderer.todo.createdTitle': 'Your automation tasks',
    'renderer.todo.empty': 'No automation tasks yet',
    'renderer.todo.emptyHint': 'Pick a template above to get started',

    // ========== Renderer：卡片 ==========
    'renderer.todo.card.toggle.disableHint': 'Enabled, click to disable',
    'renderer.todo.card.toggle.enableHint': 'Disabled, click to enable',

    // ========== Renderer：详情 ==========
    'renderer.todo.detail.contentTitle': 'Content',
    'renderer.todo.detail.attrsTitle': 'Attributes',
    'renderer.todo.detail.attr.status': 'Status',
    'renderer.todo.detail.attr.triggerType': 'Trigger',
    'renderer.todo.detail.attr.cronExpression': 'Cron expression',
    'renderer.todo.detail.attr.eventSource': 'Event source',
    'renderer.todo.detail.attr.eventName': 'Event name',
    'renderer.todo.detail.attr.deliverTarget': 'Delivery target',
    'renderer.todo.detail.attr.workspace': 'Workspace',
    'renderer.todo.detail.attr.model': 'Model',
    'renderer.todo.detail.attr.createdAt': 'Created at',
    'renderer.todo.detail.attr.updatedAt': 'Updated at',
    'renderer.todo.detail.attr.lastTriggered': 'Last triggered',
    'renderer.todo.detail.attr.disabledAt': 'Disabled at',
    'renderer.todo.detail.executeNow': 'Run Now',

    // ========== Renderer：编辑表单 ==========
    'renderer.todo.edit.newTitle': 'New Task',
    'renderer.todo.edit.editTitle': 'Edit Task',
    'renderer.todo.edit.labelTitle': 'Title',
    'renderer.todo.edit.placeholderTitle': 'Task title',
    'renderer.todo.edit.labelContent': 'Content',
    'renderer.todo.edit.placeholderContent': 'Detailed task instructions to send to the Agent...',
    'renderer.todo.edit.labelStatus': 'Status',
    'renderer.todo.edit.labelTriggerType': 'Trigger type',
    'renderer.todo.edit.triggerType.scheduled': 'Scheduled (one-time)',
    'renderer.todo.edit.triggerType.cron': 'Recurring (Cron)',
    'renderer.todo.edit.triggerType.event': 'Event-triggered',
    'renderer.todo.edit.labelWorkspace': 'Workspace',
    'renderer.todo.edit.labelModel': 'Model',
    'renderer.todo.edit.labelDeliver': 'Deliver to',
    'renderer.todo.edit.deliverDefault': 'Default',
    'renderer.todo.edit.deliverHint': 'Task replies will be delivered to the selected channel automatically',
    'renderer.todo.edit.saving': 'Saving...',
    'renderer.todo.edit.retry': 'Retry',

    // ========== Renderer: model picker ==========
    'renderer.todo.model.globalDefault': 'Follow global default model',
    'renderer.todo.model.currentDefault': 'Current default: ${alias}',
    'renderer.todo.model.noDefault': 'No default model configured',
    'renderer.todo.model.unavailable': 'Model unavailable (saved selection retained)',
    'renderer.todo.model.selectTitle': 'Select model',
    'renderer.todo.model.reasoningTitle': 'Reasoning effort',
    'renderer.todo.model.search': 'Search models',
    'renderer.todo.model.back': 'Back to models',
    'renderer.todo.model.noResults': 'No matching models',
    'renderer.todo.model.vision': 'Vision',
    'renderer.todo.model.reasoning.default': 'Model default',
    'renderer.todo.model.reasoning.none': 'None',
    'renderer.todo.model.reasoning.low': 'Low',
    'renderer.todo.model.reasoning.medium': 'Medium',
    'renderer.todo.model.reasoning.high': 'High',
    'renderer.todo.model.reasoning.max': 'Max',
    'renderer.todo.model.hint': 'Choose a model, then select a reasoning level to confirm',

    // ========== Renderer：工作空间 ==========
    'renderer.todo.workspace.default': 'Default workspace',
    'renderer.todo.workspace.isolatedName': 'Task-isolated workspace',
    'renderer.todo.workspace.isolated': 'Use a task-isolated workspace',
    'renderer.todo.workspace.recent': 'Recent workspaces',
    'renderer.todo.workspace.other': 'Other location...',
    'renderer.todo.workspace.hintDefault': 'Tasks run in the current global workspace',
    'renderer.todo.workspace.hintIsolated': 'Each task uses its own isolated workspace in the OpenDesk data directory',

    // ========== Renderer：投递目标 ==========
    'renderer.todo.deliver.noContacts': ' (no contacts yet; message this channel first)',
    'renderer.todo.deliver.groupHint': 'group',

    // ========== Renderer：日期时间选择器 ==========
    'renderer.todo.datetime.triggerTime': 'Trigger time',
    'renderer.todo.datetime.time': 'Time',
    'renderer.todo.datetime.today': 'Today',
    'renderer.todo.datetime.confirm': 'OK',
    'renderer.todo.datetime.placeholder': 'Click to pick a date and time',
    'renderer.todo.datetime.weekday.1': 'Mon',
    'renderer.todo.datetime.weekday.2': 'Tue',
    'renderer.todo.datetime.weekday.3': 'Wed',
    'renderer.todo.datetime.weekday.4': 'Thu',
    'renderer.todo.datetime.weekday.5': 'Fri',
    'renderer.todo.datetime.weekday.6': 'Sat',
    'renderer.todo.datetime.weekday.7': 'Sun',

    // ========== Renderer：Cron 构建器 ==========
    'renderer.todo.cron.repeatFrequency': 'Repeat frequency',
    'renderer.todo.cron.mode.daily': 'Daily',
    'renderer.todo.cron.mode.weekly': 'Weekly on selected days',
    'renderer.todo.cron.mode.monthly': 'Monthly on a selected day',
    'renderer.todo.cron.mode.custom': 'Custom cron expression',
    'renderer.todo.cron.selectDays': 'Select days',
    'renderer.todo.cron.executeTime': 'Execution time',
    'renderer.todo.cron.domOption': 'Day ${day}',
    'renderer.todo.cron.expressionLabel': 'Cron expression',
    'renderer.todo.cron.customPlaceholder': 'e.g. 0 9 * * 1-5 (9 AM on weekdays, local time)',
    'renderer.todo.cron.helpText': 'What is a cron expression?',
    'renderer.todo.cron.previewEmpty': 'Enter a cron expression',
    'renderer.todo.cron.previewInvalid':
        'Invalid format: a cron expression needs 5 fields (minute hour day month weekday)',
    'renderer.todo.cron.desc.everyDow': 'Every ${days}',
    'renderer.todo.cron.desc.dowRaw': 'weekday (${dow})',
    'renderer.todo.cron.desc.monthlyDom': 'day ${day} of month',
    'renderer.todo.cron.desc.month': '${month}',
    'renderer.todo.cron.desc.hourOnly': 'hour ${hour}',
    'renderer.todo.cron.desc.minuteOnly': 'minute ${minute} of every hour',
    'renderer.todo.cron.desc.everyMinute': 'every minute',

    // ========== Renderer：事件选择器 ==========
    'renderer.todo.event.bundleLabel': 'Event source app',
    'renderer.todo.event.selectBundle': 'Select an app...',
    'renderer.todo.event.nameLabel': 'Event name',
    'renderer.todo.event.selectBundleFirst': 'Select an app first...',
    'renderer.todo.event.noEvents': 'This app has no registered events',
    'renderer.todo.event.selectEvent': 'Select an event...',

    // ========== Renderer：删除确认 / 立即执行 ==========
    'renderer.todo.delete.title': 'Delete Task',
    'renderer.todo.delete.message': 'Delete task "<b>${title}</b>"? This cannot be undone.',
    'renderer.todo.execute.triggering': 'Triggering...',
    'renderer.todo.execute.triggered': 'Triggered',

    // ========== 工具卡片（GUI / CLI 渲染） ==========
    'tool.getCurrentTime.name': 'Get Current Time',
    'tool.getCurrentTime.labelUtc': 'UTC time',
    'tool.getCurrentTime.labelLocal': 'Local time',
    'tool.getCurrentTime.labelTimezone': 'Timezone',
    'tool.getCurrentTime.labelTimestamp': 'Timestamp',
    'tool.todoWrite.cardTitle.create': 'Plan tasks',
    'tool.todoWrite.cardTitle.update': 'Update task plan',
    'tool.todoWrite.cardDisabled': 'Task plan disabled',
    'tool.todoWrite.itemsCount': '${count} items',
    'tool.todoWrite.cliSummary': '${total} tasks',
    'tool.todoWrite.cliEnabled': '${count} enabled',
    'tool.todoWrite.cliDisabled': '${count} disabled',
    'tool.todoWrite.cliAllCompleted': 'All todos completed!',
    'tool.card.add': 'Add automation task',
    'tool.card.update': 'Update automation task',
    'tool.card.success': 'Success',
    'tool.card.successWithId': 'Success (ID: ${id}...)',
    'tool.cli.label.title': 'Title: ',
    'tool.cli.label.content': 'Content: ',
    'tool.cli.label.trigger': 'Trigger: ',
    'tool.cli.add.successWithId': 'Todo added, ID: ',
    'tool.cli.add.deliveredTo': 'Delivered to: ',
    'tool.cli.add.success': 'Todo added!',
    'tool.cli.add.cardTitle': 'Add Global Todo',
    'tool.cli.update.field.title': 'Title',
    'tool.cli.update.field.content': 'Content',
    'tool.cli.update.field.enabled': 'Enabled state',
    'tool.cli.update.field.priority': 'Priority',
    'tool.cli.update.field.category': 'Category',
    'tool.cli.update.field.trigger': 'Trigger',
    'tool.cli.update.field.removeTrigger': 'Remove trigger',
    'tool.cli.update.updated': 'Updated: ',
    'tool.cli.update.success': 'Todo updated!',
    'tool.cli.update.cardTitle': 'Update Global Todo',
    'tool.cli.list.loading': 'Loading...',
    'tool.cli.list.empty': 'No global todos',
    'tool.cli.list.found': 'Found ${count} global todos:',
    'tool.cli.list.more': '... and ${count} more',
    'tool.cli.list.success': 'Todo list fetched',
    'tool.cli.list.cardTitle': 'Global Todo List',
    'tool.cli.delete.success': 'Todo deleted!',
    'tool.cli.delete.cardTitle': 'Delete Global Todo',
    'tool.cli.events.cardTitle': 'Fetch App Event List',
    'tool.deliverTargets.empty': 'No message channels available. Connect a channel plugin first.',
    'tool.deliverTargets.online': 'online',
    'tool.deliverTargets.offline': 'offline',
    'tool.deliverTargets.noContacts': 'No contacts yet; message this channel first.',
    'tool.deliverTargets.group': 'group chat',
    'tool.deliverTargets.private': 'direct chat',
    'tool.events.errorNoRegistry': 'Error: ApplicationRegistry not found; unable to list available events',

    // ========== 应用事件描述（GUI 事件选择器 + getSupportedEvents 工具） ==========
    'appEvent.globalTodosUpdated': 'Global todo list updated; fired when a todo is added, deleted or updated',
    'appEvent.taskTodosUpdated':
        'Task-level todos updated; fired when the Agent creates, updates or clears a task plan via TodoWrite. ' +
        'Args: { taskId, todos }, where todos is the latest task-level todo list',

    // ========== 工具校验错误 ==========
    'error.workspaceEmpty': 'workspace cannot be empty; omit the field if no workspace is needed',
    'error.workspaceNotAbsolute': 'workspace must be an absolute path, got: "${workspace}"',
    'error.triggerInvalid':
        'Invalid trigger format: ${message}. The trigger should be an object, e.g.: {"type": "scheduled", "triggerAt": "2026-03-01T01:00:00Z"}',
    'error.triggerAtMustUtc':
        'The triggerAt of a scheduled trigger must be a UTC time (ending with Z), got: "${triggerAt}". ' +
        'Use the getCurrentTime tool to get the current UTC time and compute the target time from it. ' +
        'For example: local time 2026-03-01 09:00 (UTC+8) should be converted to "2026-03-01T01:00:00Z"',
    'error.triggerAtInvalidDate':
        'Invalid date format: "${triggerAt}". Use ISO 8601 UTC format, e.g. "2026-03-01T01:00:00Z"',

    // ========== Application assistant & triggered tasks ==========
    'agent.instruct':
        'You are the automation assistant. You help the user view and manage automation tasks. This page shows all automation tasks (scheduled, recurring and event-triggered). You can manage global todos with tools such as addGlobalTodo / updateGlobalTodo / deleteGlobalTodo / listGlobalTodos.',
    'trigger.message.template':
        '\nPlease execute the following global todo:\n\n- Todo ID: ${todoId}\n- Todo title: ${todoTitle}\n- Trigger type: ${todoTrigger}\n\nTodo content\n---\n\n${todoContent}\n\nNotes\n---\n1. This message was created automatically by the todo manager. Focus your reply on completing the task specified by the user in the todo;\n2. All todo information has already been provided to you. Do not try to fetch more details about the todo, and you do **not** need to mark it as completed;\n3. If a recurring todo cannot be completed successfully, review its past execution history. If it has failed too many times, remind the user to cancel it;\n',
    'trigger.info.event': '[event] Event-driven task, auto-triggered by ${bundle}:${event} ',
    'trigger.info.scheduled': '[scheduled] One-shot task, runs once ',
    'trigger.info.cron': '[cron] Recurring task, fires at ${cron} ',

    // ========== Cron 描述（主进程 describeCron 注入文案，dowNames 为裸名称） ==========
    'cron.desc.dowNames.0': 'Sun',
    'cron.desc.dowNames.1': 'Mon',
    'cron.desc.dowNames.2': 'Tue',
    'cron.desc.dowNames.3': 'Wed',
    'cron.desc.dowNames.4': 'Thu',
    'cron.desc.dowNames.5': 'Fri',
    'cron.desc.dowNames.6': 'Sat',
    'cron.desc.everyDow': 'Every ${day}',
    'cron.desc.dow': '${day}',
    'cron.desc.monthlyDom': 'day ${day} of month',
    'cron.desc.month': '${month}',
    'cron.desc.hourOnly': 'hour ${hour}',
    'cron.desc.minuteOnly': 'minute ${minute} of every hour',
    'cron.desc.everyMinute': 'every minute',

    // ========== 模板 ==========
    'template.tpl-interview-prep.title': 'Interview Prep Reminder',
    'template.tpl-interview-prep.description':
        'Remind you to review LLM interview topics every 2 hours on weekdays, with 3 mock questions',
    'template.tpl-interview-prep.content':
        'Please generate 3 LLM-related interview questions covering Transformer architecture, training techniques and inference optimization, and provide key reference answers.',
    'template.tpl-meeting-prep.title': 'Meeting Preparation',
    'template.tpl-meeting-prep.description':
        'Organize meeting topics, goals, open questions and related materials ahead of time',
    'template.tpl-meeting-prep.content':
        'Please help me prepare materials for the upcoming meeting. List the agenda, the goal of each topic, questions to confirm in advance, and any related reference materials.',
    'template.tpl-health-checkup.title': 'Checkup Appointment Reminder',
    'template.tpl-health-checkup.description':
        'Remind you to book your annual checkup at the specified time and confirm available slots',
    'template.tpl-health-checkup.content':
        'Please remind me to book my annual checkup. Summarize pre-checkup precautions (e.g. fasting, clothing) and list the recommended key examinations.',
    'template.tpl-daily-ai-news.title': 'Daily AI News',
    'template.tpl-daily-ai-news.description':
        "Follow the day's key AI developments in coding and embodied intelligence, with 3-5 noteworthy picks",
    'template.tpl-daily-ai-news.content':
        "Please search and summarize today's latest AI developments, focusing on AI coding and embodied intelligence. Pick 3-5 of the most noteworthy news items, each with title, source, core summary and industry impact analysis.",
    'template.tpl-daily-english.title': '5 English Words a Day',
    'template.tpl-daily-english.description':
        'Recommend 5 practical high-frequency English words daily, with definitions, phonetics, examples and memory tips',
    'template.tpl-daily-english.content':
        'Please recommend 5 practical high-frequency English words. For each word include: definition, phonetics, 2 example sentences, and one memory tip. Intermediate to advanced level.',
    'template.tpl-weekly-report.title': 'Weekly Work Report',
    'template.tpl-weekly-report.description':
        "Summarize PR and Issue progress every Friday, with key updates and next week's plan",
    'template.tpl-weekly-report.content':
        "Please generate this week's work report. Summarize the main work completed, key progress and problems encountered this week, and list next week's plan and priorities. Format it in clear sections, suitable for sharing with the team.",
    'template.tpl-daily-question.title': 'A "Why" a Day',
    'template.tpl-daily-question.description':
        'Ask one interesting question a day for you to ponder first; light tone, answers within 200-300 words',
    'template.tpl-daily-question.content':
        'Please raise an interesting "why" question (science, daily life, history, etc.), let me think first, then give an answer within 200-300 words. Keep the tone light and fun, suitable for casual reading.',
    'template.tpl-bedtime-story.title': 'Daily Bedtime Story',
    'template.tpl-bedtime-story.description': 'Generate a warm, fun story readable in 3-5 minutes with a complete plot',
    'template.tpl-bedtime-story.content':
        'Please create an original, warm and fun bedtime story for kids aged 4-8. Requirements: readable in about 3-5 minutes, complete and positive plot, containing a small lesson or inspiration. Keep the language simple and vivid, suitable for parents to read aloud.',
    'template.tpl-movie-recommend.title': 'Classic Movie Recommendation',
    'template.tpl-movie-recommend.description':
        'Recommend a classic movie with a brief plot and why it is worth watching, from anywhere in the world',
    'template.tpl-movie-recommend.content':
        'Please recommend a classic movie. Briefly introduce the plot (no key spoilers), director and main actors, explain why it is recommended and good viewing scenarios. Any country or era; pick a different genre each time.',
    'template.tpl-parent-reminder.title': 'Call Parents Reminder',
    'template.tpl-parent-reminder.description':
        'Remind you to call or message your family every Sunday at 10:00 and check in with a quick greeting',
    'template.tpl-parent-reminder.content':
        'Today is a great day to reach out to family! Help me come up with warm topics and greetings: caring about their health, sharing recent life updates, or discussing interesting news. Also suggest practical ways I could help them.',
    'template.tpl-history-today.title': 'On This Day in History',
    'template.tpl-history-today.description':
        'Pick a random "on this day" event from tech, literature, film and beyond, told in 200-300 words',
    'template.tpl-history-today.content':
        'Please tell me about one interesting or significant event that happened on this day in history. Pick randomly from technology, literature, film, music and other fields, and narrate the story and its impact vividly in 200-300 words.',
    'template.tpl-new-email-summary.title': 'Smart Email Summary',
    'template.tpl-new-email-summary.description':
        'Automatically summarize incoming emails with priority and action items',
    'template.tpl-new-email-summary.content':
        "Please summarize the newly received email intelligently. Extract the core content, the sender's intent, items requiring reply or action, and suggest a priority. Highlight any deadlines or appointment information.",
    'template.tpl-wallpaper-gen.title': 'Cute Pet Phone Wallpaper',
    'template.tpl-wallpaper-gen.description':
        'Pick from 7 styles at random and get a 9:16 ultra-HD pet phone wallpaper',
    'template.tpl-wallpaper-gen.content':
        'Please generate a cute pet phone wallpaper. Randomly pick one of these styles: watercolor, flat illustration, pixel art, Japanese manga, fluffy realism, low-poly 3D, minimalist line art. The wallpaper should be 9:16, warm and adorable, suitable as a phone lock screen or desktop background.'
};
