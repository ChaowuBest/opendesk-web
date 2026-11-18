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
 * 语言包（locale pack）纯函数层：解析、合并与展示名格式化。
 *
 * 语言包是插件以 resources.locales 声明的扁平 JSON 词典（string -> string），
 * 合并后作为"增量层"叠加在内置词典之上：增量优先于内置（内置文案概念上为
 * priority 0），同一语言允许多个插件部分提供，同 key 冲突按 @priority 优先级裁决
 * （priority 缺省 1），平局按插件 ID 字典序后者胜。本模块不依赖 Electron/文件
 * 系统，宿主（loader / LocaleStore）与测试共用同一实现，保证口径一致。
 */

/** 宿主内置语言：词典全量、互不回退（zh-CN / en-US）。定义在本模块以避免与 ../locale.ts 互相引用 */
export const BUILTIN_LOCALES = ['zh-CN', 'en-US'] as const;

/** 语言包内保留给元数据的 key 前缀，不参与翻译查找 */
const RESERVED_KEY_PREFIX = '@';
/** 保留 key：该语言的回退语言 tag（仅非内置语言有意义，缺省 en-US） */
export const LOCALE_PACK_FALLBACK_KEY = '@fallback';
/** 保留 key：语言包合并优先级（0-999 整数，数值越大越优先，缺省 1） */
export const LOCALE_PACK_PRIORITY_KEY = '@priority';
/** @priority 的取值上界（含）；下界为 0（系统内置文案的概念层级） */
export const LOCALE_PACK_PRIORITY_MAX = 999;

/** 单个语言包文件的内容（已解析、tag 已规范化） */
export interface LocalePackContent {
    /** 规范化后的 BCP-47 tag，如 tr-TR */
    tag: string;
    /** 回退语言 tag（已规范化）。非内置语言缺省 en-US，内置语言无回退 */
    fallback?: string;
    /**
     * 合并优先级（0-999 整数，数值越大越优先）。来自语言包文件的 @priority 保留 key，
     * 未声明时缺省 1；合并顺序为 priority 升序、同 priority 按插件 ID 字典序，迭代后者胜。
     */
    priority: number;
    /** 参与查找的词条（保留 key 已剥离） */
    entries: Record<string, string>;
}

/** 语言包 JSON 的解析错误：携带文件来源与出错 key，便于定位 */
export class LocalePackParseError extends Error {
    constructor(
        message: string,
        readonly sourceFile?: string
    ) {
        super(sourceFile ? `${message} (${sourceFile})` : message);
        this.name = 'LocalePackParseError';
    }
}

/**
 * normalizeLocaleTag 的结果缓存：该函数位于 t() / 系统语言解析的热路径上，
 * 且非法 tag（如 'auto'）每次都要构造 Intl.Locale 并吞掉 RangeError。
 * 候选值（设置值、系统语言、包文件名）是有穷小集合，容量上限触顶即整体清空。
 */
const normalizedTagCache = new Map<string, string | undefined>();
const NORMALIZED_TAG_CACHE_LIMIT = 512;

/**
 * 规范化语言 tag：'tr-tr' / 'tr_TR' -> 'tr-TR'。
 * 优先使用 Intl.Locale（Electron / full-icu Node 均可用），不可用或非法时返回 undefined。
 */
export function normalizeLocaleTag(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().replace(/_/g, '-');
    if (!trimmed) return undefined;
    if (normalizedTagCache.has(trimmed)) return normalizedTagCache.get(trimmed);
    let normalized: string | undefined;
    try {
        normalized = new Intl.Locale(trimmed).toString();
    } catch {
        normalized = undefined;
    }
    if (normalizedTagCache.size >= NORMALIZED_TAG_CACHE_LIMIT) normalizedTagCache.clear();
    normalizedTagCache.set(trimmed, normalized);
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析语言包 JSON 数据（已 JSON.parse 的原始值）为 LocalePackContent。
 *
 * 结构要求：顶层扁平对象、词条 key/value 均为字符串；`@` 前缀的保留 key 支持
 * @fallback（值必须是合法语言 tag）与 @priority（0-999 整数，字符串或数字形式均可），
 * 其余保留 key 忽略。任何结构问题都抛出带定位信息的 LocalePackParseError，
 * 不允许静默丢弃整个语言包。
 */
export function parseLocalePackJson(raw: unknown, sourceFile?: string): LocalePackContent {
    // function 声明（而非箭头函数常量）：TS 只对函数声明的 never 返回做控制流收窄
    function fail(message: string): never {
        throw new LocalePackParseError(message, sourceFile);
    }
    if (!isRecord(raw)) fail('locale pack must be a flat object');
    const entries: Record<string, string> = {};
    let fallback: string | undefined;
    let priority = 1;
    for (const [key, value] of Object.entries(raw)) {
        // 保留 key 分支先于词条的字符串值校验：@priority 允许 JSON 数字形式，
        // 不应被"词条必须为字符串"误伤
        if (key.startsWith(RESERVED_KEY_PREFIX)) {
            if (key === LOCALE_PACK_FALLBACK_KEY) {
                const tag = normalizeLocaleTag(value);
                if (!tag) fail(`reserved key ${LOCALE_PACK_FALLBACK_KEY} must be a valid language tag`);
                fallback = tag;
            } else if (key === LOCALE_PACK_PRIORITY_KEY) {
                const parsed =
                    typeof value === 'number'
                        ? value
                        : typeof value === 'string' && value.trim()
                          ? Number(value.trim())
                          : Number.NaN;
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > LOCALE_PACK_PRIORITY_MAX) {
                    fail(
                        `reserved key ${LOCALE_PACK_PRIORITY_KEY} must be an integer between 0 and ${LOCALE_PACK_PRIORITY_MAX}`
                    );
                }
                priority = parsed;
            }
            continue;
        }
        if (typeof value !== 'string') fail(`entry "${key}" must map to a string`);
        if (!key.trim()) fail('entry key must not be empty');
        entries[key] = value;
    }
    const tagFromFilename = sourceFile ? tagFromPackFileName(sourceFile) : undefined;
    if (!tagFromFilename) fail('pack file name must be a BCP-47 tag like ja-JP.json');
    return {
        tag: tagFromFilename,
        fallback,
        priority,
        entries
    };
}

