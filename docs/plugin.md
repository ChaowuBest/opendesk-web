# OpenDesk Plugin 系统

本文档详细说明 OpenDesk 的插件管理系统，包括插件的安装、加载机制以及 Channel 消息通信的完整执行流程。

## 目录

1. [系统架构概览](#系统架构概览)
2. [插件管理](#插件管理)
   - [安装流程](#安装流程)
   - [卸载流程](#卸载流程)
   - [启用/禁用](#启用禁用)
3. [插件加载机制](#插件加载机制)
   - [入口点解析](#入口点解析)
   - [TypeScript 编译](#typescript-编译)
   - [插件注册](#插件注册)
4. [OpenClaw 兼容层](#openclaw-兼容层)
5. [Channel 消息通信](#channel-消息通信)
   - [消息插件结构](#消息插件结构)
   - [消息流转流程](#消息流转流程)
   - [会话管理](#会话管理)
6. [核心类型定义](#核心类型定义)
7. [扩展开发指南](#扩展开发指南)

---

## 系统架构概览

OpenDesk 的插件系统采用与 OpenClaw 兼容的设计，支持通过 npm 安装第三方消息插件。整体架构如下：

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenDesk 主程序                           │
├─────────────────────────────────────────────────────────────────┤
│  CLI 入口 (cli.ts)  │  TUI 界面  │  Applications 注册表          │
├─────────────────────────────────────────────────────────────────┤
│                    ChannelsApplication                          │
│              (消息插件管理应用)                                    │
├──────────────────────────┬──────────────────────────────────────┤
│   Plugin Manager         │      ChannelMessageRouter            │
│   (插件管理器)            │      (消息路由器)                     │
├──────────────────────────┴──────────────────────────────────────┤
│                    OpenClaw 兼容层 (Shim)                        │
├─────────────────────────────────────────────────────────────────┤
│                    消息插件 (Channel Plugins)                    │
│         例如: @ynhcj/xiaoyi, discord-plugin, slack-plugin       │
└─────────────────────────────────────────────────────────────────┘
```

**核心文件：**

| 文件路径 | 职责 |
|---------|------|
| [`src/main/plugins/manager.ts`](../src/main/plugins/manager.ts) | 插件安装、卸载、加载管理 |
| [`src/main/plugins/types.ts`](../src/main/plugins/types.ts) | 插件类型定义 |
| [`src/main/applications/channels/app.ts`](../src/main/applications/channels/app.ts) | 消息插件应用，管理生命周期 |
| [`src/main/applications/channels/router.ts`](../src/main/applications/channels/router.ts) | 消息路由，对接 AI Agent |
| [`src/main/cli.ts`](../src/main/cli.ts) | CLI 命令入口 |

---

## 插件管理

### 安装流程

插件通过 npm 安装到 OpenDesk 的扩展目录中。安装流程如下：

```
用户执行: opendesk plugins install @ynhcj/xiaoyi@latest
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  1. 确保扩展目录存在                                          │
│     ~/.opendesk/extensions/                                  │
│     └── package.json (npm 初始化)                            │
├─────────────────────────────────────────────────────────────┤
│  2. 执行 npm install                                         │
│     npm install @ynhcj/xiaoyi@latest --ignore-scripts --save │
│     (使用 --ignore-scripts 确保安全性)                        │
├─────────────────────────────────────────────────────────────┤
│  3. 生成 OpenClaw 兼容层                                      │
│     node_modules/openclaw/                                   │
│     ├── package.json                                         │
│     ├── index.js                                             │
│     └── plugin-sdk/                                          │
│         ├── index.js (SDK 函数 shim)                         │
│         ├── account-id.js                                    │
│         └── keyed-async-queue.js                             │
├─────────────────────────────────────────────────────────────┤
│  4. 读取插件清单                                              │
│     openclaw.plugin.json 或 package.json                     │
├─────────────────────────────────────────────────────────────┤
│  5. 保存安装记录                                              │
│     plugins.json:                                            │
│     [{                                                       │
│       id: "xiaoyi",                                          │
│       npmSpec: "@ynhcj/xiaoyi@latest",                       │
│       installedAt: "2026-03-07T...",                         │
│       enabled: true,                                         │
│       source: "npm"                                          │
│     }]                                                       │
└─────────────────────────────────────────────────────────────┘
```

**关键代码：**

```typescript
// src/main/plugins/manager.ts
export async function installPlugin(npmSpec: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const extensionsDir = getExtensionsDir();
    ensureExtensionPackageJson();

    // 执行 npm 安装
    execSync(`npm install ${npmSpec} --ignore-scripts --save`, {
        cwd: extensionsDir,
        stdio: 'pipe',
        timeout: 120000,
    });

    // 确保兼容层存在
    ensureOpenClawShim();

    // 读取清单并保存记录
    const manifest = loadManifest(pkgName);
    saveInstallRecord(manifest);
}
```

**目录结构：**

```
~/.opendesk/
├── setting.json              # OpenDesk 配置
└── extensions/
    ├── package.json          # npm 依赖管理
    ├── plugins.json          # 插件安装记录
    └── node_modules/
        ├── openclaw/         # 兼容层 shim
        └── @ynhcj/
            └── xiaoyi/       # 安装的插件
                ├── package.json
                ├── openclaw.plugin.json
                └── index.ts
```

### 卸载流程

```
用户执行: opendesk plugins uninstall xiaoyi
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  1. 查找安装记录                                              │
│     从 plugins.json 中查找匹配的插件                           │
├─────────────────────────────────────────────────────────────┤
│  2. 执行 npm uninstall                                       │
│     npm uninstall @ynhcj/xiaoyi                              │
├─────────────────────────────────────────────────────────────┤
│  3. 更新安装记录                                              │
│     从 plugins.json 中移除对应条目                            │
└─────────────────────────────────────────────────────────────┘
```

### 启用/禁用

插件可以通过修改安装记录中的 `enabled` 字段来控制是否加载：

```typescript
export function setPluginEnabled(pluginId: string, enabled: boolean): boolean {
    const records = loadInstallRecords();
    const record = records.find(r => r.id === pluginId);
    if (!record) return false;
    record.enabled = enabled;
    saveInstallRecords(records);
    return true;
}
```

**CLI 命令：**

```bash
opendesk plugins list              # 列出所有已安装插件
opendesk plugins enable <id>       # 启用插件
opendesk plugins disable <id>      # 禁用插件
```

---

## 插件加载机制

### 入口点解析

插件加载时，系统按以下优先级查找入口文件：

```
1. package.json → openclaw.extensions[0]
   例如: "openclaw": { "extensions": ["./index.ts"] }

2. package.json → exports["."].import / exports["."].default

3. package.json → module 字段

4. package.json → main 字段

5. 默认文件: index.ts 或 index.js
```

**解析代码：**

```typescript
function resolvePluginEntryPoint(pluginDir: string): string | null {
    const pkgJson = loadPackageJson(pluginDir);

    // 1. openclaw.extensions 字段
    const extensions = pkgJson?.openclaw?.extensions;
    if (Array.isArray(extensions) && extensions.length > 0) {
        const entry = path.join(pluginDir, extensions[0]);
        if (fs.existsSync(entry)) return entry;
    }

    // 2. exports 字段
    if (pkgJson.exports) {
        const root = pkgJson.exports['.']?.import || pkgJson.exports['.']?.default;
        if (root) return path.join(pluginDir, root);
    }

    // 3. module / main 字段
    for (const field of ['module', 'main']) {
        if (pkgJson[field]) return path.join(pluginDir, pkgJson[field]);
    }

    // 4. 默认入口
    for (const name of ['index.ts', 'index.js']) {
        const entry = path.join(pluginDir, name);
        if (fs.existsSync(entry)) return entry;
    }

    return null;
}
```

### TypeScript 编译

对于 TypeScript 插件，系统使用 esbuild 进行即时编译：

```
插件入口: index.ts
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  1. 检查缓存                                                  │
│     .opendesk-compiled.mjs                                   │
│     如果已编译且源文件未修改，直接使用缓存                       │
├─────────────────────────────────────────────────────────────┤
│  2. 收集外部依赖                                              │
│     从 package.json 的 dependencies/peerDependencies 中提取   │
├─────────────────────────────────────────────────────────────┤
│  3. esbuild 编译                                              │
│     esbuild.build({                                          │
│       entryPoints: [entryPoint],                             │
│       outfile: compiledPath,                                 │
│       bundle: true,                                          │
│       format: 'esm',                                         │
│       platform: 'node',                                      │
│       target: 'node20',                                      │
│       external: externalPackages                             │
│     })                                                       │
├─────────────────────────────────────────────────────────────┤
│  4. 动态导入                                                  │
│     import('file://' + compiledPath)                         │
└─────────────────────────────────────────────────────────────┘
```

**编译代码：**

```typescript
async function compileTypeScriptPlugin(entryPoint: string, pluginDir: string): Promise<string | null> {
    const compiledPath = path.join(pluginDir, '.opendesk-compiled.mjs');

    // 缓存检查
    if (fs.existsSync(compiledPath)) {
        const compiledMtime = fs.statSync(compiledPath).mtimeMs;
        const sourceMtime = fs.statSync(entryPoint).mtimeMs;
        if (compiledMtime > sourceMtime) return compiledPath;
    }

    // 收集外部依赖
    const externalPackages = collectExternalPackages(pluginDir);

    // esbuild 编译
    const esbuild = await import('esbuild');
    await esbuild.build({
        entryPoints: [entryPoint],
        outfile: compiledPath,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        external: externalPackages,
    });

    return compiledPath;
}
```

### 插件注册

加载插件模块后，系统调用插件的注册函数并传入 API 对象：

```typescript
async function loadSinglePlugin(record: PluginInstallRecord): Promise<PluginEntry | null> {
    // 1. 解析入口点
    const entryPoint = resolvePluginEntryPoint(pluginDir);

    // 2. 加载模块（TypeScript 需编译）
    let pluginModule;
    if (entryPoint?.endsWith('.ts')) {
        const compiledPath = await compileTypeScriptPlugin(entryPoint, pluginDir);
        pluginModule = await import('file://' + compiledPath);
    } else {
        pluginModule = require(pkgName);
    }

    // 3. 创建 API 对象
    let channelPlugin: ChannelPlugin | null = null;
    const api = createPluginApi(entry, (cp: ChannelPlugin) => {
        channelPlugin = cp;  // 回调捕获注册的 ChannelPlugin
    });

    // 4. 调用注册函数
    if (typeof pluginModule === 'function') {
        await pluginModule(api);           // 导出为函数
    } else if (typeof pluginModule?.register === 'function') {
        await pluginModule.register(api);  // 导出为 { register } 对象
    }

    // 5. 保存结果
    if (channelPlugin) {
        entry.channelPlugin = channelPlugin;
    }

    return entry;
}
```

---

## OpenClaw 兼容层

OpenDesk 实现了 OpenClaw 插件 SDK 的兼容层（Shim），使 OpenClaw 生态的插件可以直接在 OpenDesk 中运行。

### Shim 结构

```
~/.opendesk/extensions/node_modules/openclaw/
├── package.json           # 模块定义和导出映射
├── index.js               # 主入口（空导出）
└── plugin-sdk/
    ├── index.js           # SDK 主模块（包含所有辅助函数）
    ├── account-id.js      # 账户 ID 处理
    └── keyed-async-queue.js  # 异步队列
```

### 提供的 SDK 函数

兼容层提供了以下 OpenClaw SDK 函数：

| 类别 | 函数 | 说明 |
|------|------|------|
| **账户管理** | `createAccountListHelpers()` | 创建账户列表辅助函数 |
| | `normalizeAccountId()` | 规范化账户 ID |
| | `isDefaultAccountId()` | 判断是否默认账户 |
| **配置解析** | `resolveChannelAccountConfigBasePath()` | 解析配置路径 |
| | `resolveThreadSessionKeys()` | 解析会话键 |
| **消息处理** | `createNormalizedOutboundDeliverer()` | 创建消息发送器 |
| | `buildMediaPayload()` | 构建媒体消息 |
| **状态管理** | `buildBaseChannelStatusSummary()` | 构建状态摘要 |
| | `createDefaultChannelRuntimeState()` | 创建运行状态 |
| **安全验证** | `normalizeAllowFrom()` | 规范化允许列表 |
| | `isAllowedParsedChatSender()` | 检查发送者权限 |
| **工具函数** | `acquireFileLock()` | 文件锁 |
| | `createDedupeCache()` | 去重缓存 |
| | `createFixedWindowRateLimiter()` | 速率限制 |

### API 对象

插件注册时接收的 API 对象：

```typescript
interface OpenClawPluginApi {
    id: string;                    // 插件 ID
    name: string;                  // 插件名称
    version?: string;              // 版本
    description?: string;          // 描述
    source: string;                // 来源
    config: any;                   // 配置
    logger: PluginLogger;          // 日志器

    // 注册方法
    registerChannel: (registration: any) => void;  // 注册消息插件
    registerTool: (tool: any, opts?: any) => void;
    registerHook: (events: string | string[], handler: any, opts?: any) => void;
    registerHttpHandler: (handler: any) => void;
    registerHttpRoute: (params: { path: string; handler: any }) => void;
    registerGatewayMethod: (method: string, handler: any) => void;
    registerCli: (registrar: any, opts?: any) => void;
    registerService: (service: any) => void;
    registerProvider: (provider: any) => void;
    registerCommand: (command: any) => void;

    // 其他
    resolvePath: (input: string) => string;
    on: (hookName: string, handler: any, opts?: any) => void;
}
```

---

## Channel 消息通信

### 消息插件结构

一个完整的消息插件（ChannelPlugin）包含以下组件：

```typescript
interface ChannelPlugin {
    id: ChannelId;                    // 插件唯一标识
    meta: ChannelMeta;                // 元信息（标签、描述等）
    capabilities: ChannelCapabilities; // 能力声明

    // 配置适配器
    config: ChannelConfigAdapter;

    // 出站消息适配器（发送消息）
    outbound?: ChannelOutboundAdapter;

    // 网关适配器（接收消息）
    gateway?: ChannelGatewayAdapter;

    // 状态适配器
    status?: ChannelStatusAdapter;

    // 其他可选组件
    auth?: any;        // 认证
    threading?: any;   // 线程支持
    messaging?: ChannelMessagingAdapter;
    agentPrompt?: any; // Agent 提示词
    agentTools?: any;  // Agent 工具
}
```

**核心适配器说明：**

| 适配器 | 职责 | 关键方法 |
|--------|------|----------|
| `config` | 配置管理 | `listAccountIds()`, `resolveAccount()` |
| `outbound` | 发送消息 | `sendText()`, `sendPayload()`, `sendMedia()` |
| `gateway` | 接收消息 | `startAccount()`, `stopAccount()` |
| `status` | 状态监控 | `buildChannelSummary()` |

### 消息流转流程

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           消息接收流程                                    │
└──────────────────────────────────────────────────────────────────────────┘

外部消息平台 (微信/Discord/Slack等)
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  1. 插件 Gateway 接收消息                                                 │
│     gateway.startAccount(ctx) 启动时注册的消息监听器                       │
│     调用 ctx.dispatch(message)                                           │
├─────────────────────────────────────────────────────────────────────────┤
│  2. ChannelsApplication.handleInboundMessage()                          │
│     - 记录日志                                                            │
│     - 发送事件通知 (channel:message)                                      │
│     - 调用 router.routeInboundMessage()                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  3. ChannelMessageRouter.routeInboundMessage()                          │
│     - 生成会话键: channelId:accountId:senderId                           │
│     - 查找或创建任务 (Task)                                               │
│     - 触发 onTaskResolved 回调：                                         │
│       · 自动将用户前台切换到该任务                                        │
│       · 发送通知告知用户收到新消息                                        │
│     - 格式化消息                                                          │
│     - 提交给 AI Agent 处理                                               │
├─────────────────────────────────────────────────────────────────────────┤
│  4. AI Agent 处理                                                        │
│     - 加载工具集 (Toolsets)                                               │
│     - 执行 LLM 推理                                                       │
│     - 生成回复                                                            │
├─────────────────────────────────────────────────────────────────────────┤
│  5. 返回回复                                                              │
│     router 返回回复文本                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  6. 发送回复                                                              │
│     outbound.sendText({ to, text, ... })                                │
└─────────────────────────────────────────────────────────────────────────┘
        │
        ▼
外部消息平台（回复送达用户）
```

**详细代码流程：**

```typescript
// 1. Gateway 接收消息
// 插件内部调用 ctx.dispatch()
ctx.dispatch({
    channelId: 'xiaoyi',
    accountId: 'default',
    senderId: 'user123',
    senderName: '张三',
    text: '你好',
    chatType: 'direct',
    messageId: 'msg-001'
});

// 2. ChannelsApplication 处理
private async handleInboundMessage(cp: ChannelPlugin, accountId: string, message: InboundChannelMessage) {
    this.emitEvent('channel:message', { channelId, accountId, senderId, text });
    const reply = await this.router.routeInboundMessage(message);
    if (reply && cp.outbound?.sendText) {
        await cp.outbound.sendText({
            channelId: cp.id,
            accountId,
            to: message.senderId,
            text: reply,
            replyToMessageId: message.messageId
        });
    }
}

// 3. Router 路由消息
async routeInboundMessage(message: InboundChannelMessage): Promise<string | null> {
    const sessionKey = `${message.channelId}:${message.accountId}:${message.senderId}`;
    const task = this.findActiveTask(sessionKey) ?? await this.createSessionTask(sessionKey, message);

    // 通知前端：自动切换到该任务并发送通知
    this.onTaskResolved?.(task, message);

    const reply = await this.submitAndWaitForReply(task, message.text);
    return reply;
}
```

### 会话管理

系统使用任务键（taskKey）来关联同一发送者的多条消息，实现上下文连续对话：

```
任务键格式:
  - 群组消息: {channelId}:{accountId}:{groupId}
  - 私信: {channelId}:{accountId}:{senderId}

示例: xiaoyi:default:user123 (私信)
示例: xiaoyi:default:group456 (群组)

taskMap: Map<taskKey, TaskEntry>
```

**任务创建流程：**

```typescript
private async createSessionTask(taskKey: string, message: InboundChannelMessage): Promise<TaskState> {
    // 1. 创建新任务
    const task = this.taskManagerState.createTask(this.model);

    // 2. 生成系统提示词（包含 Channel 上下文）
    const systemPrompt = await this.agentDecl.createSystemPrompt();
    const channelContext = [
        systemPrompt,
        '--- Channel Context ---',
        `Channel: ${message.channelId}`,
        `Sender: ${message.senderName || message.senderId}`,
        message.chatType === 'group' ? `Group: ${message.groupName}` : '',
        'Please respond concisely and naturally...'
    ].join('\n');

    await task.setSystemPrompt(channelContext);

    // 3. 记录任务映射
    task.task_name = `消息: ${message.senderName || message.senderId}`;
    taskMap.set(taskKey, { taskId: task.task_id, lastMessageAt: Date.now() });

    return task;
}
```

**消息处理流程：**

```typescript
private async submitAndWaitForReply(task: TaskState, userText: string): Promise<string | null> {
    // 1. 创建用户消息
    const userMessage = new UserMessage(userText);
    const assistantMessage = new AssistantMessage();
    task.chat_context.appendMessage(userMessage);
    task.chat_context.appendMessage(assistantMessage);

    // 2. 加载工具集
    const toolsets = await ApplicationRegistry.listAvailableToolsets();
    const skillToolset = SkillRegistry.getInstance().getToolset();
    const memoryToolset = createMemoryToolset();
    task.chat_context.attachToolsets(...toolsets, skillToolset, memoryToolset);

    // 3. 执行任务
    task.processTaskTurn();
    await task.waitUntilFinished();

    // 4. 提取回复
    const lastMsg = task.chat_context.lastMessage();
    if (lastMsg instanceof AssistantMessage) {
        return extractTextFromMessage(lastMsg);
    }
    return null;
}
```

---

## 核心类型定义

### 插件安装记录

```typescript
interface PluginInstallRecord {
    id: string;              // 插件 ID
    npmSpec: string;         // npm 规格字符串
    installedAt: string;     // 安装时间 (ISO 8601)
    enabled: boolean;        // 是否启用
    source: 'npm' | 'local'; // 安装来源
    path?: string;           // 本地路径
}
```

### 插件入口

```typescript
interface PluginEntry {
    id: string;                      // 插件 ID
    manifest: PluginManifest;        // 清单信息
    installRecord: PluginInstallRecord;
    module?: any;                    // 加载的模块
    channelPlugin?: ChannelPlugin;   // 解析出的消息插件
}
```

### 入站消息

```typescript
interface InboundChannelMessage {
    channelId: string;        // 渠道 ID
    accountId: string;        // 账户 ID
    senderId: string;         // 发送者 ID
    senderName?: string;      // 发送者名称
    text: string;             // 消息文本
    chatType: 'direct' | 'group';  // 聊天类型
    groupId?: string;         // 群组 ID（群聊）
    groupName?: string;       // 群组名称
    threadId?: string;        // 线程 ID
    messageId?: string;       // 消息 ID
    replyToMessageId?: string; // 回复的消息 ID
    media?: any[];            // 媒体附件
    raw?: any;                // 原始数据
}
```

### Gateway 上下文

```typescript
interface ChannelGatewayContext<ResolvedAccount = any> {
    accountId: string;
    account: ResolvedAccount;
    cfg: any;
    logger: PluginLogger;
    log?: PluginLogger;       // 兼容别名
    runtime?: {
        log?: (...args: any[]) => void;
        error?: (...args: any[]) => void;
        warn?: (...args: any[]) => void;
        platform: string;
    };
    abortSignal?: AbortSignal;
    dispatch: ChannelDispatchFn;  // 消息分发函数
    setStatus: (status: ChannelAccountStatus) => void;
}
```

---

## 扩展开发指南

### 创建消息插件

1. **创建项目结构**

```
my-channel-plugin/
├── package.json
├── openclaw.plugin.json
├── index.ts
└── tsconfig.json
```

2. **package.json 配置**

```json
{
  "name": "my-channel-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "openclaw": {
    "extensions": ["./index.ts"]
  },
  "peerDependencies": {
    "openclaw": ">=2024.0.0"
  }
}
```

3. **插件清单 (openclaw.plugin.json)**

```json
{
  "id": "my-channel",
  "name": "My Channel Plugin",
  "description": "A custom channel plugin",
  "version": "1.0.0",
  "kind": "channel"
}
```

4. **实现插件 (index.ts)**

```typescript
import type { OpenClawPluginApi, ChannelPlugin } from 'openclaw/plugin-sdk';

export default async function register(api: OpenClawPluginApi) {
    const plugin: ChannelPlugin = {
        id: 'my-channel',
        meta: {
            label: 'My Channel',
            description: '自定义消息渠道'
        },
        capabilities: {
            chatTypes: ['direct', 'group'],
            media: true,
            threading: true
        },
        config: {
            listAccountIds: (cfg) => ['default'],
            resolveAccount: (cfg, id) => cfg?.accounts?.[id || 'default'] || {},
            defaultAccountId: () => 'default'
        },
        outbound: {
            deliveryMode: 'gateway',
            sendText: async (ctx) => {
                // 实现发送文本消息
                api.logger.info(`Sending to ${ctx.to}: ${ctx.text}`);
                return { delivered: true };
            }
        },
        gateway: {
            startAccount: async (ctx) => {
                api.logger.info(`Starting account: ${ctx.accountId}`);
                // 启动消息监听
                // 收到消息时调用 ctx.dispatch(message)
            },
            stopAccount: async (ctx) => {
                api.logger.info(`Stopping account: ${ctx.accountId}`);
            }
        }
    };

    api.registerChannel({ plugin });
}
```

### 发布插件

```bash
# 发布到 npm
npm publish --access public

# 在 OpenDesk 中安装
opendesk plugins install my-channel-plugin@latest
```

### 配置插件

在 `~/.opendesk/setting.json` 中配置：

```json
{
  "applications": {
    "channels": {
      "my-channel": {
        "accounts": {
          "default": {
            "token": "your-token",
            "webhookUrl": "https://..."
          }
        }
      }
    }
  }
}
```

---

## 总结

OpenDesk 的插件系统通过以下机制实现了灵活的消息渠道扩展：

1. **标准化安装流程**：通过 npm 安装，自动生成兼容层
2. **动态加载机制**：支持 TypeScript 即时编译，灵活的入口点解析
3. **OpenClaw 兼容**：完整的 SDK Shim，复用现有生态
4. **消息路由架构**：清晰的职责分离，支持会话管理和 AI Agent 集成

开发者可以按照本指南开发自定义消息插件，扩展 OpenDesk 的消息渠道能力。