# Storage 内部架构文档

> 文档日期：2026-10-31（BM25 更新）
> 对应代码：`src/main/services/storage/`
> 面向读者：Storage 模块的开发者和维护者

---

## 1. 分层架构

Storage 采用三层架构，职责自上而下递进：

```
┌──────────────────────────────────────────────────┐
│  BaseStorage（协调层）                            │
│  abstract-storage.ts                             │
│  - 唯一对外接口                                   │
│  - Schema 驱动的 Indexer 按需创建                  │
│  - insert/update/upsert/delete 分发到各 Indexer   │
│  - search 管道编排（多 Indexer AND join）          │
├──────────────────────────────────────────────────┤
│  Indexer 层（语义统一层）                          │
│  base-indexer.ts / bm25-indexer.ts / ...          │
│  - 继承 Indexer 抽象类（indexer.ts）               │
│  - 统一 insert/delete/update/upsert/search 语义  │
│  - 屏蔽底层 DB 实现差异                            │
│  - 将 FilterCondition 翻译为 DB 层查询格式         │
├──────────────────────────────────────────────────┤
│  IndexDB 层（存储实现层）                          │
│  base-index-db.ts / base-index-db-wasm.ts / ...   │
│  - 实现 I*IndexDB 接口                            │
│  - 每种 Indexer 有 2 个生产实现（node/wasm）         │
│  - 直接操作 SQLite / sqlite-vec / hnsw     │
└──────────────────────────────────────────────────┘
```

**核心设计原则：业务方只接触 BaseStorage，不直接使用 Indexer 或 IndexDB。**

---

## 2. 文件组织

### 2.1 文件命名规则

```
{indexer-type}-indexer.ts        Indexer 层实现 + I*IndexDB 接口定义 + 工厂函数
{indexer-type}-index-db.ts       Node.js 平台 IndexDB 实现（better-sqlite3）
{indexer-type}-index-db-hm.ts    HarmonyOS native addon 实现（已废弃，保留参考）
{indexer-type}-index-db-wasm.ts  HarmonyOS WASM 实现（node-sqlite3-wasm）
```

### 2.2 完整文件清单

| 文件                  | 层级    | 说明                                                         |
| --------------------- | ------- | ------------------------------------------------------------ |
| `abstract-storage.ts` | 协调层  | BaseStorage 类、Item/ColumnSchema/FilterCondition 等核心类型 |
| `indexer.ts`          | 抽象    | Indexer 抽象基类定义                                         |
| `base-indexer.ts`     | Indexer | 标量元数据索引，schema 驱动动态建表                          |
| `bm25-indexer.ts`     | Indexer | 记录级 BM25，Jieba 分词与共享统计层                          |
| `vector-indexer.ts`   | Indexer | 向量相似度索引，sqlite-vec                                   |
| `tag-indexer.ts`      | Indexer | 标签精确匹配索引                                             |
| `chunk-indexer.ts`    | Indexer | 分块向量索引（1:N），RAG 场景                                |
| `*-index-db.ts`       | IndexDB | Node.js 平台实现（5 个，生产使用）                           |
| `*-index-db-wasm.ts`  | IndexDB | WASM 实现（5 个，生产使用）                                  |
| `*-index-db-hm.ts`    | IndexDB | 其它索引器的废弃 HM 实现；BM25 HM 已删除                     |
| `hnsw-adapter.ts`     | 辅助    | HNSW ANN 索引封装，供 WASM 向量实现使用                      |

---

## 3. Indexer 体系

### 3.1 Indexer 抽象接口

所有 Indexer 继承 `Indexer` 抽象类（`indexer.ts`），必须实现：

```typescript
abstract class Indexer {
    abstract readonly name: string;
    abstract readonly supportedFields: string[];
    abstract readonly supportedOperators: QueryOperator[];

    abstract initialize(): Promise<void>;
    abstract search(conditions, options?): Promise<IndexerSearchResult>;
    abstract insert(items: Item[]): Promise<void>;
    abstract delete(itemIds: string[]): Promise<void>;
    abstract update(items: Item[]): Promise<void>;
    abstract upsert(items: Item[]): Promise<void>;
    abstract close(): void;
    abstract clear(): Promise<void>;
    abstract getInfo(): Promise<Record<string, any>>;
}
```

### 3.2 五种 Indexer 对比

