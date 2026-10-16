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
 * 贡献注册表适配器：把插件经 registry capability 注册的技能注册表包装成
 * SkillRegistryBase，使 skillmgr 的市场 UI、TUI、agent 工具与安装流程
 * 无需感知插件来源。
 *
 * 两个变体：
 * - ContributedSkillRegistry：主进程使用，直接调用定义对象（同线程闭包）。
 * - ProxySkillRegistry：worker 线程使用，只拿到可序列化的元数据
 *   （PluginSkillRegistryInfo），search/resolveInstall 经 worker-bridge
 *   RPC 回主进程执行。
 */

import type {
    PluginPlatform,
    PluginRegistryFilterDef,
    PluginSkillRegistryDefinition
} from '../../../../../packages/plugin-sdk/src/index.js';
import { SkillRegistryBase, type RegistryFilterDef, type SearchOptions, type SearchResult } from './base.js';

/**
 * 判断筛选器是否适用于指定平台：未声明 platforms（或声明为空数组）时所有平台可用。
 * GUI 只渲染当前平台可用的筛选器，避免出现平台专属开关（如「鸿蒙PC兼容技能」）在
 * 无关平台上无意义的展示。
 */
export function isFilterAvailableOnPlatform(filter: PluginRegistryFilterDef, platform: string): boolean {
    return !filter.platforms?.length || filter.platforms.includes(platform as PluginPlatform);
}

/** worker 线程可见的注册表元数据（可结构化克隆的纯数据） */
export interface PluginSkillRegistryInfo {
    id: string;
    label: string;
    icon?: string;
    iconClass?: string;
    slogan?: string;
    guiHidden?: boolean;
    filters?: PluginRegistryFilterDef[];
    /** 定义是否声明了 resolveInstall（worker 侧据此决定是否发起 RPC） */
    supportsResolveInstall: boolean;
}

interface ContributedRegistryMeta {
    readonly id: string;
    readonly label: string;
    readonly icon?: string;
    readonly iconClass?: string;
    readonly slogan?: string;
    readonly guiHidden?: boolean;
}

abstract class ContributedSkillRegistryBase extends SkillRegistryBase {
    readonly id: string;
    readonly label: string;
    readonly icon: string;
    readonly iconClass: string;
    readonly guiHidden: boolean;

    protected constructor(meta: ContributedRegistryMeta) {
        super();
        this.id = meta.id;
        this.label = meta.label;
        this.icon = meta.icon ?? '🧩';
        this.iconClass = meta.iconClass ?? meta.id;
        this.guiHidden = meta.guiHidden === true;
    }

    protected abstract get metaSlogan(): string | undefined;

    /** 插件声明的原始筛选器；平台裁剪统一在 filters 出口完成 */
    protected abstract get rawFilters(): PluginRegistryFilterDef[];

    override get slogan(): string {
        return this.metaSlogan ?? super.slogan;
    }

    override get filters(): RegistryFilterDef[] {
        return this.rawFilters.filter((filter) => isFilterAvailableOnPlatform(filter, process.platform));
    }
}

/** 主进程侧适配器：直接委托给插件定义对象 */
export class ContributedSkillRegistry extends ContributedSkillRegistryBase {
    protected get metaSlogan(): string | undefined {
        return this.definition.slogan;
    }

    protected override get rawFilters(): PluginRegistryFilterDef[] {
        return this.definition.filters ?? [];
    }

    constructor(private readonly definition: PluginSkillRegistryDefinition) {
        super(definition);
    }

    override async search(opts?: SearchOptions): Promise<SearchResult> {
        return await this.definition.search(opts);
    }

    /** 安装计划解析：定义未声明 resolveInstall 时返回 null，由安装流程走内置规则 */
    resolveInstall(
        installUrl: string,
        parsed: { slug: string; version?: string }
    ): Promise<{ downloadUrl: string } | null> {
        return this.definition.resolveInstall
            ? this.definition.resolveInstall(installUrl, parsed)
            : Promise.resolve(null);
    }
}

/** worker 线程侧适配器：经 RPC 桥委托主进程执行 */
export class ProxySkillRegistry extends ContributedSkillRegistryBase {
    protected get metaSlogan(): string | undefined {
        return this.info.slogan;
    }

    protected override get rawFilters(): PluginRegistryFilterDef[] {
        return this.info.filters ?? [];
    }

    constructor(
        private readonly info: PluginSkillRegistryInfo,
        private readonly invoke: <R>(method: string, ...args: unknown[]) => Promise<R>
    ) {
        super(info);
    }

    override async search(opts?: SearchOptions): Promise<SearchResult> {
        return await this.invoke<SearchResult>('searchPluginSkillRegistry', this.id, opts ?? {});
    }

    async resolveInstall(
        installUrl: string,
        parsed: { slug: string; version?: string }
    ): Promise<{ downloadUrl: string } | null> {
        if (!this.info.supportsResolveInstall) return null;
        return await this.invoke<{ downloadUrl: string } | null>(
            'resolvePluginSkillInstall',
            this.id,
            installUrl,
            parsed
        );
    }
}

/** 把插件定义序列化为 worker 线程可传递的元数据 */
export function serializeSkillRegistryInfo(definition: PluginSkillRegistryDefinition): PluginSkillRegistryInfo {
    return {
        id: definition.id,
        label: definition.label,
        icon: definition.icon,
        iconClass: definition.iconClass,
        slogan: definition.slogan,
        guiHidden: definition.guiHidden === true ? true : undefined,
        filters: definition.filters,
        supportsResolveInstall: typeof definition.resolveInstall === 'function'
    };
}
