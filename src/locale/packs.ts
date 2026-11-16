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

/**
 * LocaleStore：插件语言包的宿主侧增量词典层。
 *
 * 插件宿主在 activate 时把解析好的语言包登记进来（按插件维度整体替换），
 * deactivate 时移除；翻译查找链（全局 t() / 应用域 t() / renderer 增量）通过
 * getMergedPack / getPackFallback 按需读取合并结果，合并按插件 ID 字典序
 * 后者胜，结果按 tag 缓存。Worker 线程中的实例不会被插件宿主写入，自动退化为
 * 仅内置词典（P2 再经 workerData 注入增量）。
 */

import { BUILTIN_LOCALES } from '../common/locale.js';
import { type LocalePackMergeConflict, type MergedLocalePack, mergeLocalePacks } from '../common/locale/pack.js';
import type { PluginLocalePackDefinition } from '../../packages/plugin-sdk/src/index.js';

/**
 * 诊断日志走 console 而非 main/utils/logger：logger 依赖 setting.js 与 winston，
 * 会被 t() 的所有消费方（CLI/Worker/renderer 打包）拖进模块图，得不偿失。
 */
function logLocaleEvent(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
    const tagged = `[locale-packs] ${message}`;
    if (level === 'error') console.error(tagged, error ?? '');
    else if (level === 'warn') console.warn(tagged, error ?? '');
    else console.info(tagged);
}

/** 下发给 renderer 的语言包快照（与具体激活语言解耦，按 tag 组织） */
export interface LocalePackSnapshot {
    /** 各语言的合并增量词条 */
    incrementsByTag: Record<string, Record<string, string>>;
    /** 各非内置语言声明的回退 tag（未声明时由查找链按 en-US 处理） */
    fallbackByTag: Record<string, string>;
    /** 内置语言 + 已启用语言包声明的全部语言（已排序、去重） */
    availableLocales: string[];
    /** 同 key 多插件冲突报告（key -> 获胜插件与被覆盖方） */
    conflicts: Record<string, LocalePackMergeConflict[]>;
    /**
     * 各 tag 的内容修订号：任何影响该 tag 的插件变更都自增。renderer 侧据此以 O(1)
     * 检测"当前语言的词条是否变了"，避免对几百 KB 的增量做全量序列化比对。
     */
    revisionsByTag: Record<string, number>;
}

type LocalePackListener = (snapshot: LocalePackSnapshot) => void;

class LocaleStore {
    private packsByPlugin = new Map<string, PluginLocalePackDefinition[]>();
    private mergedCache = new Map<string, MergedLocalePack>();
    private availableLocalesCache: string[] | undefined;
    private listeners = new Set<LocalePackListener>();
    private revisionsByTag = new Map<string, number>();
    private revisionCounter = 0;

    /** 整体替换某插件贡献的语言包（activate / 覆盖安装时调用） */
    replacePluginPacks(pluginId: string, packs: readonly PluginLocalePackDefinition[]): void {
        const affectedTags = new Set<string>();
        for (const pack of this.packsByPlugin.get(pluginId) ?? []) {
            affectedTags.add(pack.tag);
        }
        this.packsByPlugin.set(pluginId, [...packs]);
        for (const pack of packs) {
            affectedTags.add(pack.tag);
        }
        this.availableLocalesCache = undefined;
        this.invalidateTags(affectedTags);
        this.bumpRevisions(affectedTags);
        logLocaleEvent(
            'info',
            `Registered locale packs from plugin ${pluginId}: ${[...new Set(packs.map((pack) => pack.tag))].join(', ')}`
        );
        this.notify();
    }

    /** 移除某插件贡献的全部语言包（deactivate / 卸载时调用） */
    removePluginPacks(pluginId: string): void {
        const packs = this.packsByPlugin.get(pluginId);
        if (!packs) return;
        this.packsByPlugin.delete(pluginId);
        this.availableLocalesCache = undefined;
        const affectedTags = new Set(packs.map((pack) => pack.tag));
        this.invalidateTags(affectedTags);
        this.bumpRevisions(affectedTags);
        logLocaleEvent('info', `Removed locale packs from plugin ${pluginId}`);
        this.notify();
    }

    /** 受影响 tag 的修订号自增（修订号全局单调，保证任何变更都产生新指纹） */
    private bumpRevisions(tags: Iterable<string>): void {
        for (const tag of tags) {
            this.revisionCounter += 1;
            this.revisionsByTag.set(tag, this.revisionCounter);
        }
    }

    /** 测试用：清空全部状态 */
    clear(): void {
        this.packsByPlugin.clear();
        this.mergedCache.clear();
        this.availableLocalesCache = undefined;
        // 修订号整体自增而不是清空：保证清空前后快照指纹必然不同
        for (const tag of this.revisionsByTag.keys()) {
            this.revisionCounter += 1;
            this.revisionsByTag.set(tag, this.revisionCounter);
        }
        this.notify();
    }

    /**
     * 内置语言 ∪ 已启用语言包声明的语言，排序去重，供语言选项动态化。
     * 结果缓存直至插件语言包变更——该方法是 t() 热路径的一部分，不可每次重建集合。
     */
    getAvailableLocales(): string[] {
        if (this.availableLocalesCache) return this.availableLocalesCache;
        const tags = new Set<string>(BUILTIN_LOCALES);
        for (const packs of this.packsByPlugin.values()) {
            for (const pack of packs) {
                tags.add(pack.tag);
            }
        }
        this.availableLocalesCache = [...tags].sort();
        return this.availableLocalesCache;
    }