| 属性          | BaseIndexer      | BM25Indexer                      | VectorIndexer               | TagIndexer       | ChunkIndexer      |
| ------------- | ---------------- | -------------------------------- | --------------------------- | ---------------- | ----------------- |
| 数据模型      | 1 item : 1 row   | 1 item : N rows（field/subKey）  | 1 item : N rows（每列一条） | 1 item : 1 row   | 1 item : N chunks |
| 底层引擎      | SQLite 标量表    | SQLite 四表统计                  | sqlite-vec / HNSW           | SQLite 标量表    | sqlite-vec / HNSW |
| 是否必需      | 是（始终创建）   | 否（按 schema）                  | 否（按 schema）             | 否（按 schema）  | 否（按 schema）   |
| search() 行为 | 无条件时返回全部 | 直接 throw，委托 holder 专用入口 | 无条件时返回空              | 无条件时返回全部 | 直接 throw        |
| insert 去重   | 依赖 BaseStorage | 自行检查                         | 依赖 BaseStorage            | 依赖 BaseStorage | 自行检查          |
| 支持的操作符  | 全部标量操作符   | bm25_match                       | vector\_\* 系列             | 标量操作符子集   | vector\_\* 系列   |

### 3.3 BaseIndexer — 元数据主索引

- **schema 驱动**：根据 `ColumnSchema.columns` 动态建表，每个 column 成为一个 SQLite 列
- **1:1 关系**：每个 item_id 对应一行，是 item 的唯一真源
- **必须存在**：BaseStorage 始终创建 BaseIndexer，用于存在性检查和元数据 join
- **支持全部标量操作符**：`= != > < >= <= like notlike in notin between notbetween path_descendant_or_self`
- **`path_descendant_or_self` 合同**：接受单个非空路径字符串或非空路径字符串数组；数组内各成员在同一个 operator 内部做 OR，不同 FilterCondition 之间仍是 AND。空数组或包含非字符串/空字符串成员一律视为非法，不代表"不限定范围"。`///`、`C:////` 等纯斜杠或畸形盘符根值在进入数据库前即被拒绝。Native/WASM/ArkData 三个 backend 各自负责把该 operator 编译为等价的 SQL `OR` group（`LIKE ... ESCAPE '\'`），FileMgr 不拼接 SQL，只传入 string/string[] value。

### 3.4 BM25Indexer — 记录统计搜索

- 记录身份为 `(item_id, field, subKey)`，payload 的 id 对应 subKey，省略/undefined 时为空串，null 非法。`terms`、`records`、`postings`、`field_stats` 四表只存词项和统计，不存原文或拼接 tokens。
- `bm25-stats-store.ts` 是两个同步 SQLite driver 共用的事务和查询实现；`bm25-tokenizer.ts`、`bm25-scoring.ts` 分别提供分词和纯评分。
- 原文以最多 1,048,576 UTF-16 code units 分段，优先最后 LF、保护代理对；每段 NFKC→lower→Jieba HMM=true，仅保留含 Unicode 字母/数字的 token。native `@node-rs/jieba=2.0.1` 与 `jieba-wasm=2.4.0` 独立于 DB 选择；不保证分段与整文分词相同。
- 标准 BM25：`k1=1.2, b=0.75`，正 IDF=`log1p((N-df+0.5)/(df+0.5))`。固定 UTF-16 查询词序累计，score 降序、item_id/subKey UTF-16 升序，不舍入、不聚合对象。
- 全域或 allowlist 范围内的全部非空记录（包括未命中记录）决定 N/sum_len/df。TEMP allowlist、统计和 postings 在同一同步读事务内；无局部 TopK 合并。
- 每次 CRUD 为一个同步写事务；update 资格取事务起始记录集合，upsert 只覆盖显式记录，零词删除该记录；省略兄弟记录不删除。词典孤词在整批末回收。跨 indexer 和外层 500-ID 删除组不具备整体事务保证。
- `PRAGMA user_version=1` 绑定 schema/分词/评分规则。只有缺失或 v0 且无用户 schema 对象可以创建；不兼容库明确拒绝，无迁移、业务状态、generation 或重建决策。
- `searchBM25` 返回原始记录命中，不查 Base；`searchScope` 完整 Base 预筛后返回带 `bm25Record` 的逐记录真实 Item；通用 `search` 保留旧对象管道，在取回的 2K 记录中有重复 item_id 时明确拒绝，提示专用入口。

### 3.5 VectorIndexer — 向量相似度

