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

export interface RegistryMcp {
    id: string;
    name: string;
    displayName?: string;
    description: string;
    author?: string;
    source: string;
    installUrl: string;
    repository?: string;
    configuration?: string;
    logo?: string;
    deployType?: string;
    serverType?: string;
    downloads?: number;
    stars?: number;
    views?: number;
    updateTime?: string;
    tags?: string[];
    categories?: string[];
    canInstall: boolean;
}

export interface SearchResult {
    mcps: RegistryMcp[];
    total?: number;
    hasMore?: boolean;
    message?: string;
    nextCursor?: string;
}

export interface SearchOptions {
    query?: string;
    page?: number;
    limit?: number;
    cursor?: string;
}

export abstract class MCPRegistryBase {
    abstract readonly id: string;
    abstract readonly label: string;
    abstract readonly icon: string;
    abstract readonly iconClass: string;

    get slogan(): string {
        return '连接上下文，让智能体调用更多工具';
    }

    get installPrefix(): string {
        return `${this.id}:`;
    }

    matchesInstallUrl(url: string): boolean {
        return typeof url === 'string' && url.startsWith(this.installPrefix);
    }

    parseInstallUrl(installUrl: string): { id: string } | null {
        if (!this.matchesInstallUrl(installUrl)) return null;
        const id = installUrl.slice(this.installPrefix.length).trim();
        if (!id) return null;
        return { id };
    }

    abstract search(opts?: SearchOptions): Promise<SearchResult>;
    abstract getDetail(id: string): Promise<RegistryMcp | null>;
}
