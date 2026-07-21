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

import type { ApiAdapter, ApiAdapterContext, FetchResult } from './apiAdapter.js';

const JSON_HEADERS: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const API_BASE = 'https://gitcode.com/api/v5';

type EntryType = 'issues' | 'pulls' | 'commits' | 'releases' | 'contents' | 'milestones';

interface GitCodeApiInfo {
    owner: string;
    repo: string;
    type: EntryType;
    number?: string;
    sha?: string;
    tag?: string;
    ref?: string;
    path?: string;
}

/**
 * GitCode 适配器。
 *
 * GitCode 是纯 SPA，直接 HTTP 请求只能拿到骨架页。
 * 通过 Gitea 兼容的 REST API 可以直接获取结构化 JSON 数据。
 *
 * 支持的 URL 模式：
 * - `gitcode.com/{owner}/{repo}/issues/{number}`
 * - `gitcode.com/{owner}/{repo}/pulls/{number}`
 * - `gitcode.com/{owner}/{repo}/merge_requests/{number}`
 * - `gitcode.com/{owner}/{repo}/commit/{sha}`
 * - `gitcode.com/{owner}/{repo}/releases/tag/{tag}`
 * - `gitcode.com/{owner}/{repo}/releases/{id}`
 * - `gitcode.com/{owner}/{repo}/src/branch/{branch}/{path}`
 * - `gitcode.com/{owner}/{repo}/src/commit/{sha}/{path}`
 * - `gitcode.com/{owner}/{repo}/blob/{ref}/{path}`
 * - `gitcode.com/{owner}/{repo}/milestones/{id}`
 * - 以上均支持 `/-/` 前缀
 */
export class GitCodeAdapter implements ApiAdapter {
    readonly name = 'GitCode API';

    canHandle(url: string): boolean {
        return this.matchUrl(url) !== null;
    }

    async fetch(
        url: string,
        ctx: ApiAdapterContext,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const apiInfo = this.matchUrl(url);
        if (!apiInfo) return null;

        try {
            switch (apiInfo.type) {
                case 'issues':
                case 'pulls':
                    return await this.fetchIssueOrPr(apiInfo, ctx, onRetry);
                case 'commits':
                    return await this.fetchCommit(apiInfo, ctx, onRetry);
                case 'releases':
                    return await this.fetchRelease(apiInfo, ctx, onRetry);
                case 'contents':
                    return await this.fetchContents(apiInfo, ctx, onRetry);
                case 'milestones':
                    return await this.fetchMilestone(apiInfo, ctx, onRetry);
            }
        } catch {
            return null;
        }
        return null;
    }

    // ───────────────────── URL 匹配 ─────────────────────

    private matchUrl(url: string): GitCodeApiInfo | null {
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
        } catch {
            return null;
        }

        const hostname = parsedUrl.hostname.toLowerCase();
        if (hostname !== 'gitcode.com' && !hostname.endsWith('.gitcode.com')) return null;

        const path = parsedUrl.pathname.replace(/\/+$/, '');
        const m = (re: RegExp) => path.match(re);

