# Storage 使用指南

> 文档日期：2026-03-31
> 对应代码：`src/main/services/storage/`
> 运行示例：`npx tsx src/main/services/storage/__tests__/indexer-usage-example.ts`

---

## 核心原则

**只使用 `BaseStorage`，不直接使用 `TagIndexer` / `BM25Indexer` / `VectorIndexer` / `ChunkIndexer` / `BaseIndexer`。**

`BaseStorage` 是唯一对外接口，内部自动管理各 Indexer 的初始化、数据分发和查询串联。

### HarmonyOS 说明

在 `process.platform === 'openharmony'` 时，storage 工厂现在会自动切到新的 WASM 路径：

- `BaseIndexDBWasm` / `TagIndexDBWasm`
- `BM25IndexDBWasm`（`node-sqlite3-wasm + FTS5 + jieba-wasm`）
- `VectorIndexDBWasm` / `ChunkIndexDBWasm`（SQLite BLOB 真源 + `hnsw` ANN 缓存）

旧的 `*-hm.ts/js` 文件仍然保留，但分发入口不再优先走 native addon 实现。

HarmonyOS / WASM 路径的当前约定：

- `VectorIndexDBWasm` / `ChunkIndexDBWasm` 使用 SQLite 作为真源，`hnsw` 仅作为可重建缓存
- 元数据使用 `hnsw_metadata` 表保存脏标记与快照状态
- 写入会先将缓存标记为 dirty，再在成功后刷新快照
- 向量 compact 在 stale/total 比例超过 `0.2` 时触发
- 向量/Chunk 在首次真正使用 `hnsw` 前会等待初始化完成；初始化本身不要求阻塞应用启动
- `filterItemIds` 走双路径：
  - 小子集：直接暴力精确计算
  - 大子集：ANN 召回后再做 `item_id` 过滤
- `VectorIndexDBWasm` / `ChunkIndexDBWasm` 在检测到已存储向量维度与配置 `dim` 不一致时，会抛出 `DimMismatchError`
- `BM25IndexDBWasm` 使用 `jieba-wasm` 切词；原始 `text` 仅用于回传，FTS5 实际索引的是空格拼接后的 `tokens`
- HarmonyOS 当前 BM25 评分语义与 Node 主路径保持一致，都是“分词命中数”式的确定性评分，而不是直接使用 SQLite `bm25()` 内置排序

### 统一写语义

当前 `BaseStorage` 对所有 Indexer 统一采用以下语义：

- `insert = first-write-only`
- `update = existing-only`
- `upsert = 覆盖写`

含义如下：

- `insert(items)`：只写入此前不存在的 `item_id`；已存在 item 整体跳过
- `update(items)`：只更新已存在 item；不存在 item 不创建任何记录
- `upsert(items)`：不存在则插入，存在则覆盖到当前传入内容

> 说明：不同 Indexer 的底层实现方式可能不同，但对外语义以这三条为准。

---

## 1. 定义 Schema

```typescript
import { BaseStorage, ColumnSchema, IndexerBinding } from './abstract-storage.js';

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
  // 每个值是 IndexerBinding[]，可携带 options
  needIndexers: {
    tag:  [{ indexer: 'TagIndexer' }],
    text: [
      { indexer: 'BM25Indexer' },
      { indexer: 'VectorIndexer', options: { dim: 1024 } },
    ],
  },
};
```

### needIndexers 规则

| Indexer        | 存储内容                        | 用途           | 支持的 options |
| -------------- | ------------------------------- | -------------- | -------------- |
| `TagIndexer`   | 列的原始值（字符串）            | 精确 tag 过滤  | 无             |
| `BM25Indexer`  | 列的原始文本（并额外建立分词索引） | 全文模糊搜索   | 无             |
| `VectorIndexer`| 列对应的 embedding 向量         | 语义相似度搜索 | `dim`（默认 1024） |
| `ChunkIndexer` | 一个 item 的多条 chunk 向量     | Chunk 级 RAG 搜索 | `dim`（默认 1024） |

同一列可以同时指定多个 Indexer，如 `text: [{ indexer: 'BM25Indexer' }, { indexer: 'VectorIndexer', options: { dim: 1024 } }]`。

`ChunkIndexer` 不依赖 `columns` 中某个现有文本列，它消费的是 `indexer_columns.ChunkIndexer` 中传入的 chunk 集合。典型配置示例：

```typescript
needIndexers: {
  tag:  [{ indexer: 'TagIndexer' }],
  text: [
    { indexer: 'BM25Indexer' },
    { indexer: 'VectorIndexer', options: { dim: 1024 } },
  ],
  chunk_text: [
    { indexer: 'ChunkIndexer', options: { dim: 1024 } },
  ],
}
```

> **⚠️ dim 一旦确定不可更改**：数据库创建后若以不同 `dim` 重新初始化，`storage.initialize()` 会抛出 `DimMismatchError`。

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
- `ChunkIndexer` 的每个 entry 必须同时提供：
  - `id`：chunk 标识符
  - `text`：chunk 原文
  - `content`：向量（`number[]`，维度与 `dim` 一致）
- `indexer_columns` 的 key 顺序不影响结果；BaseStorage 按 `needIndexers` 配置路由数据。

### ChunkIndexer 插入示例

```typescript
await storage.insert([
  {
    item_id:   'doc_chunk_001',
    item_type: 'file',
    filename:  '产品设计说明.md',
    text:      '完整原文可以存在 BaseIndexer 列中',
    indexer_columns: {
      ChunkIndexer: [
        {
          column: 'chunk_text',
          id: 'chunk-1',
          text: '第一段：产品背景和目标',
          content: [0.1, 0.2, /* ... 1024维 */],
        },
        {
          column: 'chunk_text',
          id: 'chunk-2',
          text: '第二段：实现方案和关键约束',
          content: [0.3, 0.4, /* ... 1024维 */],
        },
      ],
    },
  },
]);
```

