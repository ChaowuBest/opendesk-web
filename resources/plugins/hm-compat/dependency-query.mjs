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
 * HarmonyOS 依赖支持情况查询（hm-compat 插件的一部分，由 index.mjs 接线）。
 *
 * 注册 checkHarmonySupport ，供模型在鸿蒙上安装第三方依赖前查询其支持情况。
 * 工具返回查询数据与时效声明，后续处理（直接安装/换鸿蒙源/切 Linux VM）由模型结合语境自主决定；
 * 查询失败不阻塞 agent，抛错文案引导照常安装，由现有摩擦检测兜底。
 *
 * 查询服务为标准 MCP streamable HTTP。
 */

import { z } from 'zod';

// 依赖支持情况查询服务端点
export const MCP_ENDPOINT = 'http://1.92.103.192/harmonyos-dependency-query/mcp';

// 单次查询超时时间
export const REQUEST_TIMEOUT_MS = 10_000;

// 查询服务数据源实际覆盖的语言（官方 schema 声明范围更大，按实际覆盖收窄）
export const SUPPORTED_LANGUAGES = ['node', 'python', 'cpp', 'java', 'rust', 'csharp'];

const CheckHarmonySupportSchema = z
    .object({
        dependencies: z
            .array(
                z
                    .object({
                        name: z.string().min(1).describe('依赖包名，如 axios、numpy'),
                        language: z.enum(SUPPORTED_LANGUAGES).describe('包所属语言生态')
                    })
                    .strict()
            )
            .min(1)
            .max(100)
            .describe('要查询的依赖列表，单次最多 100 项')
    })
    .strict();

const TOOL_DESCRIPTION =
    '查询第三方依赖在当前平台上的支持情况。在当前平台安装第三方库或依赖前' +
    '（pip/npm 安装、构建脚本拉取三方库、引入 native 模块），或怀疑依赖与当前平台不兼容时调用。' +
    'language 取值：npm 包用 node，Python 包用 python，C/C++ 库或可执行二进制用 cpp，其他语言按实际传 java/rust/csharp。' +
    '返回是否受支持、是否天然兼容及当前平台可用安装方案（harmonySolution）。' +
    '注意：supported=false 可能表示不支持，也可能是数据源暂无该包的记录；结果含数据更新时间，仅供参考。';

/**
 * 调用查询服务并返回业务结果负载（result.content[0].text 解析后的 JSON 对象）。
 *
 * @param {Array<{name: string, language: string}>} dependencies
 * @param {typeof fetch} fetchImpl 可注入的 fetch 实现（测试用）
 * @returns {Promise<{success: boolean, message?: string, results: Array, hint?: string}>}
 */
async function callDependencyQueryService(dependencies, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(MCP_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'check-harmony-support',
                    arguments: { dependencies }
                }
            }),
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const rpc = await response.json();
        if (rpc?.error) {
            throw new Error(`JSON-RPC ${rpc.error.code}: ${rpc.error.message}`);
        }
        const text = rpc?.result?.content?.[0]?.text;
        if (typeof text !== 'string') {
            throw new Error('响应缺少 result.content[0].text');
        }
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object') {
            throw new Error('响应业务负载不是 JSON 对象');
        }
        if (payload.success !== false && !Array.isArray(payload.results)) {
            throw new Error('响应业务负载缺少 results 数组');
        }
        return payload;
    } finally {
        clearTimeout(timer);
    }
}

/** 把单条查询结果翻译为语义文案。 */
function formatResultItem(item) {
    const label = `${item.name} (${item.language})`;
    if (item.supported !== true) {
        return `${label}: 不支持`;
    }
    if (item.nativelyCompatible === true) {
        return `${label}: 支持，天然兼容（可直接安装）`;
    }
    return `${label}: 支持，需从鸿蒙源下载: ${item.harmonySolution}`;
}

/**
 * 把查询服务的业务结果负载格式化为面向模型的语义文本。
 *
 * - supported=false 是歧义值（真不支持/查无记录/该语言无数据），统一呈现为
 *   「不支持」，歧义由工具描述声明；
 * - 时效行取各结果 updatedAt 的最大值，全部缺失时省略；updatedAt 为服务端已
 *   格式化的固定宽度时间字符串，字典序即时间序；
 * - 顶层 hint 存在时原样透传到结果末尾。
 *
 * @param {{success: boolean, message?: string, results: Array, hint?: string}} payload
 * @returns {string}
 */
export function formatDependencySupportResult(payload) {
    if (payload.success === false) {
        return payload.message ?? '查询失败';
    }
    const lines = payload.results.map(formatResultItem);
    const updatedAts = payload.results.map((item) => item.updatedAt).filter(Boolean);
    if (updatedAts.length > 0) {
        const latest = updatedAts.reduce((max, current) => (current > max ? current : max));
        lines.push(
            '---',
            `以上数据最后更新于 ${latest}，仅供参考，不保证当前环境下的实际有效性，请结合实际情况决定后续处理。`
        );
    }
    if (payload.hint) {
        lines.push(payload.hint);
    }
    return lines.join('\n');
}

/**
 * 查询依赖支持情况并返回格式化文本。网络/服务错误统一抛出带兜底引导的错误，
 * 查询失败不阻塞 agent。
 *
 * @param {Array<{name: string, language: string}>} dependencies
 * @param {typeof fetch} [fetchImpl] 可注入的 fetch 实现（测试用）
 * @returns {Promise<string>}
 */
export async function queryDependencySupport(dependencies, fetchImpl = fetch) {
    let payload;
    try {
        payload = await callDependencyQueryService(dependencies, fetchImpl);
    } catch (err) {
        const reason =
            err?.name === 'AbortError' ? `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）` : (err?.message ?? String(err));
        throw new Error(`HarmonyOS 依赖支持查询服务不可用（${reason}），可照常尝试安装，失败后现有摩擦检测会兜底。`);
    }
    return formatDependencySupportResult(payload);
}

/**
 * 注册 checkHarmonySupport 依赖支持情况查询工具（纯网络工具，所有 variant 可用）。
 *
 * @param {import('@bitclub.ai/opendesk-plugin-sdk').PluginContext} context
 */
export function setupDependencyQuery(context) {
    context.tools.register({
        name: 'checkHarmonySupport',
        description: TOOL_DESCRIPTION,
        parameters: CheckHarmonySupportSchema,
        execute: async (args) => queryDependencySupport(args.dependencies),
        render: {
            // 插件工具需自带渲染，否则对话里只显示工具名空壳；error 返回 undefined 走统一错误渲染
            gui: (ctx) => {
                if (ctx.status === 'error' || typeof ctx.result !== 'string' || !ctx.result) {
                    return undefined;
                }
                const summary = ctx.result.split('\n---\n')[0].trim();
                return summary ? { type: 'text', text: summary } : undefined;
            }
        }
    });
}
