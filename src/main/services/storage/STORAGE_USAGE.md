# Storage 使用指南

> 文档日期：2026-03-25
> 对应代码：`src/main/services/storage/`
> 运行示例：`npx tsx src/main/services/storage/__tests__/indexer-usage-example.ts`

---

## 核心原则

**推荐只通过 `BaseStorage` 使用存储能力。**

`BaseStorage` 负责：
- schema 校验
- 各 indexer 初始化
- 数据分发
- 跨 indexer 搜索协调

当前代码里仍然存在 `getBaseIndexer()` / `getDB()` 这类接口，但它们更偏内部/调试用途，不建议业务侧依赖。

---

## 1. 定义 Schema

```typescript
import { BaseStorage, ColumnSchema } from './abstract-storage.js';

const schema: ColumnSchema = {
  columns: {
    item_id:    { type: 'TEXT',    nullable: false },
    item_type:  { type: 'TEXT',    nullable: false },
    filename:   { type: 'TEXT',    nullable: true  },
    tag:        { type: 'TEXT',    nullable: true  },
    text:       { type: 'TEXT',    nullable: true  },
    created_at: { type: 'INTEGER', nullable: true  },
  },

  needIndexers: {
    tag:  [{ indexer: 'TagIndexer' }],
    text: [
      { indexer: 'BM25Indexer' },
      { indexer: 'VectorIndexer', options: { dim: 1024 } },
    ],
    chunks: [
      { indexer: 'ChunkIndexer', options: { dim: 1024 } },
    ],
  },
};
```

### needIndexers 规则

| Indexer | 用途 | options |
|---|---|---|
| `TagIndexer` | 精确 tag 过滤 | 无 |
| `BM25Indexer` | 全文搜索 | 无 |
| `VectorIndexer` | item 级向量相似度搜索 | `dim`，默认 `1024` |
| `ChunkIndexer` | chunk 级向量相似度搜索 | `dim`，默认 `1024` |

### 维度约束

- 同一个 `BaseStorage` 中，所有 `VectorIndexer` binding 的 `dim` 必须全局一致。
- 同一个 `BaseStorage` 中，所有 `ChunkIndexer` binding 的 `dim` 也必须全局一致。
- 数据库里若已存在向量，而初始化时配置的 `dim` 与已存储维度不一致，`initialize()` 会抛出 `DimMismatchError`。

---

## 2. 初始化

```typescript
const storage = new BaseStorage('my-storage', schema, '/path/to/data');
await storage.initialize();
```

初始化顺序：
- `VectorIndexer` 优先初始化并做维度检查
- 再初始化 `BaseIndexer`
- 其余 indexer 按需初始化

---

## 3. Item 结构

```typescript
interface Item {
  item_id: string;
  item_type: 'file' | 'mail' | 'memory';
  [key: string]: any;
  indexer_columns?: {
    [indexer: string]: Array<{
      column: string;
      content: string | number[];
      id?: string;
      text?: string;
    }>;
  };
}
```

### indexer_columns 当前语义

- `TagIndexer` / `BM25Indexer`：`content` 是字符串
- `VectorIndexer`：`content` 是 embedding 向量 `number[]`
- `ChunkIndexer`：除了 `content`（向量）外，还要求：
  - `id`：chunk 标识
  - `text`：chunk 原文

示例：

```typescript
{
  item_id: 'doc_001',
  item_type: 'file',
  filename: '报告.pdf',
  tag: 'finance',
  text: '这是正文',
  indexer_columns: {
    TagIndexer: [
      { column: 'tag', content: 'finance' },
    ],
    BM25Indexer: [
      { column: 'text', content: '这是正文' },
    ],
    VectorIndexer: [
      { column: 'text', content: [0.1, 0.2, /* ... */] },
    ],
    ChunkIndexer: [
      { column: 'chunks', id: 'c1', text: '第一段', content: [0.1, 0.2, /* ... */] },
      { column: 'chunks', id: 'c2', text: '第二段', content: [0.3, 0.4, /* ... */] },
    ],
  },
}
```

---

## 4. 插入

```typescript
await storage.insert([item1, item2]);
```

### 当前实现语义

- 对外接口是批量：`insert(items: Item[])`
- 内部由 `BaseStorage` 并行调用各 indexer 的 `insert(items)`
- **当前不是 `BatchWriteError` 语义**，并行写失败时会抛出底层错误
- **当前没有跨 indexer 回滚保证**

### 各 indexer 当前插入语义

- `BaseIndexer`：批量写主表
- `BM25Indexer`：批量写 BM25 记录
- `VectorIndexer`：批量写向量记录
- `TagIndexer`：批量写 tag 记录
- `ChunkIndexer`：**当前是 upsert 风格**
  - 若 item 带有 `ChunkIndexer` entries，会先按 `item_id` 删除旧 chunk，再插入新 chunk

这意味着：`ChunkIndexer.insert()` 当前不是“首次写入才插入”，而是“存在则替换”。

---

## 5. 更新

```typescript
await storage.update([item]);
```

### 当前实现语义

- `BaseStorage` 并行调用各 indexer 的 `update(items)`
- 未提供对应 `indexer_columns` 的 indexer 一般会跳过
- **当前没有统一的 `existing-only` 契约**

各 indexer 当前更新语义并不完全一致：

- `BaseIndexer`：按 `item_id` upsert 主表记录
- `BM25Indexer`：按 BM25 实现覆盖旧记录
- `VectorIndexer`：逐条 upsert 向量记录
- `TagIndexer`：逐条 upsert tag 记录
- `ChunkIndexer`：按 `item_id` 全量替换全部 chunk

