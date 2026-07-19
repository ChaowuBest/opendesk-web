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

import { spawn } from 'child_process';

export interface RegistrySkill {
    id: string;
    name: string;
    description: string;
    author?: string;
    source: string;
    installUrl: string;
    stars?: number;
    score?: number;
    downloads?: number;
    canInstall: boolean;
    /** 技能所属分类列表，用于前端分类过滤 */
    categories?: string[];
}

export interface SearchResult {
    skills: RegistrySkill[];
    total?: number;
    hasMore?: boolean;
    message?: string;
    nextCursor?: string;
}

export interface SearchOptions {
    query?: string;
    page?: number;
    limit?: number;
    apiKey?: string;
    cursor?: string;
    /** 分类过滤：非空时仅返回匹配该分类的技能 */
    categoryFilter?: string;
}

/** 注册源声明的筛选器定义，前端据此渲染开关/下拉等 UI */
export interface RegistryFilterDef {
    /** 筛选器唯一标识 */
    id: string;
    /** 开关打开时的标签文本 */
    labelOn: string;
    /** 开关关闭时的标签文本 */
    labelOff: string;
    /** 用于 SearchOptions.categoryFilter 的值 */
    categoryValue: string;
    /** 传给 API 的 tagIds，用于服务端过滤（Matrix 专用） */
    apiTagIds?: string[];
}

export abstract class SkillRegistryBase {
    abstract readonly id: string;
    abstract readonly label: string;
    /** GUI 中使用的 emoji 图标 */
    abstract readonly icon: string;
    /** GUI 中 r-icon 的 CSS 类名 */
    abstract readonly iconClass: string;

    /** 热门技能页面的标语，子类可覆盖 */
    get slogan(): string {
        return '技能，让智能体无所不能';
    }

    /** 注册源提供的筛选器列表，子类可覆盖。仅 Matrix 等支持分类筛选的注册源需声明 */
    get filters(): RegistryFilterDef[] {
        return [];
    }

    get installPrefix(): string {
        return `${this.id}:`;
    }

    matchesInstallUrl(url: string): boolean {
        return typeof url === 'string' && url.startsWith(this.installPrefix);
    }

    parseInstallUrl(installUrl: string): { slug: string; version?: string } | null {
        if (!this.matchesInstallUrl(installUrl)) return null;
        const rest = installUrl.slice(this.installPrefix.length).trim();
        if (!rest) return null;
        const at = rest.indexOf('@');
        if (at === -1) return { slug: rest };
        return { slug: rest.slice(0, at), version: rest.slice(at + 1).trim() || undefined };
    }

    abstract search(opts?: SearchOptions): Promise<SearchResult>;
}

export function runCliCommand(
    command: string,
    args: string[],
    timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try {
                child.kill();
            } catch {}
            reject(new Error(`命令执行超时（${Math.floor(timeoutMs / 1000)} 秒）`));
        }, timeoutMs);
        child.stdout?.on('data', (ch) => {
            stdout += ch;
        });
        child.stderr?.on('data', (ch) => {
            stderr += ch;
        });
        child.on('error', (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}
