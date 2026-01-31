/**
 * Storage Indexer 使用样例 - RAG 场景构建指南
 *
 * 本文件展示如何利用查询解释器（Indexer）构建自定义 RAG 场景。
 * 包含完整的端到端流程：创建数据库 → 插入数据 → 查询 → 更新 → 删除
 *
 * 运行方式：
 * npx tsx src/main/services/storage/__tests__/indexer-usage-example.ts
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { BaseStorage, Item, ColumnSchema, BM25Query } from '../abstrac-storage.js';
import { TagIndexer } from '../tag-indexer.js';
import { BaseIndexer } from '../base-indexer.js';
import { VectorIndexer } from '../vector-indexer.js';
import { BM25Indexer } from '../bm25-indexer.js';

// ============================================================================
// 配置和工具函数
// ============================================================================

const TEST_DIR = path.join(os.tmpdir(), 'indexer-example-' + Date.now());
const VECTOR_DIM = 1024;

function setup(): void {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    console.log(`\n📁 测试目录: ${TEST_DIR}\n`);
}

function cleanup(): void {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
}

/** 生成模拟向量（用于演示） */
function makeVector(seed: number): number[] {
    const v = Array(VECTOR_DIM).fill(0);
    v[seed % VECTOR_DIM] = 1;
    v[(seed + 1) % VECTOR_DIM] = 0.5;
    return v;
}

function log(title: string): void {
    console.log(`\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}`);
}

function logResult(label: string, data: any): void {
    console.log(`\n[${label}]`);
    console.log(JSON.stringify(data, null, 2));
}

// ============================================================================
// 测试数据
// ============================================================================

function createTestItems(): Item[] {
    const now = Date.now();
    return [
        {
            item_id: 'doc_001', item_type: 'file',
            filename: '2024年度财务报告.pdf', tag: 'finance',
            text: '本报告包含公司年度财务数据、收入支出分析和预算执行情况',
            created_at: now, updated_at: now,
            indexer_columns: {
                TagIndexer: [{ column: 'tag', content: 'finance' }],
                VectorIndexer: [{ column: 'repr', content: makeVector(1) }],
                BM25Indexer: [{ column: 'text', content: '本报告包含公司年度财务数据、收入支出分析和预算执行情况' }],
            }
        },
        {
            item_id: 'doc_002', item_type: 'file',
            filename: 'API技术文档.md', tag: 'tech',
            text: 'REST API 接口设计规范，包含认证、请求格式和错误处理',
            created_at: now, updated_at: now,
            indexer_columns: {
                TagIndexer: [{ column: 'tag', content: 'tech' }],
                VectorIndexer: [{ column: 'repr', content: makeVector(2) }],
                BM25Indexer: [{ column: 'text', content: 'REST API 接口设计规范，包含认证、请求格式和错误处理' }],
            }
        },
        {
            item_id: 'mail_001', item_type: 'mail',
            filename: '预算审批邮件', tag: 'finance',
            text: '关于Q4预算申请的审批意见，请查阅附件中的财务明细',
            created_at: now, updated_at: now,
            indexer_columns: {
                TagIndexer: [{ column: 'tag', content: 'finance' }],
                VectorIndexer: [{ column: 'repr', content: makeVector(3) }],
                BM25Indexer: [{ column: 'text', content: '关于Q4预算申请的审批意见，请查阅附件中的财务明细' }],
            }
        },
        {
            item_id: 'mail_002', item_type: 'mail',
            filename: '技术评审会议通知', tag: 'tech',
            text: '本周五下午3点召开API设计评审会议，请准备相关文档',
            created_at: now, updated_at: now,
            indexer_columns: {
                TagIndexer: [{ column: 'tag', content: 'tech' }],
                VectorIndexer: [{ column: 'repr', content: makeVector(4) }],
                BM25Indexer: [{ column: 'text', content: '本周五下午3点召开API设计评审会议，请准备相关文档' }],
            }
        },
        {
            item_id: 'note_001', item_type: 'memory',
            filename: '项目进度笔记', tag: 'project',
            text: '项目开发进度：后端API完成80%，前端界面完成60%',
            created_at: now, updated_at: now,
            indexer_columns: {
                TagIndexer: [{ column: 'tag', content: 'project' }],
                VectorIndexer: [{ column: 'repr', content: makeVector(5) }],
                BM25Indexer: [{ column: 'text', content: '项目开发进度：后端API完成80%，前端界面完成60%' }],
            }
        },
        {
            item_id: 'note_002', item_type: 'memory',
            filename: '学习笔记', tag: 'learning',
            text: 'TypeScript 高级类型学习笔记：泛型、条件类型、映射类型',
            created_at: now, updated_at: now,
            indexer_columns: {
                TagIndexer: [{ column: 'tag', content: 'learning' }],
                VectorIndexer: [{ column: 'repr', content: makeVector(6) }],
                BM25Indexer: [{ column: 'text', content: 'TypeScript 高级类型学习笔记：泛型、条件类型、映射类型' }],
            }
        },
    ];
}

