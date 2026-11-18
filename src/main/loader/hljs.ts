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

import { logger } from '../utils/logger.js';
import { createResourceLoader, type ResourceLoader } from './base.js';

/** highlight.js 默认导出。全语言包在 bundle 内约 1.5MB，不随入口静态加载。 */
export type HighlightingModule = (typeof import('highlight.js'))['default'];

export const hljsLoader: ResourceLoader<HighlightingModule> = createResourceLoader('syntax-highlighting', async () => {
    const module = await import('highlight.js');
    return (module.default ?? module) as HighlightingModule;
});

/**
 * 预取语法高亮。失败只降级为纯文本渲染并留一条告警，不阻塞消息渲染；
 * 句柄在失败后会复位，因此后续渲染可以再次触发重试。
 */
export function prefetchHighlighting(): void {
    hljsLoader.ensure().catch((error: unknown) => {
        logger.warn(
            `[messages] highlight.js unavailable; using plain text rendering: ${error instanceof Error ? error.message : String(error)}`
        );
    });
}

// 模块加载即预取：首条消息渲染通常远晚于 import 求值完成。
prefetchHighlighting();
