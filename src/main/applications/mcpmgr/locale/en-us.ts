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
    'app.name': 'MCP',
    'tool.label': 'MCP Tool',
    'tool.purpose.description':
        'Briefly describe the purpose of this MCP tool call for display, e.g. "Find button component docs"',

    // ========== 状态 ==========
    'status.connected': 'Connected',
    'status.connecting': 'Connecting',
    'status.disconnected': 'Disconnected',
    'status.error': 'Error',

    // ========== 延迟加载网关工具（mcpSearchTools / mcpGetTool / mcpCallTool） ==========
    'gateway.search.description':
        'Search lazily loaded MCP tools by capability. Returns compact summaries only; before calling a tool, use mcpGetTool to load its full description and input schema.',
    'gateway.search.query': 'Keywords for capability, topic, or tool name; leave empty to browse',
    'gateway.search.server': 'Optional MCP server name or serverId filter',
    'gateway.search.offset': 'Pagination offset',
    'gateway.search.limit': 'Max tools to return; 1-10 recommended, values above 10 are clamped',
    'gateway.search.hint':
        'Once you pick a tool, call mcpGetTool for its full definition, then call it via mcpCallTool.',
    'gateway.search.clampedHint': '(limit was clamped to ${n}; use nextOffset to paginate for more results)',
    'gateway.get.description':
        'Load the full description and input schema of a deferred MCP tool by serverId and tool name. Then call it via mcpCallTool.',
    'gateway.get.serverId': 'MCP server ID returned by mcpSearchTools',
    'gateway.get.toolName': 'Original MCP tool name returned by mcpSearchTools',
    'gateway.call.description':
        'Call a deferred MCP tool. Find it via mcpSearchTools first, then use mcpGetTool for the exact input schema.',
    'gateway.call.serverId': 'MCP server ID returned by mcpSearchTools',
    'gateway.call.toolName': 'Original MCP tool name to call',
    'gateway.call.arguments':
        'Arguments passed directly to the MCP tool. Keys must exactly match the inputSchema.properties returned by mcpGetTool — do not wrap them under query/params or similar keys. E.g. if the tool expects {query: string, top_k?: number}, pass {query: "...", top_k: 10}',
    'gateway.toolNotFound': 'Deferred MCP tool not found: ${serverId}/${toolName}',

    // ========== 错误 ==========
    'error.toolCallFailed': 'MCP tool call failed',
    'error.serverNotFound': 'MCP server not found',
    'error.serverDuplicate': 'MCP server "${name}" already exists with an identical configuration',
    'error.unknownRegistry': 'Unknown MCP registry: ${id}',
    'error.mcpMissingCommand': 'MCP "${name}" is missing "command"',
    'error.mcpMissingUrl': 'MCP "${name}" is missing "url"',
    'error.mcpServersNotFound': 'No mcpServers object found in the MCP configuration',
    'error.unrecognizedInstallUrl': 'Unrecognized MCP registry install URL: ${url}',
    'error.mcpNotFound': 'MCP not found',
    'error.noInstallableConfig': '${source} MCP "${name}" provides no installable configuration',
    'error.noInstallableServer': '${source} MCP "${name}" provides no MCP server to install',
    'error.commandNotFound': 'Command not found: ${command}',
    'error.checkRuntimeInstalled':
        'Make sure the command path is correct and the runtime (Node.js, Python, uvx, etc.) is installed',
    'error.unknownError': 'Unknown error',
    'error.operationFailed': 'Operation failed',
    'error.loadMcpFailed': 'Failed to load MCP servers',
    'error.searchFailed': 'Search failed',

    // ========== Registry 安装结果 ==========
    'install.result.summary': 'Installed ${installed}, updated ${updated}, skipped ${skipped}',
    'install.result.noneNew': 'No new MCP installed; ${skipped} matching already installed',

    // ========== 应用事件描述 ==========
    'appEvent.serversUpdated':
        'MCP server list updated; fired when servers are added, removed, reconfigured or change connection state',
    'appEvent.registriesChanged':
        'MCP registry list change event, triggered after plugins are installed, uninstalled, enabled, disabled, or reloaded',

    // ========== 页面助手 ==========
    'agent.instruct':
        'You are the MCP management assistant. Through you the user can add, manage and use MCP (Model Context Protocol) servers. This page shows the MCP marketplace and the connection status, configuration and available tools of installed MCP servers.',
    'renderer.tool.listMcpServers.description':
        'Get the name, transport, connection status and tool count of every registered MCP server',

    // ========== CLI 渲染 ==========
    'cli.install.cardTitle': 'Install MCP',
    'cli.install.server': 'Server: ',
    'cli.install.transport': 'Transport: ',
    'cli.install.running': 'Installing...',
    'cli.install.exists': 'Server already exists: ',
    'cli.install.successConnectFailed': 'Installed, but connection failed: ',
    'cli.install.success': 'Installed!',
    'cli.list.cardTitle': 'MCP List',
    'cli.list.loading': 'Loading...',
    'cli.list.empty': 'No MCP servers installed',
    'cli.list.found': 'Found ${count} MCP servers:',
    'cli.list.more': '... and ${count} more',
    'cli.list.success': 'MCP list fetched',
    'cli.delete.cardTitle': 'Delete MCP',
    'cli.delete.target': 'Target: ',
    'cli.delete.running': 'Deleting...',
    'cli.delete.successWithName': 'Deleted: ',
    'cli.delete.success': 'Deleted!',
    'cli.toggle.cardTitle.enabled': 'Enable MCP',
    'cli.toggle.cardTitle.disabled': 'Disable MCP',
    'cli.toggle.target': 'Target: ',
    'cli.toggle.enable': 'Enable',
    'cli.toggle.disable': 'Disable',
    'cli.toggle.operation': 'Action: ',
    'cli.toggle.running': 'Running...',
    'cli.toggle.result.enabled': '${name} enabled',
    'cli.toggle.result.disabled': '${name} disabled',
    'cli.toggle.success': 'Done!',
    'cli.tool.running': 'Running...',
    'cli.tool.success': 'Success',

    // ========== Renderer：主界面 ==========
    'renderer.mcp.title': 'MCP Manager',
    'renderer.mcp.tab.installed': 'Installed',
    'renderer.mcp.action.refresh': 'Refresh',
    'renderer.mcp.action.import': 'Import JSON',
    'renderer.mcp.action.add': 'Add MCP',
    'renderer.mcp.search.placeholder.registry': 'Search ${label}...',
    'renderer.mcp.search.placeholder.installed': 'Search installed MCP...',
    'renderer.mcp.search.clear': 'Clear search',
    'renderer.mcp.search.button': 'Search',
    'renderer.mcp.search.searching': 'Searching...',
    'renderer.mcp.search.refreshing': 'Refreshing...',
    'renderer.mcp.loading': 'Loading...',
    'renderer.mcp.loadingMore': 'Loading more...',
    'renderer.mcp.scrollForMore': 'Scroll for more',

    // ========== Renderer：广场（Registry） ==========
    'renderer.mcp.registry.empty.searched': 'No MCP found',
    'renderer.mcp.registry.empty.default': 'No MCP yet',
    'renderer.mcp.registry.empty.hint': 'Search for MCP servers in ${label}',
    'renderer.mcp.registry.install': 'Install',
    'renderer.mcp.registry.installing': 'Installing...',

    // ========== Renderer：已安装列表 ==========
    'renderer.mcp.installed.empty.title': 'No MCP installed',
    'renderer.mcp.installed.empty.hint': 'Install from the marketplace above, or click + in the top-right',
    'renderer.mcp.installed.filter.empty.title': 'No matching MCP',
    'renderer.mcp.installed.filter.empty.hint': 'Try a different keyword',
    'renderer.mcp.installed.count': '${count} MCP installed',
    'renderer.mcp.card.toolsCount': '${count} tools',
    'renderer.mcp.card.toolsChangedSuffix': ', refreshed on tool list change',
    'renderer.mcp.card.toggle.errorHint': 'Enabled but failed to connect; click to disable',
    'renderer.mcp.card.toggle.disableHint': 'Enabled, click to disable',
    'renderer.mcp.card.toggle.enableHint': 'Disabled, click to enable',

    // ========== Renderer: batch selection ==========
    'renderer.mcp.batch.more': 'Batch actions',
    'renderer.mcp.batch.check': 'Select this MCP',
    'renderer.mcp.batch.tray.label': 'Selected <b>${count}</b>',
    'renderer.mcp.batch.tray.remove': 'Deselect',
    'renderer.mcp.batch.tray.clear': 'Clear selection',
    'renderer.mcp.batch.menu.headPick': 'Select',
    'renderer.mcp.batch.menu.pickAll': 'Select all',
    'renderer.mcp.batch.menu.pickAllHint': 'Select all ${count} actionable items',
    'renderer.mcp.batch.menu.pickVisible': 'Select search results',
    'renderer.mcp.batch.menu.pickVisibleHint': 'Add ${count} matches to the selection',
    'renderer.mcp.batch.menu.pickVisibleHintDone': 'All matches are already selected',
    'renderer.mcp.batch.menu.clear': 'Clear selection',
    'renderer.mcp.batch.menu.clearHint': '${count} selected',
    'renderer.mcp.batch.menu.headExec': 'Run',
    'renderer.mcp.batch.menu.enable': 'Enable selected',
    'renderer.mcp.batch.menu.enableHint': 'Enable the disabled ones among ${count} selected',
    'renderer.mcp.batch.menu.disable': 'Disable selected',
    'renderer.mcp.batch.menu.disableHint': 'Disable the enabled ones among ${count} selected',
    'renderer.mcp.batch.menu.delete': 'Delete selected',
    'renderer.mcp.batch.menu.deleteHint': 'Delete ${count} selected MCPs',
    'renderer.mcp.batch.menu.empty': 'Select MCPs to run batch actions',
    'renderer.mcp.batch.delete.title': 'Delete MCPs',
    'renderer.mcp.batch.delete.message': 'Delete the ${count} selected MCPs? This cannot be undone.',
    'renderer.mcp.batch.failed': '${count} MCP operations failed. Retry or check the logs.',

    // ========== Renderer：详情弹窗 ==========
    'renderer.mcp.detail.section.meta': 'Details',
    'renderer.mcp.detail.section.intro': 'About',
    'renderer.mcp.detail.section.config': 'MCP configuration',
    'renderer.mcp.detail.section.command': 'Command',
    'renderer.mcp.detail.section.cwd': 'Working directory',
    'renderer.mcp.detail.section.env': 'Environment variables',
    'renderer.mcp.detail.section.headers': 'Headers',
    'renderer.mcp.detail.section.error': 'Error',
    'renderer.mcp.detail.section.tools': 'Available tools',
    'renderer.mcp.detail.section.toolsWithCount': 'Available tools (${count})',
    'renderer.mcp.detail.tools.empty': 'No tools',
    'renderer.mcp.detail.meta.source': 'Source',
    'renderer.mcp.detail.meta.author': 'Author',
    'renderer.mcp.detail.meta.deployType': 'Deployment',
    'renderer.mcp.detail.meta.repository': 'Repository',
    'renderer.mcp.detail.meta.downloads': 'Downloads',
    'renderer.mcp.detail.meta.stars': 'Stars',
    'renderer.mcp.detail.meta.views': 'Views',
    'renderer.mcp.detail.meta.updated': 'Updated',
    'renderer.mcp.detail.meta.transport': 'Transport',
    'renderer.mcp.detail.meta.status': 'Status',
    'renderer.mcp.detail.meta.enabled': 'Enabled',
    'renderer.mcp.detail.meta.yes': 'Yes',
    'renderer.mcp.detail.meta.no': 'No',
    'renderer.mcp.detail.meta.toolCount': 'Tools',
    'renderer.mcp.detail.meta.refreshCount': 'Tool refreshes',
    'renderer.mcp.detail.meta.lastToolChange': 'Last tool change',
    'renderer.mcp.detail.close': 'Close',
    'renderer.mcp.detail.done': 'Done',
    'renderer.mcp.detail.edit': 'Edit',
    'renderer.mcp.detail.delete': 'Delete',
    'renderer.mcp.detail.reconnect': 'Reconnect',
    'renderer.mcp.detail.installMcp': 'Install MCP',

    // ========== Renderer：添加 / 编辑表单 ==========
    'renderer.mcp.form.addTitle': 'Add MCP',
    'renderer.mcp.form.editTitle': 'Edit MCP',
    'renderer.mcp.form.addSubtitle': 'Configure an MCP server manually',
    'renderer.mcp.form.name': 'Name',
    'renderer.mcp.form.name.placeholder': 'e.g. filesystem',
    'renderer.mcp.form.transport': 'Transport',
    'renderer.mcp.form.command': 'Command',
    'renderer.mcp.form.args': 'Arguments (one per line)',
    'renderer.mcp.form.cwd': 'Working directory (optional)',
    'renderer.mcp.form.env': 'Environment variables',
    'renderer.mcp.form.addEnv': '+ Add variable',
    'renderer.mcp.form.headers': 'Headers (Key: Value)',
    'renderer.mcp.env.empty': 'No environment variables',
    'renderer.mcp.env.keyPlaceholder': 'Name',
    'renderer.mcp.env.valuePlaceholder': 'Value',
    'renderer.mcp.env.remove': 'Remove',
    'renderer.mcp.form.cancel': 'Cancel',
    'renderer.mcp.form.add': 'Add',
    'renderer.mcp.form.save': 'Save',
    'renderer.mcp.form.error.nameRequired': 'Name is required',
    'renderer.mcp.form.error.commandRequired': 'Command is required',
    'renderer.mcp.form.error.urlRequired': 'URL is required',
    'renderer.mcp.form.error.saveFailed': 'Save failed',

    // ========== Renderer：导入弹窗 ==========
    'renderer.mcp.import.title': 'Import MCP Configuration',
    'renderer.mcp.import.desc': 'Paste MCP configuration JSON from Claude Desktop, Cursor and similar tools.',
    'renderer.mcp.import.label': 'JSON configuration',
    'renderer.mcp.import.button': 'Import',
    'renderer.mcp.import.emptyError': 'JSON configuration is required',
    'renderer.mcp.import.failed': 'Import failed',

    // ========== Renderer：确认弹窗 ==========
    'renderer.mcp.confirm.delete.title': 'Delete MCP',
    'renderer.mcp.confirm.delete.message': 'Delete MCP "<b>${name}</b>"?',
    'renderer.mcp.confirm.deleteFailed.title': 'Delete Failed',
    'renderer.mcp.confirm.installFailed.title': 'Install Failed',
    'renderer.mcp.confirm.actionFailed.title': 'Action Failed',
    'renderer.mcp.confirm.reconnectFailed.title': 'Reconnect Failed',
    'renderer.mcp.confirm.acknowledge': 'Got it'
};