// ============================================================================
// Part 1: TagIndexer - 标签索引
// ============================================================================

async function demoTagIndexer(): Promise<void> {
    log('Part 1: TagIndexer - 标签索引');
    console.log('用途：基于标签的快速过滤，适合分类查询');

    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            tag: { type: 'TEXT', nullable: true },
        },
        needIndexers: { tag: ['TagIndexer'] }
    };
    const indexer = new TagIndexer(schema, path.join(TEST_DIR, 'tag.db'));
    await indexer.initialize();

    // 插入数据
    const items = createTestItems();
    await indexer.insert(items);
    console.log(`✓ 插入 ${items.length} 条数据`);

    // 查询示例 1: 精确匹配
    const r1 = await indexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'finance' }
    ]);
    logResult('精确匹配 tag=finance', r1.items.map(i => ({ id: i.item_id, tag: i.tag })));

    // 查询示例 2: 模糊匹配
    const r2 = await indexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: 'like', value: '%tech%' }
    ]);
    logResult('模糊匹配 tag LIKE %tech%', r2.items.map(i => ({ id: i.item_id, tag: i.tag })));

    // 查询示例 3: IN 操作符
    const r3 = await indexer.search([
        { indexer: 'TagIndexer', field: 'tag', operator: 'in', value: ['finance', 'project'] }
    ]);
    logResult('IN 操作符 tag IN [finance, project]', r3.items.map(i => ({ id: i.item_id, tag: i.tag })));

    // 更新
    await indexer.update([{
        item_id: 'doc_001', item_type: 'file', tag: 'finance-updated',
        indexer_columns: { TagIndexer: [{ column: 'tag', content: 'finance-updated' }] }
    }]);
    const r4 = await indexer.search([
        { indexer: 'TagIndexer', field: 'item_id', operator: '=', value: 'doc_001' }
    ]);
    logResult('更新后查询 doc_001', r4.items.map(i => ({ id: i.item_id, tag: i.tag })));

    // 删除
    await indexer.delete(['note_002']);
    console.log('\n✓ 删除 note_002');

    indexer.close();
}

// ============================================================================
// Part 2: BaseIndexer - 通用标量索引
// ============================================================================

async function demoBaseIndexer(): Promise<void> {
    log('Part 2: BaseIndexer - 通用标量索引');
    console.log('用途：支持动态 Schema，适合结构化数据的多字段查询');

    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            tag: { type: 'TEXT', nullable: true },
            created_at: { type: 'INTEGER', nullable: true },
        },
        needIndexers: {}
    };

    const indexer = new BaseIndexer(schema, path.join(TEST_DIR, 'base.db'));
    await indexer.initialize();

    // 插入数据
    const items = createTestItems();
    await indexer.insert(items);
    console.log(`✓ 插入 ${items.length} 条数据`);

    // 查询示例 1: 文件名模糊匹配
    const r1 = await indexer.search([
        { indexer: 'BaseIndexer', field: 'filename', operator: 'like', value: '%API%' }
    ]);
    logResult('文件名包含 API', r1.items.map(i => ({ id: i.item_id, filename: i.filename })));

    // 查询示例 2: 按类型过滤
    const r2 = await indexer.search([
        { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'mail' }
    ]);
    logResult('类型为 mail', r2.items.map(i => ({ id: i.item_id, type: i.item_type })));

    // 查询示例 3: 多条件组合
    const r3 = await indexer.search([
        { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' },
        { indexer: 'BaseIndexer', field: 'tag', operator: '=', value: 'tech' },
    ]);
    logResult('类型=file AND tag=tech', r3.items.map(i => ({ id: i.item_id, filename: i.filename })));

    indexer.close();
}

