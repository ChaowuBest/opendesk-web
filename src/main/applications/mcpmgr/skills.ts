export const MANAGE_MCP_SKILL = `
---
name: manage-mcp
description: 介绍MCP服务器的管理：安装，卸载与查询等的方法
---

# MCP Management

本技能介绍并提供工具来进行MCP服务器的安装和管理。

## MCP Server安装

当前我们支持使用本Skill内置的installMcpServer工具来安装sse, streamableHttp这两种形式的MCP Server。
请不要使用本Skill附带的工具安装stdio的工具，比如用'npx'来运行的本地工具，这会导致不可预测的错误。

如果用户未明确指定MCP Server的地址和协议，你应当使用搜索工具或者WebFetch工具来查询这个MCP Server的信息。

### MCP Server 搜索平台

- mcpservers.org: "https://mcpservers.org/search?query=<keyword>"
- mcp.so: "https://mcp.so/explore?q=<keyword>"

如果以上平台无法搜索到，也可以使用其他通用搜索工具。

## 查看当前安装的MCP Servers

使用本Skill内置的listMcpServers工具可以查看当前已经安装的所有MCP Server及其状态。

## MCP Server禁用与启用

使用本Skill内置的ToggleMcpServerTool可以切换MCP服务的启用或禁用状态。

## MCP Server卸载

使用本Skill内置的deleteMcpServer工具可以卸载已经安装的MCP Server。

## 其他注意事项

需要注意的是，MCP服务器中提供的工具只有在新建的会话当中才能生效。
如果用户请求在当前会话中测试你添加或更新的MCP服务器的话，你应当提醒他们通过\`/new\`命令
或者\`Ctrl+N\`快捷键来打开新的对话来测试。这是因为在已有的对话中修改工具的定义会导致上下文
缓存失效，因此我们不会在已有的对话上下文中调整工具的定义。
`