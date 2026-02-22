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

import fs from 'fs';
import path from 'path';
import type { TaskState } from '../states/tasks';
import { UserMessage, AssistantMessage, TextMessagePart, ToolCallMessagePart, FileMessagePart, ReasoningMessagePart } from '../agents/messages';
import { escapeHtml } from './escape';

const HIGHLIGHT_JS_CSS_LIGHT = `
/* highlight.js v11.9.0 - Light theme */
.hljs{color:#24292e;background:#ffffff}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#d73a49}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#6f42c1}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#005cc5}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#032f62}.hljs-built_in,.hljs-symbol{color:#e36209}.hljs-code,.hljs-comment,.hljs-formula{color:#6a737d}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#22863a}.hljs-subst{color:#24292e}.hljs-section{color:#005cc5;font-weight:700}.hljs-bullet{color:#735c0f}.hljs-emphasis{color:#24292e;font-style:italic}.hljs-strong{color:#24292e;font-weight:700}.hljs-addition{color:#22863a;background-color:#f0fff4}.hljs-deletion{color:#b31d28;background-color:#ffeef0}
`;

const HIGHLIGHT_JS_CSS_DARK = `
/* highlight.js v11.9.0 - Dark theme (GitHub Dark) */
.hljs{color:#c9d1d9;background:#0d1117}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#ff7b72}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#d2a8ff}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#79c0ff}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#a5d6ff}.hljs-built_in,.hljs-symbol{color:#ffa657}.hljs-code,.hljs-comment,.hljs-formula{color:#8b949e}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#7ee787}.hljs-subst{color:#c9d1d9}.hljs-section{color:#79c0ff;font-weight:700}.hljs-bullet{color:#d29922}.hljs-emphasis{color:#c9d1d9;font-style:italic}.hljs-strong{color:#c9d1d9;font-weight:700}.hljs-addition{color:#7ee787;background-color:#1a3f2c}.hljs-deletion{color:#f85149;background-color:#3d1e23}
`;

const STYLES = `
${HIGHLIGHT_JS_CSS_LIGHT}
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

* {
    font-family: 'Inter', 'Noto Sans SC', sans-serif;
}

pre, code {
    font-family: 'JetBrains Mono', monospace;
}

/* Light mode styles */
.prose {
    color: #1e293b;
    line-height: 1.7;
}

.prose h1, .prose h2, .prose h3 {
    color: #0f172a;
    font-weight: 600;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
}

.prose p {
    margin: 1em 0;
}

.prose pre {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 0.75rem;
    padding: 1rem;
    overflow-x: auto;
    margin: 1.25em 0;
}

.prose code {
    background: #f1f5f9;
    padding: 0.125em 0.375em;
    border-radius: 0.375rem;
    font-size: 0.875em;
}

.prose pre code {
    background: transparent;
    padding: 0;
}

.prose ul, .prose ol {
    padding-left: 1.5em;
    margin: 1em 0;
}

.prose li {
    margin: 0.5em 0;
}

.prose blockquote {
    border-left: 4px solid #3b82f6;
    padding-left: 1em;
    margin: 1em 0;
    color: #475569;
    font-style: italic;
}

.prose a {
    color: #3b82f6;
    text-decoration: underline;
}

.prose img {
    max-width: 100%;
    border-radius: 0.75rem;
    margin: 1em 0;
}

/* Dark mode styles */
@media (prefers-color-scheme: dark) {
    ${HIGHLIGHT_JS_CSS_DARK}

    .prose {
        color: #e2e8f0;
    }

    .prose h1, .prose h2, .prose h3 {
        color: #f1f5f9;
    }

    .prose pre {
        background: #1e293b;
        border: 1px solid #334155;
    }

    .prose code {
        background: #334155;
        color: #e2e8f0;
    }

    .prose blockquote {
        border-left: 4px solid #60a5fa;
        color: #94a3b8;
    }

    .prose a {
        color: #60a5fa;
    }
}
`

export async function exportTaskToHtml(task: TaskState, filePath: string): Promise<void> {
    const html = await generateTaskHtml(task);
    // 创建目录
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, html, 'utf-8');
}


export async function generateTaskHtml(task: TaskState): Promise<string> {
    await task.render();

    const messagesHtml = await renderMessages(task);
    return generateHtmlTemplate(
        task.task_name || '未命名任务',
        task.task_id,
        messagesHtml
    );
}

async function renderMessages(task: TaskState): Promise<string> {
    let html = '';

    for (const message of task.chat_context.messages) {
        if (message instanceof UserMessage) {
            html += await renderUserMessage(message);
        } else if (message instanceof AssistantMessage) {
            html += await renderAssistantMessage(message);
        }
    }

    return html;
}