- **多列支持**：一个 item 可以有多个 vector 列（如 title_embed + body_embed）
- **维度约束**：同一 BaseStorage 内所有 VectorIndexer 列必须使用相同维度
- **DimMismatchError**：已有数据与新配置维度不一致时，`initialize()` 抛出此错误，由调用方决定处理策略
- **相似度度量**：支持 `cosine / euclidean / dot_product / manhattan`
- **Node.js 实现**：直接使用 sqlite-vec 扩展
- **WASM 实现**：SQLite BLOB 作为真源 + HNSW ANN 缓存（可重建）

### 3.6 TagIndexer — 标签索引

- **单列绑定**：每个 TagIndexer 实例绑定一个 column（构造时确定）
- **轻量结构**：记录仅含 `item_id / item_type / tag` 三个字段
- **精确匹配为主**：支持标量操作符，但设计意图是 tag 精确过滤
- **当前限制**：BaseStorage 只创建一个 TagIndexer 实例，不支持多 tag 列

### 3.7 ChunkIndexer — 分块向量索引

- **1:N 关系**：一个 item 对应多条 chunk，每条 chunk 有独立的 id、text、embedding
- **不走标准 search()**：`search()` 方法直接 throw，强制通过 `BaseStorage.searchWithChunkIndexer()` 调用 `searchChunks()`
- **搜索流程**：ChunkIndexer 先全量 ANN 召回 topK chunk → BaseStorage 用 BaseIndexer 在 item_id 子集上做元数据过滤 → 按 chunk 展开结果（不去重 item_id）
- **写入语义**：insert = first-write-only（item 级）；update = 全量替换（删旧 chunk 写新 chunk）；upsert = 覆盖写
- **仅支持与 BaseIndexer 组合**：不能与 BM25/Vector/Tag 在同一次 search 中联合查询

---

## 4. BaseStorage 协调逻辑

### 4.1 Indexer 生命周期

```
BaseStorage 构造 ──→ 解析 schema.needIndexers
                     ──→ 按需创建各 Indexer 实例（BaseIndexer 始终创建）
                     ──→ 每个 Indexer 分配独立 DB 文件路径

initialize()     ──→ VectorIndexer 最先初始化（可能抛 DimMismatchError）
                     ──→ BaseIndexer 初始化
                     ──→ BM25/Tag/Chunk Indexer 初始化

close()          ──→ 依次关闭所有 Indexer 的 DB 连接
```

### 4.2 写操作分发

insert/delete/update/upsert/clear 的分发模式相同：

```typescript
await Promise.allSettled([
    this.baseIndexer.op(items),
    this.bm25Indexer?.op(items),
    this.vectorIndexer?.op(items),
    this.tagIndexer?.op(items),
    this.chunkIndexer?.op(items)
]);
```

等待所有分发 settle 后，按 indexer 数组顺序抛出首个错误。

**关键约束**：

- `insert()` 先通过 BaseIndexer 查询去重，仅将新 item 传递给各 Indexer
- 各 Indexer 内部各自决定从 item 中提取哪些数据（通过 `indexer_columns` 或 schema 列）
- 没有跨 Indexer 事务保证：某个 Indexer 写入失败，其余可能已成功

### 4.3 搜索管道

#### 标准路径（无 ChunkIndexer 条件）

```
输入：FilterCondition[]
  │
  ├─ 按 indexer 名称分组
  │
  ├─ 固定执行顺序：TagIndexer → BM25Indexer → VectorIndexer → BaseIndexer
  │
  ├─ 第一个有条件的 Indexer：独立查询，获得初始结果集
  │
  ├─ 后续 Indexer：将已有结果的 item_id 作为 existingResults 传入，做 AND join
  │
  ├─ 任一步骤结果为空：提前返回空
  │
  └─ 无条件的非 BaseIndexer：跳过（不参与管道）
      BaseIndexer 无条件时：返回全部（用于 join 过滤）
```

#### ChunkIndexer 专用路径

```
输入：FilterCondition[]（包含 ChunkIndexer 条件）
  │
  ├─ 校验：仅允许 ChunkIndexer + BaseIndexer 条件
  │
  ├─ Step 1：ChunkIndexer.searchChunks() 全量 ANN 召回
  │
  ├─ Step 2：用召回的 item_id 集合，交给 BaseIndexer 做元数据过滤
  │
  └─ Step 3：按 chunk 展开最终结果（同一 item_id 可多次出现）
```

