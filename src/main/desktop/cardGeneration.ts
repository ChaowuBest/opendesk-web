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

import type { TaskState } from '../aikernel/states/tasks.js';

export type CardGenerateInput = {
    prompt: string;
    currentHtml?: string;
    width: number;
    height: number;
    locale?: string;
    theme?: 'light' | 'dark';
};

export function normalizeCardData(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

export function getLastAssistantMessageText(task: TaskState): string {
    const messages = task.chat_context?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as any;
        if (message?.role !== 'assistant') continue;
        const content = message.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                    if (typeof part === 'string') return part;
                    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
                    if (typeof part?.content === 'string') return part.content;
                    return '';
                })
                .filter(Boolean)
                .join('\n');
        }
    }
    return '';
}

export function extractHtmlFromAssistantText(text: string): string {
    const codeBlock = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
    if (codeBlock?.[1]) return codeBlock[1].trim();
    const fullHtml = text.match(/<!doctype html[\s\S]*?<\/html>/i) ?? text.match(/<html[\s\S]*?<\/html>/i);
    if (fullHtml?.[0]) return fullHtml[0].trim();
    const firstTag = text.match(/<([a-z][a-z0-9-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>/i);
    if (firstTag?.[0]) return firstTag[0].trim();
    return text.trim();
}

export function summarizeCardPromptForTaskName(prompt: string, maxLength = 32): string {
    const normalized = prompt.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
}

export function buildCardGenerationPrompt(input: CardGenerateInput): string {
    const currentHtml = input.currentHtml?.trim()
        ? `\n当前卡片 HTML，可在此基础上改进：\n\`\`\`html\n${input.currentHtml}\n\`\`\`\n`
        : '\n当前卡片没有已有内容。\n';
    const theme = input.theme === 'dark' ? '深色' : '浅色';
    return `你正在为 OpenDesk 沉浸桌面生成一张智能卡片的 HTML 内容。

用户需求：
${input.prompt}
${currentHtml}
卡片可用尺寸：${Math.round(input.width)}px x ${Math.round(input.height)}px。
界面语言：${input.locale || 'zh-CN'}。
当前主题：${theme}。

请只输出可嵌入 iframe srcdoc 的 HTML，不要输出解释、Markdown 或代码块标记。

硬性要求：
1. 内容必须自包含，可以包含 <style> 和少量 <script>，不要依赖外部网络资源。
2. 根容器必须使用 width: 100%; height: 100%; overflow: hidden; box-sizing: border-box。
3. 所有布局必须适配上述卡片尺寸，避免固定大宽高、页面滚动条、内容溢出和文字遮挡。
4. 使用 flex/grid、clamp()、minmax(0, 1fr)、text-overflow 或换行策略，让最长文本也能装入卡片。
5. 视觉风格必须贴合当前主题，不要在深色主题中使用大面积纯白背景。
6. 卡片外框由宿主提供（圆角容器 + 边框 + 阴影，内容会被裁剪为圆角）。根容器禁止自带边框、外阴影和圆角，背景保持透明，让宿主容器作为唯一的卡片外观；边框、阴影、圆角只允许出现在卡片内部的元素上。
7. 不要生成完整桌面页面，只生成卡片内部内容。`;
}
