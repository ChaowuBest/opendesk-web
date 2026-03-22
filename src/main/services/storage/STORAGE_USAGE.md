# Storage 使用指南

> 文档日期：2026-03-21
> 对应代码：`src/main/services/storage/`
> 运行示例：`npx tsx src/main/services/storage/__tests__/indexer-usage-example.ts`

---

## 核心原则

**只使用 `BaseStorage`，不直接使用 `TagIndexer` / `BM25Indexer` / `VectorIndexer` / `BaseIndexer`。**

`BaseStorage` 是唯一对外接口，内部自动管理各 Indexer 的初始化、数据分发和查询串联。

---

## 1. 定义 Schema

```typescript
import { BaseStorage, ColumnSchema } from './abstract-storage.js';

const schema: ColumnSchema = {
  // columns：BaseIndexer 建表的所有列
  columns: {
    item_id:    { type: 'TEXT',    nullable: false },  // 必填
    item_type:  { type: 'TEXT',    nullable: false },  // 必填
    filename:   { type: 'TEXT',    nullable: true  },
    tag:        { type: 'TEXT',    nullable: true  },
    text:       { type: 'TEXT',    nullable: true  },
    created_at: { type: 'INTEGER', nullable: true  },
  },

  // needIndexers：哪些列需要被哪些 Indexer 额外索引
  // key 必须是 columns 中已存在的列名
  needIndexers: {
    tag:  ['TagIndexer'],
    text: ['BM25Indexer', 'VectorIndexer'],
  },
};
```

### needIndexers 规则

| Indexer        | 存储内容                        | 用途           |
| -------------- | ------------------------------- | -------------- |
| `TagIndexer`   | 列的原始值（字符串）            | 精确 tag 过滤  |
| `BM25Indexer`  | 列的原始文本（分词后存储）      | 全文模糊搜索   |
| `VectorIndexer`| 列对应的 embedding 向量         | 语义相似度搜索 |

同一列可以同时指定多个 Indexer，如 `text: ['BM25Indexer', 'VectorIndexer']`。

---

## 2. 初始化

```typescript
const storage = new BaseStorage('my-storage', schema, '/path/to/data/dir');
await storage.initialize();
```

---

## 3. 插入数据

```typescript
import { Item } from './abstract-storage.js';

await storage.insert([
  {
    // 业务字段（与 columns 对应）
    item_id:    'doc_001',
    item_type:  'file',
    filename:   '财务报告.pdf',
    tag:        'finance',
    text:       '本报告包含年度财务数据和预算执行情况',
    created_at: Date.now(),

    // indexer_columns：各 Indexer 需要的额外数据
    indexer_columns: {
      TagIndexer:    [{ column: 'tag',  content: 'finance' }],
      BM25Indexer:   [{ column: 'text', content: '本报告包含年度财务数据和预算执行情况' }],
      VectorIndexer: [{ column: 'text', content: [0.1, 0.3, /* ... 1024维 */] }],
    },
  },
]);
```

### indexer_columns 注意事项

- `column` 字段必须是 `needIndexers` 中已声明的列名（如 `'tag'`、`'text'`），否则数据会被忽略。
- `VectorIndexer` 的 `content` 必须是 `number[]`，维度需与初始化时一致（默认 1024）。
- `BM25Indexer` 和 `TagIndexer` 的 `content` 是字符串，与 `columns` 中对应列的值保持一致。
- `indexer_columns` 的 key 顺序不影响结果；BaseStorage 按 `needIndexers` 配置路由数据。

---

## 4. 搜索

搜索使用 `FilterCondition[]`，每条 condition 指定由哪个 Indexer 处理。多个 condition 之间是 **AND** 关系（交集）。

```typescript
const results = await storage.search(conditions);
// results: SearchItem[]，每项包含 item（完整业务字段）及各 Indexer 的分数
```

### 4.1 BaseIndexer — 精确 / 范围查询