async function renderUserMessage(message: UserMessage): Promise<string> {
    let contentHtml = '';
    for (const part of message.content) {
        if (part instanceof TextMessagePart) {
            contentHtml += `<div class="prose prose-slate max-w-none">${await part.render()}</div>`;
        } else if (part instanceof FileMessagePart) {
            contentHtml += await part.render();
        }
    }

    return `
    <div class="message-container flex gap-4 p-6">
        <div class="flex-shrink-0">
            <div class="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white font-semibold shadow-lg">
                U
            </div>
        </div>
        <div class="flex-1 min-w-0">
            <div class="message-author text-sm font-medium text-slate-700 mb-2">用户</div>
            <div class="user-message-bubble bg-slate-50 rounded-2xl px-6 py-4 shadow-sm">
                ${contentHtml}
            </div>
        </div>
    </div>
    `;
}

async function renderAssistantMessage(message: AssistantMessage): Promise<string> {
    let contentHtml = '';
    for (const part of message.content) {
        if (part instanceof TextMessagePart) {
            contentHtml += `<div class="prose prose-slate max-w-none">${await part.render()}</div>`;
        } else if (part instanceof ToolCallMessagePart) {
            contentHtml += await part.render();
        } else if (part instanceof ReasoningMessagePart) {
            contentHtml += `
            <div class="reasoning-box bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-4 mb-4">
                <div class="flex items-center gap-2 reasoning-title text-amber-800 font-medium mb-2">
                    <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    推理过程
                </div>
                <div class="reasoning-content text-amber-900 text-sm font-mono whitespace-pre-wrap">${escapeHtml(part.content)}</div>
            </div>
            `;
        }
    }

    return `
    <div class="message-container flex gap-4 p-6">
        <div class="flex-shrink-0">
            <div class="w-10 h-10 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-full flex items-center justify-center text-white font-semibold shadow-lg">
                AI
            </div>
        </div>
        <div class="flex-1 min-w-0">
            <div class="message-author text-sm font-medium text-slate-700 mb-2">OpenDesk Assistant</div>
            <div class="assistant-message-bubble bg-white rounded-2xl px-6 py-4 shadow-sm border border-slate-100">
                ${contentHtml}
            </div>
        </div>
    </div>
    `;
}


function generateHtmlTemplate(title: string, taskId: string, messagesHtml: string): string {
    const now = new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHtml(title)} - OpenDesk 会话导出</title>
        <!-- Inline base styles to prevent FOUC -->
        <style>
            /* Base background for immediate rendering */
            html, body {
                margin: 0;
                padding: 0;
                min-height: 100vh;
            }
            /* Light mode base background */
            body {
                background: linear-gradient(to bottom right, #f8fafc, #f1f5f9, #eff6ff);
            }
            /* Dark mode base background */
            @media (prefers-color-scheme: dark) {
                body {
                    background: linear-gradient(to bottom right, #0f172a, #1e293b, #1e3a5f) !important;
                }
            }
        </style>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            ${STYLES}
            /* Additional dark mode styles using direct selectors */
            @media (prefers-color-scheme: dark) {
                /* Header and main */
                header, main {
                    background-color: #1e293b !important;
                    border-color: #334155 !important;
                }

                /* Page title */
                h1 {
                    color: #f1f5f9 !important;
                }

                /* Subtitle text */
                header p, footer p {
                    color: #94a3b8 !important;
                }

                /* Task ID badge */
                header span.inline-flex {
                    background-color: #334155 !important;
                    color: #cbd5e1 !important;
                }

                /* Dividers */
                .divide-y > * + * {
                    border-top-color: #334155 !important;
                }

                /* Message author text */
                .message-author {
                    color: #cbd5e1 !important;
                }

                /* User message bubble */
                .user-message-bubble {
                    background-color: #334155 !important;
                }

                /* Assistant message bubble */
                .assistant-message-bubble {
                    background-color: #0f172a !important;
                    border-color: #334155 !important;
                }

                /* Reasoning box */
                .reasoning-box {
                    background: linear-gradient(to right, rgba(120, 53, 15, 0.3), rgba(124, 45, 18, 0.3)) !important;
                    border-color: #92400e !important;
                }

                .reasoning-title, .reasoning-content {
                    color: #fbbf24 !important;
                }
            }
        </style>
    </head>
    <body class="bg-gradient-to-br from-slate-50 via-slate-100 to-blue-50 min-h-screen">
        <div class="max-w-6xl mx-auto px-6 py-12">
            <header class="bg-white rounded-3xl shadow-xl p-8 mb-8 border border-slate-100">
                <div class="flex items-center gap-4 mb-6">
                    <div class="w-16 h-16 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg">
                        <svg class="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                        </svg>
                    </div>
                    <div>
                        <h1 class="text-3xl font-bold text-slate-900 mb-1">${escapeHtml(title)}</h1>
                        <p class="text-slate-500">OpenDesk 会话导出 · ${now}</p>
                    </div>
                </div>
                <div class="flex flex-wrap gap-3">
                    <span class="inline-flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-full text-sm text-slate-600">
                        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                        </svg>
                        任务 ID: ${taskId}
                    </span>
                </div>
            </header>

            <main class="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100">
                <div class="divide-y divide-slate-100">
                    ${messagesHtml}
                </div>
            </main>

            <footer class="text-center mt-8 text-slate-400 text-sm">
                <p>使用 OpenDesk 生成</p>
            </footer>
        </div>
    </body>
    </html>`;
}
