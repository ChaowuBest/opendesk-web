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
 * 通用的 JSON 到 HTML 转换器
 * 能够识别和渲染各种 JSON 格式的内容
 * 使用与 a2ui-to-html.js 统一的渲染主题
 */

import { theme } from './a2ui-to-html.js';

// ============================================================================
// 主题配置 - 与 a2ui 统一的样式
// ============================================================================

/**
 * 获取主题配置中的样式
 * @param {string} componentType - 组件类型
 * @param {string} variant - 变体
 * @returns {string} CSS 样式字符串
 */
function getThemeStyles(componentType, variant = null) {
    const addStyles = theme.additionalStyles?.[componentType];
    if (!addStyles) return '';

    if (variant && addStyles[variant]) {
        return Object.entries(addStyles[variant])
            .map(([prop, val]) => `${prop}: ${val}`)
            .join('; ');
    }

    // 过滤掉嵌套对象（如 h1, h2 等）
    const directStyles = Object.entries(addStyles)
        .filter(([, val]) => typeof val !== 'object')
        .map(([prop, val]) => `${prop}: ${val}`)
        .join('; ');

    return directStyles;
}

/**
 * 生成 JSON 渲染的统一样式
 * 与 a2ui 主题保持一致
 */
function generateJSONStyles() {
    // 从 a2ui 主题获取基础样式
    const rootStyles = getThemeStyles('Root');
    const h3Styles = getThemeStyles('Text', 'h3');
    const bodyStyles = getThemeStyles('Text', 'body');
    const captionStyles = getThemeStyles('Text', 'caption');

    return `
/* JSON 渲染样式 - 与 a2ui 主题统一 */
.json-container {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
    font-size: 11px;
    line-height: 1.35;
    color: #1e293b;
    -webkit-font-smoothing: antialiased;
    word-wrap: break-word;
    overflow-wrap: break-word;
    word-break: break-word;
    background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e2e8f0 100%);
    border-radius: 8px;
    padding: 10px 12px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03);
}

.json-container * {
    box-sizing: border-box;
}

/* 文章列表 */
.json-article-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.json-article-item {
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid rgba(226, 232, 240, 0.8);
    border-radius: 6px;
    padding: 8px 10px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    transition: all 0.15s ease;
}

.json-article-item:hover {
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
    border-color: rgba(139, 92, 246, 0.2);
    transform: translateY(-1px);
}

.json-article-content {
    flex: 1;
}

.json-article-title {
    margin: 0 0 4px 0;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.25;
    color: transparent;
    background: linear-gradient(135deg, #818cf8 0%, #a78bfa 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
}

.json-article-title a {
    color: transparent;
    background: linear-gradient(135deg, #818cf8 0%, #a78bfa 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    text-decoration: none;
    font-weight: 600;
}

.json-article-title a:hover {
    text-decoration: underline;
    opacity: 0.9;
}

.json-article-date {
    font-size: 10px;
    color: #64748b;
    margin-bottom: 4px;
}

.json-article-summary {
    color: #475569;
    font-size: 11px;
    line-height: 1.45;
    margin-bottom: 4px;
}

.json-article-meta {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid rgba(226, 232, 240, 0.6);
    font-size: 10px;
}

.json-article-meta-item {
    margin: 2px 0;
    color: #64748b;
}

.json-article-meta-item strong {
    color: #475569;
    font-weight: 500;
}

.json-article-image {
    margin-bottom: 6px;
}

.json-article-image img {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

/* 表格样式 */
.json-table {
    width: 100%;
    border-collapse: collapse;
    margin: 6px 0;
    font-size: 10px;
    background: rgba(255, 255, 255, 0.7);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.json-table th,
.json-table td {
    border: 1px solid rgba(226, 232, 240, 0.8);
    padding: 6px 8px;
    text-align: left;
}

.json-table th {
    background: linear-gradient(135deg, rgba(129, 140, 248, 0.1) 0%, rgba(167, 139, 250, 0.1) 100%);
    font-weight: 500;
    color: #475569;
    font-size: 10px;
}

.json-table tr:nth-child(even) {
    background-color: rgba(248, 250, 252, 0.5);
}

.json-table tr:hover {
    background-color: rgba(129, 140, 248, 0.05);
}

/* 卡片列表 */
.json-card-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
}

.json-card {
    background: rgba(255, 255, 255, 0.7);
    border: 1px solid rgba(226, 232, 240, 0.8);
    border-radius: 6px;
    padding: 8px 10px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    transition: all 0.15s ease;
}

.json-card:hover {
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
    border-color: rgba(139, 92, 246, 0.2);
    transform: translateY(-1px);
}

.json-card-field {
    margin-bottom: 4px;
}

.json-card-field:last-child {
    margin-bottom: 0;
}

.json-card-key {
    font-weight: 500;
    color: #64748b;
    margin-bottom: 1px;
    font-size: 10px;
}

.json-card-value {
    color: #334155;
    font-size: 11px;
}

/* JSON 值类型样式 */
.json-string {
    color: #059669;
}

.json-number {
    color: #2563eb;
}

.json-boolean {
    color: #7c3aed;
}

.json-null {
    color: #94a3b8;
    font-style: italic;
}

.json-key {
    color: #64748b;
    font-weight: 500;
}

/* 普通 JSON 对象/数组 */
.json-object,
.json-array {
    font-family: "Maple Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 10px;
}

.json-property,
.json-item {
    padding-left: 12px;
    border-left: 1px solid rgba(226, 232, 240, 0.6);
    margin: 2px 0;
}

/* 错误提示 */
.json-error {
    color: #dc2626;
    padding: 6px 8px;
    background: rgba(254, 226, 226, 0.5);
    border: 1px solid rgba(248, 113, 113, 0.3);
    border-radius: 4px;
    font-size: 10px;
}
    `;
}

