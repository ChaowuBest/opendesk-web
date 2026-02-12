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
 * Indexer 抽象接口
 *
 * 所有索引器必须实现此接口以与 BaseStorage 兼容。
 * 提供统一的 API 用于不同的搜索后端（SQLite、BM25、向量等）。
 *
 * HOW TO ADD A NEW INDEXER:
 *
 * 1. 创建新类继承 Indexer 抽象类
 * 2. 实现所有必需方法：initialize(), search(), insert(), delete(), update(), close()
 * 3. 在 BaseStorage 构造函数中注册索引器
 * 4. 索引器将自动可用于搜索操作
 */

import { Item, FilterCondition, QueryOperator } from './abstract-storage.js';

/**
 * 索引器搜索选项
 */
export interface IndexerSearchOptions {
    /** 已有结果集，用于 join 过滤 */
    existingResults?: Item[];
    /** 返回结果数量限制 */
    limit?: number;
    /** 跳过的结果数量 */
    offset?: number;
    /** 排序选项 */
    orderBy?: {
        field: string;
        direction: 'ASC' | 'DESC';
    };
}

/**
 * 索引器搜索结果
 */
export interface IndexerSearchResult {
    /** 匹配的 Item 数组 */
    items: Item[];
    /** 匹配总数（分页前） */
    totalCount?: number;
    /** 相关性分数（可选，用于排序结果） */
    scores?: Map<string, number>;
}

/**
 * 索引器抽象基类
 *
 * 索引器负责：
 * - 基于特定索引策略存储和检索 Item
 * - 将 FilterCondition 转换为内部查询格式
 * - 支持与已有结果集的 join 操作
 */
export abstract class Indexer {
    /** 索引器唯一名称 */
    abstract readonly name: string;

    /** 支持查询的字段列表 */
    abstract readonly supportedFields: string[];

    /** 支持的操作符列表 */
    abstract readonly supportedOperators: QueryOperator[];

    /**
     * 初始化索引器（创建表、加载模型等）
     */
    abstract initialize(): Promise<void>;

    /**
     * 搜索匹配条件的 Item
     *
     * @param conditions - 过滤条件数组
     * @param options - 搜索选项，包括用于 join 的已有结果
     * @returns 搜索结果
     */
    abstract search(
        conditions: FilterCondition[],
        options?: IndexerSearchOptions
    ): Promise<IndexerSearchResult>;

    /**
     * 向索引中插入 Item
     *
     * @param items - 要插入的 Item 数组
     */
    abstract insert(items: Item[]): Promise<void>;

    /**
     * 从索引中删除 Item
     *
     * @param itemIds - 要删除的 Item ID 数组
     */
    abstract delete(itemIds: string[]): Promise<void>;

    /**
     * 更新索引中的 Item
     *
     * @param items - 要更新的 Item 数组（按 item_id 匹配）
     */
    abstract update(items: Item[]): Promise<void>;

    /**
     * 关闭/清理索引器
     */
    abstract close(): void;

    /**
     * 检查是否支持指定操作符
     *
     * @param operator - 要检查的操作符
     * @returns 是否支持
     */
    supportsOperator(operator: QueryOperator): boolean {
        return this.supportedOperators.includes(operator);
    }

    /**
     * 检查是否支持指定字段
     *
     * @param field - 要检查的字段名
     * @returns 是否支持
     */
    supportsField(field: string): boolean {
        return this.supportedFields.includes(field);
    }
}
