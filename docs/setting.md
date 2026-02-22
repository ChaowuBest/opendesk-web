# OpenDesk 配置文件设计文档

## 概述

OpenDesk 使用一套集中式的配置管理系统，用于管理 AI 模型提供商、模型配置以及各应用程序的自定义配置。配置文件以 JSON 格式存储在用户数据目录中，通过 Zod schema 进行类型验证。

## 配置文件存储位置

配置文件存储在用户数据目录下的 `setting.json` 文件中：

- **Windows**: `%APPDATA%/opendesk/setting.json`
- **Linux/macOS**: `~/.opendesk/setting.json`

相关目录由 [`getAppDirectory()`](src/main/utils/setting.js:272) 函数管理，该函数还会自动创建以下子目录：

- `logs/` - 日志目录（通过 [`getLogDirectory()`](src/main/utils/setting.js:298) 获取）
- `tasks/` - 任务目录（通过 [`getTaskDirectory()`](src/main/utils/setting.js:311) 获取）
- `apps/` - 各应用的数据目录

## 配置 Schema 结构

配置 Schema 由 [`getSettingSchema()`](src/main/utils/setting.js:33) 函数定义，包含以下核心部分：

### 1. 全局模型配置

| 字段 | 类型 | 描述 | 默认值 |
|------|------|------|--------|
| `default_model` | string | 对话等场景中使用的默认模型 | `""` |
| `default_intent_parsing_model` | string | 意图解析中使用的多模态模型 | `""` |
| `default_embedding_model` | string | 知识库、检索使用的向量嵌入模型 | `""` |
| `default_reranker_model` | string | 检索结果重排序中使用的模型 | `""` |
| `default_vision_model` | string | 图片记忆提取中使用的多模态模型 | `""` |

### 2. 提供商配置 (`providers`)

提供商配置是一个数组，每个提供商包含：

```javascript
const ProviderSchema = z.object({
    name: z.string().default('openrouter'),        // 模型提供商名称
    base_url: z.string().default('https://openrouter.ai/api/v1'),  // API 地址
    api_key: z.string().default(''),               // API 密钥
    no_proxy: z.boolean().default(false)           // 是否禁用代理
})
```

### 3. 模型配置 (`models`)

模型配置是一个数组，每个模型包含：

```javascript
const ModelSchema = z.object({
    alias: z.string().default('model_alias'),      // 本地配置中使用的名称
    provider_name: z.string().default('openrouter'), // 模型提供商
    model_name: z.string().default('google/gemini-2.5-flash') // 提供商一侧的名称
})
```

### 4. 应用程序配置 (`applications`)

应用程序配置是一个动态扩展的对象，各应用通过 [`registerApplicationSettings()`](src/main/utils/setting.js:157) 方法注册自己的配置 Schema。

示例配置结构：

```json
{
    "default_model": "gemini-2.5-flash",
    "default_intent_parsing_model": "gemini-2.0-flash",
    "default_embedding_model": "text-embedding-3-small",
    "default_reranker_model": "rerank-english-v3.0",
    "default_vision_model": "gemini-2.0-flash",
    "providers": [
        {
            "name": "openrouter",
            "base_url": "https://openrouter.ai/api/v1",
            "api_key": "sk-xxx",
            "no_proxy": false
        }
    ],
    "models": [
        {
            "alias": "gemini-2.5-flash",
            "provider_name": "openrouter",
            "model_name": "google/gemini-2.5-flash"
        }
    ],
    "applications": {
        "filemgr": {
            "root": "/home/user",
            "include_patterns": ["**/*.{txt,md}"],
            "exclude_patterns": ["**/node_modules/**"]
        },
        "mcpmgr": {
            "servers": [...]
        },
        "calendar": {
            "dataSources": {
                "outlook": {
                    "enabled": false
                }
            }
        }
    }
}
```

## Setting 类

[`Setting`](src/main/utils/setting.js:69) 类是配置管理的核心，采用单例模式。

### 静态方法

| 方法 | 描述 |
|------|------|
| [`getInstance()`](src/main/utils/setting.js:126) | 获取唯一的 Setting 实例，会自动从文件加载 |
| [`clearCache()`](src/main/utils/setting.js:136) | 清除缓存的实例，强制重新加载 |
| [`updateInstanceData(data)`](src/main/utils/setting.js:144) | 更新实例数据（用于 Worker 线程同步配置） |
| [`registerApplicationSettings(application, callback)`](src/main/utils/setting.js:157) | 注册应用程序的配置 Schema 和变更回调 |
| [`getSettingSchema()`](src/main/utils/setting.js:255) | 获取当前的配置 Schema |
| [`load()`](src/main/utils/setting.js:172) | 从文件系统加载配置 |

### 实例方法

| 方法 | 描述 |
|------|------|
| [`getData()`](src/main/utils/setting.js:81) | 获取配置数据对象 |
| [`setData(data)`](src/main/utils/setting.js:89) | 设置配置数据，会自动保存并触发变更回调 |
| [`getApplicationConfig(applicationName)`](src/main/utils/setting.js:85) | 获取指定应用的配置 |
| [`getModelInstance(model_alias)`](src/main/utils/setting.js:203) | 根据模型别名获取 ModelInstance |
| [`getDefaultModelInstance()`](src/main/utils/setting.js:219) | 获取默认模型实例 |
| [`getDefaultEmbeddingModelInstance()`](src/main/utils/setting.js:227) | 获取默认嵌入模型实例 |
| [`getDefaultRerankerModelInstance()`](src/main/utils/setting.js:235) | 获取默认重排序模型实例 |
| [`getDefaultIntentParsingModelInstance()`](src/main/utils/setting.js:247) | 获取默认意图解析模型实例 |
| [`getDefaultVisionModelInstance()`](src/main/utils/setting.js:259) | 获取默认视觉模型实例 |
| [`save()`](src/main/utils/setting.js:192) | 保存配置到文件 |

