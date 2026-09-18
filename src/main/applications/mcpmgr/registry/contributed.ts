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

/**
 * 贡献注册表适配器：把插件经 registry capability 注册的
 * PluginMcpRegistryDefinition 包装成 MCPRegistryBase，
 * 使 mcpmgr 的市场 UI、agent 工具与安装流程无需感知插件来源。
 */

import type { PluginMcpRegistryDefinition } from '../../../../../packages/plugin-sdk/src/index.js';
import { MCPRegistryBase, type RegistryMcp, type SearchOptions, type SearchResult } from './base.js';

export class ContributedMCPRegistry extends MCPRegistryBase {
    readonly id: string;
    readonly label: string;
    readonly icon: string;
    readonly iconClass: string;
    /** GUI 市场是否隐藏该注册表 tab（当前 MCP 市场未使用，保留与 skill 侧对称） */
    readonly guiHidden: boolean;

    constructor(private readonly definition: PluginMcpRegistryDefinition) {
        super();
        this.id = definition.id;
        this.label = definition.label;
        this.icon = definition.icon ?? '🔗';
        this.iconClass = definition.iconClass ?? definition.id;
        this.guiHidden = definition.guiHidden === true;
    }

    override get slogan(): string {
        return this.definition.slogan ?? super.slogan;
    }

    override async search(opts?: SearchOptions): Promise<SearchResult> {
        return await this.definition.search(opts);
    }

    override async getDetail(id: string): Promise<RegistryMcp | null> {
        return await this.definition.getDetail(id);
    }
}
