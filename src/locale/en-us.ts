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
    // App
    'app.name': 'OpenDesk',
    'app.description': 'AI Workstation',

    // Banner
    'banner.workspace': 'Current workspace: ',

    // Headless
    'headless.action.read': 'Read',
    'headless.action.write': 'Edit',
    'headless.action.execute': 'Execute',
    'headless.action.access': 'Access',
    'headless.resource.file': 'File',
    'headless.resource.network': 'Network',
    'headless.resource.skill': 'Skill',
    'headless.mode.label': 'Mode',
    'headless.permission.request': ' tool requests ',
    'headless.permission.denied': 'Cannot confirm in headless mode, automatically denied',
    'headless.task.complete': 'Task Complete',
    'headless.execution.time': 'Execution time: ',
    'headless.token.usage': 'Token usage: ',
    'headless.user': 'User',
    'headless.assistant': 'Assistant',
    'headless.thinking': 'Thinking',
    'headless.error': 'Error',

    // Entry - QuickPass
    'quickpass.import.success': 'Import Success',
    'quickpass.import.success.detail': 'Successfully imported quickpass 「',
    'quickpass.import.range.basic': 'Basic settings (excluding app config)',
    'quickpass.import.range.all': 'All settings (including app config)',
    'quickpass.import.fail': 'Import Failed',
    'quickpass.import.scope': 'Import scope: ',
    'quickpass.close': 'OK',

    // Entry - Model not configured
    'model.not.configured': 'Model Not Configured',
    'model.not.configured.hint': 'Please configure a model to use OpenDesk',
    'model.configure.usage': 'How to configure:',
    'model.configure.step1': '1. Enter /config to open the settings menu',
    'model.configure.step2': '2. Select "Model Provider Config" and add a provider',
    'model.configure.step3': '3. Select "Model Config" and add a model',
    'model.configure.step4': '4. Select "Default Model Config" and choose your model',
    'model.configure.step5': '5. (Optional) Select "File Scan Config" to add scan directories',
    'model.configure.after': 'Then? You can rest. Let me start working!',

    // Entry - Exit hint
    'exit.hint.title': 'Hint',
    'exit.hint.message': 'Enter /exit to quit or /help for help',

    // Entry - Export
    'export.success': 'Export Success',
    'export.success.detail': 'Session exported to:\n',

    // Entry - Memory
    'memory.operation.ignored': 'Operation Ignored',
    'memory.operation.in.progress': 'Memory ',
    'memory.operation.in.progress.suffix': ' operation in progress, please wait',
    'memory.add.label': 'Add',
    'memory.search.label': 'Search',
    'memory.forget.label': 'Delete',
    'memory.list.label': 'List All Memories',
    'memory.command.description':
        'Memory management: /memory add [prompt], /memory search <query>, /memory forget <description>, /memory list',
    'memory.extracting': 'Extracting memories in background...',
    'memory.extracting.progress': 'Extracted ',
    'memory.extracting.unit': ' items',
    'memory.relevance': 'Relevance',

    // Commands - Common
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.close': 'Close',
    'common.exit': 'Exit',
    'common.delete': 'Delete',
    'common.delete.all': 'Delete All',
    'common.cover': 'Cover',
    'common.rebuild': 'Rebuild',
    'common.none': 'None',

    // Plugin commands
    'plugin.install.success': 'Install Success',
    'plugin.install.fail': 'Install Failed',
    'plugin.uninstall.success': 'Uninstall Success',
    'plugin.uninstall.fail': 'Uninstall Failed',
    'plugin.enable.success': 'Enable Success',
    'plugin.enable.fail': 'Enable Failed',
    'plugin.disable.success': 'Disable Success',
    'plugin.disable.fail': 'Disable Failed',
    'plugin.usage.hint': 'Usage Hint',

    // Commands - Confirm dialogs
    'confirm.exit.title': 'Confirm Exit',
    'confirm.exit.message': 'Are you sure you want to exit OpenDesk?',
    'confirm.delete.title': 'Confirm Delete',
    'confirm.delete.message': 'Are you sure you want to delete all task history? This cannot be undone.',

    // Commands - Bookmark
    'bookmark.add.fail': 'Add Bookmark Failed',
    'bookmark.add.fail.no.task': 'No active task',
    'bookmark.add.fail.not.found': 'Current task not found',
    'bookmark.add.fail.already.exists': 'Task is already bookmarked',
    'bookmark.add.success': 'Add Bookmark Success',
    'bookmark.add.success.detail': 'Task "',
    'bookmark.add.success.suffix': '" added to bookmarks',
    'bookmark.remove.fail': 'Remove Bookmark Failed',
    'bookmark.remove.fail.no.task': 'No active task',
    'bookmark.remove.fail.not.found': 'Current task not found',
    'bookmark.remove.fail.not.in': 'Task is not in bookmarks',
    'bookmark.remove.success': 'Remove Bookmark Success',
    'bookmark.remove.success.detail': 'Task "',
    'bookmark.remove.success.suffix': '" removed from bookmarks',
    'bookmark.unnamed.task': 'Unnamed Task',

    // Commands - Fork
    'fork.fail': 'Fork Failed',
    'fork.fail.no.task': 'No active task',
    'fork.fail.not.found': 'Current task not found',
    'fork.success': 'Fork Success',
    'fork.success.detail': 'Switched to new session copy',

    // Commands - Compact
    'compact.title': 'Context Compression',
    'compact.success': 'Context compressed successfully. Effect will be reflected in next conversation.',
    'compact.fail': 'Compression Failed',
    'compact.fail.detail': 'Error during context compression: ',
    'compact.no.task': 'No active task',
    'compact.task.not.found': 'Current task not found',

    // Commands - Debug
    'debug.current.task.id': 'Current Task ID',
    'debug.no.active.task': 'No active task',
    'debug.hint': 'Hint',

    // Commands - Memory
    'memory.extract.complete': 'Memory Extraction Complete',
    'memory.extract.complete.detail': 'Took ',
    'memory.extract.complete.seconds': ' seconds, extracted ',
    'memory.extract.complete.unit': ' memories.',
    'memory.extract.no.new': 'Memory Extraction Complete',
    'memory.extract.no.new.detail': 'Took ',
    'memory.extract.no.new.seconds': ' seconds, no new memories to save.',
    'memory.extract.fail': 'Memory Extraction Failed',
    'memory.extract.fail.detail': 'Operation error: ',
    'memory.searching': 'Searching related memories...',
    'memory.search.no.result': 'Memory Search',
    'memory.search.no.result.detail': 'No memories found related to 「',
    'memory.search.no.result.suffix': '」',
    'memory.search.complete': 'Memory Search Complete',
    'memory.search.complete.detail': 'Found ',
    'memory.search.complete.results': ' related memories, injecting top ',
    'memory.search.complete.top': ' into context:\n',
    'memory.search.fail': 'Memory Search Failed',
    'memory.search.fail.detail': 'Operation error: ',
    'memory.searching.deleting': 'Searching and deleting matching memories...',
    'memory.delete.complete': 'Memory Delete Complete',
    'memory.delete.complete.detail': 'Deleted ',
    'memory.delete.complete.unit': ' memories:\n',
    'memory.delete.no.match': 'Memory Delete',
    'memory.delete.no.match.detail': 'No memories matching 「',
    'memory.delete.no.match.suffix': '」',
    'memory.delete.fail': 'Memory Delete Failed',
    'memory.delete.fail.detail': 'Operation error: ',

    // Commands - Mode
    'mode.invalid': 'Invalid Mode',
    'mode.not.found': 'Mode not found "',
    'mode.available': 'Available modes: ',

    // Commands - Manual
    'manual.open.fail': 'Open Failed',
    'manual.open.fail.detail': 'Cannot open manual: ',
    'manual.file.not.found': 'File Not Found',
    'manual.file.not.found.detail': 'manual.html not found',

    // Commands - Import
    'import.fail': 'Import Failed',
    'import.usage': 'Usage: /import task <json_file_path>\nExample: /import task ./my-task.json',
    'import.no.path': 'Please specify JSON file path.\nUsage: /import task <json_file_path>',
    'import.file.not.exist': 'File does not exist: ',
    'import.parse.fail': 'Cannot parse or load task JSON: ',

    // Commands - Export
    'export.title': 'Export',
    'export.usage':
        'Usage: /export html <filename> or /export json <filename>.json or /export skill <skill_name> <path.zip>',
    'export.success.json': 'Export Success',
    'export.success.json.detail': 'Task exported to JSON:\n',
    'export.file.exists': 'File Exists',
    'export.file.exists.detail': 'File ',
    'export.file.exists.suffix': ' already exists. Overwrite?',
    'export.skill.usage':
        'Usage: /export skill <skill_name> <path.zip>\nExample: /export skill my-skill ./my-skill.zip',
    'export.skill.not.found': 'Export Failed',
    'export.skill.not.found.detail': 'Skill not found "',
    'export.skill.not.found.suffix': '"\nInstalled skills: ',
    'export.skill.dir.not.exist': 'Export Failed',
    'export.skill.dir.not.exist.detail': 'Skill directory does not exist: ',
    'export.skill.success': 'Export Success',
    'export.skill.success.detail': 'Skill "',
    'export.skill.success.suffix': '" exported to:\n',
    'export.skill.fail': 'Export Failed',
    'export.skill.fail.detail': 'Skill export failed: ',

    // Commands - Recover
    'recover.usage.title': 'Usage Hint',
    'recover.usage.message': 'Available subcommands:\n\n  /recover tasks  - Rebuild task list from task files',
    'recover.task.title': 'Rebuild Task List',
    'recover.task.message':
        'This will rebuild the task list based on all task files on disk.\n' +
        'Current in-memory task list will be overwritten.\n\n' +
        'Continue?',
    'recover.task.scanning': 'Scanning task files and rebuilding task list...',

    // Commands - Tools subcommand
    'tools.description': 'Tool management and debugging',
    'tools.list.description': 'List all available tools',
    'tools.info.description': 'Show tool details',
    'tools.call.description': 'Call tool and print result',
    'tools.not.found': 'Tool not found: ',
    'tools.execution.status': 'Execution complete',
    'tools.execution.state': 'Status: ',
    'tools.execution.result': 'Result:',
    'tools.execution.result.object': 'Result object:',
    'tools.param.parse.fail': 'Parameter parsing failed, please provide valid JSON string',

    // Commands - Rename
    'rename.no.task': 'No active task',
    'rename.task.not.found': 'Current task not found',
    'rename.usage': 'Please provide new task name, usage: /rename <new_name>',
    'rename.success': 'Task renamed to: ',

    // Commands - Stop/Cancel
    'cancel.description': 'Cancel all pending messages in queue',

    // Commands - Exit/Quit
    'exit.description': 'Exit OpenDesk',
    'quit.description': 'Exit OpenDesk',

    // Commands - Clear
    'clear.description': 'Delete all task history',

    // Commands - Bookmark
    'bookmark.description': 'Manage task bookmarks, usage: /bookmark add|list|remove',
    'bookmark.add.description': 'Add current task to bookmarks',
    'bookmark.list.description': 'List all bookmarked tasks',
    'bookmark.remove.description': 'Remove current task from bookmarks',

    // Commands - New
    'new.description': 'Start new task and send message',

    // Commands - Fork
    'fork.description': 'Duplicate current session and switch to new session',

    // Commands - Import
    'import.description': 'Import task from JSON file, usage: /import task <json_file_path>',
    'import.task.description': 'Import task JSON file',

    // Commands - Export
    'export.description':
        'Export session or skill: /export html|json <filename>; /export skill <skill_name> <path.zip>',
    'export.html.description': 'Export as HTML file',
    'export.json.description': 'Export as JSON (compatible with /import)',
    'export.skill.description': 'Export skill as zip file',

    // Commands - Log
    'log.description': 'Show log panel, usage: /log [off|last|all]',
    'log.off.description': 'Hide',
    'log.last.description': 'Last 10',
    'log.all.description': 'All',

    // Commands - Mode
    'mode.description': 'View or switch mode',

    // Commands - Help
    'help.description': 'Show shortcuts and command help',

    // Commands - Manual
    'manual.description': 'Open user manual',

    // Commands - Notification
    'notification.description': 'Open notification center, view all notifications',

    // Commands - Dashboard
    'dashboard.description': 'Open fullscreen dashboard, /dashboard bar toggles status bar',
    'dashboard.bar.description': 'Show/hide status bar',

    // Commands - BTW
    'btw.description': 'Quick question (without current context and tools)',
    'btw.usage': 'Usage: /btw <your_question>',
    'btw.thinking': 'Thinking...',
    'btw.no.reply': '(No reply)',
    'btw.request.fail': 'Request failed: ',

    // Commands - Quickpass
    'quickpass.description': 'Export quickpass, usage: /quickpass config base|all',
    'quickpass.config.base.description': 'Export basic settings quickpass (excluding app config)',
    'quickpass.config.all.description': 'Export all settings quickpass',
    'quickpass.base.title': 'Basic Settings Quickpass',
    'quickpass.base.message': 'Please copy the following quickpass and send to the other party:\n\n',
    'quickpass.base.fail': 'Export Failed',
    'quickpass.base.fail.detail': 'Failed to export basic settings quickpass: ',
    'quickpass.all.title': 'All Settings Quickpass',
    'quickpass.all.message': 'Please copy the following quickpass and send to the other party:\n\n',
    'quickpass.all.fail': 'Export Failed',
    'quickpass.all.fail.detail': 'Failed to export all settings quickpass: ',

    // Commands - Recover
    'recover.description': 'Recover data (subcommand: tasks)',
    'recover.tasks.description': 'Rebuild task list from task files',

    // Commands - Compact
    'compact.description': 'Manually compress current task context',
    'context.description': 'Show current context diagnostics',
    'context.title': 'Context Diagnostics',
    'context.no.task': 'No active task',
    'context.task.not.found': 'Current task not found',
    'context.fail': 'Failed to build context diagnostics',

    // Commands - Debug
    'debug.description': 'Debug command, usage: /debug log [on|off] | /debug taskid',
    'debug.log.description': 'Debug log toggle (on|off)',
    'debug.taskid.description': 'Show current task ID',
    'debug.log.on.description': 'Enable debug log',
    'debug.log.off.description': 'Disable debug log',

    // Commands - Reason
    'reason.description':
        'Adjust reasoning effort, usage: /reason effort [default|none|low|medium|high] | display [full|partial]',
    'reason.effort.description': 'Set reasoning depth',
    'reason.display.description': 'Set thinking display mode',
    'reason.display.full': 'Full Display',
    'reason.display.partial': 'Tail Preview (Last 10 Lines)',
    'reason.current.title': 'Current Reasoning Config',
    'reason.current.displaymode': 'Display mode',
    'reason.current.model': 'Current model',
    'reason.current.depth': 'Reasoning depth',
    'reason.usage.title': 'Usage',
    'reason.effort.set': 'Reasoning Depth Updated',
    'reason.effort.set.message': 'Model ${alias} reasoning depth set to: ${effort}',
    'reason.display.set': 'Display Mode Updated',
    'reason.display.set.message': 'Thinking display mode set to: ${mode}',
    'reason.display.already': 'Display Mode',
    'reason.display.already.message': 'Thinking display mode is already: ${mode}',
    'reason.error.no.model': 'No default model set. Please configure a model in settings first.',
    'reason.error.invalid.effort': 'Invalid reasoning depth: ${value}\nValid values: default, none, low, medium, high',
    'reason.error.invalid.display': 'Invalid display mode: ${value}\nValid values: full, partial',
    'reason.error.specify.effort': 'Please specify reasoning depth: /reason effort [default|none|low|medium|high]',
    'reason.error.specify.display': 'Please specify display mode: /reason display [full|partial]',
    'reason.error.unknown': 'Unknown subcommand: ${subcmd}\nAvailable: effort, display',

    // Commands - Undo/Redo
    'undo.description': 'Undo last operation',
    'undo.undomsg': 'Undo last ${count} message(s)',
    'undo.fail': 'Undo Failed',
    'undo.error.not.integer': 'Parameter must be an integer, e.g.: /undo 2',
    'undo.error.count.zero': 'Undo count must be greater than 0, current input: ${count}',
    'undo.error.no.session': 'No active session. Please start a conversation first.',
    'undo.error.task.notfound': 'Current task not found.',
    'undo.error.no.messages': 'No messages to undo in current session.',
    'undo.partial': 'Partial Undo',
    'undo.error.partial':
        'Requested ${requested} messages to undo, but only ${actual} available. Undone ${actual} messages.',
    'redo.description': 'Redo last undone operation',
    'redo.redomsg': 'Restore last ${count} undo(s)',
    'redo.fail': 'Redo Failed',
    'redo.error.not.integer': 'Parameter must be an integer, e.g.: /redo 2',
    'redo.error.count.zero': 'Redo count must be greater than 0, current input: ${count}',
    'redo.error.no.session': 'No active session. Please start a conversation first.',
    'redo.error.task.notfound': 'Current task not found.',
    'redo.error.no.records': 'No undo records to restore.',
    'redo.partial': 'Partial Redo',
    'redo.error.partial':
        'Requested ${requested} times to restore, but only ${actual} available. Restored ${actual} times.',

    // Commands - Switch
    'switch.description': 'Switch task, usage: /switch <task_id>',

    // Commands - Stop
    'stop.description': 'Stop current task',

    // Commands - Upgrade
    'upgrade.description': 'Upgrade OpenDesk CLI to latest version',

    // Plugin System / Channel
    'plugin.system': 'Plugin System',
    'message.channel': 'Message Channel',
    'channel.ready': 'ready',
    'channel.no.running': 'No running message channel plugins.',
    'channel.reload.success': 'Channel reloaded automatically.',
    'channel.install.success': 'Plugin installed: ${id}\n\nChannel reloaded automatically.',
    'channel.uninstall.success': 'Plugin uninstalled: ${id}\n\nChannel reloaded automatically.',
    'channel.enable.success': 'Plugin enabled: ${id}\n\nChannel reloaded automatically.',
    'channel.disable.success': 'Plugin disabled: ${id}\n\nChannel reloaded automatically.',

    // Input StatusBar
    'input.statusbar.switchmode': 'switch mode',
    'input.statusbar.help': 'help',

    // Help Command
    'help.name': 'help',

    // File Manager
    'filemgr.scan.dir.not.configured': 'agent filesystem not configured',
    'filemgr.embedding.model.not.configured': 'Embedding model not configured',

    // DateTime
    'datetime.weekday.sun': 'Sun',
    'datetime.weekday.mon': 'Mon',
    'datetime.weekday.tue': 'Tue',
    'datetime.weekday.wed': 'Wed',
    'datetime.weekday.thu': 'Thu',
    'datetime.weekday.fri': 'Fri',
    'datetime.weekday.sat': 'Sat',

    // Channel Status
    'channel.status.connected': 'Connected',
    'channel.status.ready': 'Ready',
    'channel.status.error': 'Error',

    // Channel Events
    'channel.event.connected': 'Channel connected',
    'channel.event.disconnected': 'Channel disconnected',
    'channel.event.message': 'Channel message received',
    'channel.event.error': 'Channel error',

    // Config - Common
    'config.command.description': 'Open system settings',
    'config.main.title': 'System Settings',
    'config.main.hint': 'Enter select  Esc back',
    'config.common.save': 'OK Save',
    'config.common.delete': 'Delete',
    'config.common.cancel': 'Back',
    'config.enter.select': 'Enter select',
    'config.esc.back': 'Esc back',

    // Config - Provider
    'config.provider.title': 'Model Provider Config',
    'config.provider.title.hint': 'Manage API model providers',
    'config.provider.add': '+ Add Model Provider',
    'config.provider.template.title': 'Select Provider Template',
    'config.provider.template.custom': 'Custom...',
    'config.provider.edit.title.add': 'Add Model Provider',
    'config.provider.edit.title.edit': 'Edit Model Provider',
    'config.provider.field.name': 'Name',
    'config.provider.field.base_url': 'API Address',
    'config.provider.field.api_key': 'API Key',
    'config.provider.field.no_proxy': 'Disable Proxy',

    // Config - Model
    'config.model.title': 'Model Config',
    'config.model.title.hint': 'Manage model aliases',
    'config.model.add': '+ Add Model',
    'config.model.edit.title.add': 'Add Model',
    'config.model.edit.title.edit': 'Edit Model',
    'config.model.field.alias': 'Model Alias',
    'config.model.field.provider': 'Model Provider',
    'config.model.field.model_name': 'Model Name (Provider side)',
    'config.model.field.reasoning_effort': 'Reasoning Mode',
    'config.model.field.context_length': 'Context Length (leave empty for auto)',
    'config.model.warning.no.models': 'No models configured yet. Please add models via /config models first',

    // Config - Default Model
    'config.defaultmodel.title': 'Default Model Config',
    'config.defaultmodel.title.hint': 'Select default models for each scenario',
    'config.defaultmodel.field.default_model': 'Default Chat Model',
    'config.defaultmodel.field.embedding_model': 'Embedding Model',
    'config.defaultmodel.field.reranker_model': 'Reranker Model',

    // Config - File Manager
    'config.filemgr.title': 'File Scan Config',
    'config.filemgr.title.hint': 'Manage file scan directories',
    'config.filemgr.add': '+ Add New Directory',
    'config.filemgr.empty': 'No directories configured',
    'config.filemgr.input.prompt': 'Enter directory path to scan (e.g. ~/Documents):',
    'config.filemgr.error.not.exist': 'Path does not exist or no permission:',
    'config.filemgr.error.not.directory': 'Not a directory:',
    'config.filemgr.error.already.exists': 'Directory already exists',
    'config.filemgr.delete': '[Delete]',

    // Config - Language
    'config.language.title': 'Language Config',
    'config.language.title.hint': 'Set display language',
    'config.language.field.locale': 'Language',
    'config.language.option.auto': 'Auto (follow system)',
    'config.language.option.zh-CN': '简体中文',
    'config.language.option.en-US': 'English',

    // File Manager Tools
    'filemgr.readFile.name': 'Read File',
    'filemgr.writeFile.name': 'Write File',
    'filemgr.writeFile.append': ' (Append)',
    'filemgr.editFile.name': 'Edit File',
    'filemgr.createFile.name': 'Create File',
    'filemgr.searchReplace.name': 'Search & Replace',
    'filemgr.applyPatch.name': 'Apply Patch',
    'filemgr.glob.name': 'Glob',
    'filemgr.grep.name': 'Grep',
    'filemgr.openInEditor': 'Edit',

    // Task & Planning Tools
    'tools.getCurrentTime.name': 'Get Current Time',
    'tools.listRecentTasks.name': 'List Tasks',
    'tools.getTaskHistory.name': 'Task History',
    'tools.askFromTask.name': 'Ask Task',
    'tools.createSubTask.name': 'Sub-task',
    'tools.waitSubTask.name': 'Await Sub-task',
    'tools.attachToSubTask.name': 'Append to Sub-task',
    'tools.askUser.name': 'Ask User',

    // Reasoning Effort Labels
    'reasoning.effort.default': 'Default',
    'reasoning.effort.none': 'No Reasoning',
    'reasoning.effort.low': 'Low Reasoning',
    'reasoning.effort.medium': 'Medium Reasoning',
    'reasoning.effort.high': 'Deep Reasoning',

    // Tool Call Status
    'toolcall.status.pending': 'Pending',
    'toolcall.status.running': 'Running…',
    'toolcall.status.success': 'Done',
    'toolcall.status.interrupted': 'Interrupted',
    'toolcall.status.error': 'Failed',

    // Task Running Hint
    'input.hint.running': 'Task in progress, you can still type...',
    'input.hint.queue.single': '📨 Pending: ${preview} (type /cancel to undo)',
    'input.hint.queue.multiple': '📨 ${count} message(s) pending (type /cancel to undo)',
    'input.hint.shell.executing': '⏳ Executing: ${cmd}',

    // Reasoning View
    'reasoning.card.title': 'Thinking',
    'reasoning.partial.hint': '…… (use /reason display full to show full thinking)',

    // Compact Boundary
    'compact.boundary.loading': 'Compressing context...',
    'compact.boundary.done': 'Context compressed',

    // Internal Message
    'message.internal': '[Internal message]',

    // Permission
    'permission.action.read': 'Read',
    'permission.action.write': 'Edit',
    'permission.action.execute': 'Execute',
    'permission.action.access': 'Access',
    'permission.resource.file': 'File',
    'permission.resource.network': 'Network',
    'permission.resource.skill': 'Skill',
    'permission.option.allow': 'Allow this time',
    'permission.option.always.prefix': 'Always allow ${typeAction} for ${label}',
    'permission.option.always.type': 'Always allow all ${typeAction} operations',
    'permission.option.deny': 'Deny',
    'permission.question': '${toolName} requests ${typeAction}, allow?',
    'permission.hint.cancel': 'Esc cancel',
    'permission.task.unnamed': 'Unnamed Task',
    'permission.task.background': '⏳ Background task: ${name}',
    'permission.queue.remaining': '${count} more permission request(s) waiting',
    'permission.truncate.prefix': 'Always allow ',
    'permission.truncate.suffix': ' for ',

    // Shortcuts
    'shortcut.switch_mode': 'Switch Mode',
    'shortcut.switch_model': 'Switch Model',
    'shortcut.endline': 'Insert Newline',
    'shortcut.show_help': 'Show Help',
    'shortcut.clear_input': 'Clear Input',
    'shortcut.list_tasks': 'Task List',
    'shortcut.model.switched': 'Model switched to',
    'shortcut.model.none': 'No models configured',

    // Config - Shortcuts
    'config.shortcuts.title': 'Shortcuts',
    'config.shortcuts.title.hint': 'Customize terminal shortcuts',
    'config.shortcuts.press.enter': 'Enter edit',
    'config.shortcuts.waiting': 'Press new key combination...',
    'config.shortcuts.captured': 'Captured',
    'config.shortcuts.confirm': 'Enter save  Esc cancel  D reset default',
    'config.shortcuts.hint': '↑↓ select  Enter edit  D reset default  Esc back',
    'config.shortcuts.saved': 'Shortcuts saved',
    'config.shortcuts.error.single_key.title': 'Invalid Shortcut',
    'config.shortcuts.error.single_key.message':
        'Single keys are not allowed as shortcuts. Please use key combinations (e.g., Ctrl+A, Alt+B).',

    // Help Overlay
    'help.tab.commands': 'Commands',
    'help.tab.skills': 'Skills',
    'help.tab.shortcuts': 'Shortcuts',
    'help.tab.switch': '← → switch',
    'help.no.commands': 'No commands',
    'help.no.shortcuts': 'No shortcuts',
    'help.shortcuts.action': 'Action',
    'help.shortcuts.key': 'Key',
    'help.skills.loading': 'Loading...',
    'help.skills.none': 'No skills available',
    'help.skills.manage': 'Use /skills to manage skills',

    // Shell
    'shell.cwd.changed': '📂 Workspace changed: ${oldCwd} → ${newCwd}',
    'shell.no.output': '(no output)',
    'shell.exec.failed': 'Execution failed: ${error}',

    // InlineResultPanel
    'inline.panel.scroll': 'Ctrl+↑/↓ scroll',
    'inline.panel.close': 'Esc close',

    // Search Tools
    'search.bing.name': 'Search (Bing)',
    'search.duckduckgo.name': 'Search (DuckDuckGo)',
    'search.brave.name': 'Search (Brave)',
    'search.tavily.name': 'Search (Tavily)',
    'search.bocha.name': 'Search (Bocha)',
    'search.exa.name': 'Search (Exa)',
    'search.arxiv.name': 'Paper Search (arXiv)',
    'search.webfetch.name': 'Web Fetch',
    'search.kb.retrieve.name': 'KB Retrieve',
    'search.kb.ask.name': 'KB Q&A',
    'search.email.name': 'Search Emails',
    'search.result.count': '${count} results',
    'search.result.chars': '${count} chars',
    'search.result.papers': '${count} papers',

    // Unknown
    'unknown.source': 'Unknown source'
};
