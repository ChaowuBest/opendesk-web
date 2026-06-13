/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { getPlatform } from '../../../../platforms/base.js';
import { MCPRegistryBase, type RegistryMcp, type SearchOptions, type SearchResult } from './base.js';

const BASE_URL = 'https://www.modelscope.cn';
const STUDIOS_ENDPOINT = `${BASE_URL}/api/v1/dolphin/studios`;
const REQUEST_TIMEOUT = 30000;
const DEFAULT_LIMIT = 20;

function toText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function toNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
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

    private async fetchStudios(body: Record<string, any>): Promise<Response> {
        return getPlatform().fetch(STUDIOS_ENDPOINT, {
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

    private mapMcp(s: any): RegistryMcp {
        const name = toText(s.Name);
        const author = toText(s.CreatedBy);
        const description = toText(s.Description || s.ChineseName);

        return {
            id: name,
            name: toText(s.ChineseName || s.Name),
            displayName: toText(s.ChineseName || s.Name),
            description,
            author: author || undefined,
            source: 'modelscope',
            installUrl: `${this.installPrefix}${name}`,
            repository: toText(s.Domain),
            logo: toText(s.Avatar || s.CoverImage),
            deployType: toText(s.SdkType),
            serverType: 'sse', // ModelScope MCP 默认使用托管 SSE
            downloads: toNumber(s.Downloads),
            stars: toNumber(s.StarCount),
            updateTime: toText(s.CreatedTime),
            tags: [],
            categories: toText(s.ScenariosName) ? [toText(s.ScenariosName)] : [],
            canInstall: Boolean(s.McpServer || s.Domain)
        };
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = DEFAULT_LIMIT } = opts;

        const criterion: Record<string, any>[] = [
            { Field: 'Scenarios', Value: '18' },
            { Field: 'McpServer', Value: 'true' }
        ];

        const body: Record<string, any> = {
            PageSize: Math.min(limit, 60),
            PageNumber: page,
            Query: query.trim(),
            Sort: 'Downloads',
            Criterion: criterion
        };

        try {
            let res: Response;
            try {
                res = await this.fetchStudios(body);
            } catch {
                await this.initCookies();
                res = await this.fetchStudios(body);
            }

            if (!res.ok) throw new Error(`ModelScope API 请求失败: ${res.status}`);

            const data = await res.json();
            if (data.Code !== 200) {
                throw new Error(data.Message || 'ModelScope API 返回错误');
            }

            const studios = data.Data?.Studios || [];
            const totalCount = data.Data?.TotalCount || 0;
            const mcps = studios.map((s: any) => this.mapMcp(s));

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

        const body = {
            PageSize: 1,
            PageNumber: 1,
            Query: id,
            Sort: 'Downloads',
            Criterion: [
                { Field: 'Scenarios', Value: '18' },
                { Field: 'McpServer', Value: 'true' }
            ]
        };

        try {
            let res: Response;
            try {
                res = await this.fetchStudios(body);
            } catch {
                await this.initCookies();
                res = await this.fetchStudios(body);
            }

            if (!res.ok) return null;

            const data = await res.json();
            const studios = data.Data?.Studios || [];
            const match = studios.find((s: any) => s.Name === id || s.ChineseName === id);
            if (!match) return null;

            return this.mapMcp(match);
        } catch {
            return null;
        }
    }
}
