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
    'app.name': 'MCP',
    'tool.label': 'MCP工具',
    'tool.purpose.description': '对本次 MCP 工具调用目的的简短描述，用于在界面中展示，例如“查找按钮组件文档”',

    // ========== 状态 ==========
    'status.connected': '已连接',
    'status.connecting': '连接中',
    'status.disconnected': '未连接',
    'status.error': '连接失败',

    // ========== 延迟加载网关工具（mcpSearchTools / mcpGetTool / mcpCallTool） ==========
    'gateway.search.description':
        '按能力检索延迟加载的 MCP 工具。仅返回精简摘要；调用前应使用 mcpGetTool 加载目标工具的完整说明和参数结构。',
    'gateway.search.query': '能力、主题或工具名关键词；留空可分页浏览',
    'gateway.search.server': '可选的 MCP Server 名称或 serverId 过滤条件',
    'gateway.search.offset': '分页起始偏移量',
    'gateway.search.limit': '本次最多返回的工具数，建议 1-10；超过 10 会被自动截断',
    'gateway.search.hint': '选定工具后，先调用 mcpGetTool 获取完整定义，再调用 mcpCallTool。',
    'gateway.search.clampedHint': '（本次 limit 已自动截断为 ${n}，如需更多结果请使用 nextOffset 分页）',
    'gateway.get.description':
        '按 serverId 和工具名加载一个延迟 MCP 工具的完整说明与输入参数结构。随后使用 mcpCallTool 调用。',
    'gateway.get.serverId': 'mcpSearchTools 返回的 MCP Server ID',
    'gateway.get.toolName': 'mcpSearchTools 返回的原始 MCP 工具名',
    'gateway.call.description':
        '调用一个延迟加载的 MCP 工具。应先通过 mcpSearchTools 查找，再通过 mcpGetTool 获取准确的输入参数结构。',
    'gateway.call.serverId': 'mcpSearchTools 返回的 MCP Server ID',
    'gateway.call.toolName': '要调用的原始 MCP 工具名',
    'gateway.call.arguments':
        '直接传递给 MCP 工具的参数对象，键值对必须与 mcpGetTool 返回的 inputSchema.properties 完全匹配，不要额外包装在 query/params 等键下。例如工具需要 {query: string, top_k?: number}，这里就直接传 {query: "...", top_k: 10}',
    'gateway.toolNotFound': '未找到延迟 MCP 工具：${serverId}/${toolName}',

    // ========== 错误 ==========
    'error.toolCallFailed': 'MCP 工具调用失败',
    'error.serverNotFound': '未找到 MCP Server',
    'error.serverDuplicate': '已存在配置相同的 MCP Server "${name}"',
    'error.unknownRegistry': '未知 MCP Registry: ${id}',
    'error.mcpMissingCommand': 'MCP "${name}" 缺少 command',
    'error.mcpMissingUrl': 'MCP "${name}" 缺少 url',
    'error.mcpServersNotFound': 'MCP 配置中未找到 mcpServers 对象',
    'error.unrecognizedInstallUrl': '无法识别 MCP Registry 安装地址: ${url}',
    'error.mcpNotFound': '未找到该 MCP',
    'error.noInstallableConfig': '${source} MCP "${name}" 未提供可安装配置',
    'error.noInstallableServer': '${source} MCP "${name}" 未提供可安装 MCP server',
    'error.commandNotFound': '命令未找到: ${command}',
    'error.checkRuntimeInstalled': '请确认命令路径正确且已安装对应的运行时（如 Node.js、Python、uvx 等）',
    'error.unknownError': '未知错误',
    'error.operationFailed': '操作失败',
    'error.loadMcpFailed': '加载 MCP 失败',
    'error.searchFailed': '搜索失败',

    // ========== Registry 安装结果 ==========
    'install.result.summary': '已安装 ${installed} 个，更新 ${updated} 个，跳过 ${skipped} 个',
    'install.result.noneNew': '未安装新 MCP，已存在 ${skipped} 个相同配置',

    // ========== 应用事件描述 ==========
    'appEvent.serversUpdated': 'MCP 列表更新事件，当添加、删除、修改配置或连接状态变化时触发',
    'appEvent.registriesChanged': 'MCP 注册表列表变更事件，当插件启停、安装、卸载或重载后触发',

    // ========== 页面助手 ==========
    'agent.instruct':
        '你是 MCP 管理助手。用户可以通过你添加、管理和使用 MCP（Model Context Protocol）服务。当前页面展示 MCP 广场和用户已安装 MCP 的连接状态、配置与可用工具。',
    'renderer.tool.listMcpServers.description': '获取当前已注册的所有 MCP 的名称、类型、连接状态和可用工具数量',

    // ========== CLI 渲染 ==========
    'cli.install.cardTitle': '安装 MCP',
    'cli.install.server': '服务器: ',
    'cli.install.transport': '传输: ',
    'cli.install.running': '安装中…',
    'cli.install.exists': '服务器已存在: ',
    'cli.install.successConnectFailed': '安装成功，连接失败: ',
    'cli.install.success': '安装成功!',
    'cli.list.cardTitle': 'MCP 列表',
    'cli.list.loading': '加载中…',
    'cli.list.empty': '暂无已安装的 MCP',
    'cli.list.found': '找到 ${count} 个 MCP:',
    'cli.list.more': '... 还有 ${count} 个',
    'cli.list.success': '已获取 MCP 列表',
    'cli.delete.cardTitle': '删除 MCP',
    'cli.delete.target': '目标: ',
    'cli.delete.running': '删除中…',
    'cli.delete.successWithName': '删除成功: ',
    'cli.delete.success': '删除成功!',
    'cli.toggle.cardTitle.enabled': '启用 MCP',
    'cli.toggle.cardTitle.disabled': '禁用 MCP',
    'cli.toggle.target': '目标: ',
    'cli.toggle.enable': '启用',
    'cli.toggle.disable': '禁用',
    'cli.toggle.operation': '操作: ',
    'cli.toggle.running': '执行中…',
    'cli.toggle.result.enabled': '${name} 已启用',
    'cli.toggle.result.disabled': '${name} 已禁用',
    'cli.toggle.success': '操作成功!',
    'cli.tool.running': '执行中…',
    'cli.tool.success': '执行成功',

    // ========== Renderer：主界面 ==========
    'renderer.mcp.title': 'MCP 管理',
    'renderer.mcp.tab.installed': '已安装 MCP',
    'renderer.mcp.action.refresh': '刷新',
    'renderer.mcp.action.import': '导入 JSON',
    'renderer.mcp.action.add': '添加 MCP',
    'renderer.mcp.search.placeholder.registry': '搜索 ${label}…',
    'renderer.mcp.search.placeholder.installed': '搜索已安装 MCP…',
    'renderer.mcp.search.clear': '清除搜索',
    'renderer.mcp.search.button': '搜索',
    'renderer.mcp.loading': '加载中…',
    'renderer.mcp.loadingMore': '加载更多…',
    'renderer.mcp.scrollForMore': '向下滚动加载更多',

    // ========== Renderer：广场（Registry） ==========
    'renderer.mcp.registry.empty.searched': '未找到 MCP',
    'renderer.mcp.registry.empty.default': '暂无 MCP',
    'renderer.mcp.registry.empty.hint': '可以搜索 ${label} 中的 MCP server',
    'renderer.mcp.registry.install': '安装',
    'renderer.mcp.registry.installing': '安装中…',

    // ========== Renderer：已安装列表 ==========
    'renderer.mcp.installed.empty.title': '暂无已安装 MCP',
    'renderer.mcp.installed.empty.hint': '可从上方广场安装，或点击右上角添加',
    'renderer.mcp.installed.filter.empty.title': '未找到匹配的 MCP',
    'renderer.mcp.installed.filter.empty.hint': '换个关键词试试',
    'renderer.mcp.installed.count': '已安装 ${count} 个 MCP',
    'renderer.mcp.card.toolsCount': '${count} 个工具',
    'renderer.mcp.card.toolsChangedSuffix': '，已响应工具列表变更通知',
    'renderer.mcp.card.toggle.errorHint': '已启用但连接失败，点击禁用',
    'renderer.mcp.card.toggle.disableHint': '已启用，点击禁用',
    'renderer.mcp.card.toggle.enableHint': '已禁用，点击启用',

    // ========== Renderer：详情弹窗 ==========
    'renderer.mcp.detail.section.meta': '元信息',
    'renderer.mcp.detail.section.intro': '简介',
    'renderer.mcp.detail.section.config': 'MCP 配置',
    'renderer.mcp.detail.section.command': '命令',
    'renderer.mcp.detail.section.cwd': '工作目录',
    'renderer.mcp.detail.section.env': '环境变量',
    'renderer.mcp.detail.section.headers': '请求头',
    'renderer.mcp.detail.section.error': '错误',
    'renderer.mcp.detail.section.tools': '可用工具',
    'renderer.mcp.detail.section.toolsWithCount': '可用工具 (${count})',
    'renderer.mcp.detail.tools.empty': '暂无工具',
    'renderer.mcp.detail.meta.source': '来源',
    'renderer.mcp.detail.meta.author': '作者',
    'renderer.mcp.detail.meta.deployType': '部署类型',
    'renderer.mcp.detail.meta.repository': '仓库',
    'renderer.mcp.detail.meta.downloads': '下载',
    'renderer.mcp.detail.meta.stars': '收藏',
    'renderer.mcp.detail.meta.views': '浏览',
    'renderer.mcp.detail.meta.updated': '更新时间',
    'renderer.mcp.detail.meta.transport': '传输',
    'renderer.mcp.detail.meta.status': '状态',
    'renderer.mcp.detail.meta.enabled': '启用',
    'renderer.mcp.detail.meta.yes': '是',
    'renderer.mcp.detail.meta.no': '否',
    'renderer.mcp.detail.meta.toolCount': '工具数量',
    'renderer.mcp.detail.meta.refreshCount': '通知刷新次数',
    'renderer.mcp.detail.meta.lastToolChange': '最近工具变更',
    'renderer.mcp.detail.close': '关闭',
    'renderer.mcp.detail.done': '完成',
    'renderer.mcp.detail.edit': '编辑',
    'renderer.mcp.detail.delete': '删除',
    'renderer.mcp.detail.reconnect': '重新连接',
    'renderer.mcp.detail.installMcp': '安装 MCP',

    // ========== Renderer：添加 / 编辑表单 ==========
    'renderer.mcp.form.addTitle': '添加 MCP',
    'renderer.mcp.form.editTitle': '编辑 MCP',
    'renderer.mcp.form.addSubtitle': '手动配置 MCP server',
    'renderer.mcp.form.name': '名称',
    'renderer.mcp.form.name.placeholder': '例如 filesystem',
    'renderer.mcp.form.transport': '传输方式',
    'renderer.mcp.form.command': '命令',
    'renderer.mcp.form.args': '参数（每行一个）',
    'renderer.mcp.form.cwd': '工作目录（可选）',
    'renderer.mcp.form.env': '环境变量',
    'renderer.mcp.form.addEnv': '+ 添加环境变量',
    'renderer.mcp.form.headers': '请求头（Key: Value）',
    'renderer.mcp.env.empty': '暂无环境变量',
    'renderer.mcp.env.keyPlaceholder': '变量名',
    'renderer.mcp.env.valuePlaceholder': '变量值',
    'renderer.mcp.env.remove': '移除',
    'renderer.mcp.form.cancel': '取消',
    'renderer.mcp.form.add': '添加',
    'renderer.mcp.form.save': '保存',
    'renderer.mcp.form.error.nameRequired': '请输入名称',
    'renderer.mcp.form.error.commandRequired': '请输入命令',
    'renderer.mcp.form.error.urlRequired': '请输入 URL',
    'renderer.mcp.form.error.saveFailed': '保存失败',

    // ========== Renderer：导入弹窗 ==========
    'renderer.mcp.import.title': '导入 MCP 配置',
    'renderer.mcp.import.desc': '粘贴 Claude Desktop、Cursor 等工具的 MCP 配置 JSON。',
    'renderer.mcp.import.label': 'JSON 配置',
    'renderer.mcp.import.button': '导入',
    'renderer.mcp.import.emptyError': '请粘贴 JSON 配置',
    'renderer.mcp.import.failed': '导入失败',

    // ========== Renderer：确认弹窗 ==========
    'renderer.mcp.confirm.delete.title': '删除 MCP',
    'renderer.mcp.confirm.delete.message': '确定要删除 MCP「<b>${name}</b>」吗？',
    'renderer.mcp.confirm.deleteFailed.title': '删除失败',
    'renderer.mcp.confirm.installFailed.title': '安装失败',
    'renderer.mcp.confirm.actionFailed.title': '操作失败',
    'renderer.mcp.confirm.reconnectFailed.title': '重连失败',
    'renderer.mcp.confirm.acknowledge': '我知道了'
};
