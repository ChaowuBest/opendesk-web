/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
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
