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

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { LLM } from '../llm.js';
import { UserMessage } from '../messages.js';
import { type MemoryMeta, type MemoryIndex, type MemoryScope, createEmptyIndex } from './common.js';

// ─── LLM response schemas ──────────────────────────

const DeduplicateResultSchema = z.object({
    action: z.enum(['create', 'update', 'skip']),
    target_uid: z.string().optional(),
    merged_content: z.string().optional(),
    merged_name: z.string().optional(),
    merged_keywords: z.array(z.string()).optional(),
    merged_summary: z.string().optional(),
    reason: z.string()
});

const SearchRerankSchema = z.object({
    results: z.array(
        z.object({
            uid: z.string(),
            relevance: z.number().min(0).max(10),
            reason: z.string()
        })
    )
});

type DeduplicateResult = z.infer<typeof DeduplicateResultSchema>;
type SearchRerankResult = z.infer<typeof SearchRerankSchema>;

export type MemoryOpType = 'add' | 'search' | 'forget';

export class MemoryRegistry {
    private static instance: MemoryRegistry | null = null;
    private workspace: string;
    private globalDirOverride?: string;

    /** 全局记忆操作锁，跨会话互斥 */
    private _busyOp: MemoryOpType | null = null;

    /** 当前批量操作中新增/更新的记忆计数 */
    private _opCounter = 0;

    get busyOp(): MemoryOpType | null {
        return this._busyOp;
    }
    get opCounter(): number {
        return this._opCounter;
    }
    resetOpCounter() {
        this._opCounter = 0;
    }

    acquireLock(op: MemoryOpType): boolean {
        if (this._busyOp) return false;
        this._busyOp = op;
        this._opCounter = 0;
        return true;
    }

    releaseLock() {
        this._busyOp = null;
    }

    private constructor(workspace: string, globalDirOverride?: string) {
        this.workspace = workspace;
        this.globalDirOverride = globalDirOverride;
    }

    static getInstance(workspace?: string): MemoryRegistry {
        if (!MemoryRegistry.instance) {
            if (!workspace) {
                throw new Error('MemoryRegistry not initialized yet, workspace is required');
            }
            MemoryRegistry.instance = new MemoryRegistry(workspace);
        }
        if (workspace && MemoryRegistry.instance.workspace !== workspace) {
            MemoryRegistry.instance.workspace = workspace;
        }
        return MemoryRegistry.instance;
    }

    static createForTest(workspace: string, globalDir: string): MemoryRegistry {
        return new MemoryRegistry(workspace, globalDir);
    }

    // ─── Path helpers ──────────────────────────────────────

    private _ensuredDirs = new Set<string>();