```typescript
// 精确匹配
{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }

// 范围查询
{ indexer: 'BaseIndexer', field: 'created_at', operator: '>=', value: 1700000000000 }

// 支持的 operator：= != > < >= <= like notlike in notin between notbetween
```

### 4.2 TagIndexer — Tag 过滤

```typescript
{ indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'finance' }
```

### 4.3 BM25Indexer — 全文搜索

```typescript
import { BM25Query } from './abstract-storage.js';

{
  indexer: 'BM25Indexer',
  field:   'text',
  operator: 'bm25_match',
  value:   { query: '财务 预算', topK: 10 } as BM25Query,
}
```

结果中通过 `result.BM25Score` 获取分数（`result` 是 `SearchItem`，不是 `result.item`）。

### 4.4 VectorIndexer — 向量相似度搜索

```typescript
{
  indexer:     'VectorIndexer',
  field:       'text',
  operator:    'vector_near',
  value:       embeddingVector,  // number[]
  vectorQuery: { topK: 10, metric: 'cosine', threshold: 0.0 },
}
// operator 可选：vector_similarity / vector_near / vector_not_similar / vector_range
// metric 可选：cosine / euclidean / dot_product / manhattan
```

结果中通过 `result.VecScore` 获取分数（`result` 是 `SearchItem`，不是 `result.item`）。

### 4.5 多 Indexer 组合（AND）

```typescript
// tag=finance 且 item_type=file
const results = await storage.search([
  { indexer: 'TagIndexer',  field: 'tag',       operator: '=',         value: 'finance' },
  { indexer: 'BaseIndexer', field: 'item_type', operator: '=',         value: 'file'    },
]);

// tag=tech 且 BM25 匹配 API
const results = await storage.search([
  { indexer: 'TagIndexer',  field: 'tag',  operator: '=',         value: 'tech'                            },
  { indexer: 'BM25Indexer', field: 'text', operator: 'bm25_match', value: { query: 'API', topK: 5 } as BM25Query },
]);
```

查询顺序：TagIndexer → BM25Indexer → VectorIndexer → BaseIndexer，每步在上一步结果中做交集（join）。

---

## 5. 更新

更新只需传入需要变更的字段，**不需要传入所有字段**。未传 `indexer_columns` 的 Indexer 不会被更新，这是预期行为。

```typescript
await storage.update([
  {
    item_id:   'doc_001',
    item_type: 'file',
    tag:       'finance-v2',
    indexer_columns: {
      TagIndexer: [{ column: 'tag', content: 'finance-v2' }],
      // BM25/VectorIndexer 不传 = 不更新文本向量，符合预期
    },
  },
]);
```

---

## 6. 删除

```typescript
await storage.delete([
  { item_id: 'doc_001', item_type: 'file' },
]);
```

删除会同步从所有 Indexer 中移除该 item 的数据。

---

## 7. 已知限制

| 限制                         | 说明                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| 只支持 AND 组合              | 多个 condition 取交集；OR 逻辑需调用方自行多次查询取并集                                   |
| 无分数融合                   | BM25Score 和 VecScore 相互独立，无内置加权合并策略                                         |
| 无跨 Indexer 事务            | 插入/更新若中途失败，部分 Indexer 可能已写入；由调用方保证重试或幂等                       |
| 每个 item 只有一个 tag       | TagIndexer 以 `item_id` 为主键，多 tag 需在业务层拼接或使用 BaseIndexer 的 `like` 查询     |
| indexer_columns 需调用方维护 | `columns` 中的字段值与 `indexer_columns` 中传入的内容是否一致，由调用方负责，框架不校验    |
| BM25 分词依赖 jieba          | 查询词需能被 jieba 正确切分；英文词和明确的中文词效果更稳定                                |
| BM25 实际使用 TFIDF 评分     | 非 HM 平台底层 `search-index` v6 不支持真正的 BM25，评分算法为 TFIDF（不做词频饱和和文档长度归一化）；HM 平台使用 SQLite FTS5 内置 `bm25()` 是真正的 BM25 |