/**
 * 检测字符串是否是有效的 JSON
 * @param {string} text - 待检测的文本
 * @returns {boolean} 是否是 JSON
 */
export function isJSON(text) {
    if (!text || typeof text !== 'string') {
        return false;
    }

    const trimmed = text.trim();
    // 检查是否以 JSON 数组或对象开头
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try {
            JSON.parse(trimmed);
            return true;
        } catch (e) {
            return false;
        }
    }
    return false;
}

/**
 * 转义 HTML 特殊字符
 * @param {string} text - 待转义的文本
 * @returns {string} 转义后的文本
 */
import { escapeHtml } from '../../../common/utils/escape.js';

/**
 * 渲染单个 JSON 对象为 HTML
 * @param {object} obj - JSON 对象
 * @param {number} depth - 嵌套深度
 * @returns {string} HTML 字符串
 */
function renderObject(obj, depth = 0) {
    if (obj === null || obj === undefined) {
        return '<span class="json-null">null</span>';
    }

    const indent = '  '.repeat(depth);
    const nextIndent = '  '.repeat(depth + 1);

    if (Array.isArray(obj)) {
        if (obj.length === 0) {
            return '<span class="json-array">[]</span>';
        }

        // 检查是否是对象数组（常见的数据列表格式）
        if (obj.length > 0 && typeof obj[0] === 'object' && obj[0] !== null) {
            return renderObjectArray(obj);
        }

        // 普通数组
        const items = obj
            .map((item) => {
                if (typeof item === 'object' && item !== null) {
                    return `<div class="json-item">${nextIndent}${renderObject(item, depth + 1)}</div>`;
                } else {
                    return `<div class="json-item">${nextIndent}${renderValue(item)}</div>`;
                }
            })
            .join('');

        return `<div class="json-array">[${items}\n${indent}]</div>`;
    }

    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return '<span class="json-object">{}</span>';
        }

        const items = keys
            .map((key) => {
                const value = obj[key];
                const keyHtml = `<span class="json-key">${escapeHtml(key)}</span>`;
                let valueHtml;

                if (typeof value === 'object' && value !== null) {
                    valueHtml = renderObject(value, depth + 1);
                } else {
                    valueHtml = renderValue(value);
                }

                return `<div class="json-property">${nextIndent}${keyHtml}: ${valueHtml}</div>`;
            })
            .join('');

        return `<div class="json-object">{${items}\n${indent}}</div>`;
    }

    return renderValue(obj);
}

/**
 * 渲染值
 * @param {any} value - 值
 * @returns {string} HTML 字符串
 */
function renderValue(value) {
    if (value === null) {
        return '<span class="json-null">null</span>';
    }
    if (typeof value === 'string') {
        return `<span class="json-string">"${escapeHtml(value)}"</span>`;
    }
    if (typeof value === 'number') {
        return `<span class="json-number">${value}</span>`;
    }
    if (typeof value === 'boolean') {
        return `<span class="json-boolean">${value}</span>`;
    }
    return escapeHtml(String(value));
}

/**
 * 渲染对象数组（常见的数据列表格式，如新闻列表、商品列表等）
 * @param {Array<object>} array - 对象数组
 * @returns {string} HTML 字符串
 */
