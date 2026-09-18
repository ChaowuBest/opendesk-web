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

const BASE_URL = 'https://www.modelscope.cn';
const MCP_AGG_ENDPOINT = `${BASE_URL}/api/v1/dolphin/agg`;
const REQUEST_TIMEOUT = 30000;
const DEFAULT_LIMIT = 20;

function toText(value) {
    return typeof value === 'string' ? value : '';
}

function toNumber(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function toStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => toText(item)).filter(Boolean);
}

function toDateText(value) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
}

function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * ModelScope MCP 注册表（原 mcpmgr/registry/modelscope.ts 的实现，经 registry capability 贡献）。
 * 注意 id 保持为 'modelscope-mcp'：installUrl（modelscope-mcp:<id>）与用户配置中的
 * registryId 都依赖该值，改动会导致已安装条目的来源追踪失效。
 * @param {{ fetch: typeof fetch }} registryApi 宿主注入的 registry 能力（fetch 继承代理配置）
 */
export function createModelScopeMcpRegistryDefinition(registryApi) {
    function buildMcpId(s) {
        const name = toText(s.Name);
        const path = toText(s.Path);
        return path ? `${path}/${name}` : name;
    }

    function getServersFromConfig(config) {
        const servers = config.mcpServers || config.servers || config;
        return isRecord(servers) ? servers : null;
    }

    function hasInstallableServerConfig(config) {
        if (!isRecord(config)) return false;
        const servers = getServersFromConfig(config);
        if (!servers) return false;
        return Object.values(servers).some((entry) => isRecord(entry) && (entry.command || entry.url));
    }

    function pickInstallableConfig(configs) {
        if (Array.isArray(configs)) {
            return configs.find((config) => hasInstallableServerConfig(config)) || null;
        }
        return hasInstallableServerConfig(configs) ? configs : null;
    }

    function stringifyInstallableConfig(configs) {
        const config = pickInstallableConfig(configs);
        return config ? JSON.stringify(config, null, 2) : undefined;
    }

    function getConfiguration(s) {
        return (
            stringifyInstallableConfig(s.StreamableHTTPServerConfig) ||
            stringifyInstallableConfig(s.SSEServerConfig) ||
            stringifyInstallableConfig(s.ServerConfig)
        );
    }

    function getRepository(s) {
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

    function inferServerType(configuration) {
        if (!configuration) return undefined;

        try {
            const parsed = JSON.parse(configuration);
            const servers = getServersFromConfig(parsed);
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

    function splitMcpId(id) {
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

    function getFavoriteCount(s) {
        return toNumber(s.Stars || s.StarCount) || 0;
    }

    function sortByFavorites(servers) {
        return [...servers].sort((a, b) => {
            const favoriteDiff = getFavoriteCount(b) - getFavoriteCount(a);
            if (favoriteDiff !== 0) return favoriteDiff;

            return buildMcpId(a).localeCompare(buildMcpId(b));
        });
    }

    async function initCookies() {
        try {
            await registryApi.fetch(`${BASE_URL}/mcp`, {
                signal: AbortSignal.timeout(10000)
            });
        } catch {
            // best-effort cookie init
        }
    }

    async function fetchMcpAgg(body) {
        return registryApi.fetch(MCP_AGG_ENDPOINT, {
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

    function getMcpBucket(data) {
        return (
            data?.Data?.Data?.Mcp ||
            data?.Data?.Mcp ||
            data?.Data?.Data?.McpServer ||
            data?.Data?.McpServer ||
            data?.Mcp ||
            data?.McpServer
        );
    }

    function mapMcp(s) {
        const id = buildMcpId(s);
        const author = toText(s.NickName || s.Path || s.CreatedBy || s.FromSitePath);
        const description = toText(s.AbstractCN || s.Abstract || s.Description || s.OriginalAbstract || s.ChineseName);
        const configuration = getConfiguration(s);
        const categories = toStringArray(s.Category || s.Domain);
        const tags = toStringArray(s.Tags);

        return {
            id,
            name: toText(s.ChineseName || s.Name),
            displayName: toText(s.ChineseName || s.Name),
            description,
            author: author || undefined,
            source: 'modelscope',
            installUrl: `modelscope-mcp:${encodeURIComponent(id)}`,
            repository: getRepository(s),
            configuration,
            logo: toText(s.FromSiteIcon || s.Avatar || s.CoverImage),
            deployType: typeof s.Hosted === 'boolean' ? (s.Hosted ? 'Hosted' : 'Local') : undefined,
            serverType: inferServerType(configuration),
            downloads: toNumber(s.Downloads || s.CallVolume),
            stars: toNumber(s.Stars || s.StarCount),
            views: toNumber(s.ViewCount || s.Visits),
            updateTime: toDateText(s.GmtUpdated || s.UpdatedAt || s.LastUpdatedTime || s.CreatedTime || s.GmtCreated),
            tags,
            categories,
            canInstall: Boolean(configuration)
        };
    }

    return {
        id: 'modelscope-mcp',
        label: 'ModelScope',
        icon: '🔮',
        iconClass: 'modelscope',
        slogan: '魔搭社区 MCP 广场',

        async search(opts = {}) {
            const { query = '', page = 1, limit = DEFAULT_LIMIT } = opts;

            const body = {
                PageSize: Math.min(limit, 60),
                PageNumber: page,
                Query: query.trim(),
                Criterion: []
            };

            try {
                let res;
                try {
                    res = await fetchMcpAgg(body);
                } catch {
                    await initCookies();
                    res = await fetchMcpAgg(body);
                }

                if (!res.ok) throw new Error(`ModelScope API 请求失败: ${res.status}`);

                const data = await res.json();
                if (data.Code !== 200) {
                    throw new Error(data.Message || 'ModelScope API 返回错误');
                }

                const bucket = getMcpBucket(data);
                const servers = Array.isArray(bucket?.McpServers) ? bucket.McpServers : [];
                const totalCount = toNumber(bucket?.TotalCount) || servers.length;
                const mcps = sortByFavorites(servers)
                    .map((s) => mapMcp(s))
                    .filter((mcp) => Boolean(mcp.id));

                return {
                    mcps,
                    total: totalCount,
                    hasMore: page * limit < totalCount,
                    message: mcps.length > 0 ? `显示 ${mcps.length} / ${totalCount} 个结果` : undefined
                };
            } catch (e) {
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
        },

        async getDetail(id) {
            if (!id) return null;
            const parsedId = splitMcpId(id);

            const body = {
                PageSize: 60,
                PageNumber: 1,
                Query: parsedId.name,
                Criterion: []
            };

            try {
                let res;
                try {
                    res = await fetchMcpAgg(body);
                } catch {
                    await initCookies();
                    res = await fetchMcpAgg(body);
                }

                if (!res.ok) return null;

                const data = await res.json();
                const bucket = getMcpBucket(data);
                const servers = Array.isArray(bucket?.McpServers) ? bucket.McpServers : [];
                const match =
                    servers.find((s) => buildMcpId(s) === id) ||
                    servers.find(
                        (s) =>
                            s.Name === parsedId.name &&
                            (!parsedId.path ||
                                s.Path === parsedId.path ||
                                s.FromSitePath === parsedId.path.replace(/^@/, ''))
                    ) ||
                    servers.find((s) => s.Name === parsedId.name || s.ChineseName === parsedId.name);
                if (!match) return null;

                return mapMcp(match);
            } catch {
                return null;
            }
        }
    };
}