## ModelInstance 类

[`ModelInstance`](src/main/utils/setting.js:50) 类表示一个可用的模型实例：

```javascript
class ModelInstance {
    model_name: string;   // 模型名称
    base_url: string;     // API 基础地址
    api_key: string;      // API 密钥
    no_proxy: boolean;    // 是否禁用代理
}
```

## 应用程序配置注册机制

应用程序通过继承 [`BaseApplication`](src/main/applications/base.ts:88) 类并实现静态方法 `getConfigSchema()` 来定义自己的配置：

```javascript
static getConfigSchema(): z.ZodObject<any> {
    return z.object({
        // 应用配置字段定义
    });
}
```

在应用注册时，通过 [`Setting.registerApplicationSettings()`](src/main/utils/setting.js:157) 将应用配置 Schema 扩展到主配置中：

```typescript
// 在 ApplicationRegistry 中
Setting.registerApplicationSettings(application, () => {
    application.onConfigChanged();
});
```

当配置发生变化时，会触发注册的回调函数通知应用更新。

### 应用配置示例

#### 文件管理器 (filemgr)

定义于 [`src/main/applications/filemgr/setting.js`](src/main/applications/filemgr/setting.js:43)：

```javascript
export const FSEntrySchema = z.object({
    root: z.string().default(getHomeDirectory()),
    include_patterns: z.array(z.string()).default([
        "**/*.{txt,md}",
        "**/*.{pdf,doc,docx,ppt,pptx,xls,xlsx,csv}",
        "**/*.{json,yaml,yml,xml,html,css,js}",
    ]),
    exclude_patterns: z.array(z.string()).default(defaultExcludePatterns),
})
```

#### MCP 管理器 (mcpmgr)

定义于 [`src/main/applications/mcpmgr/app.ts`](src/main/applications/mcpmgr/app.ts:36)：

```typescript
const McpMgrConfigSchema = z.object({
    servers: z.array(McpServerConfigSchema).describe('MCP 服务配置列表').default([]),
});
```

#### 日历 (calendar)

定义于 [`src/main/applications/calendar/app.js`](src/main/applications/calendar/app.js:29)：

```javascript
static getConfigSchema() {
    return z.object({
        dataSources: z.object({
            outlook: z.object({
                enabled: z.boolean().default(false).describe('是否同步 Outlook 日历数据'),
            }).optional()
        }).default({})
    });
}
```

## 配置使用场景

### 1. LLM 调用

[`LLM`](src/main/agents/llm.ts:14) 类使用配置获取模型实例进行各种 AI 操作：

- [`embed()`](src/main/agents/llm.ts:91) - 文本嵌入
- [`batchEmbed()`](src/main/agents/llm.ts:104) - 批量文本嵌入
- [`rerank()`](src/main/agents/llm.ts:135) - 检索结果重排序
- [`ask()`](src/main/agents/llm.ts:193) - 普通对话
- [`stream()`](src/main/agents/llm.ts:353) - 流式对话

### 2. 意图解析

[`IntentParser`](src/main/services/intent/parser.js:123) 使用默认意图解析模型进行多模态意图识别。

### 3. 图片分析

[`imageAnalyzeManager`](src/main/applications/recall/service/snapshot/imageAnalyzeManager.js:228) 使用默认视觉模型进行图片内容分析。

### 4. Worker 线程配置同步

Worker 线程通过消息接收主线程的配置更新：

```typescript
// 在 worker.ts 中
parentPort?.on('message', (message) => {
    if (message.type === 'updateSetting') {
        Setting.updateInstanceData(message.newSettingData);
    }
});
```

## IPC 接口

渲染进程通过以下 IPC 句柄与配置系统交互（定义于 [`src/main/main.js`](src/main/main.js:399)）：

| IPC 句柄 | 描述 |
|----------|------|
| `setting:loadSettingSchema` | 加载配置 Schema（用于生成设置界面） |
| `setting:loadSettingObject` | 加载当前配置数据 |
| `setting:saveSettingObject` | 保存配置数据 |
| `setting:exportSettingData` | 导出配置到文件 |

## 设置界面

渲染进程中的 [`SettingEditor`](src/renderer/components/setting.js:12) 组件提供配置编辑界面：

- 动态加载 Schema 并渲染表单
- 支持保存、导入、导出配置
- 配置变更后显示通知反馈

## 配置变更流程

1. 用户在设置界面修改配置
2. 渲染进程调用 `setting:saveSettingObject` IPC
3. 主进程调用 `Setting.setData()` 验证并保存
4. 如果应用配置发生变化，触发对应的回调函数
5. 通知 Worker 线程更新配置
6. 返回成功/失败状态给渲染进程

## 最佳实践

1. **Schema 定义**: 使用 Zod 定义配置 Schema，确保类型安全
2. **默认值**: 为所有配置字段提供合理的默认值
3. **配置隔离**: 各应用使用独立的配置命名空间（通过 bundleName）
4. **变更通知**: 注册配置变更回调以响应配置更新
5. **Worker 同步**: 在 Worker 线程中使用 `updateInstanceData()` 同步配置