/** 从语言包文件名提取语言 tag：'locales/tr-TR.json' -> 'tr-TR' */
export function tagFromPackFileName(filePath: string): string | undefined {
    const basename = filePath.split(/[\\/]/).pop() ?? '';
    if (!basename.toLowerCase().endsWith('.json')) return undefined;
    return normalizeLocaleTag(basename.slice(0, -'.json'.length));
}

/** 合并冲突记录：key -> 覆盖获胜的插件 ID 与被覆盖方列表 */
export interface LocalePackMergeConflict {
    key: string;
    winner: string;
    losers: string[];
}

/** 多插件语言包按 tag 合并的结果 */
export interface MergedLocalePack {
    /** 该语言下所有插件词条的合并结果（增量层最终形态） */
    entries: Record<string, string>;
    /** 多包 fallback 的合并结果：合并顺序中最后一个声明生效（priority 最高者，平局按 ID 字典序） */
    fallback?: string;
    /** 同 key 多插件冲突报告（获胜者为合并后实际生效的插件） */
    conflicts: LocalePackMergeConflict[];
}

/** 参与合并的单个来源 */
export interface LocalePackSource {
    pluginId: string;
    content: LocalePackContent;
}

/**
 * 合并同一语言的多份语言包：按 priority 升序、同 priority 按插件 ID 字典序排序后
 * 迭代后者覆盖前者，因此 priority 高者胜、平局时 ID 大者胜。priority 来自语言包的
 * @priority 声明（缺省 1）；系统内置文案概念上为 priority 0——包增量在查找链中恒
 * 覆盖内置词典。
 *
 * 平局裁决与安装顺序、启动顺序无关——卸载重装不改变合并结果，冲突可复现、可解释。
 * key 冲突不是错误：照常合并并写入 conflicts 报告（P2 插件中心展示）。
 */
export function mergeLocalePacks(sources: readonly LocalePackSource[]): MergedLocalePack | undefined {
    if (sources.length === 0) return undefined;
    const ordered = [...sources].sort((a, b) => {
        if (a.content.priority !== b.content.priority) return a.content.priority - b.content.priority;
        return a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0;
    });
    const entries: Record<string, string> = {};
    const owners = new Map<string, string[]>();
    const conflicts: LocalePackMergeConflict[] = [];
    let fallback: string | undefined;
    for (const source of ordered) {
        for (const [key, value] of Object.entries(source.content.entries)) {
            const previousOwners = owners.get(key);
            if (previousOwners !== undefined) {
                conflicts.push({ key, winner: source.pluginId, losers: [...previousOwners] });
            }
            entries[key] = value;
            const ownerList = owners.get(key) ?? [];
            ownerList.push(source.pluginId);
            owners.set(key, ownerList);
        }
        if (source.content.fallback !== undefined) {
            fallback = source.content.fallback;
        }
    }
    return { entries, fallback, conflicts };
}

/**
 * 语言 tag 的展示名：取该语言主语言的自身书写形式（如 tr-TR -> Türkçe、id-ID ->
 * Bahasa Indonesia），与设置页/TUI 下拉框对齐；不展示区域后缀（pt-BR/pt-PT 均
 * 显示 Português，语言包层面的区分交给插件 displayName）。
 * 各语言对语言名的书写规范不一致（如 fr -> français 小写、de -> Deutsch 大写），
 * 选项列表统一改为首字母大写，保证同一列表内大小写风格一致。
 * Intl.DisplayNames 不可用或解析失败时退回原始 tag。
 */