// ============================================================================
// Part 3: VectorIndexer - 向量相似度搜索
// ============================================================================

async function demoVectorIndexer(): Promise<void> {
    log('Part 3: VectorIndexer - 向量相似度搜索');
    console.log('用途：语义相似度搜索，适合 RAG 场景的文档检索');

    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            repr: { type: 'BLOB', nullable: true },
        },
        needIndexers: { repr: ['VectorIndexer'] }
    };
    const indexer = new VectorIndexer(schema, path.join(TEST_DIR, 'vector.db'), VECTOR_DIM);
    await indexer.initialize();

    // 插入数据
    const items = createTestItems();
    await indexer.insert(items);
    console.log(`✓ 插入 ${items.length} 条数据`);

    // 查询示例 1: 相似度搜索 (vector_near)
    const queryVector = makeVector(1); // 与 doc_001 相似
    const r1 = await indexer.search([{
        indexer: 'VectorIndexer',
        field: 'repr',
        operator: 'vector_near',
        value: queryVector,
        vectorQuery: { topK: 3, metric: 'cosine', threshold: 0.0 }
    }]);
    logResult('向量相似度搜索 TopK=3', r1.items.map(i => i.item_id));
    console.log('分数:', Object.fromEntries(r1.scores || []));

    // 查询示例 2: 带阈值过滤
    const r2 = await indexer.search([{
        indexer: 'VectorIndexer',
        field: 'repr',
        operator: 'vector_similarity',
        value: queryVector,
        vectorQuery: { topK: 10, metric: 'cosine', threshold: 0.5 }
    }]);
    logResult('相似度 > 0.5', r2.items.map(i => i.item_id));

    indexer.close();
}

// ============================================================================
// Part 4: BM25Indexer - 全文搜索
// ============================================================================

async function demoBM25Indexer(): Promise<void> {
    log('Part 4: BM25Indexer - 全文搜索 (BM25 + jieba分词)');
    console.log('用途：关键词全文搜索，支持中英文混合');

    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            text: { type: 'TEXT', nullable: true },
        },
        needIndexers: { text: ['BM25Indexer'] }
    };
    const indexer = new BM25Indexer(schema, path.join(TEST_DIR, 'bm25'), 10);
    await indexer.initialize();

    // 插入数据
    const items = createTestItems();
    await indexer.insert(items);
    console.log(`✓ 插入 ${items.length} 条数据`);

    // 查询示例 1: 中文关键词
    const r1 = await indexer.search([{
        indexer: 'BM25Indexer',
        field: 'text',
        operator: 'bm25_match',
        value: { query: '财务 预算', topK: 5 } as BM25Query
    }]);
    logResult('搜索: 财务 预算', r1.items.map(i => ({ id: i.item_id, text: i.text?.substring(0, 30) })));

    // 查询示例 2: 英文关键词
    const r2 = await indexer.search([{
        indexer: 'BM25Indexer',
        field: 'text',
        operator: 'bm25_match',
        value: { query: 'API', topK: 5 } as BM25Query
    }]);
    logResult('搜索: API', r2.items.map(i => ({ id: i.item_id, text: i.text?.substring(0, 30) })));

    // 查询示例 3: 中英文混合
    const r3 = await indexer.search([{
        indexer: 'BM25Indexer',
        field: 'text',
        operator: 'bm25_match',
        value: { query: 'TypeScript 类型', topK: 3 } as BM25Query
    }]);
    logResult('搜索: TypeScript 类型', r3.items.map(i => ({ id: i.item_id, text: i.text?.substring(0, 30) })));

    indexer.close();
}

