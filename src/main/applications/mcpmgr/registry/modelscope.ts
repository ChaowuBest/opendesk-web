/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { getPlatform } from '../../../../platforms/base.js';
import { MCPRegistryBase, type RegistryMcp, type SearchOptions, type SearchResult } from './base.js';

const BASE_URL = 'https://www.modelscope.cn';
const MCP_AGG_ENDPOINT = `${BASE_URL}/api/v1/dolphin/agg`;
const REQUEST_TIMEOUT = 30000;
const DEFAULT_LIMIT = 20;

function toText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => toText(item)).filter(Boolean);
}

function toDateText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export class ModelScopeMCPRegistry extends MCPRegistryBase {
    readonly id = 'modelscope-mcp';
    readonly label = 'ModelScope';
    readonly icon = '🔮';
    readonly iconClass = 'modelscope';

    override get slogan(): string {
        return '魔搭社区 MCP 广场';
    }

    private async initCookies(): Promise<void> {
        try {
            await getPlatform().fetch(`${BASE_URL}/mcp`, {
                signal: AbortSignal.timeout(10000)
            });
        } catch {
            // best-effort cookie init
        }
    }

    override parseInstallUrl(installUrl: string): { id: string } | null {
        const parsed = super.parseInstallUrl(installUrl);
        if (!parsed) return null;
        return { id: decodeURIComponent(parsed.id) };
    }

    private async fetchMcpAgg(body: Record<string, any>): Promise<Response> {
        return getPlatform().fetch(MCP_AGG_ENDPOINT, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenDesk/1.0'
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
    }

    private getMcpBucket(data: any): any {
        return (
            data?.Data?.Data?.Mcp ||
            data?.Data?.Mcp ||
            data?.Data?.Data?.McpServer ||
            data?.Data?.McpServer ||
            data?.Mcp ||
            data?.McpServer
        );
    }

    private buildMcpId(s: any): string {
        const name = toText(s.Name);
        const path = toText(s.Path);
        return path ? `${path}/${name}` : name;
    }

    private getFavoriteCount(s: any): number {
        return toNumber(s.Stars || s.StarCount) || 0;
    }

    private sortByFavorites(servers: any[]): any[] {
        return [...servers].sort((a, b) => {
            const favoriteDiff = this.getFavoriteCount(b) - this.getFavoriteCount(a);
            if (favoriteDiff !== 0) return favoriteDiff;

            return this.buildMcpId(a).localeCompare(this.buildMcpId(b));
        });
    }

    private splitMcpId(id: string): { path?: string; name: string } {
        const normalized = decodeURIComponent(id || '').trim();
        const index = normalized.lastIndexOf('/');
        if (index > 0 && index < normalized.length - 1) {
            return {
                path: normalized.slice(0, index),
                name: normalized.slice(index + 1)
            };
        }
        return { name: normalized };
    }

    private getServersFromConfig(config: Record<string, any>): Record<string, any> | null {
        const servers = config.mcpServers || config.servers || config;
        return isRecord(servers) ? servers : null;
    }

    private hasInstallableServerConfig(config: unknown): config is Record<string, any> {
        if (!isRecord(config)) return false;
        const servers = this.getServersFromConfig(config);
        if (!servers) return false;
        return Object.values(servers).some((entry) => isRecord(entry) && (entry.command || entry.url));
    }

    private pickInstallableConfig(configs: unknown): Record<string, any> | null {
        if (Array.isArray(configs)) {
            return configs.find((config) => this.hasInstallableServerConfig(config)) || null;
        }
        return this.hasInstallableServerConfig(configs) ? configs : null;
    }

    private stringifyInstallableConfig(configs: unknown): string | undefined {
        const config = this.pickInstallableConfig(configs);
        return config ? JSON.stringify(config, null, 2) : undefined;
    }

    private getConfiguration(s: any): string | undefined {
        return (
            this.stringifyInstallableConfig(s.StreamableHTTPServerConfig) ||
            this.stringifyInstallableConfig(s.SSEServerConfig) ||
            this.stringifyInstallableConfig(s.ServerConfig)
        );
    }

    private getRepository(s: any): string | undefined {
        const directUrl = toText(s.FromSiteUrl || s.Repository || s.SourceUrl);
        if (directUrl) return directUrl;

        const fromSite = toText(s.FromSite).toLowerCase();
        const fromSitePath = toText(s.FromSitePath).replace(/^@/, '');
        const name = toText(s.Name);
        if (fromSite === 'github' && fromSitePath && name) {
            return `https://github.com/${fromSitePath}/${name}`;
        }

        return undefined;
    }

    private inferServerType(configuration?: string): string | undefined {
        if (!configuration) return undefined;

        try {
            const parsed = JSON.parse(configuration);
            const servers = this.getServersFromConfig(parsed);
            const first = servers ? Object.values(servers).find((entry) => isRecord(entry)) : undefined;
            if (!isRecord(first)) return undefined;

            const type = toText(first.type || first.transport)
                .toLowerCase()
                .replace(/[_-]/g, '');
            if (type === 'sse') return 'sse';
            if (type === 'streamablehttp') return 'streamableHttp';
            if (first.url) return toText(first.url).includes('/sse') ? 'sse' : 'streamableHttp';
            if (first.command) return 'stdio';
        } catch {
            return undefined;
        }

        return undefined;
    }

    private mapMcp(s: any): RegistryMcp {
        const id = this.buildMcpId(s);
        const author = toText(s.NickName || s.Path || s.CreatedBy || s.FromSitePath);
        const description = toText(s.AbstractCN || s.Abstract || s.Description || s.OriginalAbstract || s.ChineseName);
        const configuration = this.getConfiguration(s);
        const categories = toStringArray(s.Category || s.Domain);
        const tags = toStringArray(s.Tags);

        return {
            id,
            name: toText(s.ChineseName || s.Name),
            displayName: toText(s.ChineseName || s.Name),
            description,
            author: author || undefined,
            source: 'modelscope',
            installUrl: `${this.installPrefix}${encodeURIComponent(id)}`,
            repository: this.getRepository(s),
            configuration,
            logo: toText(s.FromSiteIcon || s.Avatar || s.CoverImage),
            deployType: typeof s.Hosted === 'boolean' ? (s.Hosted ? 'Hosted' : 'Local') : undefined,
            serverType: this.inferServerType(configuration),
            downloads: toNumber(s.Downloads || s.CallVolume),
            stars: toNumber(s.Stars || s.StarCount),
            views: toNumber(s.ViewCount || s.Visits),
            updateTime: toDateText(s.GmtUpdated || s.UpdatedAt || s.LastUpdatedTime || s.CreatedTime || s.GmtCreated),
            tags,
            categories,
            canInstall: Boolean(configuration)
        };
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = DEFAULT_LIMIT } = opts;

        const body: Record<string, any> = {
            PageSize: Math.min(limit, 60),
            PageNumber: page,
            Query: query.trim(),
            Criterion: []
        };

        try {
            let res: Response;
            try {
                res = await this.fetchMcpAgg(body);
            } catch {
                await this.initCookies();
                res = await this.fetchMcpAgg(body);
            }

            if (!res.ok) throw new Error(`ModelScope API 请求失败: ${res.status}`);

            const data = await res.json();
            if (data.Code !== 200) {
                throw new Error(data.Message || 'ModelScope API 返回错误');
            }

            const bucket = this.getMcpBucket(data);
            const servers = Array.isArray(bucket?.McpServers) ? bucket.McpServers : [];
            const totalCount = toNumber(bucket?.TotalCount) || servers.length;
            const mcps = this.sortByFavorites(servers)
                .map((s: any) => this.mapMcp(s))
                .filter((mcp: RegistryMcp) => Boolean(mcp.id));

            return {
                mcps,
                total: totalCount,
                hasMore: page * limit < totalCount,
                message: mcps.length > 0 ? `显示 ${mcps.length} / ${totalCount} 个结果` : undefined
            };
        } catch (e: any) {
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                return { mcps: [], total: 0, hasMore: false, message: 'ModelScope 搜索超时，请稍后重试' };
            }
            return {
                mcps: [],
                total: 0,
                hasMore: false,
                message: `ModelScope 搜索失败: ${e.message || '未知错误'}`
            };
        }
    }

    async getDetail(id: string): Promise<RegistryMcp | null> {
        if (!id) return null;
        const parsedId = this.splitMcpId(id);

        const body = {
            PageSize: 60,
            PageNumber: 1,
            Query: parsedId.name,
            Criterion: []
        };

        try {
            let res: Response;
            try {
                res = await this.fetchMcpAgg(body);
            } catch {
                await this.initCookies();
                res = await this.fetchMcpAgg(body);
            }

            if (!res.ok) return null;

            const data = await res.json();
            const bucket = this.getMcpBucket(data);
            const servers = Array.isArray(bucket?.McpServers) ? bucket.McpServers : [];
            const match =
                servers.find((s: any) => this.buildMcpId(s) === id) ||
                servers.find(
                    (s: any) =>
                        s.Name === parsedId.name &&
                        (!parsedId.path ||
                            s.Path === parsedId.path ||
                            s.FromSitePath === parsedId.path.replace(/^@/, ''))
                ) ||
                servers.find((s: any) => s.Name === parsedId.name || s.ChineseName === parsedId.name);
            if (!match) return null;

            return this.mapMcp(match);
        } catch {
            return null;
        }
    }
}
