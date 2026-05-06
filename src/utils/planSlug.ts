/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * 计划文件命名工具。
 *
 * 每个任务（session）对应一个随机单词 slug，格式为 "adjective-verb-noun"，
 * 用于生成唯一的计划文件名（如 gleaming-brewing-phoenix.md）。
 * slug 按 taskId 缓存，同一任务始终使用同一 slug。
 */

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

const ADJECTIVES = [
    'agile',
    'bold',
    'bright',
    'calm',
    'clean',
    'clever',
    'cool',
    'cosmic',
    'crisp',
    'deft',
    'eager',
    'fair',
    'fast',
    'fine',
    'firm',
    'fleet',
    'fresh',
    'glad',
    'grand',
    'keen',
    'kind',
    'lean',
    'light',
    'lush',
    'neat',
    'noble',
    'prime',
    'pure',
    'quick',
    'rapid',
    'sharp',
    'sleek',
    'smart',
    'smooth',
    'solid',
    'steady',
    'strong',
    'subtle',
    'sure',
    'swift',
    'tidy',
    'vivid',
    'warm',
    'wise',
    'witty',
    'zen',
    'brief',
    'clear',
    'deep',
    'gentle',
    'golden',
    'graceful',
    'humble',
    'lively',
    'lucid',
    'mellow',
    'modest',
    'nimble',
    'peaceful',
    'polished',
    'quiet',
    'radiant',
    'refined',
    'serene',
    'silent',
    'simple',
    'sincere',
    'stellar',
    'tranquil'
];

const VERBS = [
    'brewing',
    'building',
    'carving',
    'casting',
    'crafting',
    'dancing',
    'dashing',
    'diving',
    'drawing',
    'drifting',
    'driving',
    'flying',
    'forging',
    'gliding',
    'growing',
    'guiding',
    'humming',
    'jumping',
    'leading',
    'leaping',
    'making',
    'mapping',
    'mining',
    'mixing',
    'moving',
    'pacing',
    'parsing',
    'passing',
    'paving',
    'picking',
    'planning',
    'planting',
    'playing',
    'pouring',
    'racing',
    'reading',
    'riding',
    'rising',
    'roaming',
    'rowing',
    'running',
    'sailing',
    'seeking',
    'shaping',
    'singing',
    'skating',
    'solving',
    'sorting',
    'sparking',
    'spinning',
    'staging',
    'stacking',
    'surfing',
    'swimming',
    'tapping',
    'testing',
    'tracing',
    'trading',
    'tuning',
    'turning',
    'typing',
    'walking',
    'waving',
    'weaving',
    'winding',
    'writing'
];

const NOUNS = [
    'anchor',
    'arrow',
    'beacon',
    'blade',
    'bloom',
    'bridge',
    'brook',
    'candle',
    'canyon',
    'cedar',
    'cipher',
    'cliff',
    'cloud',
    'comet',
    'coral',
    'crane',
    'creek',
    'crest',
    'crystal',
    'dawn',
    'delta',
    'dune',
    'eagle',
    'echo',
    'ember',
    'falcon',
    'field',
    'flame',
    'flash',
    'forge',
    'fox',
    'frost',
    'garden',
    'gate',
    'glacier',
    'grove',
    'hawk',
    'haven',
    'harbor',
    'heron',
    'hill',
    'horizon',
    'iris',
    'island',
    'jade',
    'jewel',
    'knight',
    'lake',
    'lantern',
    'lark',
    'leaf',
    'light',
    'lily',
    'maple',
    'marsh',
    'meadow',
    'moon',
    'oak',
    'ocean',
    'orbit',
    'otter',
    'panda',
    'pearl',
    'peak',
    'phoenix',
    'pine',
    'plaza',
    'plume',
    'pond',
    'prism',
    'pulse',
    'quartz',
    'raven',
    'reef',
    'ridge',
    'river',
    'robin',
    'rose',
    'sage',
    'shore',
    'spark',
    'star',
    'stone',
    'storm',
    'stream',
    'summit',
    'swan',
    'tide',
    'torch',
    'tower',
    'trail',
    'tulip',
    'valley',
    'vine',
    'wave',
    'willow',
    'wind',
    'wolf'
];

const MAX_SLUG_RETRIES = 10;

const _slugCache = new Map<string, string>();

function pickRandom(arr: readonly string[]): string {
    const bytes = randomBytes(4);
    const idx = bytes.readUInt32BE(0) % arr.length;
    return arr[idx];
}

function generateWordSlug(): string {
    const adjective = pickRandom(ADJECTIVES);
    const verb = pickRandom(VERBS);
    const noun = pickRandom(NOUNS);
    return `${adjective}-${verb}-${noun}`;
}

/**
 * 获取指定任务的计划 slug。同一 taskId 始终返回同一 slug。
 * 若尚未分配则生成新的，并确保不与 plansDir 中已有文件冲突。
 */
export function getPlanSlug(taskId: string, plansDir?: string): string {
    let slug = _slugCache.get(taskId);
    if (slug) return slug;

    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
        slug = generateWordSlug();
        if (!plansDir) break;
        const filePath = path.join(plansDir, `${slug}.md`);
        if (!fs.existsSync(filePath)) break;
    }
    _slugCache.set(taskId, slug!);
    return slug!;
}

/**
 * 恢复加载时设置 slug（例如从持久化的任务数据中恢复）。
 */
export function setPlanSlug(taskId: string, slug: string): void {
    _slugCache.set(taskId, slug);
}

/**
 * 获取指定任务的计划文件路径。
 */
export function getPlanFilePath(taskId: string, workspace: string): string {
    const plansDir = path.join(workspace, '.plan');
    const slug = getPlanSlug(taskId, plansDir);
    return path.join(plansDir, `${slug}.md`);
}

/**
 * 查找 .plan 目录中已有的计划文件（用于 exitPlanMode 时查找文件）。
 * 优先返回与 taskId 绑定的 slug 对应的文件，
 * 如果没有缓存则回退到目录中最新的 .md 文件。
 */
export function findPlanFile(taskId: string, workspace: string): string | null {
    const plansDir = path.join(workspace, '.plan');

    // 优先检查已缓存的 slug
    const cachedSlug = _slugCache.get(taskId);
    if (cachedSlug) {
        const fp = path.join(plansDir, `${cachedSlug}.md`);
        if (fs.existsSync(fp)) return fp;
    }

    // 回退：扫描 .plan 目录找最新的 .md 文件
    try {
        if (!fs.existsSync(plansDir)) return null;
        const files = fs
            .readdirSync(plansDir)
            .filter((f) => f.endsWith('.md'))
            .map((f) => ({
                name: f,
                path: path.join(plansDir, f),
                mtime: fs.statSync(path.join(plansDir, f)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
            const slugFromFile = files[0].name.replace(/\.md$/, '');
            _slugCache.set(taskId, slugFromFile);
            return files[0].path;
        }
    } catch {
        // ignore
    }
    return null;
}

/**
 * 清除指定任务的 slug 缓存。
 */
export function clearPlanSlug(taskId: string): void {
    _slugCache.delete(taskId);
}
