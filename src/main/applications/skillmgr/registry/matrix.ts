/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { SkillRegistryBase, runCliCommand, type SearchOptions, type SearchResult } from './base.js';

export class MatrixRegistry extends SkillRegistryBase {
    readonly id = 'matrix';
    readonly label = 'Matrix Skill';
    readonly icon = '🔷';
    readonly iconClass = 'matrix';

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = 20 } = opts;
        const safeQuery = query.trim() || 'skill';

        try {
            const { code, stdout, stderr } = await runCliCommand(
                'npx',
                ['@matrixopenharmony/matrix-cli', 'skill', 'search', safeQuery],
                60000
            );
            if (code !== 0) {
                throw new Error((stderr || '').trim() || `Matrix CLI 退出码 ${code}`);
            }

            const lines = stdout.split(/\r?\n/);
            const skills = [];
            let foundCount = 0;
            let showedHint = '';

            for (const line of lines) {
                const countMatch = line.match(/找到\s+(\d+)\s+个技能/);
                if (countMatch) foundCount = parseInt(countMatch[1], 10) || 0;

                const hintMatch = line.match(/ℹ\s+显示\s+(\d+)\s+\/\s+(\d+)\s+个结果/);
                if (hintMatch) showedHint = `显示 ${hintMatch[1]} / ${hintMatch[2]} 个结果`;

                if (!line.includes('|')) continue;
                const parts = line.split('|').map((s) => s.trim());
                if (parts.length >= 4 && parts[1] && parts[1] !== '英文名称' && !parts[1].startsWith('-')) {
                    const enName = parts[1];
                    const description = parts[2] || '';
                    const tag = parts[3] || '';
                    skills.push({
                        id: enName,
                        name: enName,
                        description,
                        author: tag,
                        source: 'matrix' as const,
                        installUrl: `${this.installPrefix}${enName}`,
                        stars: 0,
                        canInstall: true
                    });
                }
            }

            const total = foundCount || skills.length;
            const start = (page - 1) * limit;
            const paged = skills.slice(start, start + limit);
            return {
                skills: paged,
                total,
                hasMore: start + limit < total,
                message: showedHint || undefined
            };
        } catch (e: any) {
            return {
                skills: [],
                total: 0,
                hasMore: false,
                message: `Matrix Skill 搜索失败: ${e.message || '未知错误'}`
            };
        }
    }
}
