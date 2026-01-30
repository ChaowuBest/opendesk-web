import { net } from 'electron';
import { BaseTool } from '../../agents/tool.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { ToolCall } from '../../agents/messages.js';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';


const SERVICE_URL = 'http://119.8.241.85:59801';

interface PPTResult {
    name: string
    ppt_url: string
    zip_url: string
    abstract: string
}

class PPTAgent {
    instanceId: string
    result?: PPTResult

    constructor() {
        this.instanceId = '';
        this.result = undefined;
    }

    async initializeFromExisting(instanceId: string) {
        this.instanceId = instanceId;
        return;
    }

    async initializeFromRequest(request: string) {
        var response = await net.fetch(SERVICE_URL + "/create_pptagent", { method: 'POST' })
        if (!response.ok) {
            throw new Error('错误：无法创建PPT智能体')
        }

        this.instanceId = await response.text();
        // 去掉第一位和最后一位
        this.instanceId = this.instanceId.slice(1, -1);
        logger.info(`PPT智能体分配成功，实例ID: ${this.instanceId}`);

        response = await net.fetch(SERVICE_URL + "/ainvoke", {
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

        const response = await net.fetch(SERVICE_URL + "/aresume", {
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
                console.info(line);
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
        this.executor = this.createPPT;
        this.appDataDirectory = appDataDirectory;
    }

    renderToolCall(toolcall: ToolCall): string | undefined {
        return `
        <div class="max-w-2xl h-full overflow-auto p-2 flex items-start justify-center">
            <ppt-container class="block w-full max-w-2xl" data-id="e498bdd9496546c6aff652996d0412dd"></ppt-container>
        </div>
        `
    }

    async createPPT(args: z.output<typeof CreatePPTSchema>): Promise<string> {
        const pptAgent = new PPTAgent();
        // await pptAgent.initializeFromRequest(args.request);
        await pptAgent.initializeFromExisting('e498bdd9496546c6aff652996d0412dd');

        var result = '<b>PPTAgent</b><br/>';
        for await (const chunk of pptAgent.fetchPPTTask()) {
            result += chunk;
        }

        const instanceId = pptAgent.instanceId;
        const zipUrl = pptAgent.result?.zip_url;
        const targetDir = path.join(this.appDataDirectory, 'data', instanceId);

        if (zipUrl && !fs.existsSync(targetDir)) {
            // 下载zip文件
            const response = await net.fetch(zipUrl);
            if (!response.ok) {
                throw new Error(`下载PPT压缩包失败: ${response.statusText}`);
            }
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

        result += `<br/>`;
        result += `下载PPT：<a href="${pptAgent.result?.ppt_url}" target="_blank">${pptAgent.result?.name}</a>`;
        result += `PPT摘要：${pptAgent.result?.abstract}`;
        return result;
    }
}