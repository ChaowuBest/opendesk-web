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

import { fetch } from 'undici';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
    KnowledgeBase,
    KnowledgeBaseProvider,
    type KnowledgeBaseInfo,
    type RetrieveResult,
    type AskResult
} from '../base';
import { logger } from '../../../utils/logger';

const ZHIPU_API_BASE = 'https://open.bigmodel.cn/api/llm-application/open';

const SUPPORTED_FILE_TYPES = ['.txt', '.doc', '.docx', '.pdf', '.ppt', '.pptx', '.md', '.xls', '.xlsx', '.csv'];

const REQUEST_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

async function zhipuFetch(url: string, options: Parameters<typeof fetch>[1]): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                return (await fetch(url, {
                    ...options,
                    signal: controller.signal
                })) as unknown as Response;
            } finally {
                clearTimeout(timer);
            }
        } catch (err: any) {
            lastError = err;
            if (attempt < MAX_RETRIES) {
                logger.warn(`智谱API请求失败(第${attempt + 1}次), 重试中: ${err.message}`);
                await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
    }
    throw lastError!;
}

async function zhipuRequest(apiKey: string, method: string, endpoint: string, body?: object): Promise<any> {
    const url = `${ZHIPU_API_BASE}${endpoint}`;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`
    };
    if (body) {
        headers['Content-Type'] = 'application/json';
    }

    const resp = await zhipuFetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });

    const json: any = await (resp as any).json();
    if (json.code !== 200) {
        throw new Error(`智谱API错误 (${json.code}): ${json.message || '未知错误'}`);
    }
    return json.data;
}

function buildMultipartBody(
    fields: { name: string; value: string }[],
    file: { fieldName: string; fileName: string; content: Buffer }
): { body: Buffer; contentType: string } {
    const boundary = '----OpenDeskBoundary' + crypto.randomUUID().replace(/-/g, '');
    const parts: Buffer[] = [];

    parts.push(
        Buffer.from(
            `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\n` +
                `Content-Type: application/octet-stream\r\n\r\n`
        )
    );
    parts.push(file.content);
    parts.push(Buffer.from('\r\n'));

    for (const field of fields) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
                    `${field.value}\r\n`
            )
        );
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return {
        body: Buffer.concat(parts),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

async function zhipuUploadFile(
    apiKey: string,
    knowledgeBaseId: string,
    filePath: string
): Promise<{ documentId: string; fileName: string }> {
    const url = `${ZHIPU_API_BASE}/document/upload_document/${knowledgeBaseId}`;
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);

    const { body, contentType } = buildMultipartBody([{ name: 'knowledge_type', value: '1' }], {
        fieldName: 'files',
        fileName,
        content: fileBuffer
    });

    const resp = await zhipuFetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': contentType
        },
        body
    });

    const json: any = await (resp as any).json();
    if (json.code !== 200) {
        throw new Error(`智谱文件上传失败 (${json.code}): ${json.message || '未知错误'}`);
    }

    const data = json.data;
    if (data.failedInfos && data.failedInfos.length > 0) {
        throw new Error(`文件上传失败: ${data.failedInfos[0].failReason}`);
    }
    if (!data.successInfos || data.successInfos.length === 0) {
        throw new Error('文件上传失败: 没有成功的文件');
    }

    return {
        documentId: data.successInfos[0].documentId,
        fileName: data.successInfos[0].fileName
    };
}

export class ZhipuKnowledgeBase extends KnowledgeBase {
    private apiKey: string;

    constructor(id: string, name: string, description: string, apiKey: string) {
        super(id, name, description, 'zhipu');
        this.apiKey = apiKey;
    }

    getSupportedFileTypes(): string[] {
        return SUPPORTED_FILE_TYPES;
    }

    async addFile(filePath: string): Promise<{ documentId: string; fileName: string }> {
        const ext = path.extname(filePath).toLowerCase();
        if (!SUPPORTED_FILE_TYPES.includes(ext)) {
            throw new Error(`不支持的文件类型: ${ext}，支持的类型: ${SUPPORTED_FILE_TYPES.join(', ')}`);
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`文件不存在: ${filePath}`);
        }
        return await zhipuUploadFile(this.apiKey, this.id, filePath);
    }

    async retrieve(query: string, topK: number = 5): Promise<RetrieveResult[]> {
        const data = await zhipuRequest(this.apiKey, 'POST', '/knowledge/retrieve', {
            query,
            knowledge_ids: [this.id],
            top_k: topK,
            top_n: topK * 2,
            recall_method: 'mixed',
            recall_ratio: 80
        });

        if (!Array.isArray(data)) {
            return [];
        }

        return data.map((item: any) => ({
            text: item.text,
            score: item.score,
            metadata: item.metadata
        }));
    }

    async ask(question: string): Promise<AskResult> {
        const results = await this.retrieve(question, 5);
        if (results.length === 0) {
            return { answer: '在知识库中未找到与该问题相关的内容。', references: [] };
        }

        const context = results.map((r, i) => `[${i + 1}] ${r.text}`).join('\n\n');
        const prompt = `基于以下知识库内容回答问题。如果内容不足以回答，请说明。\n\n知识库内容:\n${context}\n\n问题: ${question}`;

        try {
            const resp = await zhipuFetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'glm-4-flash',
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            const json: any = await (resp as any).json();
            const answer = json.choices?.[0]?.message?.content || '无法生成回答';
            return { answer, references: results };
        } catch (err) {
            logger.error(`智谱对话API调用失败: ${err}`);
            return {
                answer: `基于检索到的内容:\n\n${context}`,
                references: results
            };
        }
    }
}

export class ZhipuKnowledgeBaseProvider extends KnowledgeBaseProvider {
    private apiKey: string;

    constructor(apiKey: string = '') {
        super('zhipu', '智谱AI知识库', '基于智谱AI开放平台的云端知识库服务，支持多种文档格式上传与语义检索');
        this.apiKey = apiKey;
    }

    setApiKey(apiKey: string) {
        this.apiKey = apiKey;
    }

    getApiKey(): string {
        return this.apiKey;
    }

    isConfigured(): boolean {
        return this.apiKey.length > 0;
    }

    async createKnowledgeBase(name: string, description?: string): Promise<KnowledgeBase> {
        this.ensureConfigured();
        const data = await zhipuRequest(this.apiKey, 'POST', '/knowledge', {
            embedding_id: 3,
            name,
            description: description || '',
            background: 'blue',
            icon: 'book'
        });
        return new ZhipuKnowledgeBase(data.id, name, description || '', this.apiKey);
    }

    async deleteKnowledgeBase(knowledgeBaseId: string): Promise<void> {
        this.ensureConfigured();
        await zhipuRequest(this.apiKey, 'DELETE', `/knowledge/${knowledgeBaseId}`);
    }

    async listKnowledgeBases(): Promise<KnowledgeBaseInfo[]> {
        this.ensureConfigured();
        const data = await zhipuRequest(this.apiKey, 'GET', '/knowledge?page=1&size=100');
        if (!data || !Array.isArray(data.list)) {
            return [];
        }
        return data.list.map((item: any) => ({
            id: item.id,
            name: item.name,
            description: item.description || '',
            documentCount: item.document_size,
            wordCount: item.word_num
        }));
    }

    async getKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBase | undefined> {
        this.ensureConfigured();
        try {
            const data = await zhipuRequest(this.apiKey, 'GET', `/knowledge/${knowledgeBaseId}`);
            if (!data) return undefined;
            return new ZhipuKnowledgeBase(data.id, data.name, data.description || '', this.apiKey);
        } catch {
            return undefined;
        }
    }

    private ensureConfigured() {
        if (!this.isConfigured()) {
            throw new Error('智谱AI知识库未配置API密钥，请先配置api_key');
        }
    }
}
