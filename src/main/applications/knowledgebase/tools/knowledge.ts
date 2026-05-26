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

import { BaseTool } from '../../../aikernel/tool';
import { ToolCall } from '../../../aikernel/messages';
import { Card } from '../../../tui/components/card';
import { statusDisplay, truncText } from '../../../tui/components/toolcall';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { t } from '../../../../locale/index.js';
import { type KnowledgeBaseApplication } from '../app';
import chalk from 'chalk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const ListKnowledgeBasesArgsSchema = z.object({
    provider_id: z
        .string()
        .optional()
        .describe('可选，指定服务商ID以仅列出该服务商的知识库。不指定则列出所有已启用服务商的知识库')
});

export class ListKnowledgeBasesTool extends BaseTool<typeof ListKnowledgeBasesArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super(
            'listKnowledgeBases',
            '列出所有知识库清单，包括各知识库的ID、名称、描述、文档数量等信息',
            ListKnowledgeBasesArgsSchema
        );
        this.app = app;
        this.setExecutor(this.list.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  加载中...'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                let total = 0;
                for (const group of result.knowledge_bases || []) {
                    const kbs = group.items || [];
                    total += kbs.length;
                    body.push(
                        chalk.dim(`  ${chalk.magenta(group.provider_id)}: ${chalk.white(String(kbs.length))} 个知识库`)
                    );
                    for (const kb of kbs) {
                        body.push(`    ${chalk.cyan(kb.name)} ${chalk.dim(`(${kb.id})`)}`);
                    }
                }
                if (total === 0) body.push(chalk.dim('  暂无知识库'));
            } catch {
                body.push(chalk.dim('  已获取知识库列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '📚',
            title: '知识库列表',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        if (toolcall.status === 'running') {
            return `
            <div class="flex items-center gap-2 mt-1 mb-1 text-xs text-slate-500">
                <span class="animate-pulse">📚</span>
                <span>加载知识库列表...</span>
            </div>`;
        }

        if (toolcall.status === 'error') {
            return `
            <div class="flex items-center gap-2 mt-1 mb-1 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                <span>❌</span>
                <span>${toolcall.result || '加载失败'}</span>
            </div>`;
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const groups = result.knowledge_bases || [];
                let total = 0;
                for (const group of groups) {
                    total += (group.items || []).length;
                }

                if (total === 0) {
                    return `
                    <div class="flex items-center gap-2 mt-1 mb-1 text-xs text-slate-400">
                        <span>📚</span>
                        <span>暂无知识库</span>
                    </div>`;
                }

                let html = `<div class="mt-1 mb-1 text-xs">`;
                for (const group of groups) {
                    const kbs = group.items || [];
                    if (kbs.length === 0) continue;
                    html += `
                    <div class="mb-2">
                        <div class="text-[10px] text-violet-600 font-medium mb-1 px-1">${group.provider_name || group.provider_id} (${kbs.length})</div>
                        <div class="flex flex-wrap gap-1">`;
                    for (const kb of kbs) {
                        if (kb.error) {
                            html += `<span class="inline-flex items-center gap-1 px-2 py-1 bg-rose-50 border border-rose-200 rounded-md text-rose-600">${kb.error}</span>`;
                        } else {
                            const docCount = kb.document_count ?? kb.doc_count ?? '-';
                            html += `<span class="inline-flex items-center gap-1 px-2 py-1 bg-slate-50 border border-slate-200 rounded-md text-slate-700" title="ID: ${kb.id}">📄 ${kb.name} <span class="text-slate-400">(${docCount})</span></span>`;
                        }
                    }
                    html += `</div></div>`;
                }
                html += `</div>`;
                return html;
            } catch {
                return `
                <div class="flex items-center gap-2 mt-1 mb-1 text-xs text-slate-500">
                    <span>📚</span>
                    <span>已获取知识库列表</span>
                </div>`;
            }
        }

        return undefined;
    }

    private async list(args: z.output<typeof ListKnowledgeBasesArgsSchema>): Promise<string> {
        const results: { provider_id: string; provider_name: string; items: any[] }[] = [];

        const providers = this.app.getEnabledProviders();
        for (const provider of providers) {
            if (args.provider_id && provider.id !== args.provider_id) continue;
            try {
                const kbs = await provider.listKnowledgeBases();
                results.push({
                    provider_id: provider.id,
                    provider_name: provider.name,
                    items: kbs
                });
            } catch (err: any) {
                results.push({
                    provider_id: provider.id,
                    provider_name: provider.name,
                    items: [{ error: err.message }]
                });
            }
        }

        return JSON.stringify({ knowledge_bases: results });
    }
}

