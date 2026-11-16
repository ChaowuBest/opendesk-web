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
 * 应用视图的语言跟随刷新器。
 *
 * 应用界面（application.html / application_window.html 的应用 iframe）是宿主窗口的
 * 子 frame：主进程的 setting:changed / locale:packsChanged 广播只送达主 frame，
 * 子 frame 的订阅永远不会触发（见 agentgate 的 LOCALE_CHANGED postMessage 桥，
 * commit 67d2376f），应用无法原地跟随语言切换。
 *
 * 这里统一采用"关闭重建"策略：生效语言变化（或当前语言的语言包词条实际变化）时
 * 重建应用视图，重开的应用在 connectedCallback 里主动 loadSettingObject / 拉取
 * 语言包快照（frame 发起的 invoke 不受广播限制），按最新语言全新渲染。
 */

import { isBuiltinLocaleTag } from '../../common/locale/pack.js';

/** 宿主下发的语言包快照（preload localeAPI 结构，只取本模块用到的字段） */
export interface LocalePackSnapshotLike {
    incrementsByTag?: Record<string, Record<string, string>>;
    fallbackByTag?: Record<string, string>;
    availableLocales?: string[];
    /** 各 tag 的内容修订号；缺失时退回对增量做全量序列化比对 */
    revisionsByTag?: Record<string, number>;
}

/** 打开应用视图的宿主状态（主窗口 index.html 的闭包变量子集） */
export interface AppViewCloseHost {
    /** 驻留应用 iframe 缓存（bundleName -> iframe），全部要销毁 */
    appFrameCache: Record<string, { remove(): unknown }>;
    /** 内联挂载的应用容器（浏览器应用等，带 data-inline-app 标记） */
    nonAppSlot: { querySelectorAll(selectors: string): ArrayLike<{ remove(): unknown }> } | null;
    /** 当前前台应用包名；null 表示前台不是应用视图 */
    currentOpenAppBundleName: string | null;
    /** 回主页（skipWizard 透传，语言切换不弹首启向导） */
    openHomePage(skipWizard?: boolean): void;
}

/**
 * 关闭所有已打开的应用视图：销毁全部驻留应用 iframe、移除内联应用，
 * 前台是应用视图时回主页。前台是主页/任务/设置等非应用视图时保持不动，
 * 只清理后台驻留。返回是否有应用视图被关闭。
 */
export function closeAllOpenApplicationViews(host: AppViewCloseHost): boolean {
    const hadOpenApp = Boolean(host.currentOpenAppBundleName);
    for (const bundleName of Object.keys(host.appFrameCache)) {
        host.appFrameCache[bundleName].remove();
        delete host.appFrameCache[bundleName];
    }
    if (host.nonAppSlot) {
        const inlineApps = host.nonAppSlot.querySelectorAll('[data-inline-app]');
        for (let i = 0; i < inlineApps.length; i++) {
            inlineApps[i].remove();
        }
    }
    if (hadOpenApp) {
        host.openHomePage(true);
    }
    return hadOpenApp;
}

/**
 * 当前语言（含其回退链）的语言包词条指纹：lookup 链中任一环节变化都会改变
 * 应用可见文案。内置语言不回退（resolveLocaleText 对 builtin 跳过 fallback 链），
 * 只取本语言增量。快照缺失 / 语言未知时返回 null（调用方视为基线，不触发重建）。
 *
 * 快照携带修订号（revisionsByTag）时用 O(1) 修订号拼指纹；旧快照（测试或
 * 未升级的宿主）退回对增量做全量 JSON 序列化比对。
 *
 * fallback 只跟踪 fallbackByTag 中声明过的 @fallback。取词链 resolveLocaleText
 * 对未声明 @fallback 的非内置语言缺省回退 en-US，但宿主下发的瘦身快照
 * （LocaleStore.getSlimSnapshot，组装规则见其注释）同样不携带 en-US 增量，
 * en-US 词条变化不可能影响显示，指纹不含 en-US 才与取词口径一致；
 * 两处规则互为前提，必须同步修改（locale-store.test.ts 锁有该不变式）。
 */
export function activeLocalePackKey(snapshot: LocalePackSnapshotLike | null, locale: string | null): string | null {
    if (!snapshot || !locale) return null;
    const revisions = snapshot.revisionsByTag;
    if (revisions) {
        if (isBuiltinLocaleTag(locale)) {
            return `r${revisions[locale] ?? 0}`;
        }
        const fallback = snapshot.fallbackByTag?.[locale] ?? null;
        return `r${revisions[locale] ?? 0}|f${fallback ?? ''}|r${fallback ? (revisions[fallback] ?? 0) : 0}`;
    }
    const incrementsByTag = snapshot.incrementsByTag ?? {};
    const increments = incrementsByTag[locale];
    if (isBuiltinLocaleTag(locale)) {
        return JSON.stringify([increments ?? null]);
    }
    const fallbackByTag = snapshot.fallbackByTag ?? {};
    const fallback = fallbackByTag[locale] ?? null;
    const fallbackIncrements = fallback ? (incrementsByTag[fallback] ?? null) : null;
    return JSON.stringify([increments ?? null, fallback, fallbackIncrements]);
}

export interface LocaleAppViewRefresher {
    /**
     * 记录生效语言（setting:changed 广播与启动基线 loadSettingObject 共用）。
     * 首次调用只记基线不触发重建，之后语言变化触发一次重建。
     */
    recordLocale(resolvedLocale: unknown): void;
    /** 记录语言包快照（locale:packsChanged）：当前语言的词条实际变化时触发重建 */
    recordPackSnapshot(snapshot: LocalePackSnapshotLike | null): void;
    /** 最近记录的生效语言（尚未记录时为 null），供语言包指纹取当前语言 */
    getLocale(): string | null;
}

/**
 * 创建语言/语言包 → 应用视图重建的判定器：把"什么时候必须重建"收敛在一处，
 * 重建动作由宿主注入（主窗口销毁应用视图回主页，独立窗口原地重挂 iframe）。
 * 首次记录（启动基线 / preload 首次拉包）不触发重建，避免启动时误关应用。
 */
export function createLocaleAppViewRefresher(rebuildView: () => void): LocaleAppViewRefresher {
    let lastLocale: string | null = null;
    let lastPackKey: string | null = null;
    let lastSnapshot: LocalePackSnapshotLike | null = null;

    function normalizeLocale(value: unknown): string | null {
        return typeof value === 'string' && value ? value : null;
    }

    return {
        recordLocale(resolvedLocale: unknown): void {
            const next = normalizeLocale(resolvedLocale);
            if (lastLocale !== null && next !== null && next !== lastLocale) {
                rebuildView();
            }
            lastLocale = next;
            if (lastSnapshot !== null && lastLocale !== null) {
                // 快照先于语言基线到达时（启动竞态），先前指纹是在语言未知下记的 null，
                // 不能当作已建立基线；这里用最近快照按新语言静默重算，不重复触发重建
                lastPackKey = activeLocalePackKey(lastSnapshot, lastLocale);
            }
        },
        recordPackSnapshot(snapshot: LocalePackSnapshotLike | null): void {
            // 无快照（preload 未就绪等）不动基线，避免下一次真实变更被误当首次记录
            if (!snapshot) return;
            lastSnapshot = snapshot;
            const key = activeLocalePackKey(snapshot, lastLocale);
            if (lastPackKey !== null && key !== null && key !== lastPackKey) {
                rebuildView();
            }
            lastPackKey = key;
        },
        getLocale(): string | null {
            return lastLocale;
        }
    };
}