### 4.4 getStatus()

返回各 Indexer 的 `getInfo()` 结果。仅包含已配置的 Indexer：

```typescript
{
    BaseIndexer:   { size: number },           // item 总数
    BM25Indexer?:  { size: number, backend, tokenizer, indexVersion, compatibility, fields }, // 非空记录数；fields 含 n/sum_len
    VectorIndexer?:{ size: number, dim: number },
    TagIndexer?:   { size: number },
    ChunkIndexer?: { size: number, dim: number }, // chunk 总数
}
```

注意：各 Indexer 的 `size` 含义不同。BaseIndexer 的 `size` = item 数量，其余是各自索引记录数。

---

## 5. IndexDB 层与平台分发

### 5.1 两套生产实现

| 平台                          | 后缀       | SQLite 引擎               | 向量引擎                    | BM25 分词        | 状态                   |
| ----------------------------- | ---------- | ------------------------- | --------------------------- | ---------------- | ---------------------- |
| Node.js / Electron            | 无后缀     | better-sqlite3            | sqlite-vec 扩展             | @node-rs/jieba   | **生产使用**           |
| WASM 路由（含 Windows ARM64） | `-wasm.ts` | node-sqlite3-wasm         | SQLite BLOB + hnsw ANN 缓存 | jieba-wasm       | **生产使用**           |
| HarmonyOS Native              | `-hm.ts`   | hm_sqlite_addon（native） | hm_sqlite_addon             | 不再提供 BM25 HM | **已废弃，仅保留参考** |

桌面 BM25 使用 native 或 WASM 后端。鸿蒙 BM25 使用 `Intl.Segmenter` 分词（后端名 `harmonyos-intl`），在普通 ArkData 库的对象事务内执行查询和宿主评分。同一个库统一使用一种事务 API，迁移时一并切换该库的所有调用方。

### 5.2 工厂分发机制

每种 Indexer 有一个 `create*IndexDB()` 工厂函数，根据 `process.platform` 选择实现：

```typescript
// 示例：createBaseIndexDB（定义在 base-index-db.ts）
export async function createBaseIndexDB(dbPath, schema): Promise<IBaseIndexDB> {
    if ((process.platform as string) === 'openharmony') {
        const { BaseIndexDBWasm } = await import('./base-index-db-wasm.js');
        return new BaseIndexDBWasm(dbPath, schema);
    }
    return new BaseIndexDB(dbPath, schema);
}
```

工厂函数位置：

| Indexer       | 工厂函数                | 定义文件                   |
| ------------- | ----------------------- | -------------------------- |
| BaseIndexer   | `createBaseIndexDB()`   | `base-index-db.ts`         |
| BM25Indexer   | `createBM25IndexDB()`   | `bm25-index-db-factory.ts` |
| VectorIndexer | `createVectorIndexDB()` | `vector-index-db.ts`       |
| TagIndexer    | `createTagIndexDB()`    | `tag-index-db.ts`          |
| ChunkIndexer  | `createChunkIndexDB()`  | `chunk-indexer.ts`         |

### 5.3 接口约束

每种 IndexDB 有对应的 TypeScript 接口（`I*IndexDB`），定义在对应的 Indexer 文件中：

| 接口             | 定义文件                                      | 方法数 |
| ---------------- | --------------------------------------------- | ------ |
| `IBaseIndexDB`   | `base-indexer.ts`                             | 19     |
| `IBM25IndexDB`   | `bm25-indexer.ts`（共享 BM25StatsStore 类型） | 见实现 |
| `IVectorIndexDB` | `vector-indexer.ts`                           | 14     |
| `ITagIndexDB`    | `tag-indexer.ts`                              | 17     |
| `IChunkIndexDB`  | `chunk-indexer.ts`                            | 8      |

两套生产实现（node / wasm）必须实现对应接口的所有方法。`*-hm.ts` 实现同样遵循接口但已不被工厂分发。Indexer 层仅通过接口调用 DB 层，不依赖具体实现类。

### 5.4 WASM 向量实现架构（VectorIndexDBWasm / ChunkIndexDBWasm）

```
┌─────────────────────────┐
│  SQLite（BLOB 真源）     │  ← 写入先落盘，数据不丢失
│  向量存储 + 元数据       │
└──────────┬──────────────┘
           │ 同步
┌──────────▼──────────────┐
│  HNSW ANN 缓存          │  ← 可重建，仅用于加速搜索
│  hnsw-adapter.ts        │
│  JSON 快照持久化         │
└─────────────────────────┘
```

