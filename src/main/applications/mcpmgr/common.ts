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

import type { PluginSourceKind } from '../../aikernel/skill.js';

export interface McpServerConfig {
    id: string;
    name: string;
    /**
     * 面向用户的展示名。从 Registry 安装时，注册表条目名（如「天眼查MCP」）通常和
     * 配置里的技术名（如 tyc-mcp）不一致：UI 展示 displayName，name 继续用于
     * 工具命名空间与重复检测。未设置时 UI 回退到 name。
     */
    displayName?: string;
    transport: 'stdio' | 'sse' | 'streamableHttp';
    enabled: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    source?: string;
    registryId?: string;
    registryMcpId?: string;
    /**
     * 限定此 server 发现的工具仅向这些 Agent 暴露。
     * undefined 表示不限定；空数组表示不向任何 Agent 暴露。
     */
    agentIds?: string[];
    /**
     * 内部 MCP 归属信息：由插件技能（skills.register 的 mcps 字段 / mcps.registerInternalServer）
     * 注入的 server 带 `pluginSkillName` 标记。这类 server 的工具不进入全局工具视角，
     * 只作为所属技能的内部工具集渐进式披露；生命周期由插件启停驱动（运行时注入，
     * 不写入用户配置）。
     */
    pluginId?: string;
    pluginSkillName?: string;
    pluginSource?: PluginSourceKind;
}

export interface McpToolInfo {
    serverId: string;
    serverName: string;
    name: string;
    description: string;
    inputSchema: object;
    agentIds?: string[];
}

export interface McpServerState extends McpServerConfig {
    readOnly?: boolean;
    providerId?: string;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    tools: { name: string; description: string; inputSchema?: object }[];
    toolsChangedCount?: number;
    lastToolsChangedAt?: string;
}

/** 批量操作中单条失败的原因 */
export interface McpBatchFailure {
    id: string;
    error: string;
}

/** 批量操作结果：changed 为实际变更条数，failed 为逐条失败明细 */
export interface McpBatchOperationResult {
    changed: number;
    failed: McpBatchFailure[];
}
