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

export interface RetrieveResult {
    text: string;
    score: number;
    metadata?: Record<string, any>;
}

export interface AskResult {
    answer: string;
    references?: RetrieveResult[];
}

/**
 * 通用知识库定义基类
 */
export abstract class KnowledgeBase {
    id: string;
    name: string;
    description: string;
    providerId: string;

    constructor(id: string, name: string, description: string, providerId: string) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.providerId = providerId;
    }

    abstract getSupportedFileTypes(): string[];

    abstract addFile(filePath: string): Promise<{ documentId: string; fileName: string }>;

    abstract retrieve(query: string, topK?: number): Promise<RetrieveResult[]>;

    abstract ask(question: string): Promise<AskResult>;
}

export interface KnowledgeBaseInfo {
    id: string;
    name: string;
    description: string;
    documentCount?: number;
    wordCount?: number;
}

/**
 * 通用知识库服务商定义基类
 */
export abstract class KnowledgeBaseProvider {
    id: string;
    name: string;
    description: string;

    constructor(id: string, name: string, description: string) {
        this.id = id;
        this.name = name;
        this.description = description;
    }

    abstract isConfigured(): boolean;

    abstract createKnowledgeBase(name: string, description?: string): Promise<KnowledgeBase>;

    abstract deleteKnowledgeBase(knowledgeBaseId: string): Promise<void>;

    abstract listKnowledgeBases(): Promise<KnowledgeBaseInfo[]>;

    abstract getKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBase | undefined>;
}
