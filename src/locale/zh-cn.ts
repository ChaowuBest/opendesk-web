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
    // App
    'app.name': 'OpenDesk',
    'app.description': 'AI 工作站',

    // Banner
    'banner.workspace': '当前工作空间为: ',

    // Headless
    'headless.action.read': '读取',
    'headless.action.write': '编辑',
    'headless.action.execute': '执行',
    'headless.action.access': '访问',
    'headless.resource.file': '文件',
    'headless.resource.network': '网络',
    'headless.resource.skill': '技能',
    'headless.mode.label': '模式',
    'headless.permission.request': '工具请求',
    'headless.permission.denied': 'headless 模式下无法交互确认，已自动拒绝',
    'headless.task.complete': '任务完成',
    'headless.execution.time': '执行时间: ',
    'headless.token.usage': 'Token 消耗: ',
    'headless.user': '用户',
    'headless.assistant': '助手',
    'headless.thinking': '思考',
    'headless.error': '错误',

    // Entry - QuickPass
    'quickpass.import.success': '口令导入成功',
    'quickpass.import.success.detail': '已成功导入口令「',
    'quickpass.import.range.basic': '基础设置（不含应用配置）',
    'quickpass.import.range.all': '全部设置（含应用配置）',
    'quickpass.import.fail': '口令导入失败',
    'quickpass.import.scope': '导入范围：',
    'quickpass.close': '确定',

    // Entry - Model not configured
    'model.not.configured': '模型未配置',
    'model.not.configured.hint': '请先配置模型才能使用 OpenDesk',
    'model.configure.usage': '使用方法：',
    'model.configure.step1': '1. 输入 /config 打开配置菜单',
    'model.configure.step2': '2. 选择"模型服务商配置"并添加一个模型服务商',
    'model.configure.step3': '3. 选择"模型配置"并添加一个模型',
    'model.configure.step4': '4. 选择 "默认模型配置", 并选择你要使用的模型',
    'model.configure.step5': '5. (可选) 选择 "文件扫描配置", 添加文件搜索目录',
    'model.configure.after': '然后? 你可以休息了，让我开始工作吧!',

    // Entry - Exit hint
    'exit.hint.title': '提示',
    'exit.hint.message': '你可以输入 /exit 退出或者输入 /help 查看帮助',

    // Entry - Export
    'export.success': '导出成功',
    'export.success.detail': '会话已成功导出到：\n',

    // Entry - Memory
    'memory.operation.ignored': '操作被忽略',
    'memory.operation.in.progress': '当前有记忆',
    'memory.operation.in.progress.suffix': '操作正在进行中，请等待完成后再试。',
    'memory.add.label': '添加',
    'memory.search.label': '搜索',
    'memory.forget.label': '删除',
    'memory.list.label': '列出所有记忆',
    'memory.command.description':
        '记忆管理: /memory add [提示词], /memory search <查询内容>, /memory forget <描述>, /memory list',
    'memory.extracting': '正在后台提取记忆...',
    'memory.extracting.progress': '已提取 ',
    'memory.extracting.unit': ' 条',
    'memory.relevance': '相关度',

    // Commands - Common
    'common.cancel': '取消',
    'common.confirm': '确定',
    'common.close': '关闭',
    'common.exit': '退出',
    'common.delete': '删除',
    'common.delete.all': '删除所有',
    'common.cover': '覆盖',
    'common.rebuild': '重建',
    'common.none': '无',

    // Plugin commands
    'plugin.install.success': '安装成功',
    'plugin.install.fail': '安装失败',
    'plugin.uninstall.success': '卸载成功',
    'plugin.uninstall.fail': '卸载失败',
    'plugin.enable.success': '启用成功',
    'plugin.enable.fail': '启用失败',
    'plugin.disable.success': '禁用成功',
    'plugin.disable.fail': '禁用失败',
    'plugin.usage.hint': '用法提示',

    // Commands - Confirm dialogs
    'confirm.exit.title': '确认退出',
    'confirm.exit.message': '确定要退出 OpenDesk 吗？',
    'confirm.delete.title': '确认删除',
    'confirm.delete.message': '确定要删除所有任务历史吗？此操作不可恢复。',

    // Commands - Bookmark
    'bookmark.add.fail': '添加书签失败',
    'bookmark.add.fail.no.task': '没有活跃的任务',
    'bookmark.add.fail.not.found': '未找到当前任务',
    'bookmark.add.fail.already.exists': '当前任务已在书签中',
    'bookmark.add.success': '添加书签成功',
    'bookmark.add.success.detail': '任务"',
    'bookmark.add.success.suffix': '"已添加到书签',
    'bookmark.remove.fail': '移除书签失败',
    'bookmark.remove.fail.no.task': '没有活跃的任务',
    'bookmark.remove.fail.not.found': '未找到当前任务',
    'bookmark.remove.fail.not.in': '当前任务不在书签中',
    'bookmark.remove.success': '移除书签成功',
    'bookmark.remove.success.detail': '任务"',
    'bookmark.remove.success.suffix': '"已从书签中移除',
    'bookmark.unnamed.task': '未命名任务',

    // Commands - Fork
    'fork.fail': 'Fork 失败',
    'fork.fail.no.task': '没有活跃的任务',
    'fork.fail.not.found': '未找到当前任务',
    'fork.success': 'Fork 成功',
    'fork.success.detail': '已切换到新的会话副本',

    // Commands - Compact
    'compact.title': '上下文压缩',
    'compact.success': '上下文已成功压缩。压缩效果将在下次对话时体现。',
    'compact.fail': '压缩失败',
    'compact.fail.detail': '上下文压缩过程中发生错误：',
    'compact.no.task': '没有活跃的任务',
    'compact.task.not.found': '未找到当前任务',

    // Commands - Debug
    'debug.current.task.id': '当前任务ID',
    'debug.no.active.task': '当前没有活跃任务',
    'debug.hint': '提示',

    // Commands - Memory
    'memory.extract.complete': '记忆提取完成',
    'memory.extract.complete.detail': '耗时 ',
    'memory.extract.complete.seconds': ' 秒，共提取 ',
    'memory.extract.complete.unit': ' 条记忆。',
    'memory.extract.no.new': '记忆提取完成',
    'memory.extract.no.new.detail': '耗时 ',
    'memory.extract.no.new.seconds': ' 秒，未发现需要保存的新记忆。',
    'memory.extract.fail': '记忆提取失败',
    'memory.extract.fail.detail': '操作出错：',
    'memory.searching': '正在搜索相关记忆...',
    'memory.search.no.result': '记忆搜索',
    'memory.search.no.result.detail': '未找到与「',
    'memory.search.no.result.suffix': '」相关的记忆',
    'memory.search.complete': '记忆搜索完成',
    'memory.search.complete.detail': '找到 ',
    'memory.search.complete.results': ' 条相关记忆，将前 ',
    'memory.search.complete.top': ' 条注入对话上下文：\n',
    'memory.search.fail': '记忆搜索失败',
    'memory.search.fail.detail': '操作出错：',
    'memory.searching.deleting': '正在搜索并删除匹配的记忆...',
    'memory.delete.complete': '记忆删除完成',
    'memory.delete.complete.detail': '已删除 ',
    'memory.delete.complete.unit': ' 条记忆：\n',
    'memory.delete.no.match': '记忆删除',
    'memory.delete.no.match.detail': '未找到与「',
    'memory.delete.no.match.suffix': '」匹配的记忆',
    'memory.delete.fail': '记忆删除失败',
    'memory.delete.fail.detail': '操作出错：',

    // Commands - Mode
    'mode.invalid': '无效的模式',
    'mode.not.found': '未找到模式 "',
    'mode.available': '可用模式: ',

    // Commands - Manual
    'manual.open.fail': '打开失败',
    'manual.open.fail.detail': '无法打开手册: ',
    'manual.file.not.found': '文件未找到',
    'manual.file.not.found.detail': '未找到 manual.html 文件',

    // Commands - Import
    'import.fail': '导入失败',
    'import.usage': '用法：/import task <json文件路径>\n例如：/import task ./my-task.json',
    'import.no.path': '请指定要导入的 JSON 文件路径。\n用法：/import task <json文件路径>',
    'import.file.not.exist': '文件不存在：',
    'import.parse.fail': '无法解析或加载任务 JSON：',

    // Commands - Export
    'export.title': '导出',
    'export.usage': '用法：/export html <文件名> 或 /export json <文件名.json> 或 /export skill <技能名> <路径.zip>',
    'export.success.json': '导出成功',
    'export.success.json.detail': '任务已导出为 JSON：\n',
    'export.file.exists': '文件已存在',
    'export.file.exists.detail': '文件 ',
    'export.file.exists.suffix': ' 已存在。是否覆盖？',
    'export.skill.usage': '用法：/export skill <技能名> <路径.zip>\n例如：/export skill my-skill ./my-skill.zip',
    'export.skill.not.found': '导出失败',
    'export.skill.not.found.detail': '未找到技能 "',
    'export.skill.not.found.suffix': '"\n已安装的技能：',
    'export.skill.dir.not.exist': '导出失败',
    'export.skill.dir.not.exist.detail': '技能目录不存在：',
    'export.skill.success': '导出成功',
    'export.skill.success.detail': '技能 "',
    'export.skill.success.suffix': '" 已导出到：\n',
    'export.skill.fail': '导出失败',
    'export.skill.fail.detail': '导出技能失败：',

    // Commands - Recover
    'recover.usage.title': '用法提示',
    'recover.usage.message': '可用的子命令:\n\n  /recover tasks  - 从任务文件重建任务列表',
    'recover.task.title': '重建任务列表',
    'recover.task.message':
        '此操作将基于磁盘上扫描到的所有任务文件重建任务列表。\n' +
        '当前内存中的任务列表将被覆盖。\n\n' +
        '确定要继续吗？',
    'recover.task.scanning': '正在扫描任务文件并重建任务列表...',

    // Commands - Tools subcommand
    'tools.description': '工具管理与调试',
    'tools.list.description': '列出所有可用工具',
    'tools.info.description': '显示工具详细信息',
    'tools.call.description': '调用工具并打印结果',
    'tools.not.found': '未找到工具: ',
    'tools.execution.status': '执行完成',
    'tools.execution.state': '状态: ',
    'tools.execution.result': '结果:',
    'tools.execution.result.object': '结果对象:',
    'tools.param.parse.fail': '参数解析失败，请传入合法的 JSON 字符串',

    // Commands - Rename
    'rename.no.task': '没有活跃的任务',
    'rename.task.not.found': '未找到当前任务',
    'rename.usage': '请提供新的任务名称，用法：/rename <新名称>',
    'rename.success': '任务已重命名为: ',

    // Commands - Stop/Cancel
    'cancel.description': '撤销消息队列中的所有待发送消息',

    // Commands - Exit/Quit
    'exit.description': '退出 OpenDesk',
    'quit.description': '退出 OpenDesk',

    // Commands - Clear
    'clear.description': '删除所有任务历史',

    // Commands - Bookmark
    'bookmark.description': '管理任务书签，用法：/bookmark add|list|remove',
    'bookmark.add.description': '将当前任务添加到书签',
    'bookmark.list.description': '列出所有书签任务',
    'bookmark.remove.description': '移除当前任务的书签',

    // Commands - New
    'new.description': '启动新任务并发送消息',

    // Commands - Fork
    'fork.description': '复制当前会话并切换到新会话',

    // Commands - Import
    'import.description': '从 JSON 文件导入任务，用法：/import task <json文件路径>',
    'import.task.description': '导入任务 JSON 文件',

    // Commands - Export
    'export.description': '导出会话或技能：/export html|json <文件名>；/export skill <技能名> <路径.zip>',
    'export.html.description': '导出为 HTML 文件',
    'export.json.description': '导出为 JSON（可与 /import 兼容）',
    'export.skill.description': '将技能导出为 zip 文件',

    // Commands - Log
    'log.description': '显示日志面板，用法: /log [off|last|all]',
    'log.off.description': '不显示',
    'log.last.description': '最后10条',
    'log.all.description': '全部',

    // Commands - Mode
    'mode.description': '查看或切换运行模式',

    // Commands - Model
    'model.description': '查看或切换当前模型',
    'model.current': '当前模型',
    'model.available': '可用模型',
    'model.not.found': '模型不存在: ',
    'model.switched': '已切换到模型: ',
    'model.no.models': '没有配置任何模型',
    'model.usage': '用法: /model <别名>',

    // Commands - Help
    'help.description': '显示快捷键与指令帮助',

    // Commands - Manual
    'manual.description': '打开使用手册',

    // Commands - Notification
    'notification.description': '打开通知中心，查看所有通知',

    // Commands - Dashboard
    'dashboard.description': '打开全屏仪表盘，/dashboard bar 可切换底栏状态条',
    'dashboard.bar.description': '显示/隐藏底栏状态条',

    // Commands - BTW
    'btw.description': '快速提问 (不使用当前上下文和工具)',
    'btw.usage': '用法: /btw <你的问题>',
    'btw.thinking': '正在思考...',
    'btw.no.reply': '(无回复)',
    'btw.request.fail': '请求失败: ',

    // Commands - Quickpass
    'quickpass.description': '导出快捷口令，用法：/quickpass config base|all',
    'quickpass.config.base.description': '导出基础设置口令（不含应用配置）',
    'quickpass.config.all.description': '导出全部设置口令',
    'quickpass.base.title': '基础设置口令',
    'quickpass.base.message': '请复制以下口令并发送给对方：\n\n',
    'quickpass.base.fail': '导出失败',
    'quickpass.base.fail.detail': '导出基础设置口令失败：',
    'quickpass.all.title': '全部设置口令',
    'quickpass.all.message': '请复制以下口令并发送给对方：\n\n',
    'quickpass.all.fail': '导出失败',
    'quickpass.all.fail.detail': '导出全部设置口令失败：',

    // Commands - Recover
    'recover.description': '恢复数据（子命令: tasks）',
    'recover.tasks.description': '从任务文件重建任务列表',

    // Commands - Compact
    'compact.description': '手动压缩当前任务的上下文',
    'context.description': '显示当前上下文诊断',
    'context.title': '上下文诊断',
    'context.no.task': '当前没有活跃任务',
    'context.task.not.found': '未找到当前任务',
    'context.fail': '无法生成上下文诊断',

    // Commands - Debug
    'debug.description': '调试命令，用法: /debug log [on|off] | /debug taskid',
    'debug.log.description': '调试日志开关 (on|off)',
    'debug.taskid.description': '显示当前任务ID',
    'debug.log.on.description': '开启调试日志',
    'debug.log.off.description': '关闭调试日志',

    // Commands - Reason
    'reason.description': '调整思考强度，用法: /reason effort [default|none|low|medium|high] | display [full|partial]',
    'reason.effort.description': '设置推理深度',
    'reason.display.description': '设置思考显示模式',
    'reason.display.full': '完整显示',
    'reason.display.partial': '尾部预览（末 10 行）',
    'reason.current.title': '当前思考配置',
    'reason.current.displaymode': '显示模式',
    'reason.current.model': '当前模型',
    'reason.current.depth': '推理深度',
    'reason.usage.title': '用法',
    'reason.effort.set': '推理深度已更新',
    'reason.effort.set.message': '模型 ${alias} 推理深度已设置为: ${effort}',
    'reason.display.set': '显示模式已更新',
    'reason.display.set.message': '思考显示模式已设置为: ${mode}',
    'reason.display.already': '显示模式',
    'reason.display.already.message': '思考显示模式已是: ${mode}',
    'reason.error.no.model': '未设置默认模型。请先在设置中配置模型。',
    'reason.error.invalid.effort': '无效的推理深度: ${value}\n有效值: default, none, low, medium, high',
    'reason.error.invalid.display': '无效的显示模式: ${value}\n有效值: full, partial',
    'reason.error.specify.effort': '请指定推理深度: /reason effort [default|none|low|medium|high]',
    'reason.error.specify.display': '请指定显示模式: /reason display [full|partial]',
    'reason.error.unknown': '未知子命令: ${subcmd}\n可用: effort, display',

    // Commands - Undo/Redo
    'undo.description': '撤销上一步操作',
    'undo.undomsg': '撤销上 ${count} 条消息',
    'undo.fail': '撤销失败',
    'undo.error.not.integer': '参数必须是整数，例如: /undo 2',
    'undo.error.count.zero': '撤销数量必须大于 0，当前输入: ${count}',
    'undo.error.no.session': '无活跃会话。请先开始对话。',
    'undo.error.task.notfound': '当前任务未找到。',
    'undo.error.no.messages': '当前会话中没有可撤销的消息。',
    'undo.partial': '部分撤销',
    'undo.error.partial': '请求撤销 ${requested} 条消息，但只有 ${actual} 条可用。已撤销 ${actual} 条消息。',
    'redo.description': '重做上一步撤销的操作',
    'redo.redomsg': '恢复上 ${count} 条撤销',
    'redo.fail': '重做失败',
    'redo.error.not.integer': '参数必须是整数，例如: /redo 2',
    'redo.error.count.zero': '重做次数必须大于 0，当前输入: ${count}',
    'redo.error.no.session': '无活跃会话。请先开始对话。',
    'redo.error.task.notfound': '当前任务未找到。',
    'redo.error.no.records': '没有可恢复的撤销记录。',
    'redo.partial': '部分重做',
    'redo.error.partial': '请求恢复 ${requested} 次，但只有 ${actual} 次可用。已恢复 ${actual} 次。',

    // Commands - Switch
    'switch.description': '切换任务，用法: /switch <task_id>',

    // Commands - Stop
    'stop.description': '停止当前任务',

    // Commands - Upgrade
    'upgrade.description': '升级 OpenDesk CLI 到最新版本',

    // Plugin System / Channel
    'plugin.system': '插件系统',
    'message.channel': '消息渠道',
    'channel.ready': '已就绪',
    'channel.no.running': '当前没有运行中的消息渠道插件。',
    'channel.reload.success': '消息渠道已自动重新加载。',
    'channel.install.success': '插件安装成功: ${id}\n\n消息渠道已自动重新加载。',
    'channel.uninstall.success': '插件已卸载: ${id}\n\n消息渠道已自动重新加载。',
    'channel.enable.success': '插件已启用: ${id}\n\n消息渠道已自动重新加载。',
    'channel.disable.success': '插件已禁用: ${id}\n\n消息渠道已自动重新加载。',

    // Input StatusBar
    'input.statusbar.switchmode': '切换模式',
    'input.statusbar.help': '帮助',

    // Help Command
    'help.name': 'help',

    // File Manager
    'filemgr.scan.dir.not.configured': '文件扫描目录未配置',
    'filemgr.embedding.model.not.configured': '向量嵌入模型未配置',

    // DateTime
    'datetime.weekday.sun': '周日',
    'datetime.weekday.mon': '周一',
    'datetime.weekday.tue': '周二',
    'datetime.weekday.wed': '周三',
    'datetime.weekday.thu': '周四',
    'datetime.weekday.fri': '周五',
    'datetime.weekday.sat': '周六',

    // Channel Status
    'channel.status.connected': '已连接',
    'channel.status.ready': '就绪',
    'channel.status.error': '错误',

    // Channel Events
    'channel.event.connected': '消息插件已连接',
    'channel.event.disconnected': '消息插件已断开',
    'channel.event.message': '收到消息插件消息',
    'channel.event.error': '消息插件发生错误',

    // Config - Common
    'config.command.description': '打开系统设置',
    'config.main.title': '系统设置',
    'config.main.hint': 'Enter 进入  Esc 返回',
    'config.common.save': '🆗 保存',
    'config.common.delete': '🗑️  删除',
    'config.common.cancel': '↩  返回',
    'config.enter.select': 'Enter 选择',
    'config.esc.back': 'Esc 返回',

    // Config - Provider
    'config.provider.title': '模型服务商配置',
    'config.provider.title.hint': '管理 API 模型服务商',
    'config.provider.add': '+ 添加模型服务商',
    'config.provider.template.title': '选择模型服务商模板',
    'config.provider.template.custom': '✏️  自定义…',
    'config.provider.edit.title.add': '添加模型服务商',
    'config.provider.edit.title.edit': '编辑模型服务商',
    'config.provider.field.name': '名称',
    'config.provider.field.base_url': 'API 地址',
    'config.provider.field.api_key': 'API 密钥',
    'config.provider.field.no_proxy': '禁用代理',

    // Config - Model
    'config.model.title': '模型配置',
    'config.model.title.hint': '管理模型别名',
    'config.model.add': '+ 添加模型',
    'config.model.edit.title.add': '添加模型',
    'config.model.edit.title.edit': '编辑模型',
    'config.model.field.alias': '模型别名',
    'config.model.field.provider': '模型服务商',
    'config.model.field.model_name': '模型名称 (提供商侧)',
    'config.model.field.reasoning_effort': '推理模式',
    'config.model.field.context_length': '上下文长度 (留空自动估算)',
    'config.model.field.custom_headers': '自定义 Headers',
    'config.model.field.edit_headers': '编辑 Headers',
    'config.model.header.add': '+ 添加 Header',
    'config.model.header.add_title': '添加 Header',
    'config.model.header.edit': '编辑 Header',
    'config.model.header.key': 'Header 名称',
    'config.model.header.value': 'Header 值',
    'config.model.header.empty': '(空)',
    'config.model.warning.no.models': '尚未配置任何模型，请先通过 /config models 添加模型',

    // Config - Default Model
    'config.defaultmodel.title': '默认模型配置',
    'config.defaultmodel.title.hint': '选择各场景默认模型',
    'config.defaultmodel.field.default_model': '默认对话模型',
    'config.defaultmodel.field.embedding_model': '向量嵌入模型',
    'config.defaultmodel.field.reranker_model': '重排序模型',

    // Config - File Manager
    'config.filemgr.title': '文件扫描配置',
    'config.filemgr.title.hint': '管理文件扫描目录',
    'config.filemgr.add': '+ 添加新目录',
    'config.filemgr.empty': '暂无配置目录',
    'config.filemgr.input.prompt': '输入要扫描的目录路径（例: ~/Documents）:',
    'config.filemgr.error.not.exist': '路径不存在或无权限访问:',
    'config.filemgr.error.not.directory': '不是目录:',
    'config.filemgr.error.already.exists': '该目录已存在',
    'config.filemgr.delete': '[删除]',

    // Config - Language
    'config.language.title': '语言设置',
    'config.language.title.hint': '设置显示语言',
    'config.language.field.locale': '语言',
    'config.language.option.auto': '自动（跟随系统）',
    'config.language.option.zh-CN': '简体中文',
    'config.language.option.en-US': 'English',

    // File Manager Tools
    'filemgr.readFile.name': '读取文件',
    'filemgr.writeFile.name': '写入文件',
    'filemgr.writeFile.append': ' (追加)',
    'filemgr.editFile.name': '编辑文件',
    'filemgr.createFile.name': '创建文件',
    'filemgr.searchReplace.name': '搜索替换',
    'filemgr.applyPatch.name': '应用补丁',
    'filemgr.glob.name': '模式匹配',
    'filemgr.grep.name': '内容搜索',
    'filemgr.openInEditor': '编辑',

    // Task & Planning Tools
    'tools.getCurrentTime.name': '获取当前时间',
    'tools.listRecentTasks.name': '列出任务',
    'tools.getTaskHistory.name': '获取历史',
    'tools.askFromTask.name': '任务追问',
    'tools.createSubTask.name': '子任务',
    'tools.waitSubTask.name': '等待子任务',
    'tools.attachToSubTask.name': '追加消息到子任务',
    'tools.askUser.name': '询问用户',

    // Reasoning Effort Labels
    'reasoning.effort.default': '默认',
    'reasoning.effort.none': '无推理',
    'reasoning.effort.low': '简洁推理',
    'reasoning.effort.medium': '推理适中',
    'reasoning.effort.high': '推理深入',

    // Tool Call Status
    'toolcall.status.pending': '等待中',
    'toolcall.status.running': '执行中…',
    'toolcall.status.success': '完成',
    'toolcall.status.interrupted': '中断',
    'toolcall.status.error': '失败',

    // Task Running Hint
    'input.hint.running': '任务进行中，你仍然可以继续输入...',
    'input.hint.queue.single': '📨 待发送: ${preview} (输入 /cancel 撤销)',
    'input.hint.queue.multiple': '📨 ${count} 条消息待发送 (输入 /cancel 撤销)',
    'input.hint.shell.executing': '⏳ 正在执行: ${cmd}',

    // Reasoning View
    'reasoning.card.title': '思考',
    'reasoning.partial.hint': '…… (使用 /reason display full 来显示完整思考内容)',

    // Compact Boundary
    'compact.boundary.loading': '正在压缩上下文...',
    'compact.boundary.done': '上下文已压缩',

    // Internal Message
    'message.internal': '[内部消息]',

    // Permission
    'permission.action.read': '读取',
    'permission.action.write': '编辑',
    'permission.action.execute': '执行',
    'permission.action.access': '访问',
    'permission.resource.file': '文件',
    'permission.resource.network': '网络',
    'permission.resource.skill': '技能',
    'permission.option.allow': '本次允许',
    'permission.option.always.prefix': '始终允许 ${label} 的${typeAction}',
    'permission.option.always.type': '始终允许所有${typeAction}操作',
    'permission.option.deny': '拒绝',
    'permission.question': '${toolName} 请求${typeAction}，是否允许？',
    'permission.hint.cancel': 'Esc 取消',
    'permission.task.unnamed': '未命名任务',
    'permission.task.background': '⏳ 后台任务: ${name}',
    'permission.queue.remaining': '还有 ${count} 个权限请求等待确认',
    'permission.truncate.prefix': '始终允许 ',
    'permission.truncate.suffix': ' 的',

    // Shortcuts
    'shortcut.switch_mode': '模式切换',
    'shortcut.switch_model': '模型切换',
    'shortcut.endline': '回车换行',
    'shortcut.show_help': '打开帮助',
    'shortcut.clear_input': '删除输入内容',
    'shortcut.list_tasks': '显示任务列表',
    'shortcut.model.switched': '模型已切换为',
    'shortcut.model.none': '未配置任何模型',

    // Config - Shortcuts
    'config.shortcuts.title': '快捷键设置',
    'config.shortcuts.title.hint': '自定义终端快捷键',
    'config.shortcuts.press.enter': 'Enter 编辑',
    'config.shortcuts.waiting': '按下新的快捷键组合...',
    'config.shortcuts.captured': '已捕获',
    'config.shortcuts.confirm': 'Enter 保存  Esc 取消  D 恢复默认',
    'config.shortcuts.hint': '↑↓ 选择  Enter 编辑  D 恢复默认  Esc 返回',
    'config.shortcuts.saved': '快捷键已保存',
    'config.shortcuts.error.single_key.title': '快捷键无效',
    'config.shortcuts.error.single_key.message': '不允许使用单个按键作为快捷键，请使用组合键（如 Ctrl+A、Alt+B 等）。',

    // Help Overlay
    'help.tab.commands': '指令',
    'help.tab.skills': '技能',
    'help.tab.shortcuts': '快捷键',
    'help.tab.switch': '← → 切换',
    'help.no.commands': '暂无命令',
    'help.no.shortcuts': '暂无快捷键',
    'help.shortcuts.action': '功能',
    'help.shortcuts.key': '快捷键',
    'help.skills.loading': '加载中...',
    'help.skills.none': '暂无可用技能',
    'help.skills.manage': '使用 /skills 管理技能',

    // Shell
    'shell.cwd.changed': '📂 工作空间已切换: ${oldCwd} → ${newCwd}',
    'shell.no.output': '(无输出)',
    'shell.exec.failed': '执行失败: ${error}',

    // InlineResultPanel
    'inline.panel.scroll': 'Ctrl+↑/↓ 翻页',
    'inline.panel.close': 'Esc 关闭',

    // Search Tools
    'search.bing.name': '搜索 (Bing)',
    'search.duckduckgo.name': '搜索 (DuckDuckGo)',
    'search.brave.name': '搜索 (Brave)',
    'search.tavily.name': '搜索 (Tavily)',
    'search.bocha.name': '搜索 (博查)',
    'search.exa.name': '搜索 (Exa)',
    'search.arxiv.name': '论文搜索 (arXiv)',
    'search.webfetch.name': '网页获取',
    'search.kb.retrieve.name': '知识库检索',
    'search.kb.ask.name': '知识库问答',
    'search.email.name': '搜索邮件',
    'search.result.count': '${count} 条结果',
    'search.result.chars': '${count} 字符',
    'search.result.papers': '${count} 篇论文',

    // Unknown
    'unknown.source': '未知来源',

    // Settings Load Error
    'setting.load.error.title': '设置加载失败',
    'setting.load.error.ok': '确定'
};
