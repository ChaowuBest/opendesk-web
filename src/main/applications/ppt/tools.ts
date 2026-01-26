import { net } from 'electron';
import { BaseTool } from '../../agents/tool.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { ToolCall } from '../../agents/messages.js';
import { text } from 'stream/consumers';


const SERVICE_URL = 'http://119.8.241.85:59801';

interface PPTResult {
    name: string
    url: string
    abstract: string
}

class PPTAgent {
    instanceId: string
    result?: PPTResult

    constructor() {
        this.instanceId = '';
        this.result = undefined;
    }

    async initialize() {
        const response = await net.fetch(SERVICE_URL + "/create_pptagent", { method: 'POST' })
        if (!response.ok) {
            throw new Error('错误：无法创建PPT智能体')
        }

        this.instanceId = await response.text();
        // 去掉第一位和最后一位
        this.instanceId = this.instanceId.slice(1, -1);
        logger.info(`PPT智能体创建成功，实例ID: ${this.instanceId}`);
    }

    async* createPPT(request: string): AsyncIterable<string> {
        const response = await net.fetch(SERVICE_URL + "/ainvoke", {
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
                    if (chunk.role === 'assistant') {
                        yield chunk.text;
                    } else if (chunk.role === 'thinkflow' && chunk.sources) {
                        this.result = chunk.sources;
                    }
                    console.info(chunk);
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
    constructor() {
        super('CreatePPT', '根据指定的需求创建PPT', CreatePPTSchema);
        this.executor = this.createPPT;
    }

    renderToolCall(toolcall: ToolCall): string | undefined {
        return `
        <!-- 终端主容器 -->
        <div class="terminal-window w-full max-w-4xl rounded-xl overflow-hidden border border-gray-300 flex flex-col my-2 font-mono">
            <!-- macOS 顶部标题栏 (浅色渐变) -->
            <div class="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-gray-100 to-gray-200 border-b border-gray-300">
                <div class="text-[12px] font-medium text-gray-600 flex items-center gap-2">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                    FillipDesk Agent -- PPT生成
                </div>
                <div class="w-12"></div>
            </div>

            <!-- 终端内容区域 -->
            <div class="p-3 text-xs xs:text-base leading-relaxed overflow-y-none custom-scrollbar text-gray-800">

                <!-- 执行脚本 -->
                <div class="mb-2 flex items-start">
                    <span class="text-blue-500 font-bold mr-2">❯</span>
                    <div>
                        <span class="text-blue-600">Create PPT</span>
                        <span class="text-gray-800 ml-1">${toolcall.args_object?.request}</span>
                    </div>
                </div>

                <!-- 过程记录 -->
                <div class="space-y-1 mb-4 border-l-2 border-gray-200 pl-4 ml-1">
                    ${toolcall.result === undefined
                        ? `<div class="flex items-center gap-2 text-gray-400 animate-pulse h-7">
                            <svg class="w-5 h-5 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                            <span>PPT生成中，请稍候…</span>
                        </div>`
                        : `<pre>${toolcall.result}</pre>`}
                </div>
            </div>
        </div>
        `
    }

    async createPPT(args: z.output<typeof CreatePPTSchema>): Promise<string> {
        const pptAgent = new PPTAgent();
        await pptAgent.initialize();

        var result = '<b>PPTAgent</b><br/>';
        for await (const chunk of pptAgent.createPPT(args.request)) {
            result += chunk;
        }

        result += `<br/>`;
        result += `下载PPT：<a href="${pptAgent.result?.url}" target="_blank">${pptAgent.result?.name}</a>`;
        result += `PPT摘要：${pptAgent.result?.abstract}`;
        return result;
    }
}