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

export const MANAGE_MCP_SKILL = `
---
name: manage-mcp
description: 介绍MCP服务器的管理：安装，卸载与查询等的方法
---

# MCP Management

本技能介绍并提供工具来进行MCP服务器的安装和管理。

## MCP Server安装

当前支持使用本Skill内置工具安装stdio、sse、streamableHttp三种形式的MCP Server。

如果用户提供了明确配置，使用installMcpServer手动安装。如果用户只给出MCP名称、关键词或想从MCP广场安装，优先使用listMcpRegistries、searchMcpRegistry、getMcpRegistryEntry和installMcpServerFromRegistry完成查询与安装。

如果内置MCP Registry无法找到目标，或用户要求安装特定第三方MCP但未提供地址和协议，你应当使用搜索工具或者WebFetch工具查询该MCP Server的官方信息。

### 安装参数

- stdio：适用于本地命令行 MCP Server。必须提供transport="stdio"和command，并按数组形式提供args；可选提供cwd和env。
- sse：适用于SSE远程 MCP Server。必须提供transport="sse"和url；如服务需要鉴权，可提供headers。
- streamableHttp：适用于Streamable HTTP远程 MCP Server。必须提供transport="streamableHttp"和url；如服务需要鉴权，可提供headers。

安装stdio类型时，不要把整段shell命令写进command。command只填写可执行文件名或路径，例如"npx"、"node"、"python"、"uvx"；命令参数应拆分写入args，例如["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]。

stdio MCP Server会在本机启动子进程。对于来源不明的安装命令，先查询官方文档或可信Registry配置，并向用户说明该命令会在本机执行。

### MCP Registry工具

- 内置Registry包括Matrix和ModelScope。未知registryId时先调用listMcpRegistries。
- listMcpRegistries：查看当前可用的MCP Registry及registryId。
- searchMcpRegistry：在指定Registry中搜索MCP，返回条目ID、安装地址、简介、配置等信息。
- getMcpRegistryEntry：查看单个Registry条目的详情和可安装配置。
- installMcpServerFromRegistry：使用Registry条目的installUrl，或registryId+id安装MCP。

### 外部搜索平台

- mcpservers.org: "https://mcpservers.org/search?query=<keyword>"
- mcp.so: "https://mcp.so/explore?q=<keyword>"

如果以上平台无法搜索到，也可以使用其他通用搜索工具。

## 查看当前安装的MCP Servers

使用本Skill内置的listMcpServers工具可以查看当前已经安装的所有MCP Server及其状态。

## MCP Server编辑与重连

使用updateMcpServer工具可以编辑已安装MCP Server的名称、传输类型、命令、参数、工作目录、环境变量、URL和请求头。
使用reconnectMcpServer工具可以重新连接已安装MCP Server。

## MCP Server禁用与启用

使用本Skill内置的toggleMcpServer工具可以切换 MCP 的启用或禁用状态。

## MCP Server卸载

使用本Skill内置的deleteMcpServer工具可以卸载已经安装的MCP Server。

## MCP 配置导入

使用importMcpServersFromJson工具可以导入Claude Desktop、Cursor等工具的MCP配置JSON。

## 其他注意事项

需要注意的是，MCP服务器中提供的工具只有在新建的会话当中才能生效。
如果用户请求在当前会话中测试你添加或更新的MCP服务器的话，你应当提醒他们通过\`/new\`命令
或者\`Ctrl+N\`快捷键来打开新的对话来测试。这是因为在已有的对话中修改工具的定义会导致上下文
缓存失效，因此我们不会在已有的对话上下文中调整工具的定义。
`;