function renderObjectArray(array) {
    // 检测常见的字段模式
    const firstItem = array[0];
    const keys = Object.keys(firstItem);

    // 检查是否是新闻/文章类型（有 title, summary, url），定制化渲染增强
    if (keys.includes('title') && (keys.includes('summary') || keys.includes('content'))) {
        return renderArticleList(array);
    }

    // 检查是否是表格类型（所有对象有相同的键）
    if (
        keys.length > 0 &&
        array.every(
            (item) => typeof item === 'object' && item !== null && Object.keys(item).every((key) => keys.includes(key))
        )
    ) {
        return renderTable(array, keys);
    }

    // 默认：卡片列表
    return renderCardList(array);
}

/**
 * 渲染文章/新闻列表
 * @param {Array<object>} articles - 文章数组
 * @returns {string} HTML 字符串
 */
function renderArticleList(articles) {
    const items = articles
        .map((article, index) => {
            const title = article.title || article.name || '';
            const summary = article.summary || article.content || article.description || '';
            const url = article.url || article.link || article.href || '';
            const image = article.image || article.thumbnail || '';
            const date = article.date || article.publishedAt || article.time || '';

            let html = '<div class="json-article-item">';

            if (image) {
                html += `<div class="json-article-image"><img src="${escapeHtml(image)}" alt="${escapeHtml(title)}" /></div>`;
            }

            html += '<div class="json-article-content">';

            if (title) {
                if (url) {
                    html += `<h3 class="json-article-title"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></h3>`;
                } else {
                    html += `<h3 class="json-article-title">${escapeHtml(title)}</h3>`;
                }
            }

            if (date) {
                html += `<div class="json-article-date">${escapeHtml(date)}</div>`;
            }

            if (summary) {
                html += `<div class="json-article-summary">${escapeHtml(summary)}</div>`;
            }

            // 渲染其他字段
            const otherFields = Object.keys(article).filter(
                (key) =>
                    ![
                        'title',
                        'summary',
                        'content',
                        'description',
                        'url',
                        'link',
                        'href',
                        'image',
                        'thumbnail',
                        'date',
                        'publishedAt',
                        'time'
                    ].includes(key)
            );

            if (otherFields.length > 0) {
                html += '<div class="json-article-meta">';
                otherFields.forEach((key) => {
                    const value = article[key];
                    if (value !== null && value !== undefined && value !== '') {
                        html += `<div class="json-article-meta-item"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(value))}</div>`;
                    }
                });
                html += '</div>';
            }

            html += '</div></div>';
            return html;
        })
        .join('');

    return `<div class="json-article-list">${items}</div>`;
}

/**
 * 渲染表格
 * @param {Array<object>} data - 数据数组
 * @param {Array<string>} columns - 列名数组
 * @returns {string} HTML 字符串
 */
function renderTable(data, columns) {
    const header = `<thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead>`;
    const rows = data
        .map((item) => {
            const cells = columns
                .map((col) => {
                    const value = item[col];
                    return `<td>${renderValue(value)}</td>`;
                })
                .join('');
            return `<tr>${cells}</tr>`;
        })
        .join('');

    return `<table class="json-table"><tbody>${header}${rows}</tbody></table>`;
}

/**
 * 渲染卡片列表（通用对象列表）
 * @param {Array<object>} items - 对象数组
 * @returns {string} HTML 字符串
 */
function renderCardList(items) {
    const cards = items
        .map((item, index) => {
            const fields = Object.keys(item);
            let html = '<div class="json-card">';

            fields.forEach((key) => {
                const value = item[key];
                html += `<div class="json-card-field">`;
                html += `<div class="json-card-key">${escapeHtml(key)}</div>`;
                html += `<div class="json-card-value">${renderValue(value)}</div>`;
                html += `</div>`;
            });

            html += '</div>';
            return html;
        })
        .join('');

    return `<div class="json-card-list">${cards}</div>`;
}

/**
 * 将 JSON 字符串转换为 HTML
 * @param {string} jsonText - JSON 字符串
 * @returns {string} HTML 字符串
 */
export function jsonToHTML(jsonText) {
    if (!jsonText || typeof jsonText !== 'string') {
        return '';
    }

    try {
        const trimmed = jsonText.trim();
        const data = JSON.parse(trimmed);

        // 使用统一的 a2ui 主题样式
        const styles = `<style>${generateJSONStyles()}</style>`;
        const html = renderObject(data);
        return `<div class="json-container">${styles}${html}</div>`;
    } catch (error) {
        console.error('JSON to HTML conversion error:', error);
        return `<div class="json-error">JSON 解析失败: ${escapeHtml(error.message)}</div>`;
    }
}

/**
 * 获取 JSON 渲染的样式（用于外部引用）
 * @returns {string} CSS 样式字符串
 */
export function getJSONStyles() {
    return generateJSONStyles();
}