    /** 某语言的合并增量（含冲突报告），结果缓存直至相关插件变更 */
    getMergedPack(tag: string): MergedLocalePack | undefined {
        const cached = this.mergedCache.get(tag);
        if (cached !== undefined) return cached;
        const sources = [];
        for (const [pluginId, packs] of this.packsByPlugin) {
            for (const pack of packs) {
                if (pack.tag === tag) {
                    sources.push({ pluginId, content: pack });
                }
            }
        }
        const merged = mergeLocalePacks(sources);
        if (merged) {
            // 冲突是可解释的正常合并结果（插件 ID 字典序后者胜），仅在缓存重建时告警一次，
            // 供开发期排查；冲突清单同时随快照下发（P2 插件中心展示）
            if (merged.conflicts.length > 0) {
                logLocaleEvent(
                    'warn',
                    `Locale pack conflicts for ${tag}: ${merged.conflicts
                        .map((conflict) => `${conflict.key} (${conflict.winner} over ${conflict.losers.join(', ')})`)
                        .join('; ')}`
                );
            }
            this.mergedCache.set(tag, merged);
        }
        return merged;
    }

    /** 某语言声明的回退 tag（来自 @fallback 的合并结果），未声明返回 undefined */
    getPackFallback(tag: string): string | undefined {
        return this.getMergedPack(tag)?.fallback;
    }

    /**
     * 瘦身快照：只带"生效语言 + 其回退语言"的增量词条，供 IPC 下发 renderer。
     *
     * 渲染查找链只需要这两层；多装几个语言包时，全量快照体积按语言数线性膨胀
     * （4 个全量包约 1.4MB），而瘦身后恒为单语言体量（~350KB），每个窗口 / 子
     * frame 的 preload 都持有一份副本，节省的是 4 倍内存与每次推送的克隆耗时。
     * availableLocales / fallbackByTag / revisionsByTag 仍是小对象，保持全量。
     *
     * 组装规则与 renderer 侧应用视图重建指纹 activeLocalePackKey
     * （src/renderer/scripts/application-locale-refresh.ts）互为前提：指纹只跟踪
     * fallbackByTag 中声明过的 fallback。未声明 @fallback 的语言在取词链
     * resolveLocaleText 中虽缺省回退 en-US，但本快照不携带 en-US 增量，en-US
     * 词条变化不可能影响其显示，指纹不含 en-US 才与取词口径一致。修改本组装
     * 规则（如恒定带上 en-US）时必须同步修改指纹，locale-store.test.ts 锁有
     * 该不变式的测试。
     */
    getSlimSnapshot(activeLocale: string): LocalePackSnapshot {
        const incrementsByTag: Record<string, Record<string, string>> = {};
        const fallbackByTag: Record<string, string> = {};
        const conflicts: Record<string, LocalePackMergeConflict[]> = {};
        const includedTags = new Set<string>([activeLocale]);
        const activeFallback = this.getPackFallback(activeLocale);
        if (activeFallback && activeFallback !== activeLocale) {
            includedTags.add(activeFallback);
        }
        for (const tag of includedTags) {
            const merged = this.getMergedPack(tag);
            if (!merged) continue;
            incrementsByTag[tag] = merged.entries;
            if (merged.fallback !== undefined) fallbackByTag[tag] = merged.fallback;
            if (merged.conflicts.length > 0) conflicts[tag] = merged.conflicts;
        }
        return this.withRevisions({
            incrementsByTag,
            fallbackByTag,
            availableLocales: this.getAvailableLocales(),
            conflicts
        });
    }

    /** 当前快照全量导出：main 下发 renderer（IPC 拉取 / packsChanged 推送共用） */
    getSnapshot(): LocalePackSnapshot {
        const incrementsByTag: Record<string, Record<string, string>> = {};
        const fallbackByTag: Record<string, string> = {};
        const conflicts: Record<string, LocalePackMergeConflict[]> = {};
        for (const tag of this.getPackTags()) {
            const merged = this.getMergedPack(tag);
            if (!merged) continue;
            incrementsByTag[tag] = merged.entries;
            if (merged.fallback !== undefined) fallbackByTag[tag] = merged.fallback;
            if (merged.conflicts.length > 0) conflicts[tag] = merged.conflicts;
        }
        return this.withRevisions({
            incrementsByTag,
            fallbackByTag,
            availableLocales: this.getAvailableLocales(),
            conflicts
        });
    }

    private withRevisions(snapshot: Omit<LocalePackSnapshot, 'revisionsByTag'>): LocalePackSnapshot {
        const revisionsByTag: Record<string, number> = {};
        for (const [tag, revision] of this.revisionsByTag) {
            revisionsByTag[tag] = revision;
        }
        return { ...snapshot, revisionsByTag };
    }

    /** 订阅语言包变更（main 据此向各窗口广播 locale:packsChanged），返回取消函数 */
    subscribe(listener: LocalePackListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private getPackTags(): string[] {
        const tags = new Set<string>();
        for (const packs of this.packsByPlugin.values()) {
            for (const pack of packs) {
                tags.add(pack.tag);
            }
        }
        return [...tags];
    }

    private invalidateTags(tags: Iterable<string>): void {
        for (const tag of tags) {
            this.mergedCache.delete(tag);
        }
    }

    private notify(): void {
        if (this.listeners.size === 0) return;
        const snapshot = this.getSnapshot();
        for (const listener of [...this.listeners]) {
            try {
                listener(snapshot);
            } catch (error) {
                logLocaleEvent('error', 'Locale pack change listener failed', error);
            }
        }
    }
}

let store: LocaleStore | undefined;

export function getLocalePackStore(): LocaleStore {
    store ??= new LocaleStore();
    return store;
}
