/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { SkillRegistryBase, runCliCommand, type SearchOptions, type SearchResult } from './base.js';

export class ClawHubRegistry extends SkillRegistryBase {
    readonly id = 'clawhub';
    readonly label = 'ClawHub';
    readonly icon = '🐾';
    readonly iconClass = 'clawhub';

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', limit = 20 } = opts;
        const safeQuery = query.trim() || 'skill';

        try {
            const { code, stdout, stderr } = await runCliCommand(
                'npx',
                ['clawhub@latest', 'search', safeQuery, '--limit', String(limit)],
                60000
            );
            if (code !== 0) {
                throw new Error((stderr || '').trim() || `ClawHub CLI 退出码 ${code}`);
            }

            const lines = stdout.split(/\r?\n/);
            const skills = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('*')) continue;
                const match = trimmed.match(/^([^\s]+)\s+(.+?)\s+\((\d+\.?\d*)\)$/);
                if (match) {
                    const [, slug, description, scoreStr] = match;
                    skills.push({
                        id: slug,
                        name: slug,
                        description: description.trim(),
                        author: '',
                        source: 'clawhub' as const,
                        installUrl: `${this.installPrefix}${slug}`,
                        stars: 0,
                        score: parseFloat(scoreStr) || 0,
                        canInstall: true
                    });
                }
            }
            return {
                skills,
                total: skills.length,
                hasMore: false,
                message: skills.length > 0 ? `显示 ${skills.length} / ${skills.length} 个结果` : undefined
            };
        } catch (e: any) {
            return {
                skills: [],
                total: 0,
                hasMore: false,
                message: `ClawHub 搜索失败: ${e.message || '未知错误'}`
            };
        }
    }
}