关键行为：

- 写入先标记 HNSW 缓存为 dirty，成功后刷新快照
- compact 在 stale/total 比例超过 0.2 时触发
- `filterItemIds` 走双路径：小子集暴力计算，大子集 ANN 召回后过滤
- `hnsw_metadata` 表保存脏标记与快照状态

---

## 6. 类型系统

### 6.1 核心类型

```typescript
// Item — 存储单元
interface Item {
    item_id: string; // 主键
    item_type: ItemType; // 'file' | 'mail' | 'memory'
    [key: string]: any; // schema 定义的业务字段
    indexer_columns?: {
        // 各 Indexer 需要的额外数据
        [indexer: string]: Array<{
            column: string;
            content: string | number[];
            id?: string; // ChunkIndexer: chunk_id；BM25Indexer: subKey
            text?: string; // ChunkIndexer: chunk_text
        }>;
    };
}

// ColumnSchema — 存储定义
interface ColumnSchema {
    columns: { [column: string]: ColumnConstraint }; // BaseIndexer 建表列
    needIndexers: { [column: string]: IndexerBinding[] }; // 列 → Indexer 绑定
}

// FilterCondition — 搜索条件
interface FilterCondition {
    indexer: string; // 目标 Indexer 名
    field: string; // 查询字段
    operator: QueryOperator; // 操作符
    value: any; // 查询值
    vectorQuery?: VectorQuery; // 向量查询参数（仅 Vector/Chunk）
}
```

### 6.2 操作符分类

```
ScalarOperator:  = | != | > | < | >= | <= | like | notlike | in | notin | between | notbetween
VectorOperator:  vector_similarity | vector_near | vector_not_similar | vector_range
BM25Operator:    bm25_match
QueryOperator:   ScalarOperator | VectorOperator | BM25Operator
```

### 6.3 搜索结果类型

```typescript
interface SearchItem {
    item: Item; // 完整业务对象（来自 BaseIndexer）
    tags?: string; // tag 值
    VecScore?: number; // 向量相似度分数
    BM25Score?: number; // BM25 匹配分数
    bm25Record?: { field: string; subKey: string }; // BM25 scope 记录身份
    ChunkScore?: number; // chunk 相似度分数
    chunk_id?: string; // 命中的 chunk 标识符
    chunk_text?: string; // 命中的 chunk 原文
}
```

---

## 7. 写语义规范

BaseStorage 对外统一三种写语义：

| 操作     | 语义             | 不存在的 item | 已存在的 item    |
| -------- | ---------------- | ------------- | ---------------- |
| `insert` | first-write-only | 写入          | 跳过             |
| `update` | existing-only    | 跳过          | 更新（部分字段） |
| `upsert` | 覆盖写           | 写入          | 覆盖             |

**Indexer 层职责**：各 Indexer 实现上述语义时，内部策略可以不同，但对外行为必须一致。

**存在性判断**：由 BaseStorage 通过 BaseIndexer 统一执行（`getExistingItemIds`），结果用于 insert 去重。个别 Indexer（BM25、Chunk）额外做了自行检查，属于防御性编程。

**部分更新**：`update()` 只更新传入的字段。未传入的 `indexer_columns` 不会触发对应 Indexer 的更新。这是设计意图，不是遗漏。

---

## 8. 约束与限制

### 8.1 架构约束

| 约束                      | 说明                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **单 BaseStorage 单实例** | 通用约束仍为同一个 dbBasePath 不应被多个 BaseStorage 实例同时使用；其它索引器的实例约束不因 BM25 改动而放宽                     |
| **BM25 多 holder**        | BM25 索引支持同进程独立 holder 交替读写；native 跨进程由 SQLite WAL/锁协调，此能力不扩展为其它引擎或整个 BaseStorage 的并发保证 |
| **BaseIndexer 必须存在**  | 不可跳过，它是 item 存在性判断和元数据 join 的唯一来源                                                                          |
| **维度不可变**            | VectorIndexer / ChunkIndexer 的 dim 在首次写入后固定，变更需清空重建                                                            |
| **无跨 Indexer 事务**     | 多个 Indexer 的写入并行执行，某个失败不会回滚其余                                                                               |
| **搜索只支持 AND**        | 多条件取交集；OR 需调用方多次查询取并集                                                                                         |
| **ChunkIndexer 搜索受限** | 只能与 BaseIndexer 组合，不能与 BM25/Vector/Tag 联合搜索                                                                        |

