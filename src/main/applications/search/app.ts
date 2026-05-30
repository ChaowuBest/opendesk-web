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

import { BaseApplication } from '../base';
import { BaseToolset } from '../../aikernel/tool';
import { z } from 'zod';
import { WebFetchTool } from './tools/webfetch';
import { WebSearchTool, type WebSearchChannel, WEB_CHANNELS } from './tools/webSearch';
import { AcademicSearchTool, type AcademicSearchChannel, ACADEMIC_CHANNELS } from './tools/academicSearch';
import { ConfigureSearchTool, ListSearchToolsTool, ToggleSearchToolTool } from './tools/manage';
import { Skill } from '../../aikernel/skill.js';
import { MANAGE_SEARCH_TOOLS_SKILL } from './skills';

const APIDependentChannelConfig = z.object({
    api_key: z.string().default('').describe('API密钥')
});

/**
 * 搜索应用配置 Schema。
 * channels 只存储需要 api_key 的渠道；不需要 api_key 的渠道（bing/duckduckgo/arxiv）天然可用。
 * defaultWebSearch / defaultAcademicSearch 指定当前默认使用的渠道。
 * webSearchEnabled / academicSearchEnabled 控制是否启用对应的搜索工具。
 */
const SearchApplicationConfigSchema = z.object({
    channels: z
        .object({
            tavily: APIDependentChannelConfig.optional(),
            brave: APIDependentChannelConfig.optional(),
            bocha: APIDependentChannelConfig.optional(),
            exa: APIDependentChannelConfig.optional()
        })
        .optional(),
    defaultWebSearch: z
        .enum(['tavily', 'bing', 'duckduckgo', 'brave', 'bocha', 'exa'])
        .default('bing')
        .describe('当前默认网页搜索引擎'),
    defaultAcademicSearch: z.enum(['arxiv']).default('arxiv').describe('当前默认学术搜索引擎'),
    webSearchEnabled: z.boolean().default(true).describe('是否启用网页搜索工具'),
    academicSearchEnabled: z.boolean().default(true).describe('是否启用学术搜索工具')
});

/** 旧配置结构（用于迁移） */
interface LegacyConfig {
    bing_search?: { enabled?: boolean };
    duckduckgo_search?: { enabled?: boolean };
    exa_search?: { api_key?: string; enabled?: boolean };
    brave_search?: { api_key?: string; enabled?: boolean };
    tavily_search?: { api_key?: string; enabled?: boolean };
    bocha_search?: { api_key?: string; enabled?: boolean };
    arxiv_search?: { enabled?: boolean };
    channels?: Record<string, { api_key?: string }>;
    defaultWebSearch?: string;
    defaultAcademicSearch?: string;
}

export class SearchApplication extends BaseApplication {
    constructor() {
        super('search', '融合搜索', false);
    }

    static getConfigSchema() {
        return SearchApplicationConfigSchema;
    }

    /**
     * 迁移旧配置到新格式，并返回规范化后的配置
     */
    private normalizeConfig(): z.output<typeof SearchApplicationConfigSchema> {
        const raw: any = super.getConfig() ?? {};

        // 如果已经是新格式（有 channels 或 defaultWebSearch），直接返回
        if (raw.channels || raw.defaultWebSearch) {
            return SearchApplicationConfigSchema.parse(raw);
        }

        // 从旧格式迁移
        const legacy = raw as LegacyConfig;
        const channels: Record<string, { api_key: string }> = {};

        if (legacy.tavily_search?.api_key) {
            channels.tavily = { api_key: legacy.tavily_search.api_key };
        }
        if (legacy.brave_search?.api_key) {
            channels.brave = { api_key: legacy.brave_search.api_key };
        }
        if (legacy.bocha_search?.api_key) {
            channels.bocha = { api_key: legacy.bocha_search.api_key };
        }
        if (legacy.exa_search?.api_key) {
            channels.exa = { api_key: legacy.exa_search.api_key };
        }

        const newConfig: any = { channels };
        return SearchApplicationConfigSchema.parse(newConfig);
    }

    /**
     * 获取规范化后的配置
     */
    getConfig(): z.output<typeof SearchApplicationConfigSchema> | undefined {
        return this.normalizeConfig();
    }

    /**
     * 获取某个需要 API Key 的渠道的 api_key
     */
    getChannelApiKey(channel: string): string {
        const config = this.normalizeConfig();
        const channels: any = config.channels ?? {};
        return channels[channel]?.api_key ?? '';
    }

    /**
     * 判断某个渠道是否可用。
     * 不需要 api_key 的渠道（bing/duckduckgo）天然可用；
     * 需要 api_key 的渠道需要配置了 key 才可用。
     */
    isChannelAvailable(channel: string): boolean {
        const meta = WEB_CHANNELS.find((c) => c.id === channel);
        if (!meta) return false;
        if (!meta.needsApiKey) return true;
        return this.getChannelApiKey(channel) !== '';
    }

    /**
     * 获取当前有效的默认 web search 渠道。
     * 如果配置的默认渠道不可用或为 'none'，回退到 duckduckgo（如果未禁用）或返回 null。
     */
    getEffectiveWebSearchChannel(): WebSearchChannel {
        const config = this.normalizeConfig();
        const preferred = config.defaultWebSearch as WebSearchChannel;
        if (this.isChannelAvailable(preferred)) return preferred;
        return 'bing';
    }

    /**
     * 获取当前有效的默认 academic search 渠道
     */
    getEffectiveAcademicSearchChannel(): AcademicSearchChannel {
        const config = this.normalizeConfig();
        return config.defaultAcademicSearch as AcademicSearchChannel;
    }