        // Issues / Pulls / Merge requests (GitCode Web URL 用单数 pull，API 用复数 pulls)
        let r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?(issues|pull|pulls|merge_requests)\/(\d+)$/);
        if (r)
            return {
                owner: r[1],
                repo: r[2],
                type: r[3] === 'merge_requests' || r[3] === 'pull' ? 'pulls' : (r[3] as EntryType),
                number: r[4]
            };

        // Commits
        r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?commit\/([0-9a-f]{7,40})$/i);
        if (r) return { owner: r[1], repo: r[2], type: 'commits', sha: r[3] };

        // Releases by tag (must precede ID match)
        r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?releases\/tag\/(.+)$/);
        if (r) return { owner: r[1], repo: r[2], type: 'releases', tag: r[3] };

        // Releases by ID
        r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?releases\/(\d+)$/);
        if (r) return { owner: r[1], repo: r[2], type: 'releases', number: r[3] };

        // File content via src/branch
        r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?src\/branch\/([^/]+)\/(.+)$/);
        if (r) return { owner: r[1], repo: r[2], type: 'contents', ref: r[3], path: r[4] };

        // File content via src/commit
        r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?src\/commit\/([0-9a-f]{7,40})\/(.+)$/i);
        if (r) return { owner: r[1], repo: r[2], type: 'contents', ref: r[3], path: r[4] };

        // File content via blob (GitCode 兼容格式)
        r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?blob\/([^/]+)\/(.+)$/);
        if (r) return { owner: r[1], repo: r[2], type: 'contents', ref: r[3], path: r[4] };

        // Milestones
        r = m(/^\/([^/]+)\/([^/]+)\/(?:-\/)?milestones\/(\d+)$/);
        if (r) return { owner: r[1], repo: r[2], type: 'milestones', number: r[3] };

        return null;
    }

    // ───────────────────── Issues / PRs ─────────────────────

    private async fetchIssueOrPr(
        apiInfo: GitCodeApiInfo,
        ctx: ApiAdapterContext,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/${apiInfo.type}/${apiInfo.number}`;
        const response = await ctx.fetch(apiUrl, JSON_HEADERS, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        const markdown = this.formatIssueOrPr(data, apiInfo.type);

        const commentCount = typeof data.comments === 'number' ? data.comments : 0;
        if (commentCount > 0) {
            const commentsUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/issues/${apiInfo.number}/comments`;
            const commentsMd = await this.fetchComments(commentsUrl, ctx, JSON_HEADERS, onRetry);
            if (commentsMd) {
                return {
                    content: ctx.truncate(markdown + '\n\n---\n\n## 评论\n\n' + commentsMd),
                    strategy: `GitCode API (${apiInfo.type})`,
                    httpStatus: response.status
                };
            }
        }

        return {
            content: ctx.truncate(markdown),
            strategy: `GitCode API (${apiInfo.type})`,
            httpStatus: response.status
        };
    }

    private formatIssueOrPr(data: any, type: string): string {
        const lines: string[] = [];
        const isPr = type === 'pulls';
        const stateLabel = isPr
            ? data.merged_at
                ? '已合并'
                : data.state === 'closed'
                  ? '已关闭'
                  : '开放'
            : data.state === 'open'
              ? '开放'
              : '已关闭';

        lines.push(`# ${data.title || ''}`);
        lines.push('');
        lines.push(`**状态**: ${stateLabel}`);

        if (data.user?.name) {
            const handle = data.user.login ? ` ([@${data.user.login}](${data.user.html_url || ''}))` : '';
            lines.push(`**作者**: ${data.user.name}${handle}`);
        }
        if (data.assignee?.name) lines.push(`**指派给**: ${data.assignee.name}`);
        if (Array.isArray(data.labels) && data.labels.length > 0) {
            lines.push(`**标签**: ${data.labels.map((l: any) => l.name).join(', ')}`);
        }
        if (data.milestone?.title) lines.push(`**里程碑**: ${data.milestone.title}`);
        if (data.created_at) lines.push(`**创建时间**: ${data.created_at}`);
        if (data.updated_at && data.updated_at !== data.created_at) {
            lines.push(`**更新时间**: ${data.updated_at}`);
        }

        if (isPr) {
            if (data.base?.ref) lines.push(`**目标分支**: ${data.base.ref}`);
            if (data.merged_at) lines.push(`**合并时间**: ${data.merged_at}`);
            if (data.merged_by?.name) lines.push(`**合并者**: ${data.merged_by.name}`);
            if (data.draft) lines.push(`**草稿**: 是`);
        }

        lines.push('');
        lines.push(data.body?.trim() || '_(无描述)_');
        return lines.join('\n');
    }

    // ───────────────────── Commits ─────────────────────

    private async fetchCommit(
        apiInfo: GitCodeApiInfo,
        ctx: ApiAdapterContext,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/commits/${apiInfo.sha}`;
        const response = await ctx.fetch(apiUrl, JSON_HEADERS, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        return {
            content: ctx.truncate(this.formatCommit(data)),
            strategy: 'GitCode API (commits)',
            httpStatus: response.status
        };
    }

    private formatCommit(data: any): string {
        const lines: string[] = [];
        const commit = data.commit || data;
        const sha = data.sha || '';
        const shortSha = sha ? sha.slice(0, 8) : '';

        lines.push(`# Commit ${shortSha}`);
        lines.push('');

        const message = commit.message?.trim() || '_(无提交信息)_';
        lines.push(message);
        lines.push('');

        const author = commit.author;
        if (author?.name) lines.push(`**作者**: ${author.name} <${author.email || ''}>`);
        if (author?.date) lines.push(`**日期**: ${author.date}`);
        if (data.html_url) lines.push(`**链接**: ${data.html_url}`);

        const stats = commit.stats;
        if (stats) {
            lines.push(`**变更**: +${stats.additions ?? 0} / -${stats.deletions ?? 0}`);
        }

        if (Array.isArray(data.parents) && data.parents.length > 0) {
            const parents = data.parents
                .map((p: any) => p.sha?.slice(0, 8) || '')
                .filter(Boolean)
                .join(', ');
            if (parents) lines.push(`**父提交**: ${parents}`);
        }

        return lines.join('\n');
    }

    // ───────────────────── Releases ─────────────────────

    private async fetchRelease(
        apiInfo: GitCodeApiInfo,
        ctx: ApiAdapterContext,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const idOrTag = apiInfo.tag ? `tags/${apiInfo.tag}` : apiInfo.number;
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/releases/${idOrTag}`;
        const response = await ctx.fetch(apiUrl, JSON_HEADERS, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        return {
            content: ctx.truncate(this.formatRelease(data)),
            strategy: 'GitCode API (releases)',
            httpStatus: response.status
        };
    }

    private formatRelease(data: any): string {
        const lines: string[] = [];

        lines.push(`# ${data.name || data.tag_name || 'Release'}`);
        lines.push('');
        if (data.tag_name) lines.push(`**标签**: ${data.tag_name}`);
        if (data.author?.login) {
            const handle = data.author.html_url ? ` ([@${data.author.login}](${data.author.html_url}))` : '';
            lines.push(`**发布者**: @${data.author.login}${handle}`);
        }
        if (data.draft !== undefined) lines.push(`**草稿**: ${data.draft ? '是' : '否'}`);
        if (data.prerelease !== undefined) lines.push(`**预发布**: ${data.prerelease ? '是' : '否'}`);
        if (data.created_at) lines.push(`**创建时间**: ${data.created_at}`);
        if (data.published_at) lines.push(`**发布时间**: ${data.published_at}`);
        if (data.html_url) lines.push(`**链接**: ${data.html_url}`);

        if (Array.isArray(data.assets) && data.assets.length > 0) {
            lines.push('');
            lines.push('## 附件');
            for (const asset of data.assets) {
                const size = asset.size ? this.formatSize(asset.size) : '';
                const dl = asset.browser_download_url || asset.html_url || '';
                lines.push(`- [${asset.name}](${dl})${size ? ` (${size})` : ''}`);
            }
        }

        lines.push('');
        lines.push(data.body?.trim() || '_(无发布说明)_');
        return lines.join('\n');
    }

    // ───────────────────── File Contents ─────────────────────

    private async fetchContents(
        apiInfo: GitCodeApiInfo,
        ctx: ApiAdapterContext,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const encodedPath = apiInfo.path!.split('/').map(encodeURIComponent).join('/');
        const refParam = apiInfo.ref ? `?ref=${encodeURIComponent(apiInfo.ref)}` : '';
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/contents/${encodedPath}${refParam}`;
        const response = await ctx.fetch(apiUrl, JSON_HEADERS, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);

        // 目录列表
        if (Array.isArray(data)) {
            return {
                content: ctx.truncate(this.formatDirListing(data, apiInfo)),
                strategy: 'GitCode API (contents)',
                httpStatus: response.status
            };
        }

        // 单文件
        if (data.type === 'file') {
            return {
                content: ctx.truncate(this.formatFile(data, apiInfo)),
                strategy: 'GitCode API (contents)',
                httpStatus: response.status
            };
        }

        return null;
    }

    private formatFile(data: any, apiInfo: GitCodeApiInfo): string {
        const lines: string[] = [];
        const filePath = data.path || apiInfo.path || '';
        const ref = apiInfo.ref || '';
        const refPart = ref ? ` (${ref})` : '';

        lines.push(`# ${filePath}${refPart}`);
        lines.push('');

        if (data.size !== undefined) lines.push(`**大小**: ${this.formatSize(data.size)}`);
        if (data.sha) lines.push(`**SHA**: ${data.sha}`);
        if (data.html_url) lines.push(`**链接**: ${data.html_url}`);

        lines.push('');

        // 尝试从文件名推断语言
        const ext = filePath.split('.').pop() || '';
        lines.push('```' + ext);

        let content = '';
        if (data.encoding === 'base64' && data.content) {
            try {
                content = Buffer.from(data.content, 'base64').toString('utf-8');
            } catch {
                content = '_(无法解码文件内容)_';
            }
        } else if (data.content) {
            content = data.content;
        }

        lines.push(content || '_(空文件)_');
        lines.push('```');
        return lines.join('\n');
    }

    private formatDirListing(entries: any[], apiInfo: GitCodeApiInfo): string {
        const lines: string[] = [];
        const dirPath = apiInfo.path || '';
        const ref = apiInfo.ref || '';
        const refPart = ref ? ` (${ref})` : '';

        lines.push(`# ${dirPath || '/'}${refPart}`);
        lines.push('');
        lines.push('| 名称 | 类型 | 大小 |');
        lines.push('|------|------|------|');

        for (const entry of entries) {
            const name = entry.name || entry.path || '';
            const type = entry.type === 'dir' ? '📁 目录' : '📄 文件';
            const size = entry.size ? this.formatSize(entry.size) : '-';
            lines.push(`| ${name} | ${type} | ${size} |`);
        }

        return lines.join('\n');
    }

    // ───────────────────── Milestones ─────────────────────

    private async fetchMilestone(
        apiInfo: GitCodeApiInfo,
        ctx: ApiAdapterContext,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/milestones/${apiInfo.number}`;
        const response = await ctx.fetch(apiUrl, JSON_HEADERS, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        return {
            content: ctx.truncate(this.formatMilestone(data)),
            strategy: 'GitCode API (milestones)',
            httpStatus: response.status
        };
    }

    private formatMilestone(data: any): string {
        const lines: string[] = [];

        lines.push(`# ${data.title || 'Milestone'}`);
        lines.push('');
        lines.push(`**状态**: ${data.state === 'open' ? '开放' : '已关闭'}`);
        if (data.due_on) lines.push(`**截止日期**: ${data.due_on}`);
        if (data.created_at) lines.push(`**创建时间**: ${data.created_at}`);
        if (data.closed_at) lines.push(`**关闭时间**: ${data.closed_at}`);
        if (data.open_issues !== undefined) {
            lines.push(`**Issue**: ${data.open_issues} 开放 / ${data.closed_issues} 关闭`);
        }

        lines.push('');
        lines.push(data.description?.trim() || '_(无描述)_');
        return lines.join('\n');
    }

    // ───────────────────── Comments ─────────────────────

    private async fetchComments(
        commentsUrl: string,
        ctx: ApiAdapterContext,
        headers: Record<string, string>,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<string | null> {
        try {
            const response = await ctx.fetch(commentsUrl, headers, onRetry);
            if (!response.ok) return null;

            const body = await ctx.readBody(response);
            if (!body) return null;

            const comments = JSON.parse(body) as any[];
            if (!Array.isArray(comments) || comments.length === 0) return null;

            return comments
                .map((c) => {
                    const author = c.user?.name || c.user?.login || '匿名';
                    const time = c.created_at || '';
                    return `### ${author} — ${time}\n\n${c.body?.trim() || '_(无内容)_'}`;
                })
                .join('\n\n---\n\n');
        } catch {
            return null;
        }
    }

    // ───────────────────── Utils ─────────────────────

    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}
