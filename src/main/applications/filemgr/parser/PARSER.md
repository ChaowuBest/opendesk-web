# FileMgr Parser 使用指南

`parser/` 模块负责文件内容提取和分块，对外入口为 `parser/index.js`。

---

## 对外接口

```js
import { parseAndChunk } from './parser/index.js';

const result = await parseAndChunk(filePath, options, embedFn);
```

### 参数

| 参数              | 类型                                       | 默认值         | 说明                                                   |
| ----------------- | ------------------------------------------ | -------------- | ------------------------------------------------------ |
| `filePath`        | `string`                                   | —              | 单文件绝对路径                                         |
| `options.isChunk` | `boolean`                                  | `true`         | `false` 时只返回 `{ filePath, text }`                  |
| `options.level`   | `'basic' \| 'structured' \| 'semantic'`    | `'structured'` | 分块级别                                               |
| `embedFn`         | `(texts: string[]) => Promise<number[][]>` | —              | L4 可选 embedding 函数，不传则 fallback LLM.batchEmbed |

### 返回值

```js
// isChunk: false
{ filePath: string, text: string | null }

// isChunk: true（默认）
{
  filePath: string,
  chunk_type: 'chunk' | 'abstract' | 'filename' | null,
  chunks: Array<{ id: string, text: string }> | null
}
```

**chunk_type / chunks 的 4-way 语义**（level: 'structured' | 'semantic'）：

| chunk_type | chunks | 含义                               |
| ---------- | ------ | ---------------------------------- |
| `null`     | `null` | 文件格式不支持分块                 |
| 非 null    | `null` | 格式受支持，但未能提取出可分块文本 |
| 非 null    | `[]`   | 成功提取文本，但内容为空           |
| 非 null    | `[…]`  | 正常分块成功                       |

> **例外**：`filename` 格式（json/yaml/yml/xml）即使无法读取文件也返回 basename chunk。
> **L2（basic）**：chunk_type 恒为 `'chunk'`，第一行不适用。

### 调用示例

```js
// 基本用法（L3 structured，默认）
const result = await parseAndChunk('/path/to/report.pdf');

// L2 basic（快速索引，格式无关）
const result = await parseAndChunk('/path/to/file.txt', { level: 'basic' });

// L4 semantic（自定义 embedFn）
const result = await parseAndChunk(
    '/path/to/doc.md',
    {
        level: 'semantic',
        breakpointPercentile: 85,
        minChunkSize: 200
    },
    myEmbedFn
);

// 只解析不分块
const { text } = await parseAndChunk('/path/to/file.pdf', { isChunk: false });

// 处理结果
const { chunk_type, chunks } = result;
if (chunks === null) return; // 跳过失败文件
if (chunks.length === 0) return; // 跳过空文件
for (const { id, text } of chunks) {
    // 将 text 送入 embedding
}
```

---

## 直接使用 chunk 函数

如果已有文本（无需文件 I/O），可直接 import chunk 函数：

```js
import { chunkBasic, chunkStructured, chunkSemantic, extractText } from './parser/index.js';

// L2
const { chunks } = chunkBasic(text, { chunkSize: 800 });

// L3（需要 filePath 确定格式）
const { chunk_type, chunks } = chunkStructured(text, filePath, { chunkSize: 800 });

// L4（需要 filePath + embedFn）
const { chunk_type, chunks } = await chunkSemantic(text, filePath, options, embedFn);
```

---

## Options 参数

### 通用参数

| 参数        | 默认值 | 说明                  |
| ----------- | ------ | --------------------- |
| `chunkSize` | `1000` | 每 chunk 最大字符数   |
| `overlap`   | `200`  | 相邻 chunk 重叠字符数 |

### L3/L4 格式专用

| 参数                | 默认值 | 适用格式   | 说明                                       |
| ------------------- | ------ | ---------- | ------------------------------------------ |
| `chunkTokens`       | `512`  | code       | 每 chunk 近似 token 数（1 token ≈ 4 字符） |
| `tokenOverlap`      | `50`   | code       | 相邻 chunk 重叠 token 数                   |
| `maxSlideChunkSize` | `2000` | slides     | 单张 slide 超过此值时再做 prose 切分       |
| `maxAbstractLines`  | `10`   | csv / xlsx | 摘要中包含的最大数据行数                   |

### L4 专用

| 参数                   | 默认值 | 说明                                |
| ---------------------- | ------ | ----------------------------------- |
| `bufferSize`           | `1`    | 上下文窗口半径                      |
| `breakpointPercentile` | `95`   | 断点阈值百分位（值越小断点越多）    |
| `minChunkSize`         | `100`  | 短于此字符数的 chunk 并入相邻 chunk |

---

## 分块级别

| 级别       | 名称         | 核心思想                              | 调用 Embedding |
| ---------- | ------------ | ------------------------------------- | -------------- |
| basic      | 递归字符切分 | 段落/句子边界贪婪切分，不感知文件格式 | ❌             |
| structured | 结构感知切分 | 按文件格式内置语义边界切分            | ❌             |
| semantic   | 语义断点切分 | embedding 相似度检测话题转换点        | ✅             |

## 文件类型支持

| 扩展名                             | format   | chunk_type | L4 embedding |
| ---------------------------------- | -------- | ---------- | ------------ |
| pdf / doc / docx / odt / ods / txt | prose    | chunk      | ✅           |
| md                                 | markdown | chunk      | ✅           |
| pptx / odp                         | slides   | chunk      | ✅           |
| js / css / html                    | code     | chunk      | ❌           |
| csv                                | csv      | abstract   | ❌           |
| xls / xlsx                         | xlsx     | abstract   | ❌           |
| json / yaml / yml / xml            | filename | filename   | ❌           |
