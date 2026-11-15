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
 * 导出任务时把组件占位节点渲染成静态 HTML：导出走的是按数据重建的消息 HTML，
 * 不含页面上已挂载的组件，这里用同一套组件生成快照，样式由导出流程按类名收集。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { GENUI_PLACEHOLDER_CLASS, parseGenUiPayload } from '../../common/genui/protocol.js';
import { createRendererTranslator, resolveRendererLocale } from '../locale.js';
import { GenUiWidget } from './widgets.js';

type LocaleSource = Parameters<typeof createRendererTranslator>[0];

export function renderGenUiStaticHtml(html: string, localeSource?: LocaleSource): string {
    if (!html.includes(GENUI_PLACEHOLDER_CLASS)) return html;
    const t = createRendererTranslator(localeSource);
    const locale = resolveRendererLocale(localeSource);
    const box = document.createElement('div');
    box.innerHTML = html;
    for (const placeholder of box.querySelectorAll<HTMLElement>(`.${GENUI_PLACEHOLDER_CLASS}`)) {
        const payload = parseGenUiPayload(placeholder.dataset.genui);
        if (!payload) continue;
        // 导出是静态快照：等待中的交互卡片按只读展示，不带可点击的按钮
        const { requestId: _requestId, ...snapshot } = payload;
        placeholder.innerHTML = renderToStaticMarkup(<GenUiWidget payload={snapshot} t={t} locale={locale} />);
    }
    return box.innerHTML;
}
