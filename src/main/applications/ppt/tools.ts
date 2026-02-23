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

import { BaseTool, ToolResult } from '../../aikernel/tool';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { ToolCall } from '../../aikernel/messages';
import { marked } from '../../aikernel/messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { fetch } from 'undici';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';


interface PPTResult {
    name: string
    ppt_url: string
    zip_url: string
    abstract: string
}

export class PPTAgent {
    instanceId: string
    result?: PPTResult

    static serviceUrl?: string

    constructor() {
        this.instanceId = '';
        this.result = undefined;
    }

    static setServiceUrl(serviceUrl: string) {
        this.serviceUrl = serviceUrl;
    }

    getServiceUrl(): string {
        if (!PPTAgent.serviceUrl) {
            throw new Error('错误：PPT制作服务地址未设置')
        }
        return PPTAgent.serviceUrl;
    }

    async initializeFromExisting(instanceId: string) {
        this.instanceId = instanceId;
        return;
    }

    async initializeFromRequest(request: string) {
        var response = await fetch(this.getServiceUrl() + "/create_pptagent", { method: 'POST' })
        if (!response.ok) {
            throw new Error('错误：无法创建PPT智能体')
        }

        this.instanceId = await response.text();
        // 去掉第一位和最后一位
        this.instanceId = this.instanceId.slice(1, -1);
        logger.info(`PPT智能体分配成功，实例ID: ${this.instanceId}`);

        response = await fetch(this.getServiceUrl() + "/ainvoke", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instance_id: this.instanceId,
                message: request
            })
        })

        if (!response.ok || !response.body) {
            throw new Error('错误：无法创建PPT')
        }
    }

    async* fetchPPTTask(): AsyncIterable<string> {
        if (!this.instanceId) {
            throw new Error('错误：PPT智能体未初始化')
        }

        const response = await fetch(this.getServiceUrl() + "/aresume", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                instance_id: this.instanceId,
            })
        })

        if (!response.ok || !response.body) {
            throw new Error('错误：无法获取PPT任务状态')
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            const textChunk = decoder.decode(value, { stream: true });
            for (const line of textChunk.split('\n').filter(line => line.trim() !== '')) {
                try {
                    const chunk = JSON.parse(line);
                    if (chunk.text) {
                        yield chunk.text;
                    }
                    if (chunk.status === 'completed' && chunk.sources?.name !== undefined) {
                        console.info('result received');
                        this.result = {
                            name: chunk.sources.name,
                            ppt_url: chunk.sources.url,
                            zip_url: chunk.sources.zip_url,
                            abstract: chunk.sources.abstract,
                        }
                    }
                } catch (error) {
                    logger.error(`Error parsing JSON chunk: ${line}, error: ${error}`);
                }
            }
        }
    }
}

const CreatePPTSchema = z.object({
    request: z.string().describe('制作PPT的要求')
})

export class CreatePPTTool extends BaseTool<typeof CreatePPTSchema> {
    appDataDirectory: string

    constructor(appDataDirectory: string) {
        super('CreatePPT', '根据指定的需求创建PPT', CreatePPTSchema);
        this.appDataDirectory = appDataDirectory;
        this.setUniversalExecutor(this.createPPT);
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const request = toolcall.args_object?.['request'];
        const body: string[] = [];

        if (request) {
            body.push(chalk.dim('需求: ') + chalk.white(truncText(String(request), width - 14)));
        }

        if (toolcall.status === 'running' && toolcall.result) {
            const lines = toolcall.result.split('\n').filter((l: string) => l.trim());
            const lastLine = lines[lines.length - 1]?.trim();
            if (lastLine) {
                body.push(chalk.dim('  ' + truncText(lastLine, width - 10)));
            }
        } else if (toolcall.status === 'success') {
            body.push(chalk.greenBright('  ✨ PPT 制作完成'));
        }

        return new Card({ icon: '📊', title: '制作 PPT', status: statusDisplay(toolcall.status), body }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const md = toolcall.result !== undefined ? (await marked.parse(toolcall.result)) : 'PPT制作中...';
        var result = `<div class="max-w-2xl h-full overflow-auto p-2 flex flex-col space-y-2 items-start justify-center">${md}</div>`
        if (toolcall.status === 'success') {
            const instanceId = toolcall.result_object?.['instanceId'];
            result += `
            <div class="max-w-3xl h-full overflow-auto p-2 flex items-start justify-center">
                <ppt-container class="block w-full" data-id="${instanceId}"></ppt-container>
            </div>
            `
        } else {
            result += `
            <div class="max-w-md flex gap-4 items-center p-3 bg-slate-50 rounded-xl border border-slate-100 transform transition-all hover:scale-[1.01] hover:bg-white hover:shadow-sm">
                <div class="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600 animate-pulse">
                    <i class="fa-solid fa-brain text-lg"></i>
                </div>
                <div class="flex-1 space-y-2">
                    <div class="h-2.5 bg-slate-200 rounded w-1/3 skeleton-shimmer rounded-full"></div>
                    <div class="h-2 bg-slate-100 rounded w-3/4 skeleton-shimmer rounded-full"></div>
                </div>
            </div>
`
        }
        return result;
    }

    async createPPT(args: z.output<typeof CreatePPTSchema>, result: ToolResult): Promise<void> {
        const pptAgent = new PPTAgent();
        await pptAgent.initializeFromRequest(args.request);

        for await (const chunk of pptAgent.fetchPPTTask()) {
            result.attachResult(chunk);
        }

        const instanceId = pptAgent.instanceId;
        const zipUrl = pptAgent.result?.zip_url;
        const targetDir = path.join(this.appDataDirectory, 'data', instanceId);

        if (zipUrl && !fs.existsSync(targetDir)) {
            // 下载zip文件
            const response = await fetch(zipUrl);
            if (!response.ok) {
                throw new Error(`下载PPT压缩包失败: ${response.statusText}`);
            }

            fs.mkdirSync(targetDir, { recursive: true });
            const buffer = await response.arrayBuffer();
            // 保存到临时路径
            const tmpZipPath = path.join(this.appDataDirectory, 'data', `${instanceId}.zip`);
            fs.writeFileSync(tmpZipPath, Buffer.from(buffer));

            const zip = new AdmZip(tmpZipPath);
            zip.extractAllTo(targetDir, true);

            // 删除临时zip
            fs.unlinkSync(tmpZipPath);
            console.info(`PPT压缩包下载成功，解压到: ${targetDir}`);

            const manifestPath = path.join(targetDir, 'manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify({
                name: pptAgent.result?.name || '未命名PPT',
                abstract: pptAgent.result?.abstract || '系统未生成摘要',
            }));
        }

        result.updateResultObject({ instanceId: instanceId });
    }
}