---

## 4. 搜索

搜索使用 `FilterCondition[]`，每条 condition 指定由哪个 Indexer 处理。多个 condition 之间是 **AND** 关系（交集）。

```typescript
const results = await storage.search(conditions);
// results: { items, totalCount }
// results.items: SearchItem[]，每项包含 item（完整业务字段）及各 Indexer 的分数
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

### 4.6 ChunkIndexer — Chunk 级向量检索

`ChunkIndexer` 走专用搜索路径，返回仍然是：

```typescript
{ items, totalCount }
```

但 `items` 中每一项是按 chunk 展开的 `SearchItem`：

- `item`：完整业务对象（来自 BaseIndexer）
- `ChunkScore`：chunk 相似度
- `chunk_id`：命中的 chunk id
- `chunk_text`：命中的 chunk 文本

示例：

```typescript
const results = await storage.search([
  {
    indexer: 'ChunkIndexer',
    field: 'chunk_text',
    operator: 'vector_near',
    value: queryVector,
    vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.4 },
  },
  {
    indexer: 'BaseIndexer',
    field: 'item_type',
    operator: '=',
    value: 'file',
  },
]);
```

限制：

- 仅支持 `ChunkIndexer + BaseIndexer` 条件组合
- 必须且只能有一个 `ChunkIndexer` 条件
- 同一个 `item_id` 可能在结果中出现多次（因为不同 chunk 同时命中）

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

### 三种写操作的区别

```typescript
// insert：已存在 item 不会覆盖
await storage.insert([item]);

// update：仅更新已存在 item，不存在则 no-op
await storage.update([partialItem]);

// upsert：不存在则插入，存在则覆盖写
await storage.upsert([item]);
```

对于 `ChunkIndexer`：

- `insert`：只写入新的 `item_id`
- `update`：只对已存在 item 做全量替换
- `upsert`：新 item 直接写入；已存在 item 先删旧 chunk 再写新 chunk

---

## 6. 删除

```typescript
await storage.delete([
  { item_id: 'doc_001', item_type: 'file' },
]);
```

删除会同步从所有 Indexer 中移除该 item 的数据。

---

## 7. Upsert（insert or update）

```typescript
await storage.upsert([
  { item_id: 'doc_001', item_type: 'file', tag: 'finance', /* ... */ indexer_columns: { /* ... */ } },
  { item_id: 'doc_999', item_type: 'file', tag: 'new',     /* ... */ indexer_columns: { /* ... */ } },
]);
```

`upsert()` 采用统一的覆盖写语义：各 Indexer 直接执行自己的 `upsert` 协议，不再暴露旧的 “先经 BaseIndexer 判存在，再拆分成 insert/update” 行为。

统一语义如下：
- `insert = first-write-only`
- `update = existing-only`
- `upsert = 覆盖写`

---

## 8. 状态查询与清空

```typescript
// 查询各 Indexer 的数据量
const status = await storage.getStatus();
// 返回示例：
// {
//   BaseIndexer:   { size: 120 },
//   BM25Indexer:   { size: 118 },
//   VectorIndexer: { size: 120, dim: 1024 },
//   TagIndexer:    { size: 120 },
//   ChunkIndexer:  { size: 360, dim: 1024 },
// }

// 清空所有 Indexer 的数据
await storage.clear();
```

---

## 9. 错误处理

写操作不再暴露旧的 `BatchWriteError` 协议。

当前语义下，`insert()` / `update()` / `upsert()` / `delete()` 会直接传播底层 Indexer 抛出的错误；调用方应按具体错误类型处理，而不是依赖旧的批量恢复包装。

### DimMismatchError

以不同维度重新初始化已有数据库时抛出：

```typescript
import { DimMismatchError } from './abstract-storage.js';

try {
  await storage.initialize();
} catch (e) {
  if (e instanceof DimMismatchError) {
    console.log('已存储维度:', e.storedDim);     // 数据库中已有的向量维度
    console.log('配置维度:',  e.configuredDim);  // schema 中指定的 dim
    // 处理方式：清空数据库后重新初始化，或使用正确的 dim
  }
}
```

---

## 10. 已知限制

| 限制                         | 说明                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| 只支持 AND 组合              | 多个 condition 取交集；OR 逻辑需调用方自行多次查询取并集                                   |
| 无分数融合                   | BM25Score 和 VecScore 相互独立，无内置加权合并策略                                         |
| 无跨 Indexer 事务            | 多个 Indexer 的写入不是单事务提交；某个 Indexer 失败时会直接传播底层错误，调用方需自行决定重试或补偿 |
| 每个 item 只有一个 tag       | TagIndexer 以 `item_id` 为主键，多 tag 需在业务层拼接或使用 BaseIndexer 的 `like` 查询     |
| indexer_columns 需调用方维护 | `columns` 中的字段值与 `indexer_columns` 中传入的内容是否一致，由调用方负责，框架不校验    |
| BM25 分词依赖 jieba / jieba-wasm | 查询词需能被 jieba 正确切分；HarmonyOS WASM 路径会把切词结果写入 FTS tokens 列，再做候选召回与命中数排序 |
| BM25 分数为命中数语义        | 当前 Node / HarmonyOS WASM 路径都使用分词命中数作为确定性评分，分数可用于排序，但不应被解释为标准 BM25 数值 |
| Chunk 搜索不走普通 item 去重 | `ChunkIndexer` 返回的是 chunk 命中展开结果，同一 `item_id` 允许重复出现                      |
