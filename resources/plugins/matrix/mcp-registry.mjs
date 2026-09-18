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

const MATRIX_BASE = 'https://matrix.openharmony.cn';
const REQUEST_TIMEOUT = 30000;

function toText(value) {
    return typeof value === 'string' ? value : '';
}

function toNumber(value) {
    return typeof value === 'number' ? value : undefined;
}

function mapNames(items, localeKey) {
    return items.map((item) => toText(item?.[localeKey] || item?.name || item?.enName || item?.cnName)).filter(Boolean);
}

function hasServerEntries(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const servers = value.mcpServers || value.servers || value;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return false;
    return Object.keys(servers).length > 0;
}

/** 依次尝试原文、Markdown 代码块与首尾大括号片段的宽松 JSON 解析 */
function tryParseConfiguration(text) {
    const candidates = [text];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim());
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate);
        } catch {
            // 尝试下一个候选片段
        }
    }
    return undefined;
}

/**
 * 空配置（如平台数据只填了 "{}"）在安装时解析不出任何 server，视为不可安装；
 * 无法解析的内容不在此判定，交由安装流程给出具体错误。
 */
function hasInstallableConfiguration(raw) {
    const text = toText(raw).trim();
    if (!text) return false;
    const parsed = tryParseConfiguration(text);
    if (parsed === undefined) return true;
    return hasServerEntries(parsed);
}

/**
 * Matrix MCP 注册表（原 mcpmgr/registry/matrix.ts 的实现，经 registry capability 贡献）。
 * @param {{ fetch: typeof fetch }} registryApi 宿主注入的 registry 能力（fetch 继承代理配置）
 */
export function createMatrixMcpRegistryDefinition(registryApi) {
    return {
        id: 'matrix',
        label: 'Matrix MCPs',
        icon: '◇',
        iconClass: 'matrix',
        slogan: '探索 OpenHarmony Matrix MCP 广场',

        mapMcp(item) {
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
                installUrl: `matrix:${id}`,
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
                canInstall: Boolean(id && hasInstallableConfiguration(item?.mcpServerConfiguration))
            };
        },

        async search(opts = {}) {
            const { query = '', page = 1, limit = 30 } = opts;

            try {
                const body = {
                    deployType: '',
                    categoryId: '',
                    keyword: query.trim(),
                    orgId: '',
                    pageNum: page,
                    pageSize: limit,
                    statusList: ['2', '3'],
                    tagIds: []
                };

                const res = await registryApi.fetch(`${MATRIX_BASE}/api/registry/mcp/mcps`, {
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
                const mcps = records.map((item) => this.mapMcp(item));

                return {
                    mcps,
                    total,
                    hasMore: page * limit < total,
                    message: mcps.length > 0 ? `显示 ${mcps.length} / ${total} 个结果` : undefined
                };
            } catch (e) {
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
        },

        async getDetail(id) {
            if (!id) return null;

            const res = await registryApi.fetch(`${MATRIX_BASE}/api/registry/mcp/details/${encodeURIComponent(id)}`, {
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
    };
}