export function formatLocaleDisplayName(tag: string): string {
    try {
        const primary = tag.trim().replace(/_/g, '-').split('-')[0];
        const displayNames = new Intl.DisplayNames([primary], { type: 'language' });
        const name = displayNames.of(primary);
        if (name && name.toLowerCase() !== primary.toLowerCase()) return capitalizeFirstLetter(name);
    } catch {
        /* Intl.DisplayNames 不可用时退回 tag 本身 */
    }
    return tag;
}

function capitalizeFirstLetter(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * 语言选项的展示顺序：中文紧随「自动/默认」项之后、先于其它语言，其余按字母序。
 * 仅用于选项列表渲染，不改变 getAvailableLocales() 的字典序结果（查找链与
 * BCP-47 匹配不关心顺序）。
 */
export function orderLocaleOptions(tags: readonly string[]): string[] {
    return [...tags].sort((a, b) => {
        const aChinese = isChineseLocaleTag(a);
        const bChinese = isChineseLocaleTag(b);
        if (aChinese !== bChinese) return aChinese ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
    });
}

function isChineseLocaleTag(tag: string): boolean {
    return tag.trim().toLowerCase().startsWith('zh');
}

/**
 * 判断语言 tag 是否是宿主内置语言（zh-CN / en-US）。
 * 内置语言词典全量、互不回退；非内置语言才走 @fallback 链。
 */
export function isBuiltinLocaleTag(tag: string): boolean {
    return (BUILTIN_LOCALES as readonly string[]).includes(tag);
}

/**
 * 语言包查找链的统一实现，main 侧全局 t() 与应用域 t()、renderer 的
 * createTranslator 共用同一顺序，保证各端对同一 key 的解析结果一致。
 *
 * 链序：
 *  1. pack[locale][<prefix>.key]（仅 domainPrefix 存在时；应用歧义 key 的域专属覆盖）
 *  2. pack[locale][key]
 *  3. domain[locale][key]（内置词典：全局词典或应用词典，由调用方传入）
 *  4. 非 builtin locale：<prefix>.key -> key（pack[fallback]）-> domain[fallback][key]，fallback 缺省 en-US
 *  5. locale === 'en-US'：domain['zh-CN'][key]（保持 renderer 既有兜底）
 *  6. 回显 key 本身
 *
 * @param lookupPack 由宿主注入的增量查询：返回该 tag 的合并增量词条
 * @param domainPrefix 应用域前缀（如 'notes'）。传入后语言包可按 <prefix>.<key>
 *   提供域专属覆盖（app.name / agent.instruct 等跨应用歧义 key 的解法），
 *   未命中时回退裸 key，保持「共享域覆盖影响所有应用」的既有语义
 */
export function resolveLocaleText(
    key: string,
    locale: string,
    domainTranslations: Record<string, Record<string, string>>,
    lookupPack: (tag: string) => Record<string, string> | undefined,
    getPackFallback: (tag: string) => string | undefined,
    domainPrefix?: string
): string {
    const packEntries = lookupPack(locale);
    // 前缀串拼接保持无条件：主语言无增量但回退语言的包可能携带前缀条目，
    // 不能以主语言增量为存在条件（重复取词的开销已由 renderer 记忆化兜住）
    const prefixedKey = domainPrefix ? `${domainPrefix}.${key}` : undefined;
    let text =
        (prefixedKey ? packEntries?.[prefixedKey] : undefined) ??
        packEntries?.[key] ??
        domainTranslations[locale]?.[key];
    if (text !== undefined) return text;
    if (!isBuiltinLocaleTag(locale)) {
        const fallback = getPackFallback(locale) ?? 'en-US';
        if (fallback !== locale) {
            const fallbackPack = lookupPack(fallback);
            text =
                (prefixedKey ? fallbackPack?.[prefixedKey] : undefined) ??
                fallbackPack?.[key] ??
                domainTranslations[fallback]?.[key];
            if (text !== undefined) return text;
        }
    }
    if (locale === 'en-US') {
        text = domainTranslations['zh-CN']?.[key];
        if (text !== undefined) return text;
    }
    return key;
}

/** 对已解析文案应用 ${param} 插值（与既有 t() 行为一致） */
export function applyLocaleParams(text: string, params?: Record<string, string | number>): string {
    if (!params) return text;
    let result = text;
    for (const [name, value] of Object.entries(params)) {
        // split/join 与 replace + 全局正则的替换语义一致（全部出现、字面匹配），
        // 但免去每次调用的 RegExp 编译，也避免替换值中的 $ 序列被当作正则替换模式
        result = result.split(`\${${name}}`).join(String(value));
    }
    return result;
}