### 8.2 当前实现限制

| 限制                                           | 说明                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| **Indexer 注册为具名字段**                     | BaseStorage 用 5 个独立字段管理 Indexer，新增 Indexer 需改 7+ 个方法 |
| **搜索管道顺序硬编码**                         | `indexerOrder` 数组固定为 Tag → BM25 → Vector → Base                 |
| **ChunkIndexer 违反 Indexer 契约**             | `search()` 直接 throw，不满足里氏替换原则                            |
| **Item 类型弱**                                | `[key: string]: any` 绕过了 TypeScript 类型检查                      |
| **TagIndexer 单实例**                          | BaseStorage 只创建一个 TagIndexer，不支持多 tag 列                   |
| **searchWithChunkIndexer 中 item_type 硬编码** | stub Item 的 `item_type` 写死为 `'file'`（当前为死代码，不影响功能） |
| **无 count() 便捷方法**                        | 获取 item 总数需走 `getStatus().BaseIndexer.size`，不够直观          |

### 8.3 平台特殊行为

| 行为            | Node.js                        | WASM 路由                   |
| --------------- | ------------------------------ | --------------------------- |
| 向量搜索        | sqlite-vec 原生                | HNSW ANN 缓存 + SQLite 真源 |
| BM25 分词       | @node-rs/jieba分词器           | jieba-wasm，四表统计        |
| BM25 评分       | 标准 BM25                      | 标准 BM25（共享算法）       |
| DB 磁盘大小查询 | PRAGMA page_count \* page_size | 同左（hm-addon 返回 0）     |
| 向量 compact    | 不需要                         | stale/total > 0.2 时触发    |

---

## 9. 数据流示意

### 9.1 insert 流程

```
storage.insert([item])
  │
  ├─ BaseStorage: getExistingItemIds() → 过滤已存在 item
  │
  └─ Promise.all:
       ├─ BaseIndexer.insert()
       │    └─ 从 item 提取 schema 列 → DB.insertMany()
       │
       ├─ BM25Indexer.insert()
       │    └─ 逐 entry 分词 → 记录级事务 insert()
       │
       ├─ VectorIndexer.insert()
       │    └─ 从 item.indexer_columns.VectorIndexer 提取向量 → DB.insertMany()
       │
       ├─ TagIndexer.insert()
       │    └─ 从 item.indexer_columns.TagIndexer 提取标签 → DB.insertMany()
       │
       └─ ChunkIndexer.insert()
            └─ 从 item.indexer_columns.ChunkIndexer 提取 chunk 集 → DB.insertMany()
```

### 9.2 search 流程（标准路径）

```
storage.search([
    { indexer: 'TagIndexer',    field: 'tag',  operator: '=', value: 'finance' },
    { indexer: 'BM25Indexer',   field: 'text', operator: 'bm25_match', value: { query: '报告' } },
    { indexer: 'BaseIndexer',   field: 'type', operator: '=', value: 'file' },
])
  │
  ├─ Step 1: TagIndexer.search([tag='finance'])
  │    → 结果集 A: [item_1, item_3, item_7]
  │
  ├─ Step 2: holder BM25 阶段：全域 searchHits('报告') → 校验记录唯一 → 与 A 交集
  │    → A ∩ BM25结果 → 结果集 B: [item_1, item_7]
  │
  ├─ (VectorIndexer 无条件，跳过)
  │
  └─ Step 3: BaseIndexer.search([type='file'], existingResults=B)
       → B ∩ Base结果 → 最终结果: [item_1]
```

---

## 10. DB 文件布局

```
{dbBasePath}/
├── base-index.db          BaseIndexer 数据
├── bm25-index.db          BM25 native 统计库（WAL）
├── bm25-index.wasm.db     BM25 WASM 统计库（DELETE）
├── vector-index.db        VectorIndexer 数据
├── tag-index.db           TagIndexer 数据
├── chunk-index.db         ChunkIndexer 数据
└── (WASM 平台额外文件)
    ├── vector-index.hnsw.json   HNSW ANN 缓存快照
    └── chunk-index.hnsw.json    HNSW ANN 缓存快照
```

