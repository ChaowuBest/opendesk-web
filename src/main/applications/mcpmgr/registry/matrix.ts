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

import { getPlatform } from '../../../../platforms/base.js';
import { MCPRegistryBase, type RegistryMcp, type SearchOptions, type SearchResult } from './base.js';

const MATRIX_BASE = 'https://matrix.openharmony.cn';
const REQUEST_TIMEOUT = 30000;

function toText(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function toNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

function mapNames(items: unknown[], localeKey: 'cnName' | 'enName' | 'name'): string[] {
    return items
        .map((item: any) => toText(item?.[localeKey] || item?.name || item?.enName || item?.cnName))
        .filter(Boolean);
}

export class MatrixMCPRegistry extends MCPRegistryBase {
    readonly id = 'matrix';
    readonly label = 'Matrix MCPs';
    readonly icon = '◇';
    readonly iconClass = 'matrix';

    override get slogan(): string {
        return '探索 OpenHarmony Matrix MCP 广场';
    }

    private mapMcp(item: any): RegistryMcp {
        const id = toText(item?.id || item?.enName || item?.name);
        const organizationName = toText(item?.organization?.enName || item?.organization?.name);
        const ownerName = toText(item?.owner?.account || item?.owner?.enName || item?.owner?.cnName);
        const categories = Array.isArray(item?.categoryList) ? mapNames(item.categoryList, 'cnName') : [];
        const tags = Array.isArray(item?.tags) ? mapNames(item.tags, 'name') : [];

        return {
            id,
            name: toText(item?.enName || item?.name || id),
            displayName: toText(item?.name || item?.enName || id),
            description: toText(item?.description || item?.name || item?.enName),
            author: organizationName || ownerName || toText(item?.author || item?.account),
            source: 'matrix',
            installUrl: `${this.installPrefix}${id}`,
            repository: toText(item?.repository || item?.sourceUrl),
            configuration: toText(item?.mcpServerConfiguration),
            logo: toText(item?.image),
            deployType: toText(item?.deployType),
            serverType: toText(item?.serverType),
            downloads: toNumber(item?.download),
            stars: toNumber(item?.favor),
            views: toNumber(item?.view),
            updateTime: toText(item?.updateTime),
            tags,
            categories,
            canInstall: Boolean(id && item?.mcpServerConfiguration)
        };
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = 30 } = opts;

        try {
            const body: Record<string, any> = {
                deployType: '',
                categoryId: '',
                keyword: query.trim(),
                orgId: '',
                pageNum: page,
                pageSize: limit,
                statusList: ['2', '3'],
                tagIds: []
            };

            const res = await getPlatform().fetch(`${MATRIX_BASE}/api/registry/mcp/mcps`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'User-Agent': 'OpenDesk/1.0'
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT)
            });

            if (!res.ok) throw new Error(`Matrix MCP API 请求失败: ${res.status}`);
            const data = await res.json();
            const records = data?.data?.list || data?.data?.records || [];
            const total = data?.data?.count || data?.data?.total || records.length;
            const mcps = records.map((item: any) => this.mapMcp(item));

            return {
                mcps,
                total,
                hasMore: page * limit < total,
                message: mcps.length > 0 ? `显示 ${mcps.length} / ${total} 个结果` : undefined
            };
        } catch (e: any) {
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                return { mcps: [], total: 0, hasMore: false, message: 'Matrix MCP 请求超时，请稍后重试' };
            }
            return {
                mcps: [],
                total: 0,
                hasMore: false,
                message: `Matrix MCP 搜索失败: ${e.message || '未知错误'}`
            };
        }
    }

    async getDetail(id: string): Promise<RegistryMcp | null> {
        if (!id) return null;

        const res = await getPlatform().fetch(`${MATRIX_BASE}/api/registry/mcp/details/${encodeURIComponent(id)}`, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'OpenDesk/1.0'
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
        if (!res.ok) throw new Error(`Matrix MCP 详情请求失败: ${res.status}`);
        const data = await res.json();
        const item = data?.data || data;
        return item ? this.mapMcp(item) : null;
    }
}