const RetrieveFromKnowledgeBaseArgsSchema = z.object({
    provider_id: z.string().describe('知识库所属的服务商ID'),
    knowledge_base_id: z.string().describe('知识库ID'),
    query: z.string().describe('检索查询内容'),
    top_k: z.number().optional().describe('返回结果数量，默认5')
});

export class RetrieveFromKnowledgeBaseTool extends BaseTool<typeof RetrieveFromKnowledgeBaseArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super(
            'retrieveFromKnowledgeBase',
            '从指定知识库中检索相关内容片段，返回按相似度排序的结果',
            RetrieveFromKnowledgeBaseArgsSchema
        );
        this.app = app;
        this.setExecutor(this.retrieve.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const query = args?.query as string | undefined;
        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';
        const detailParts: string[] = [];
        if (query) detailParts.push(`"${escapeHtml(query)}"`);
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                detailParts.push(`${r.results?.length || 0} 条结果`);
            } catch {}
        }
        const detail = detailParts.join(' · ');
        const detailHtml = detail ? `<span class="truncate text-xs text-slate-600">${detail}</span>` : '';
        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-book-open shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(t('search.kb.retrieve.name'))}</span>
                ${statusIcon}
                ${detailHtml}
            </div>
        </div>`;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.query) body.push(chalk.dim('查询: ') + chalk.cyan(`"${truncText(String(args.query), width - 16)}"`));
        if (args?.knowledge_base_id) body.push(chalk.dim('知识库: ') + chalk.magenta(String(args.knowledge_base_id)));

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  检索中...'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                body.push(chalk.dim('  找到 ') + chalk.white(String(r.results?.length || 0)) + chalk.dim(' 条结果'));
            } catch {
                body.push(chalk.dim('  检索完成'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '🔍',
            title: '知识库检索',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async retrieve(args: z.output<typeof RetrieveFromKnowledgeBaseArgsSchema>): Promise<string> {
        const provider = this.app.getProvider(args.provider_id);
        if (!provider) throw new Error(`服务商 "${args.provider_id}" 不存在`);

        const kb = await provider.getKnowledgeBase(args.knowledge_base_id);
        if (!kb) throw new Error(`知识库 "${args.knowledge_base_id}" 不存在`);

        const results = await kb.retrieve(args.query, args.top_k ?? 5);
        return JSON.stringify({ results });
    }
}

const AskKnowledgeBaseArgsSchema = z.object({
    provider_id: z.string().describe('知识库所属的服务商ID'),
    knowledge_base_id: z.string().describe('知识库ID'),
    question: z.string().describe('要提问的问题')
});

export class AskKnowledgeBaseTool extends BaseTool<typeof AskKnowledgeBaseArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super(
            'askKnowledgeBase',
            '在指定知识库上下文中提问，大模型会结合知识库内容生成回答',
            AskKnowledgeBaseArgsSchema
        );
        this.app = app;
        this.setExecutor(this.ask.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as any;
        const question = args?.question as string | undefined;
        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';
        const detailHtml = question
            ? `<span class="truncate text-xs text-slate-600">"${escapeHtml(question)}"</span>`
            : '';
        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-comments shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(t('search.kb.ask.name'))}</span>
                ${statusIcon}
                ${detailHtml}
            </div>
        </div>`;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.question)
            body.push(chalk.dim('问题: ') + chalk.cyan(`"${truncText(String(args.question), width - 16)}"`));
        if (args?.knowledge_base_id) body.push(chalk.dim('知识库: ') + chalk.magenta(String(args.knowledge_base_id)));

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  提问中...'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                const ans = r.answer || '';
                body.push(chalk.dim('  回答: ') + truncText(ans, width - 12));
            } catch {
                body.push(chalk.dim('  已获得回答'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '💬',
            title: '知识库问答',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async ask(args: z.output<typeof AskKnowledgeBaseArgsSchema>): Promise<string> {
        const provider = this.app.getProvider(args.provider_id);
        if (!provider) throw new Error(`服务商 "${args.provider_id}" 不存在`);

        const kb = await provider.getKnowledgeBase(args.knowledge_base_id);
        if (!kb) throw new Error(`知识库 "${args.knowledge_base_id}" 不存在`);

        const result = await kb.ask(args.question);
        return JSON.stringify(result);
    }
}

const AddFilesToKnowledgeBaseArgsSchema = z.object({
    provider_id: z.string().describe('知识库所属的服务商ID'),
    knowledge_base_id: z.string().describe('知识库ID'),
    paths: z.array(z.string()).describe('本地文件或目录路径列表')
});

export class AddFilesToKnowledgeBaseTool extends BaseTool<typeof AddFilesToKnowledgeBaseArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super(
            'addFilesToKnowledgeBase',
            '将本地文件或目录下的文件添加到知识库中。支持递归添加目录中所有受支持格式的文件',
            AddFilesToKnowledgeBaseArgsSchema
        );
        this.app = app;
        this.setExecutor(this.addFiles.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.paths) body.push(chalk.dim('路径: ') + chalk.cyan(String(args.paths.length) + ' 个'));
        if (args?.knowledge_base_id) body.push(chalk.dim('知识库: ') + chalk.magenta(String(args.knowledge_base_id)));

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  上传中...'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                body.push(chalk.dim('  成功: ') + chalk.green(String(r.success_count || 0)));
                if (r.fail_count > 0) body.push(chalk.dim('  失败: ') + chalk.red(String(r.fail_count)));
            } catch {
                body.push(chalk.dim('  上传完成'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '📁',
            title: '添加文件到知识库',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async addFiles(args: z.output<typeof AddFilesToKnowledgeBaseArgsSchema>): Promise<string> {
        const provider = this.app.getProvider(args.provider_id);
        if (!provider) throw new Error(`服务商 "${args.provider_id}" 不存在`);

        const kb = await provider.getKnowledgeBase(args.knowledge_base_id);
        if (!kb) throw new Error(`知识库 "${args.knowledge_base_id}" 不存在`);

        const supportedExts = new Set(kb.getSupportedFileTypes());
        const filesToUpload: string[] = [];

        for (const p of args.paths) {
            if (!fs.existsSync(p)) {
                continue;
            }
            const stat = fs.statSync(p);
            if (stat.isFile()) {
                const ext = path.extname(p).toLowerCase();
                if (supportedExts.has(ext)) {
                    filesToUpload.push(p);
                }
            } else if (stat.isDirectory()) {
                this.collectFiles(p, supportedExts, filesToUpload);
            }
        }

        if (filesToUpload.length === 0) {
            return JSON.stringify({
                success_count: 0,
                fail_count: 0,
                message: '没有找到支持的文件',
                supported_types: kb.getSupportedFileTypes()
            });
        }

        const successes: { documentId: string; fileName: string }[] = [];
        const failures: { fileName: string; error: string }[] = [];

        for (const file of filesToUpload) {
            try {
                const result = await kb.addFile(file);
                successes.push(result);
            } catch (err: any) {
                failures.push({ fileName: path.basename(file), error: err.message });
            }
        }

        return JSON.stringify({
            success_count: successes.length,
            fail_count: failures.length,
            successes,
            failures
        });
    }

    private collectFiles(dir: string, supportedExts: Set<string>, result: string[]) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (supportedExts.has(ext)) {
                    result.push(fullPath);
                }
            } else if (entry.isDirectory()) {
                this.collectFiles(fullPath, supportedExts, result);
            }
        }
    }
}
