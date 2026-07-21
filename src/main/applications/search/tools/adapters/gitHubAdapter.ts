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
    Accept: 'application/vnd.github+json',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const API_BASE = 'https://api.github.com';

type EntryType = 'issues' | 'pulls' | 'commits' | 'releases' | 'contents' | 'gist';

interface GitHubApiInfo {
    type: EntryType;
    owner?: string;
    repo?: string;
    number?: string;
    sha?: string;
    tag?: string;
    ref?: string;
    path?: string;
    gistId?: string;
}

/**
 * GitHub 适配器。
 *
 * GitHub 的 PR/Issue 页面虽然是服务端渲染的，但包含大量导航和 UI 元素。
 * 通过 REST API 可以直接获取结构化 JSON 数据，输出干净且信息完整。
 *
 * 支持的 URL 模式：
 * - `github.com/{owner}/{repo}/pull/{number}` (Web URL 用单数 pull)
 * - `github.com/{owner}/{repo}/pulls/{number}`
 * - `github.com/{owner}/{repo}/issues/{number}`
 * - `github.com/{owner}/{repo}/commit/{sha}`
 * - `github.com/{owner}/{repo}/releases/tag/{tag}`
 * - `github.com/{owner}/{repo}/releases/{id}`
 * - `github.com/{owner}/{repo}/blob/{ref}/{path}`
 * - `gist.github.com/{user}/{id}`
 *
 * 公开仓库无需 token 即可读取（受 60 次/小时速率限制）。
 * 若环境变量中设置了 GITHUB_TOKEN 或 GH_TOKEN，则自动携带以提升速率限制。
 */
