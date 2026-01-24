/**
 * 通用的 JSON 到 HTML 转换器
 * 能够识别和渲染各种 JSON 格式的内容
 */

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
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
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
function escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }
    // 统一使用字符串替换方式，兼容 Node.js 和浏览器环境
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
        const items = obj.map(item => {
            if (typeof item === 'object' && item !== null) {
                return `<div class="json-item">${nextIndent}${renderObject(item, depth + 1)}</div>`;
            } else {
                const value = typeof item === 'string' ? escapeHtml(item) : item;
                return `<div class="json-item">${nextIndent}${renderValue(item)}</div>`;
            }
        }).join('');

        return `<div class="json-array">[${items}\n${indent}]</div>`;
    }

    if (typeof obj === 'object') {
        const keys = Object.keys(obj);
        if (keys.length === 0) {
            return '<span class="json-object">{}</span>';
        }

        const items = keys.map(key => {
            const value = obj[key];
            const keyHtml = `<span class="json-key">${escapeHtml(key)}</span>`;
            let valueHtml;

            if (typeof value === 'object' && value !== null) {
                valueHtml = renderObject(value, depth + 1);
            } else {
                valueHtml = renderValue(value);
            }

            return `<div class="json-property">${nextIndent}${keyHtml}: ${valueHtml}</div>`;
        }).join('');

        return `<div class="json-object">{${items}\n${indent}]</div>`;
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
    if (keys.length > 0 && array.every(item => 
        typeof item === 'object' && 
        item !== null && 
        Object.keys(item).every(key => keys.includes(key))
    )) {
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
    const items = articles.map((article, index) => {
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
        const otherFields = Object.keys(article).filter(key => 
            !['title', 'summary', 'content', 'description', 'url', 'link', 'href', 'image', 'thumbnail', 'date', 'publishedAt', 'time'].includes(key)
        );

        if (otherFields.length > 0) {
            html += '<div class="json-article-meta">';
            otherFields.forEach(key => {
                const value = article[key];
                if (value !== null && value !== undefined && value !== '') {
                    html += `<div class="json-article-meta-item"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(value))}</div>`;
                }
            });
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }).join('');

    return `<div class="json-article-list">${items}</div>`;
}

/**
 * 渲染表格
 * @param {Array<object>} data - 数据数组
 * @param {Array<string>} columns - 列名数组
 * @returns {string} HTML 字符串
 */
function renderTable(data, columns) {
    const header = `<thead><tr>${columns.map(col => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead>`;
    const rows = data.map(item => {
        const cells = columns.map(col => {
            const value = item[col];
            return `<td>${renderValue(value)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    return `<table class="json-table"><tbody>${header}${rows}</tbody></table>`;
}

/**
 * 渲染卡片列表（通用对象列表）
 * @param {Array<object>} items - 对象数组
 * @returns {string} HTML 字符串
 */
function renderCardList(items) {
    const cards = items.map((item, index) => {
        const fields = Object.keys(item);
        let html = '<div class="json-card">';

        fields.forEach(key => {
            const value = item[key];
            html += `<div class="json-card-field">`;
            html += `<div class="json-card-key">${escapeHtml(key)}</div>`;
            html += `<div class="json-card-value">${renderValue(value)}</div>`;
            html += `</div>`;
        });

        html += '</div>';
        return html;
    }).join('');

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

        // 添加样式
        const styles = `
            <style>
                .json-container {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                    line-height: 1.6;
                    color: #333;
                }
                .json-article-list {
                    display: flex;
                    flex-direction: column;
                    gap: 1.5rem;
                }
                .json-article-item {
                    border: 1px solid #e0e0e0;
                    border-radius: 8px;
                    padding: 1rem;
                    background: #fff;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                    transition: box-shadow 0.2s;
                }
                .json-article-item:hover {
                    box-shadow: 0 2px 6px rgba(0,0,0,0.15);
                }
                .json-article-content {
                    flex: 1;
                }
                .json-article-title {
                    margin: 0 0 0.5rem 0;
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: #1a1a1a;
                }
                .json-article-title a {
                    color: #2563eb;
                    text-decoration: none;
                }
                .json-article-title a:hover {
                    text-decoration: underline;
                }
                .json-article-date {
                    font-size: 0.85rem;
                    color: #666;
                    margin-bottom: 0.5rem;
                }
                .json-article-summary {
                    color: #555;
                    line-height: 1.6;
                    margin-bottom: 0.5rem;
                }
                .json-article-meta {
                    margin-top: 0.5rem;
                    padding-top: 0.5rem;
                    border-top: 1px solid #e0e0e0;
                    font-size: 0.9rem;
                }
                .json-article-meta-item {
                    margin: 0.25rem 0;
                }
                .json-article-image {
                    margin-bottom: 0.75rem;
                }
                .json-article-image img {
                    max-width: 100%;
                    height: auto;
                    border-radius: 4px;
                }
                .json-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin: 1rem 0;
                }
                .json-table th,
                .json-table td {
                    border: 1px solid #e0e0e0;
                    padding: 0.75rem;
                    text-align: left;
                }
                .json-table th {
                    background-color: #f5f5f5;
                    font-weight: 600;
                }
                .json-table tr:nth-child(even) {
                    background-color: #fafafa;
                }
                .json-card-list {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: 1rem;
                }
                .json-card {
                    border: 1px solid #e0e0e0;
                    border-radius: 8px;
                    padding: 1rem;
                    background: #fff;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
                }
                .json-card-field {
                    margin-bottom: 0.75rem;
                }
                .json-card-field:last-child {
                    margin-bottom: 0;
                }
                .json-card-key {
                    font-weight: 600;
                    color: #555;
                    margin-bottom: 0.25rem;
                    font-size: 0.9rem;
                }
                .json-card-value {
                    color: #333;
                }
                .json-string {
                    color: #0d7377;
                }
                .json-number {
                    color: #2563eb;
                }
                .json-boolean {
                    color: #7c3aed;
                }
                .json-null {
                    color: #999;
                    font-style: italic;
                }
            </style>
        `;

        const html = renderObject(data);
        return `<div class="json-container">${styles}${html}</div>`;
    } catch (error) {
        console.error('JSON to HTML conversion error:', error);
        return `<div class="json-error">JSON 解析失败: ${escapeHtml(error.message)}</div>`;
    }
}