    private async getGlobalMemoryDir(): Promise<string> {
        const base = this.globalDirOverride ?? getOpendeskDirectory();
        const dir = path.join(base, 'memory');
        if (!this._ensuredDirs.has(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
            this._ensuredDirs.add(dir);
        }
        return dir;
    }

    private async getWorkspaceMemoryDir(): Promise<string> {
        const dir = path.join(this.workspace, '.opendesk', 'memory');
        if (!this._ensuredDirs.has(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
            this._ensuredDirs.add(dir);
        }
        return dir;
    }

    private async getMemoryDir(scope: MemoryScope): Promise<string> {
        return scope === 'global' ? this.getGlobalMemoryDir() : this.getWorkspaceMemoryDir();
    }

    private async getIndexPath(scope: MemoryScope): Promise<string> {
        return path.join(await this.getMemoryDir(scope), 'index.json');
    }

    private async getContentPath(scope: MemoryScope, uid: string): Promise<string> {
        return path.join(await this.getMemoryDir(scope), `${uid}.md`);
    }

    // ─── Index I/O ────────────────────────────────────────

    private async loadIndex(scope: MemoryScope): Promise<MemoryIndex> {
        const indexPath = await this.getIndexPath(scope);
        try {
            const raw = await fs.promises.readFile(indexPath, 'utf-8');
            return JSON.parse(raw) as MemoryIndex;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return createEmptyIndex();
            }
            logger.warn(`Failed to load memory index (${scope}): ${err}`);
            return createEmptyIndex();
        }
    }

    private async saveIndex(scope: MemoryScope, index: MemoryIndex): Promise<void> {
        const indexPath = await this.getIndexPath(scope);
        await fs.promises.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
    }

    // ─── Low-level CRUD ───────────────────────────────────

    /**
     * 底层写入。如果存在相同 uid 则更新，否则创建。
     */
    async putMemory(
        scope: MemoryScope,
        meta: Omit<MemoryMeta, 'created_at' | 'updated_at'> & {
            created_at?: string;
            updated_at?: string;
        },
        content: string
    ): Promise<MemoryMeta> {
        const index = await this.loadIndex(scope);
        const now = new Date().toISOString();

        const existingIdx = index.memories.findIndex((m) => m.uid === meta.uid);
        const fullMeta: MemoryMeta = {
            ...meta,
            created_at: existingIdx >= 0 ? index.memories[existingIdx].created_at : (meta.created_at ?? now),
            updated_at: now
        };

        if (existingIdx >= 0) {
            index.memories[existingIdx] = fullMeta;
        } else {
            index.memories.push(fullMeta);
        }

        await this.saveIndex(scope, index);
        await fs.promises.writeFile(await this.getContentPath(scope, meta.uid), content, 'utf-8');
        return fullMeta;
    }

    async getMemory(uid: string): Promise<{ meta: MemoryMeta; content: string; scope: MemoryScope } | undefined> {
        for (const scope of ['workspace', 'global'] as MemoryScope[]) {
            const index = await this.loadIndex(scope);
            const meta = index.memories.find((m) => m.uid === uid);
            if (meta) {
                const contentPath = await this.getContentPath(scope, uid);
                let content = '';
                try {
                    content = await fs.promises.readFile(contentPath, 'utf-8');
                } catch {
                    /* content file missing */
                }
                return { meta, content, scope };
            }
        }
        return undefined;
    }

    async deleteMemory(uid: string): Promise<boolean> {
        for (const scope of ['workspace', 'global'] as MemoryScope[]) {
            const index = await this.loadIndex(scope);
            const idx = index.memories.findIndex((m) => m.uid === uid);
            if (idx >= 0) {
                index.memories.splice(idx, 1);
                await this.saveIndex(scope, index);
                const contentPath = await this.getContentPath(scope, uid);
                try {
                    await fs.promises.unlink(contentPath);
                } catch {
                    /* file already gone */
                }
                return true;
            }
        }
        return false;
    }

    async listMemories(scope: MemoryScope): Promise<MemoryMeta[]> {
        return (await this.loadIndex(scope)).memories;
    }

    async listAllMemories(): Promise<{ scope: MemoryScope; meta: MemoryMeta }[]> {
        const result: { scope: MemoryScope; meta: MemoryMeta }[] = [];
        for (const scope of ['workspace', 'global'] as MemoryScope[]) {
            for (const meta of await this.listMemories(scope)) {
                result.push({ scope, meta });
            }
        }
        return result;
    }

    // ─── Keyword pre-filter ───────────────────────────────

    /**
     * 基于关键词的快速预过滤，返回候选集供 LLM 重排。
     */
    async keywordSearch(query: string): Promise<{ scope: MemoryScope; meta: MemoryMeta; score: number }[]> {
        const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const results: { scope: MemoryScope; meta: MemoryMeta; score: number }[] = [];

        for (const scope of ['workspace', 'global'] as MemoryScope[]) {
            const index = await this.loadIndex(scope);
            for (const meta of index.memories) {
                let score = 0;
                for (const token of queryTokens) {
                    if (meta.name.toLowerCase().includes(token)) score += 3;
                    if (meta.keywords.some((k) => k.toLowerCase().includes(token))) score += 2;
                    if (meta.summary.toLowerCase().includes(token)) score += 1;
                    if (meta.category.toLowerCase().includes(token)) score += 1;
                }
                if (score > 0) {
                    results.push({ scope, meta, score });
                }
            }
        }

        return results.sort((a, b) => b.score - a.score);
    }

    // ─── LLM-powered search ───────────────────────────────

    /**
     * 使用 LLM 对候选记忆进行语义重排，返回真正相关的记忆。
     * 流程：关键词预过滤 → 全量候选（若预过滤无结果）→ LLM 语义评分 → 过滤低分项
     */
    async smartSearch(query: string): Promise<{ scope: MemoryScope; meta: MemoryMeta; relevance: number }[]> {
        let candidates = await this.keywordSearch(query);

        if (candidates.length === 0) {
            candidates = (await this.listAllMemories()).map((m) => ({ ...m, score: 0 }));
        }

        if (candidates.length === 0) {
            return [];
        }

        // 取前20条交给 LLM 重排
        const topCandidates = candidates.slice(0, 20);

        const candidateDescriptions = topCandidates
            .map(
                (c, i) =>
                    `[${i}] uid=${c.meta.uid} | 名称: ${c.meta.name} | 分类: ${c.meta.category} | 关键词: ${c.meta.keywords.join(',')} | 摘要: ${c.meta.summary}`
            )
            .join('\n');

        const prompt = `你是一个记忆检索助手。用户正在搜索相关记忆，请根据语义相关性对以下候选记忆进行评分。

用户查询: "${query}"

候选记忆列表:
${candidateDescriptions}

请对每条候选记忆评估与查询的语义相关性，返回 JSON 格式:
\`\`\`json
{
  "results": [
    {"uid": "记忆uid", "relevance": 0-10的相关性分数, "reason": "简短说明相关性原因"}
  ]
}
\`\`\`

评分标准:
- 10: 完全匹配查询意图
- 7-9: 高度相关
- 4-6: 部分相关
- 1-3: 弱相关
- 0: 无关

只返回 relevance >= 3 的记忆。`;

        try {
            const response = (await LLM.askForObjectWithSchema(
                new UserMessage(prompt),
                SearchRerankSchema
            )) as SearchRerankResult;

            const uidToCandidate = new Map(topCandidates.map((c) => [c.meta.uid, c]));
            return response.results
                .filter((r) => r.relevance >= 3)
                .sort((a, b) => b.relevance - a.relevance)
                .map((r) => {
                    const c = uidToCandidate.get(r.uid);
                    if (!c) return null;
                    return { scope: c.scope, meta: c.meta, relevance: r.relevance };
                })
                .filter((r): r is NonNullable<typeof r> => r !== null);
        } catch (err) {
            logger.warn(`LLM rerank failed, falling back to keyword search: ${err}`);
            return candidates.slice(0, 10).map((c) => ({
                scope: c.scope,
                meta: c.meta,
                relevance: Math.min(10, c.score)
            }));
        }
    }

    // ─── LLM-powered add with dedup ───────────────────────

    /**
     * 智能添加记忆：使用 LLM 判断新记忆与现有记忆是否重复，
     * 并决定创建新记忆、更新已有记忆、或跳过。
     */
    /**
     * 快速计算两组关键词的相似度（Jaccard 系数），返回 0~1。
     */
    private keywordSimilarity(a: string[], b: string[]): number {
        if (a.length === 0 && b.length === 0) return 0;
        const setA = new Set(a.map((k) => k.toLowerCase()));
        const setB = new Set(b.map((k) => k.toLowerCase()));
        let intersection = 0;
        for (const k of setA) {
            if (setB.has(k)) intersection++;
        }
        const union = new Set([...setA, ...setB]).size;
        return union === 0 ? 0 : intersection / union;
    }

    /**
     * 简单的名称相似度：检测子串包含关系或名称一致。
     */
    private nameSimilarity(a: string, b: string): number {
        const la = a.toLowerCase().trim();
        const lb = b.toLowerCase().trim();
        if (la === lb) return 1;
        if (la.includes(lb) || lb.includes(la)) return 0.6;
        return 0;
    }

    async smartAdd(
        scope: MemoryScope,
        name: string,
        content: string,
        keywords: string[],
        summary: string,
        category: string,
        sourceTaskId?: string
    ): Promise<{ action: 'created' | 'updated' | 'skipped'; uid: string; name: string }> {
        const result = await this._smartAddInner(scope, name, content, keywords, summary, category, sourceTaskId);
        if (result.action !== 'skipped') {
            this._opCounter++;
        }
        return result;
    }

    private async _smartAddInner(
        scope: MemoryScope,
        name: string,
        content: string,
        keywords: string[],
        summary: string,
        category: string,
        sourceTaskId?: string
    ): Promise<{ action: 'created' | 'updated' | 'skipped'; uid: string; name: string }> {
        const existingMemories = await this.listMemories(scope);

        if (existingMemories.length === 0) {
            const uid = this.generateUid();
            await this.putMemory(
                scope,
                { uid, name, keywords, summary, category, source_task_id: sourceTaskId },
                content
            );
            return { action: 'created', uid, name };
        }

        // 快速预筛选：只挑出与新记忆有关键词或名称重叠的候选项
        const candidates = existingMemories
            .map((m) => ({
                meta: m,
                score: Math.max(this.keywordSimilarity(keywords, m.keywords), this.nameSimilarity(name, m.name))
            }))
            .filter((c) => c.score > 0.15)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

        if (candidates.length === 0) {
            const uid = this.generateUid();
            await this.putMemory(
                scope,
                { uid, name, keywords, summary, category, source_task_id: sourceTaskId },
                content
            );
            return { action: 'created', uid, name };
        }

        const existingDescriptionParts = await Promise.all(
            candidates.map(async (c) => {
                const m = c.meta;
                const existingContent = (await this.loadMemoryContent(m.uid)) ?? '';
                const contentPreview =
                    existingContent.length > 200 ? existingContent.slice(0, 200) + '...' : existingContent;
                return `- uid=${m.uid} | 名称: ${m.name} | 关键词: ${m.keywords.join(',')} | 摘要: ${m.summary}\n  内容摘要: ${contentPreview}`;
            })
        );
        const existingDescriptions = existingDescriptionParts.join('\n');

        const prompt = `你是一个记忆管理助手。现在要添加一条新记忆，请判断它与现有记忆的关系。

## 新记忆
- 名称: ${name}
- 关键词: ${keywords.join(', ')}
- 摘要: ${summary}
- 分类: ${category}
- 内容:
${content}

## 可能相关的现有记忆 (${scope === 'global' ? '全局' : '工作区'})
${existingDescriptions}

## 判断规则
1. 如果新记忆与某条现有记忆描述的是**同一主题**（即使表述不同），应该合并更新（action=update）
2. 如果新记忆是全新的信息，应该创建新记忆（action=create）
3. 如果新记忆的信息已被现有记忆**完全覆盖**且无新增价值，应跳过（action=skip）

请返回 JSON：
\`\`\`json
{
  "action": "create" | "update" | "skip",
  "target_uid": "如果 update，填写目标记忆的 uid",
  "merged_content": "如果 update，填写合并后的完整内容（Markdown格式，融合新旧信息的精华）",
  "merged_name": "如果 update，填写合并后的记忆名称",
  "merged_keywords": ["如果 update，填写合并后的关键词列表"],
  "merged_summary": "如果 update，填写合并后的摘要",
  "reason": "简要说明判断理由"
}
\`\`\``;

        try {
            const result = (await LLM.askForObjectWithSchema(
                new UserMessage(prompt),
                DeduplicateResultSchema
            )) as DeduplicateResult;

            switch (result.action) {
                case 'update': {
                    const targetUid = result.target_uid;
                    if (!targetUid) {
                        const uid = this.generateUid();
                        await this.putMemory(
                            scope,
                            {
                                uid,
                                name,
                                keywords,
                                summary,
                                category,
                                source_task_id: sourceTaskId
                            },
                            content
                        );
                        return { action: 'created', uid, name };
                    }
                    await this.putMemory(
                        scope,
                        {
                            uid: targetUid,
                            name: result.merged_name ?? name,
                            keywords: result.merged_keywords ?? keywords,
                            summary: result.merged_summary ?? summary,
                            category,
                            source_task_id: sourceTaskId
                        },
                        result.merged_content ?? content
                    );
                    return { action: 'updated', uid: targetUid, name: result.merged_name ?? name };
                }
                case 'skip':
                    return { action: 'skipped', uid: '', name };
                case 'create':
                default: {
                    const uid = this.generateUid();
                    await this.putMemory(
                        scope,
                        { uid, name, keywords, summary, category, source_task_id: sourceTaskId },
                        content
                    );
                    return { action: 'created', uid, name };
                }
            }
        } catch (err) {
            logger.warn(`LLM dedup failed, creating new memory: ${err}`);
            const uid = this.generateUid();
            await this.putMemory(
                scope,
                { uid, name, keywords, summary, category, source_task_id: sourceTaskId },
                content
            );
            return { action: 'created', uid, name };
        }
    }

    // ─── LLM-powered forget ───────────────────────────────

    /**
     * 智能删除：用 LLM 理解用户描述，找到最匹配的记忆并删除。
     */
    async smartForget(description: string): Promise<{ deleted: { uid: string; name: string; scope: MemoryScope }[] }> {
        const allMemories = await this.listAllMemories();
        if (allMemories.length === 0) {
            return { deleted: [] };
        }

        const memDescriptions = allMemories
            .map(
                (m, i) => `[${i}] uid=${m.meta.uid} | 范围: ${m.scope} | 名称: ${m.meta.name} | 摘要: ${m.meta.summary}`
            )
            .join('\n');

        const prompt = `你是一个记忆管理助手。用户想要删除一些记忆。

用户描述: "${description}"

现有记忆:
${memDescriptions}

请判断哪些记忆应该被删除。返回 JSON:
\`\`\`json
{
  "results": [
    {"uid": "要删除的记忆uid", "relevance": 10, "reason": "为什么应该删除"}
  ]
}
\`\`\`

只返回确实匹配用户删除意图的记忆（relevance >= 7）。如果没有匹配的，返回空 results 数组。`;

        try {
            const response = (await LLM.askForObjectWithSchema(
                new UserMessage(prompt),
                SearchRerankSchema
            )) as SearchRerankResult;

            const deleted: { uid: string; name: string; scope: MemoryScope }[] = [];
            for (const r of response.results.filter((r) => r.relevance >= 7)) {
                const mem = allMemories.find((m) => m.meta.uid === r.uid);
                if (mem && (await this.deleteMemory(r.uid))) {
                    deleted.push({ uid: r.uid, name: mem.meta.name, scope: mem.scope });
                }
            }
            return { deleted };
        } catch (err) {
            logger.warn(`LLM forget failed: ${err}`);
            return { deleted: [] };
        }
    }

    // ─── Helpers ──────────────────────────────────────────

    private generateUid(): string {
        return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    async loadMemoryContent(uid: string): Promise<string | undefined> {
        const memory = await this.getMemory(uid);
        if (!memory) return undefined;
        return memory.content;
    }

    async formatMemoriesForContext(memories: { scope: MemoryScope; meta: MemoryMeta }[]): Promise<string> {
        if (memories.length === 0) return '未找到相关记忆。';

        const lines: string[] = ['以下是检索到的相关记忆信息：\n'];

        for (const { scope, meta } of memories) {
            const content = await this.loadMemoryContent(meta.uid);
            const scopeLabel = scope === 'global' ? '全局' : '工作区';
            lines.push(`### [${scopeLabel}] ${meta.name}`);
            lines.push(`- 分类: ${meta.category}`);
            lines.push(`- 关键词: ${meta.keywords.join(', ')}`);
            lines.push(`- 更新时间: ${meta.updated_at}`);
            if (meta.summary) {
                lines.push(`- 摘要: ${meta.summary}`);
            }
            if (content) {
                lines.push('');
                lines.push(content);
            }
            lines.push('\n---\n');
        }

        return lines.join('\n');
    }
}
