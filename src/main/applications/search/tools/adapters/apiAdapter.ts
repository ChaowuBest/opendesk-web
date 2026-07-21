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
 * SPA 站点 API 适配器机制。
 *
 * 很多现代网站是纯 SPA（如 GitCode、GitLab），直接 HTTP 请求只能拿到骨架页。
 * 当这些站点提供 REST API 时，可以通过适配器直接获取结构化数据，
 * 绕过 SPA 渲染问题。
 *
 * 扩展方式：实现 {@link ApiAdapter} 接口，注册到 WebFetchTool 的适配器列表即可。
 */

export interface FetchResult {
    content: string;
    strategy: string;
    httpStatus?: number;
}

/**
 * 适配器运行时上下文，由 WebFetchTool 提供给适配器使用。
 * 封装了共享的 HTTP 请求、响应体读取和文本截断能力，
 * 使适配器无需重复实现重试逻辑、超时保护等。
 */
export interface ApiAdapterContext {
    fetch(
        url: string,
        headers: Record<string, string>,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<Response>;
    readBody(response: Response): Promise<string>;
    truncate(text: string): string;
}

/**
 * SPA 站点 API 适配器接口。
 *
 * 适配器在 WebFetchTool 的策略链中优先于直接获取执行。
 * 当 {@link canHandle} 返回 true 时，{@link fetch} 将被调用以通过 API 获取内容。
 */
export interface ApiAdapter {
    /** 适配器名称，用于策略标识和进度提示 */
    readonly name: string;
    /** 检测 URL 是否可以被此适配器处理 */
    canHandle(url: string): boolean;
    /** 通过 API 获取内容并格式化为 Markdown，失败时返回 null 以回退到后续策略 */
    fetch(
        url: string,
        ctx: ApiAdapterContext,
        onRetry?: (attempt: number, reason: string) => void
    ): Promise<FetchResult | null>;
}
