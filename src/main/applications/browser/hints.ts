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
 * Browser hints — 把插件注册的页面提示接入 use-browser。
 *
 * 插件通过 `ctx.browser.hint.register(urlPrefix, generator)` 声明某类页面的提示；
 * 本模块负责在快照时构造 BrowserContext、拉取命中的 hint、渲染成快照前缀，
 * 并为 `trigger` 工具按名字解析 ActionHint。
 *
 * 每次都实时重新拉取 hint（而不是缓存上一次快照的结果），因此页面跳转、
 * 插件热重载都不会产生过期动作。
 */

import type {
    BrowserController,
    BrowserPageEvaluator,
    SnapshotPrefixProvider
} from '../../../common/embedBrowserUse/main.js';
import { getPluginHost } from '../pluginmgr/runtime/host.js';
import type { ActionHint, BrowserContext, BrowserHint } from '../../../../packages/plugin-sdk/src/index.js';

/** 页面基础信息，快照与 trigger 共用 */
export interface BrowserPageInfo {
    url: string;
    title?: string;
}

/** 去掉协议部分，得到 `域名/路径?查询` 形式的地址（hint 的 urlPrefix 与此匹配） */
function toAddress(url: string): string {
    return url
        .trim()
        .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
        .replace(/^\/\//, '');
}

function toDomain(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return toAddress(url).split(/[/?#]/)[0] ?? '';
    }
}

const READ_DOM_EXPRESSION = 'document.documentElement ? document.documentElement.outerHTML : ""';

/**
 * 构造传给 hint 生成器的页面上下文。
 *
 * DOM 采用懒加载：只依赖 URL 的生成器不会触发任何额外页面通信。
 */
export function buildBrowserContext(evaluate: BrowserPageEvaluator, page: BrowserPageInfo): BrowserContext {
    let domPromise: Promise<string> | undefined;
    return {
        url: page.url,
        domain: toDomain(page.url),
        address: toAddress(page.url),
        title: page.title ?? '',
        dom: () => {
            domPromise ??= Promise.resolve(evaluate(READ_DOM_EXPRESSION)).then((value) =>
                typeof value === 'string' ? value : ''
            );
            return domPromise;
        }
    };
}

/** 以 BrowserController 为后端的页面求值器（工具链路使用） */
function controllerEvaluator(ctrl: BrowserController): BrowserPageEvaluator {
    return (expression: string) => ctrl.evaluate(expression);
}

/** 拉取当前页面命中的全部 hint；无插件注册或全部失败时返回空数组 */
export async function collectBrowserHints(
    evaluate: BrowserPageEvaluator,
    page: BrowserPageInfo
): Promise<BrowserHint[]> {
    if (!page.url) return [];
    return await getPluginHost().getBrowserHints(buildBrowserContext(evaluate, page));
}

/**
 * 地址栏「页面提示」面板使用的 hint 摘要形态。
 *
 * 与快照链路不同，UI 只需要展示信息：剥离 `functionStr` 等重负载字段，
 * 避免把可执行源码经 IPC 传给 renderer。
 */
export type BrowserHintSummary =
    | { kind: 'text'; content: string }
    | {
          kind: 'action';
          name: string;
          /** 如 `SearchItem(keyword, category)` */
          signature: string;
          description: string;
          args: Record<string, string>;
      };

/** 把 hint 列表转换为地址栏面板展示用的摘要 */
export function summarizeBrowserHints(hints: readonly BrowserHint[]): BrowserHintSummary[] {
    return hints.map((hint) => {
        if (hint.kind === 'text') {
            return { kind: 'text' as const, content: hint.content };
        }
        return {
            kind: 'action' as const,
            name: hint.name,
            signature: renderActionSignature(hint),
            description: hint.description,
            args: { ...(hint.args ?? {}) }
        };
    });
}

/** 拉取当前页面命中的 hint 并转换为地址栏面板需要的摘要形态 */
export async function collectBrowserHintSummaries(
    evaluate: BrowserPageEvaluator,
    page: BrowserPageInfo
): Promise<BrowserHintSummary[]> {
    return summarizeBrowserHints(await collectBrowserHints(evaluate, page));
}

function renderActionSignature(hint: ActionHint): string {
    const args = Object.keys(hint.args ?? {}).join(', ');
    return `${hint.name}(${args})`;
}

/**
 * 把 hint 渲染成快照前缀。无 hint 时返回空数组；
 * 某一类 hint 不存在时对应的小节标题也不输出。
 */
export function renderBrowserHints(hints: readonly BrowserHint[]): string[] {
    if (hints.length === 0) return [];
    const textHints = hints.filter((hint) => hint.kind === 'text');
    const actionHints = hints.filter((hint): hint is ActionHint => hint.kind === 'action');
    const lines: string[] = ['## Browser Hints'];
    if (textHints.length > 0) {
        lines.push('', '### Text Hints', '');
        for (const hint of textHints) lines.push(`- ${hint.content}`);
    }
    if (actionHints.length > 0) {
        lines.push(
            '',
            '### Action Hints',
            '',
            "Actions are only available in this page and should be invoked by the 'trigger' tool.",
            ''
        );
        for (const hint of actionHints) {
            lines.push(`- ${renderActionSignature(hint)}: ${hint.description}`);
            for (const [name, description] of Object.entries(hint.args ?? {})) {
                lines.push(`  - ${name}: ${description}`);
            }
        }
    }
    lines.push('');
    return lines;
}

/**
 * 拉取并渲染当前页面的 hint 前缀，供快照输出直接拼接。
 *
 * hint 属于附加信息：任何失败都降级为无前缀，不影响快照本身。
 */
export async function renderBrowserHintsFor(ctrl: BrowserController, page: BrowserPageInfo): Promise<string[]> {
    try {
        return renderBrowserHints(await collectBrowserHints(controllerEvaluator(ctrl), page));
    } catch {
        return [];
    }
}

/**
 * embedBrowserUse 的快照前缀提供者。
 *
 * 通过 `setSnapshotPrefixProvider` 注入后，任务浏览器标签与浏览器应用的
 * 「导出 Snapshot」都会自动带上 Browser Hints，与 agent 的 snapshot 工具一致。
 */
export const browserHintsSnapshotPrefixProvider: SnapshotPrefixProvider = async (snapshot, evaluate) =>
    renderBrowserHints(await collectBrowserHints(evaluate, snapshot));

/** 按名字解析当前页面可用的 ActionHint */
export async function resolveActionHint(
    ctrl: BrowserController,
    page: BrowserPageInfo,
    name: string
): Promise<{ hint?: ActionHint; available: string[] }> {
    const hints = await collectBrowserHints(controllerEvaluator(ctrl), page);
    const actions = hints.filter((hint): hint is ActionHint => hint.kind === 'action');
    return {
        hint: actions.find((action) => action.name === name),
        available: actions.map(renderActionSignature)
    };
}

/**
 * 生成在页面中调用 action 的表达式：先 eval functionStr 得到函数对象，再以 fn(args) 调用。
 *
 * 返回值经 JSON 往返以满足 CDP 的 returnByValue；不可序列化时降级为字符串描述。
 */
export function makeActionInvokeExpression(hint: ActionHint, args: Record<string, unknown>): string {
    return `(async () => {
    const fn = (${hint.functionStr});
    if (typeof fn !== 'function') throw new Error('Action ${hint.name} is not a function');
    const value = await fn(${JSON.stringify(args)});
    if (value === undefined) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (error) {
        return String(value);
    }
})()`;
}