// ============================================================================
// Part 5: BaseStorage - 多 Indexer 组合查询
// ============================================================================

async function demoBaseStorage(): Promise<void> {
    log('Part 5: BaseStorage - 多 Indexer 组合查询');
    console.log('用途：统一接口管理多个 Indexer，支持跨索引器的 AND 查询');
    console.log('注意：BaseStorage 内部管理 Indexer 实例，自动分发数据到各索引器');

    const schema: ColumnSchema = {
        columns: {
            item_id: { type: 'TEXT', nullable: false },
            item_type: { type: 'TEXT', nullable: false },
            filename: { type: 'TEXT', nullable: true },
            tag: { type: 'TEXT', nullable: true },
            text: { type: 'TEXT', nullable: true },
            created_at: { type: 'INTEGER', nullable: true },
            updated_at: { type: 'INTEGER', nullable: true },
        },
        needIndexers: {
            tag: ['TagIndexer'],
            text: ['BM25Indexer'],
        }
    };

    const storage = new BaseStorage('example', schema, TEST_DIR);
    await storage.initialize();

    // 插入数据
    const items = createTestItems();
    await storage.insert(items);
    console.log(`✓ 插入 ${items.length} 条数据到所有 Indexer`);

    // 查询示例 1: BaseIndexer 查询
    const r1 = await storage.search([], [
        { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }
    ]);
    logResult('BaseIndexer: item_type=file', r1.map(i => i.item.item_id));

    // 查询示例 2: TagIndexer 查询
    const r2 = await storage.search([], [
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'tech' }
    ]);
    logResult('TagIndexer: tag=tech', r2.map(i => i.item.item_id));

    // 查询示例 3: BM25 全文搜索
    const r3 = await storage.search([], [{
        indexer: 'BM25Indexer',
        field: 'text',
        operator: 'bm25_match',
        value: { query: '项目 进度', topK: 3 } as BM25Query
    }]);
    logResult('BM25Indexer: 搜索 "项目 进度"', r3.map(i => ({ id: i.item.item_id, score: i.BM25Score })));

    // 查询示例 4: 多 Indexer 组合 (Tag + Base)
    const r4 = await storage.search([], [
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'finance' },
        { indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' },
    ]);
    logResult('组合查询: tag=finance AND type=file', r4.map(i => i.item.item_id));

    // 查询示例 5: Tag + BM25 组合
    const r5 = await storage.search([], [
        { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'tech' },
        { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'API', topK: 5 } as BM25Query },
    ]);
    logResult('组合查询: tag=tech AND BM25搜索API', r5.map(i => ({ id: i.item.item_id, score: i.BM25Score })));

    // 更新和删除
    await storage.update([{
        item_id: 'doc_001', item_type: 'file', tag: 'finance-v2',
        indexer_columns: { TagIndexer: [{ column: 'tag', content: 'finance-v2' }] }
    }]);
    console.log('\n✓ 更新 doc_001 的 tag');

    await storage.delete([{ item_id: 'note_002', item_type: 'memory' }]);
    console.log('✓ 删除 note_002');
}

// ============================================================================
// 主函数
// ============================================================================

async function main(): Promise<void> {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║     Storage Indexer 使用样例 - RAG 场景构建指南            ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    setup();

    try {
        await demoTagIndexer();
        await demoBaseIndexer();
        await demoVectorIndexer();
        await demoBM25Indexer();
        await demoBaseStorage();

        log('完成');
        console.log('\n所有示例执行成功！\n');
    } finally {
        await new Promise(r => setTimeout(r, 200));
        cleanup();
    }
}

main().catch(err => {
    console.error('执行失败:', err);
    process.exit(1);
});