export class GitHubAdapter implements ApiAdapter {
    readonly name = 'GitHub API';

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
            const headers = { ...JSON_HEADERS };
            const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            switch (apiInfo.type) {
                case 'issues':
                case 'pulls':
                    return await this.fetchIssueOrPr(apiInfo, ctx, headers, onRetry);
                case 'commits':
                    return await this.fetchCommit(apiInfo, ctx, headers, onRetry);
                case 'releases':
                    return await this.fetchRelease(apiInfo, ctx, headers, onRetry);
                case 'contents':
                    return await this.fetchContents(apiInfo, ctx, headers, onRetry);
                case 'gist':
                    return await this.fetchGist(apiInfo, ctx, headers, onRetry);
            }
        } catch {
            return null;
        }
        return null;
    }

    // ───────────────────── URL 匹配 ─────────────────────

    private matchUrl(url: string): GitHubApiInfo | null {
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
        } catch {
            return null;
        }

        const hostname = parsedUrl.hostname.toLowerCase();

        // Gist
        if (hostname === 'gist.github.com' || hostname.endsWith('.gist.github.com')) {
            const m = parsedUrl.pathname.replace(/\/+$/, '').match(/^\/([^/]+)\/([a-f0-9]+)$/i);
            if (m) return { type: 'gist', gistId: m[2] };
            return null;
        }

        if (hostname !== 'github.com' && !hostname.endsWith('.github.com')) return null;

        const path = parsedUrl.pathname.replace(/\/+$/, '');
        const m = (re: RegExp) => path.match(re);

        // Pulls (Web URL 用单数 "pull"，API 用复数 "pulls")
        let r = m(/^\/([^/]+)\/([^/]+)\/(?:pull|pulls)\/(\d+)$/);
        if (r) return { type: 'pulls', owner: r[1], repo: r[2], number: r[3] };

        // Issues
        r = m(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
        if (r) return { type: 'issues', owner: r[1], repo: r[2], number: r[3] };

        // Commits
        r = m(/^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})$/i);
        if (r) return { type: 'commits', owner: r[1], repo: r[2], sha: r[3] };

        // Releases by tag (must precede ID match)
        r = m(/^\/([^/]+)\/([^/]+)\/releases\/tag\/(.+)$/);
        if (r) return { type: 'releases', owner: r[1], repo: r[2], tag: r[3] };

        // Releases by ID
        r = m(/^\/([^/]+)\/([^/]+)\/releases\/(\d+)$/);
        if (r) return { type: 'releases', owner: r[1], repo: r[2], number: r[3] };

        // File content (blob)
        r = m(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
        if (r) return { type: 'contents', owner: r[1], repo: r[2], ref: r[3], path: r[4] };

        return null;
    }

    // ───────────────────── Issues / PRs ─────────────────────

    private async fetchIssueOrPr(
        apiInfo: GitHubApiInfo,
        ctx: ApiAdapterContext,
        headers: Record<string, string>,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/${apiInfo.type}/${apiInfo.number}`;
        const response = await ctx.fetch(apiUrl, headers, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        const markdown = this.formatIssueOrPr(data, apiInfo.type);

        const commentCount = typeof data.comments === 'number' ? data.comments : 0;
        if (commentCount > 0) {
            const commentsUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/issues/${apiInfo.number}/comments`;
            const commentsMd = await this.fetchComments(commentsUrl, ctx, headers, onRetry);
            if (commentsMd) {
                return {
                    content: ctx.truncate(markdown + '\n\n---\n\n## 评论\n\n' + commentsMd),
                    strategy: `GitHub API (${apiInfo.type})`,
                    httpStatus: response.status
                };
            }
        }

        return {
            content: ctx.truncate(markdown),
            strategy: `GitHub API (${apiInfo.type})`,
            httpStatus: response.status
        };
    }

    private formatIssueOrPr(data: any, type: string): string {
        const lines: string[] = [];
        const isPr = type === 'pulls';
        const stateLabel = isPr
            ? data.merged
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

        if (data.user?.login) {
            const handle = data.user.html_url
                ? ` ([@${data.user.login}](${data.user.html_url}))`
                : ` (@${data.user.login})`;
            lines.push(`**作者**: ${data.user.login}${handle}`);
        }
        if (Array.isArray(data.assignees) && data.assignees.length > 0) {
            const assignees = data.assignees.map((a: any) => `[@${a.login}](${a.html_url || ''})`).join(', ');
            lines.push(`**指派给**: ${assignees}`);
        }
        if (Array.isArray(data.labels) && data.labels.length > 0) {
            lines.push(`**标签**: ${data.labels.map((l: any) => l.name).join(', ')}`);
        }
        if (data.milestone?.title) lines.push(`**里程碑**: ${data.milestone.title}`);
        if (data.created_at) lines.push(`**创建时间**: ${data.created_at}`);
        if (data.updated_at && data.updated_at !== data.created_at) {
            lines.push(`**更新时间**: ${data.updated_at}`);
        }

        if (isPr) {
            if (data.head?.ref) lines.push(`**源分支**: ${data.head.ref}`);
            if (data.base?.ref) lines.push(`**目标分支**: ${data.base.ref}`);
            if (data.merged_at) lines.push(`**合并时间**: ${data.merged_at}`);
            if (data.merged_by?.login) {
                const handle = data.merged_by.html_url
                    ? ` ([@${data.merged_by.login}](${data.merged_by.html_url}))`
                    : '';
                lines.push(`**合并者**: @${data.merged_by.login}${handle}`);
            }
            if (data.draft) lines.push(`**草稿**: 是`);
        }

        lines.push('');
        lines.push(data.body?.trim() || '_(无描述)_');
        return lines.join('\n');
    }

    // ───────────────────── Commits ─────────────────────

    private async fetchCommit(
        apiInfo: GitHubApiInfo,
        ctx: ApiAdapterContext,
        headers: Record<string, string>,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/commits/${apiInfo.sha}`;
        const response = await ctx.fetch(apiUrl, headers, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        return {
            content: ctx.truncate(this.formatCommit(data)),
            strategy: 'GitHub API (commits)',
            httpStatus: response.status
        };
    }

    private formatCommit(data: any): string {
        const lines: string[] = [];
        const commit = data.commit || {};
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
        // GitHub commit 还会返回关联的 GitHub 用户
        if (data.author?.login) {
            const handle = data.author.html_url ? ` ([@${data.author.login}](${data.author.html_url}))` : '';
            lines.push(`**GitHub 用户**: @${data.author.login}${handle}`);
        }
        if (data.html_url) lines.push(`**链接**: ${data.html_url}`);

        const stats = data.stats || commit.stats;
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
        apiInfo: GitHubApiInfo,
        ctx: ApiAdapterContext,
        headers: Record<string, string>,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const idOrTag = apiInfo.tag ? `tags/${apiInfo.tag}` : apiInfo.number;
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/releases/${idOrTag}`;
        const response = await ctx.fetch(apiUrl, headers, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        return {
            content: ctx.truncate(this.formatRelease(data)),
            strategy: 'GitHub API (releases)',
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
                const dl = asset.browser_download_url || asset.url || '';
                lines.push(`- [${asset.name}](${dl})${size ? ` (${size})` : ''}`);
            }
        }

        lines.push('');
        lines.push(data.body?.trim() || '_(无发布说明)_');
        return lines.join('\n');
    }

    // ───────────────────── File Contents ─────────────────────

    private async fetchContents(
        apiInfo: GitHubApiInfo,
        ctx: ApiAdapterContext,
        headers: Record<string, string>,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const encodedPath = apiInfo.path!.split('/').map(encodeURIComponent).join('/');
        const refParam = apiInfo.ref ? `?ref=${encodeURIComponent(apiInfo.ref)}` : '';
        const apiUrl = `${API_BASE}/repos/${apiInfo.owner}/${apiInfo.repo}/contents/${encodedPath}${refParam}`;
        const response = await ctx.fetch(apiUrl, headers, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);

        // 目录列表
        if (Array.isArray(data)) {
            return {
                content: ctx.truncate(this.formatDirListing(data, apiInfo)),
                strategy: 'GitHub API (contents)',
                httpStatus: response.status
            };
        }

        // 单文件
        if (data.type === 'file') {
            return {
                content: ctx.truncate(this.formatFile(data, apiInfo)),
                strategy: 'GitHub API (contents)',
                httpStatus: response.status
            };
        }

        return null;
    }

    private formatFile(data: any, apiInfo: GitHubApiInfo): string {
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
        const langHint = ext ? ext : '';
        lines.push('```' + langHint);

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

    private formatDirListing(entries: any[], apiInfo: GitHubApiInfo): string {
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

    // ───────────────────── Gists ─────────────────────

    private async fetchGist(
        apiInfo: GitHubApiInfo,
        ctx: ApiAdapterContext,
        headers: Record<string, string>,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null> {
        const apiUrl = `${API_BASE}/gists/${apiInfo.gistId}`;
        const response = await ctx.fetch(apiUrl, headers, onRetry);
        if (!response.ok) return null;

        const body = await ctx.readBody(response);
        if (!body) return null;

        const data = JSON.parse(body);
        return {
            content: ctx.truncate(this.formatGist(data)),
            strategy: 'GitHub API (gist)',
            httpStatus: response.status
        };
    }

    private formatGist(data: any): string {
        const lines: string[] = [];

        const desc = data.description?.trim();
        lines.push(`# ${desc || 'Gist'}`);
        lines.push('');

        if (data.owner?.login) {
            const handle = data.owner.html_url ? ` ([@${data.owner.login}](${data.owner.html_url}))` : '';
            lines.push(`**作者**: @${data.owner.login}${handle}`);
        }
        if (data.created_at) lines.push(`**创建时间**: ${data.created_at}`);
        if (data.updated_at && data.updated_at !== data.created_at) {
            lines.push(`**更新时间**: ${data.updated_at}`);
        }
        if (data.html_url) lines.push(`**链接**: ${data.html_url}`);

        const files = data.files || {};
        const fileEntries = Object.values(files) as any[];

        for (const file of fileEntries) {
            lines.push('');
            lines.push(`---`);
            lines.push('');
            const filename = file.filename || 'unknown';
            const language = file.language || '';
            lines.push(`## ${filename}`);
            if (language) lines.push(`**语言**: ${language}`);
            if (file.size) lines.push(`**大小**: ${this.formatSize(file.size)}`);
            lines.push('');

            const ext = filename.split('.').pop() || '';
            lines.push('```' + ext);
            lines.push(file.content?.trim() || '_(空文件)_');
            lines.push('```');
        }

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
                    const author = c.user?.login || '匿名';
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