所以当前代码里，`update()` 更接近“覆盖已提供的索引数据”，而不是严格的“仅更新已存在行”。

---

## 6. Upsert

```typescript
await storage.upsert([item1, item2]);
```

### 当前实现语义

当前 `BaseStorage.upsert()` 的逻辑是：
- 先通过 `BaseIndexer.getDB().exists(item_id)` 判断主表是否存在
- 不存在的走 `insert(newItems)`
- 已存在的走 `update(existingItems)`

注意：
- `upsert()` 是以 **BaseIndexer 是否存在** 为判定依据
- 它不是“所有 indexer 各自独立判断是否存在”

---

## 7. 删除

```typescript
await storage.delete([
  { item_id: 'doc_001', item_type: 'file' },
]);
```

### 当前实现语义

- 当前 `delete()` 参数是 `Item[]`，不是 `string[]`
- `BaseStorage` 会提取 `item_id`
- 然后并行调用所有 indexer 的 `delete(itemIds)`

删除会同步作用于：
- 主表
- BM25
- Vector
- Tag
- Chunk

---

## 8. 搜索

```typescript
const results = await storage.search(conditions);
// results: SearchItem[]
```

### 返回值

当前 `storage.search()` **返回的是 `SearchItem[]`**，不是 `{ items, totalCount }`。

```typescript
interface SearchItem {
  item: Item;
  tags?: string;
  VecScore?: number;
  BM25Score?: number;
  ChunkScore?: number;
  chunk_id?: string;
  chunk_text?: string;
}
```

### 8.1 BaseIndexer

```typescript
{ indexer: 'BaseIndexer', field: 'item_type', operator: '=', value: 'file' }
```

支持标量过滤：
- `= != > < >= <=`
- `like notlike`
- `in notin`
- `between notbetween`

### 8.2 TagIndexer

```typescript
{ indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'finance' }
```

### 8.3 BM25Indexer

```typescript
{
  indexer: 'BM25Indexer',
  field: 'text',
  operator: 'bm25_match',
  value: { query: '财务 预算', topK: 10 },
}
```

结果分数在：
- `searchItem.BM25Score`

### 8.4 VectorIndexer

```typescript
{
  indexer: 'VectorIndexer',
  field: 'text',
  operator: 'vector_near',
  value: embeddingVector,
  vectorQuery: { topK: 10, metric: 'cosine', threshold: 0.0 },
}
```

结果分数在：
- `searchItem.VecScore`

### 8.5 ChunkIndexer

ChunkIndexer 不走普通 `Indexer.search()` 路径，而是走 `BaseStorage.searchWithChunkIndexer()` 专用路径。

当前只支持：
- `ChunkIndexer`
- 可选叠加 `BaseIndexer`

**不支持**直接和：
- `BM25Indexer`
- `VectorIndexer`
- `TagIndexer`

混合查询。

示例：

```typescript
const results = await storage.search([
  {
    indexer: 'ChunkIndexer',
    field: 'chunk_text',
    operator: 'vector_near',
    value: embeddingVector,
    vectorQuery: { topK: 5, metric: 'cosine', threshold: 0.0 },
  },
  {
    indexer: 'BaseIndexer',
    field: 'item_type',
    operator: '=',
    value: 'file',
  },
]);
```

返回结果中：
- `item` 仍然是父 item
- `ChunkScore` 是 chunk 命中分数
- `chunk_id` / `chunk_text` 给出命中的 chunk 信息

---

## 9. 搜索合并模型

普通搜索路径下：
- 顺序为 `TagIndexer -> BM25Indexer -> VectorIndexer -> BaseIndexer`
- 多个条件是 **AND** 关系
- 合并主键是 `item_id`

这意味着：
- 普通路径默认是 **item-level merge**
- 同一 `item_id` 最终只保留一条结果
- `ChunkIndexer` 之所以能返回多条同 `item_id` 结果，是因为它走专用路径

---

## 10. 状态查询与清空

```typescript
const status = await storage.getStatus();
await storage.clear();
```

### getStatus 返回示例

```typescript
{
  BaseIndexer:   { size: 120 },
  BM25Indexer:   { size: 118 },
  VectorIndexer: { size: 120, dim: 1024 },
  TagIndexer:    { size: 120 },
  ChunkIndexer:  { size: 240, dim: 1024 },
}
```

### clear 语义

- `clear()` 会清空所有已初始化 indexer
- 不需要手工分别 clear 主表和附表

---

## 11. 错误处理

### 当前代码里的重要错误

- `SchemaValidationError`
  - schema 不合法时抛出
- `DimMismatchError`
  - 向量/分块索引已存储维度与当前配置维度不一致时抛出
- 各 indexer / DB 自身抛出的原始错误

### 当前没有的语义

当前代码**没有**：
- `BatchWriteError`
- 跨 indexer 事务回滚

所以如果 `insert/update/delete` 的某个 indexer 在并行写阶段失败：
- 会直接抛出底层错误
- 其他 indexer 可能已经成功

---

## 12. 测试与示例

建议优先参考：
- [storage.test.ts](/Users/liumingxing/FillipDesk/FillipDesk/src/main/services/storage/__tests__/storage.test.ts)
- [chunk-indexer.test.ts](/Users/liumingxing/FillipDesk/FillipDesk/src/main/services/storage/__tests__/chunk-indexer.test.ts)
- [indexer-usage-example.ts](/Users/liumingxing/FillipDesk/FillipDesk/src/main/services/storage/__tests__/indexer-usage-example.ts)

当前文档若与代码冲突，请以代码与测试为准。