    /**
     * 获取可用的 Web 搜索渠道列表（用于 UI 展示）
     */
    getAvailableWebChannels(): Array<{
        id: string;
        name: string;
        description: string;
        available: boolean;
        apiKeyConfigured: boolean;
        needsApiKey: boolean;
    }> {
        return WEB_CHANNELS.map((meta) => ({
            id: meta.id,
            name: meta.name,
            description: meta.description,
            available: this.isChannelAvailable(meta.id),
            apiKeyConfigured: meta.needsApiKey ? this.getChannelApiKey(meta.id) !== '' : true,
            needsApiKey: meta.needsApiKey
        }));
    }

    /**
     * 获取学术搜索渠道列表
     */
    getAcademicChannels(): Array<{
        id: string;
        name: string;
        description: string;
    }> {
        return ACADEMIC_CHANNELS.map((meta) => ({
            id: meta.id,
            name: meta.name,
            description: meta.description
        }));
    }

    /**
     * 设置渠道的 api_key
     */
    async setChannelApiKey(channel: string, apiKey: string): Promise<void> {
        const config = this.normalizeConfig();
        if (!config.channels) {
            (config as any).channels = {};
        }
        const channels: any = config.channels;
        if (!channels[channel]) {
            channels[channel] = {};
        }
        channels[channel].api_key = apiKey;
        this.setConfig(config);
    }

    /**
     * 设置默认 Web 搜索渠道
     */
    async setDefaultWebSearch(channel: WebSearchChannel): Promise<void> {
        const config = this.normalizeConfig();
        (config as any).defaultWebSearch = channel;
        this.setConfig(config);
    }

    /**
     * 设置默认学术搜索渠道
     */
    async setDefaultAcademicSearch(channel: AcademicSearchChannel): Promise<void> {
        const config = this.normalizeConfig();
        (config as any).defaultAcademicSearch = channel;
        this.setConfig(config);
    }

    /**
     * 设置网页搜索开关
     */
    async setWebSearchEnabled(enabled: boolean): Promise<void> {
        const config = this.normalizeConfig();
        (config as any).webSearchEnabled = enabled;
        this.setConfig(config);
    }

    /**
     * 设置学术搜索开关
     */
    async setAcademicSearchEnabled(enabled: boolean): Promise<void> {
        const config = this.normalizeConfig();
        (config as any).academicSearchEnabled = enabled;
        this.setConfig(config);
    }

    /** @deprecated 保留用于 manage.ts 中的兼容 */
    async configureSearchTool(id: string, updates: { api_key?: string; enabled?: boolean }): Promise<void> {
        if (updates.api_key !== undefined && updates.api_key !== '') {
            await this.setChannelApiKey(id, updates.api_key);
        } else if (updates.api_key === '') {
            await this.setChannelApiKey(id, '');
        }
        // enabled 在新架构中不再使用，忽略
    }

    /** @deprecated 保留用于 manage.ts 中的兼容 */
    async toggleSearchTool(_id: string, _enabled: boolean): Promise<void> {
        // 新架构中不再需要 toggle，由 defaultWebSearch 选择决定
    }

    /**
     * 获取搜索渠道信息列表（用于 manage skill 展示）
     */
    public getSearchToolsFromConfig(): Array<{
        id: string;
        name: string;
        type: string;
        enabled: boolean;
        api_key?: string;
        description?: string;
        canDisable?: boolean;
    }> {
        const channels = this.getAvailableWebChannels();
        const academicChannels = this.getAcademicChannels();
        const defaultWeb = this.getEffectiveWebSearchChannel();
        const defaultAcademic = this.getEffectiveAcademicSearchChannel();

        const webList = channels.map((ch) => ({
            id: ch.id,
            name: ch.name,
            type: 'web',
            enabled: ch.id === defaultWeb,
            api_key: ch.needsApiKey ? this.getChannelApiKey(ch.id) || undefined : undefined,
            description: ch.description,
            canDisable: false
        }));

        const academicList = academicChannels.map((ch) => ({
            id: ch.id,
            name: ch.name,
            type: 'academic',
            enabled: ch.id === defaultAcademic,
            description: ch.description,
            canDisable: false
        }));

        return [...webList, ...academicList];
    }

    async getToolsets() {
        const toolset = new BaseToolset('search');
        const config = this.normalizeConfig();
        const webEnabled = config.webSearchEnabled ?? true;
        const academicEnabled = config.academicSearchEnabled ?? true;

        // 根据开关决定是否添加 Web 搜索工具
        if (webEnabled) {
            const webChannel = this.getEffectiveWebSearchChannel();
            const webApiKey = this.getChannelApiKey(webChannel);
            toolset.addTool(new WebSearchTool(webChannel, webApiKey));
        }

        // 根据开关决定是否添加学术搜索工具
        if (academicEnabled) {
            const academicChannel = this.getEffectiveAcademicSearchChannel();
            toolset.addTool(new AcademicSearchTool(academicChannel));
        }

        // WebFetch 保持独立
        toolset.addTool(new WebFetchTool());

        return [toolset];
    }

    async getSkills(): Promise<Skill[]> {
        const searchManageSkill = Skill.parseMd(MANAGE_SEARCH_TOOLS_SKILL);
        const searchManageToolset = new BaseToolset('search-manage');

        searchManageToolset.addTool(new ConfigureSearchTool(this));
        searchManageToolset.addTool(new ListSearchToolsTool(this));
        searchManageToolset.addTool(new ToggleSearchToolTool(this));
        searchManageSkill.toolsets = [searchManageToolset];

        return [searchManageSkill];
    }
}
