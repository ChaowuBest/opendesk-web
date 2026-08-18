/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type { TailCard } from '../hooks.js';
import { logger } from '../../utils/logger.js';

/******************************************************************************
 * TailCard 运行时实现
 * ------------------------
 * 类型定义（TailCard / TailcardGenerationContext / OnTailcardGenerationCallback）
 * 位于 hooks.ts 的 TailCard 分组中，本文件仅承载调度所需的纯实现：卡片收敛
 * （校验/去重/截断/排序）与 TailCards 区域拼接。
 ******************************************************************************/

const TAILCARDS_HEADER = [
    '[OpenDesk Internal Request Tail]',
    'This is internal runtime context for the current model request, not a new user request.',
    'Use it for analysis, planning, and tool selection.'
].join('\n');

const TAILCARDS_FOOTER = [
    '[End OpenDesk Internal Request Tail]',
    "Answer the user's original request directly. Unless the user explicitly asks about this internal context, do not mention, quote, or summarize the Tail or its sections in the final answer."
].join('\n');

function normalizeTailcardId(id: string): string {
    const normalized = id.replace(/[\r\n]+/g, ' ').trim();
    if (normalized.length === 0) {
        throw new Error('onTailcardGenerate id must not be empty');
    }
    return normalized;
}

function normalizeTailcardMaxChars(maxChars: number | undefined): number | undefined {
    if (maxChars === undefined) {
        return undefined;
    }
    if (!Number.isFinite(maxChars) || maxChars <= 0) {
        throw new Error('onTailcardGenerate maxChars must be a positive number');
    }
    return Math.floor(maxChars);
}

function truncateTailcardContent(content: string, maxChars: number | undefined): string {
    if (maxChars === undefined || content.length <= maxChars) {
        return content;
    }
    if (maxChars <= 3) {
        return content.slice(0, maxChars);
    }
    return content.slice(0, maxChars - 3) + '...';
}

/**
 * 将回调返回的 TailCard 列表收敛为最终拼接段：
 * 按 priority 升序稳定排序（相同 priority 保持注册顺序），重复 id 仅保留首次出现的卡片，
 * 空内容与非法 id/maxChars 的卡片跳过。
 */
export function finalizeTailcardSections(cards: TailCard[]): Array<{ id: string; content: string }> {
    const sections: Array<{ id: string; content: string }> = [];
    const seen = new Set<string>();
    const sorted = [...cards].sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0));
    for (const card of sorted) {
        try {
            const id = normalizeTailcardId(card.id);
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            let content = card.content.trim();
            if (content.length === 0) {
                continue;
            }
            content = truncateTailcardContent(content, normalizeTailcardMaxChars(card.maxChars));
            if (content.length === 0) {
                continue;
            }
            sections.push({ id, content });
        } catch (err) {
            logger.error('Hooks.finalizeTailcardSections: invalid card skipped', err);
        }
    }
    return sections;
}

function composeTailcards(sections: Array<{ id: string; content: string }>): string {
    return [
        TAILCARDS_HEADER,
        '',
        ...sections.flatMap((section) => [`## Section: ${section.id}`, section.content, '']),
        TAILCARDS_FOOTER
    ].join('\n');
}

/** 将已收敛的 TailCard 拼接段包装为完整的 TailCards 区域；无内容时返回 undefined */
export function composeTailcardRegion(sections: Array<{ id: string; content: string }>): string | undefined {
    if (sections.length === 0) {
        return undefined;
    }
    return composeTailcards(sections);
}