每个 Indexer 使用独立 DB 文件，互不干扰。WASM 平台的 HNSW 快照可安全删除（会从 SQLite 真源重建）。

---

## 11. 演进规划

按优先级排列（详见 memory: project_storage_arch_evolution.md）：

1. **[高] Indexer 注册表** — 将 5 个具名字段改为 `Map<string, Indexer>`，CRUD 操作统一遍历
2. **[高] ChunkIndexer 脱离 Indexer 继承** — 承认 1:N chunk 模型与 1:1 item 模型是不同抽象
3. **[中] 搜索管道优先级** — Indexer 声明 `priority`，管道按优先级排序（随 #1 一起做）
4. **[中] 平台工厂收敛** — 5 个工厂函数的平台判断逻辑合并到统一 `createDB()` 工厂
5. **[低] Item 泛型化** — 消除 `[key: string]: any`，用泛型让 schema 列反映到 Item 类型
6. **[低] IndexDB 基接口** — 抽出 `IIndexDB` 包含 close/clear/count 公共方法

### BM25 资源与兼容边界

DB 通过现有 SQLite helper 仅在 native 依赖不可用且清理成功后回退；不因文件缺失、忙、权限、损坏或版本不兼容换库。Jieba 独立回退，词典/输出异常不会伪装为模块缺失。两种连接 busy_timeout=5000；只读打开不切换 journal。

readonly holder 初始化分别以机器错误码 `bm25_missing` / `bm25_uninitialized` 报告主库缺失 / 安全空库未建表；分类 `reason` 为 `missing` / `uninitialized`、`kind` 为 `other`。它们不属于 `BM25CompatibilityError`，不携带版本迁移方向，也不会自动创建或重建。

BM25 binding 仅接受 `access: 'readwrite' | 'readonly'`，汇总显式值后默认 readwrite，冲突/未知键拒绝。readonly 禁所有持久写和 instance drop，允许连接局部 TEMP 查询。probe 不加载 tokenizer、不建目录/主库，先真实内存连接验证 addon，再只读探测所选文件；不是初始化租约。

close 等待已接纳操作及 probe，失败资源保留供显式重试。BaseStorage.close 是 holder 终态；内部 BM25Indexer 成功 close 后回未初始化。初始化失败清理成功后，同一未关闭 holder 可重试 initialize。instance drop 完整关闭后只删所选物理文件及 sidecar；raw drop 要求调用者已关闭所有 holder，再精确删除 native/WASM 两套文件，拒绝未知 WASM 锁。

真实 CLI tgz 仓外安装、Electron application worker、Windows ARM64 产物和新 HAP 内容验收留业务接入/发布阶段；本机测试及构建不代替这些验收。

BM25 身份（item_id/field/subKey、候选及删除 ID）与保留词项必须不含 NUL，且 UTF-16 完整；非法值明确拒绝，写入整批在 BM25 事务前失败。合法字符串不转换。原始正文/查询文本仍按分词规则处理，不因原文含这些字符直接整段拒绝；分词后若保留非法词项则失败。

### Windows SQLite 发布验收清单（待执行）

本清单由后续 Windows 业务接入/发布验收执行，不作为本轮 storage 代码审核已通过的证据。根仓库不跟踪 `package-lock.json`，依赖声明单测也不能证明成品的依赖布局或原生模块可加载。

- 在仓库外安装实际发布产物，从成品中的 `@kenhkl/agent-gate` 和 `@kenhkl/agent-moss` 各自运行位置核对 `better-sqlite3` 的解析路径、真实路径和版本。两者须按根 `$better-sqlite3` override 去重到根依赖；检查各自 `node_modules/better-sqlite3`，不得残留独立编译的嵌套副本。记录产物标识、目标架构、根依赖与两个调用方的解析证据，不借用开发仓库的 `node_modules`。
- 在目标 Windows 架构（包括 ARM64）的成品既有 agent 子进程路径中，验证实际 Electron-as-node 运行时能够加载原生模块，并使用隔离临时数据库完成建库、写入、读取和关闭。记录 Electron/Node 版本、架构、加载结果和退出码；不得将捕获加载异常后的静默回退当作通过。
- 任一路径解析、去重或原生加载不符时，保留该发布验收项未通过，修正产物后重验。包声明检查、构建成功、Mac 上的 SQLite 测试均不能代替本项；不为本项新增生产验收入口或调整安全设置。
