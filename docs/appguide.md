# OpenDesk 应用开发指南

本文档面向希望在 OpenDesk 平台上开发新应用的开发者，涵盖应用的完整开发流程：从创建应用骨架，到为 Agent 提供工具、开发主界面，以及使用 Worker 执行后台任务。

> **语言选择**：我们推荐使用 **TypeScript** 进行应用开发，以获得更好的类型安全和开发体验。项目构建工具（Electron Vite）同时支持 TypeScript（`.ts`）、JavaScript（`.js`）以及两者混合使用，你可以根据实际情况自由选择。本文档的代码示例以 TypeScript 为主。

---

## 目录

1. [应用的基本概念](#1-应用的基本概念)
2. [创建一个新应用](#2-创建一个新应用)
3. [为 Agent 提供工具](#3-为-agent-提供工具)
4. [开发终端字符界面](#4-开发终端字符界面)
5. [开发应用主界面](#5-开发应用主界面)
6. [使用 Worker 执行后台任务](#6-使用-worker-执行后台任务)
7. [注册应用](#7-注册应用)
8. [完整示例](#8-完整示例)

---

## 1. 应用的基本概念

OpenDesk 中的每个功能模块都以"应用（Application）"的形式组织。每个应用由以下几个核心部分组成：

| 部分 | 文件 | 说明 |
|------|------|------|
| **应用类** | `app.ts` | 应用的核心，继承 `BaseApplication`，声明应用元数据、工具集和 Worker |
| **Worker 类** | `worker.ts` | 可选，继承 `BaseWorker`，在独立线程中执行耗时的后台任务 |
| **渲染入口** | `renderer/entry.ts` | 可选，定义应用主界面的 Web Component，显示在应用面板中 |
| **应用图标** | `resources/renderer/applications/<bundleName>/icon.png` | 在侧边栏中展示的应用图标 |

这几个部分相互独立、按需组合：如果你的应用只需要提供工具而不需要界面，可以不创建渲染入口；如果所有操作都很轻量、无需后台线程，可以不创建 Worker。

应用目录的典型结构如下：

```
src/main/applications/<bundleName>/
├── app.ts               # 应用类（必须）
├── common.ts            # 可选：共享的数据类型、Zod Schema
├── worker.ts            # 可选：Worker 类
├── tools.ts             # 可选：复杂工具逻辑的独立文件
└── renderer/
    ├── entry.ts         # 可选：渲染入口，定义 Web Component
    └── ...              # 其他 UI 子组件

resources/renderer/applications/<bundleName>/
└── icon.png             # 应用图标（建议 128×128px 或更高分辨率）
```

---

## 2. 创建一个新应用

### 2.1 创建应用类

应用类是整个应用的"控制中心"，负责声明应用的基本信息、关联 Worker、定义配置项，以及向 Agent 暴露工具。所有应用类都必须继承 `BaseApplication`，并在构造函数中传入 `bundleName`（全局唯一的字符串标识）和显示名称。

在 `src/main/applications/<bundleName>/app.ts` 中创建应用类：

```typescript
// src/main/applications/myapp/app.ts
import { BaseApplication } from "../base.js";
import { BaseToolset } from "../../aikernel/tool";
import { z } from 'zod';
import MyAppWorker from "./worker";

// 在 app.ts 中直接定义配置 Schema，也可以提取到 common.ts 中
const MyAppConfigSchema = z.object({
    enabled: z.boolean().describe('启用此应用').default(true),
    api_key: z.string().describe('API 密钥').default(''),
});

export class MyAppApplication extends BaseApplication {
    constructor() {
        // 第一个参数是 bundleName（唯一标识，建议只含小写字母、数字和连字符）
        // 第二个参数是显示在侧边栏和标题栏的应用名称
        super('myapp', '我的应用');
    }

    /**
     * 返回应用使用的 Worker 类。
     * 框架会自动在独立线程中实例化并管理此 Worker。
     * 如果应用不需要后台任务，可以省略此方法（默认返回 undefined）。
     */
    static getWorkerClass() {
        return MyAppWorker;
    }

    /**
     * 返回应用的配置 Schema（使用 Zod 定义）。
     * 框架会根据此 Schema 自动在"设置"界面中生成对应的配置表单。
     * 如果应用不需要用户配置，可以省略此方法（默认返回空对象 Schema）。
     */
    static getConfigSchema(): z.ZodObject<any> {
        return MyAppConfigSchema;
    }

    /**
     * 配置项发生变化时，框架会自动调用此方法。
     * 可在此处响应配置变更，例如重新加载连接、刷新缓存等。
     */
    async onConfigChanged(): Promise<void> {
        const config = this.getConfig() as z.output<typeof MyAppConfigSchema>;
        console.info('配置已更新:', config);
        // 例如：根据新的 api_key 重新初始化客户端
    }

    /**
     * 返回应用为 Agent 提供的工具集列表。详见第 3 节。
     */
    async getToolsets(): Promise<BaseToolset[]> {
        return [];
    }
}
```

### 2.2 `BaseApplication` 的可用方法

在应用类的任何方法中，都可以使用以下由基类提供的方法：

| 方法 | 说明 |
|------|------|
| `this.getConfig()` | 获取当前应用的配置（已解析为 JS 对象，类型由 `getConfigSchema()` 决定） |
| `await this.getDataDirectory()` | 获取应用专属的数据目录路径（`apps/<bundleName>/`），若目录不存在则自动创建 |
| `await this.callWorker(methodName, ...args)` | 调用 Worker 线程中的方法，支持任意参数和返回值 |
| `this.getProtocolHandlers()` | 覆写此方法以注册自定义 URL 协议（如 `myapp://`），用于在渲染进程中安全加载应用内资源 |
| `this.sendEventToSubscribers(eventName, ...args)` | 向所有订阅了指定事件的渲染进程帧广播消息 |

### 2.3 添加应用图标

侧边栏会根据 `bundleName` 自动查找并加载对应的图标文件。请在以下路径放置一张 PNG 格式的图标：

```
resources/renderer/applications/myapp/icon.png
```

---

## 3. 为 Agent 提供工具

OpenDesk 内置的 Agent 可以调用应用注册的"工具（Tool）"来感知界面状态或执行操作。工具分为两类，分别在不同的进程中运行：

- **主进程工具（`BaseTool` + `BaseToolset`）**：运行在主进程，在 `app.ts` 的 `getToolsets()` 方法中注册。适合调用 Node.js API、访问文件系统、发起网络请求，以及代理调用 Worker 中的逻辑。
- **渲染进程工具（`RendererTool` + `RendererToolset`）**：运行在渲染进程（浏览器环境），在 `renderer/entry.ts` 的 `getToolset()` 方法中注册。可以直接读取组件内部状态、操作 DOM，反映当前界面的实时情况。

### 3.1 主进程工具

每个工具（`BaseTool`）由三部分构成：工具名称、对功能的自然语言描述（Agent 依据此描述判断何时调用此工具）、以及用 Zod 定义的参数 Schema。定义好工具后，使用 `setExecutor()` 设置其执行逻辑，最后将工具加入工具集（`BaseToolset`）。

多个工具集可以同时返回，每个工具集对应应用的一个功能分组。

```typescript
// src/main/applications/myapp/app.ts
import { BaseApplication } from "../base.js";
import { BaseTool, BaseToolset } from "../../aikernel/tool";
import { z } from 'zod';

export class MyAppApplication extends BaseApplication {
    constructor() {
        super('myapp', '我的应用');
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('myapp');

        // 定义一个工具：根据关键词查询数据
        // 工具名称建议使用小驼峰命名，工具描述应清晰说明工具的作用和适用场景
        const queryTool = new BaseTool(
            'queryData',
            '根据给定的关键词查询相关数据，返回匹配的数据列表',
            z.object({
                keyword: z.string().describe('查询关键词'),
                limit: z.number().optional().describe('返回结果的最大数量').default(10),
            })
        );

        // setExecutor 接收一个异步函数，参数为经过 Zod 验证的入参对象，返回值为字符串
        // 如果需要返回结构化数据，请先序列化为 JSON 字符串
        queryTool.setExecutor(async (args) => {
            // 耗时操作应交给 Worker 执行，在此通过 callWorker 代理调用
            const result = await this.callWorker('doQuery', args.keyword, args.limit);
            return JSON.stringify(result);
        });

        toolset.addTool(queryTool);
        return [toolset];
    }
}
```

**工具执行器的两种形式：**

当工具需要流式地逐步输出结果（例如实时进度反馈），可以使用 `setUniversalExecutor()` 替代 `setExecutor()`。通用执行器接收一个 `ToolResult` 对象，可以多次调用 `result.attachResult()` 追加内容，Agent 会实时看到更新。

```typescript
// 流式输出示例：通过 attachResult 逐步追加结果内容
streamTool.setUniversalExecutor(async (args, result) => {
    result.attachResult('开始处理...\n');
    for await (const chunk of someAsyncGenerator(args)) {
        result.attachResult(chunk);
    }
    // 无需手动设置 status，框架会在执行器返回后自动标记为 success
});
```

### 3.2 渲染进程工具

渲染进程工具的定义方式与主进程工具类似，区别在于：使用 `RendererTool` 和 `RendererToolset` 类，并且定义在 `renderer/entry.ts` 入口组件的 `getToolset()` 方法中，而非 `app.ts`。

由于 `getToolset()` 在每次 Agent 发起对话时都会被调用，工具可以动态地反映组件当前的状态（例如：当页面上有数据时才注册读取数据的工具）。

同时，建议覆写 `getAgentInstruct()` 方法，返回一段描述当前界面和 Agent 角色的说明文字，帮助 Agent 更好地理解上下文。

```typescript
// src/main/applications/myapp/renderer/entry.ts
import { AgentOperableHTMLElement, RendererTool, RendererToolset } from '../../widget_utils.js';
import { z } from 'zod';

class MyAppEntryWidget extends AgentOperableHTMLElement {
    private currentData: object[] = [];
    private selectedIndex: number = 0;

    /**
     * 向 Agent 说明当前界面的背景信息和 Agent 的角色定位。
     * Agent 会将此文字加入系统提示，以便更好地理解对话上下文。
     */
    getAgentInstruct(): string {
        return '你是我的应用助手，帮助用户查看和分析当前页面的数据。';
    }

    /**
     * 返回渲染进程工具集。
     * 此方法在每次 Agent 发起对话时都会被调用，因此工具内容可以反映最新的界面状态。
     */
    getToolset(): RendererToolset {
        const toolset = new RendererToolset('myapp');

        // 只有在页面有数据时才注册读取数据的工具，避免 Agent 调用到空工具
        if (this.currentData.length > 0) {
            const getDataTool = new RendererTool(
                'getCurrentData',
                '获取当前页面展示的数据列表',
                z.object({})
            );
            // 执行器可以直接访问组件实例的属性和方法
            getDataTool.setExecutor(async () => {
                return JSON.stringify(this.currentData);
            });
            toolset.addTool(getDataTool);
        }

        // 注册一个可以操作界面的工具
        const selectItemTool = new RendererTool(
            'selectItem',
            '选中指定索引的数据项，使其在详情区域高亮显示',
            z.object({
                index: z.number().describe('要选中的数据项索引（从 0 开始）'),
            })
        );
        selectItemTool.setExecutor(async (args) => {
            this.selectedIndex = args.index;
            this.render();
            return `已选中第 ${args.index + 1} 项`;
        });
        toolset.addTool(selectItemTool);

        return toolset;
    }

    // ... 界面实现代码（详见第 4 节）
}

customElements.define('myapp-entry-widget', MyAppEntryWidget);
```

---

## 4. 开发终端字符界面

OpenDesk 支持在终端中以 TUI（Text User Interface，文本用户界面）模式运行。应用可以通过覆写 `getCliSlashCommands()` 方法，为 CLI（Command-Line Interface，命令行界面）模式注册自定义的斜杠命令。这使得用户可以在终端中通过 `/命令名` 的形式快速调用应用的功能。

### 4.1 基本用法

在应用类中覆写 `getCliSlashCommands()` 方法，返回一个 `SlashCommandHandler` 数组：

```typescript
// src/main/applications/myapp/app.ts
import { BaseApplication } from "../base.js";
import type { SlashCommandHandler } from "../../tui/commands.js";

export class MyAppApplication extends BaseApplication {
    constructor() {
        super('myapp', '我的应用');
    }

    /**
     * 返回应用提供的 CLI 斜杠命令
     * @param tui TUI 实例，用于显示 overlay 等
     */
    getCliSlashCommands(tui: any): SlashCommandHandler[] {
        return [
            {
                name: 'myapp',           // 命令名称（用户输入 /myapp 来调用）
                description: '打开我的应用', // 在帮助中显示的描述
                execute: async (args: string) => {
                    // 命令执行逻辑
                    console.log(`执行 myapp 命令，参数: ${args}`);
                    // 可以调用 Worker 方法
                    await this.callWorker('doSomething', args);
                },
            },
        ];
    }
}
```

### 4.2 命令处理器字段说明

`SlashCommandHandler` 接口包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 命令名称（不含 `/` 前缀） |
| `description` | `string` | 是 | 命令描述，显示在帮助列表中 |
| `execute` | `(args: string) => void \| Promise<void>` | 是 | 命令执行函数，`args` 为用户输入的参数 |
| `shortcut` | `KeyId` | 否 | 快捷键，如 `Key.ctrl('m')` |
| `getArgumentCompletions` | `(argPrefix: string) => AutocompleteItem[] \| null` | 否 | 参数自动补全函数 |

### 4.3 完整示例：带参数补全的命令

以下示例展示了一个带参数自动补全功能的命令：

```typescript
// src/main/applications/myapp/app.ts
import { BaseApplication } from "../base.js";
import type { SlashCommandHandler } from "../../tui/commands.js";
import { Key } from "@mariozechner/pi-tui";

export class MyAppApplication extends BaseApplication {
    constructor() {
        super('myapp', '我的应用');
    }

    getCliSlashCommands(tui: any): SlashCommandHandler[] {
        return [
            {
                name: 'myapp',
                description: '管理我的应用，用法: /myapp [list|add|remove]',
                shortcut: Key.ctrl('m'), // 可选：绑定快捷键
                getArgumentCompletions: (argPrefix: string) => {
                    const options = ['list', 'add', 'remove'];
                    return options
                        .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                        .map(opt => ({
                            value: opt,
                            label: opt,
                            description: opt === 'list' ? '列出所有项目' :
                                         opt === 'add' ? '添加新项目' : '移除项目'
                        }));
                },
                execute: async (args: string) => {
                    const subCommand = args.trim().split(/\s+/)[0];
                    switch (subCommand) {
                        case 'list':
                            await this.callWorker('listItems');
                            break;
                        case 'add':
                            await this.callWorker('addItem', args.trim().split(/\s+/).slice(1).join(' '));
                            break;
                        case 'remove':
                            await this.callWorker('removeItem', args.trim().split(/\s+/)[1]);
                            break;
                        default:
                            console.log('用法: /myapp [list|add|remove]');
                    }
                },
            },
        ];
    }
}
```

### 4.4 实际案例：邮箱应用的 `/mail` 命令

邮箱应用通过此机制注册了 `/mail` 命令，用户输入 `/mail` 即可打开邮箱界面：

```javascript
// src/main/applications/mailbox/app.js
import { BaseApplication } from "../base";
import { MailOverlay } from "./tui.js";
import { logger } from "../../utils/logger.js";

class MailboxApplication extends BaseApplication {
    constructor() {
        super('mailbox', '邮箱');
    }

    getCliSlashCommands(tui) {
        return [
            {
                name: 'mail',
                description: '打开邮箱',
                execute: async () => {
                    try {
                        const mailOverlay = new MailOverlay(tui);
                        await mailOverlay.show();
                    } catch (err) {
                        logger.error(`打开邮箱失败: ${err}`);
                    }
                },
            },
        ];
    }
}
```

### 4.5 命令重复检测

如果多个应用注册了同名命令，系统会在启动时发出警告，并保留先注册的命令。命令的 `source` 字段会自动设置为应用名称，便于追踪：

```
[SlashCommandRegistry] 命令 "/mail" 已被 "邮箱" 注册，忽略来自 "其他应用" 的重复注册
```

---

## 5. 开发应用主界面

### 5.1 入口 Web Component

应用的主界面通过一个自定义 HTML 元素（Web Component）来实现。框架在打开应用时，会动态加载 `renderer/entry.ts`，并将其中定义的 `<bundleName>-entry-widget` 元素挂载到应用容器中。

编写界面时，需要：
1. 创建一个类，继承 `AgentOperableHTMLElement`（它已继承自标准 `HTMLElement`）
2. 在 `connectedCallback()` 生命周期方法中初始化界面和数据加载
3. 在 `disconnectedCallback()` 中清理所有定时器、事件订阅等，防止内存泄漏
4. 在文件末尾通过 `customElements.define('<bundleName>-entry-widget', ClassName)` 完成注册

界面使用 **Tailwind CSS** 构建，所有样式类均可直接使用。

```typescript
// src/main/applications/myapp/renderer/entry.ts
import { AgentOperableHTMLElement } from '../../widget_utils.js';

class MyAppEntryWidget extends AgentOperableHTMLElement {
    private reloadInterval: ReturnType<typeof setInterval> | null = null;

    // 元素插入 DOM 时自动调用，适合在此处初始化界面并开始加载数据
    connectedCallback() {
        this.render();
        this.loadData();
        // 如有需要，可设置定时刷新
        this.reloadInterval = setInterval(() => this.loadData(), 5000);
    }

    // 元素从 DOM 移除时自动调用，务必在此处清理所有副作用
    disconnectedCallback() {
        if (this.reloadInterval !== null) {
            clearInterval(this.reloadInterval);
            this.reloadInterval = null;
        }
    }

    // 渲染界面骨架。建议将静态结构写在 render() 中，动态数据由独立方法填充
    render() {
        this.innerHTML = `
        <div class="w-full h-full flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100">
            <!-- 顶部标题栏 -->
            <header class="pl-6 pr-16 py-4 flex items-center justify-between border-b border-gray-200 bg-white/80 backdrop-blur">
                <div>
                    <p class="text-xs uppercase tracking-wide text-gray-400">My App</p>
                    <h1 class="text-xl font-semibold text-gray-800">我的应用</h1>
                </div>
                <button id="refresh-btn" class="px-4 py-2 rounded-full bg-blue-600 text-white text-sm hover:bg-blue-700 transition">
                    刷新
                </button>
            </header>

            <!-- 主内容区 -->
            <div class="flex-1 p-4 overflow-auto">
                <div id="content" class="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
                    加载中...
                </div>
            </div>
        </div>
        `;

        // 在 render() 末尾绑定静态元素的事件监听器
        this.querySelector('#refresh-btn')!.addEventListener('click', () => this.loadData());
    }

    async loadData() {
        try {
            // 通过 applicationAPI 调用 Worker 中的方法获取数据
            const data = await window.applicationAPI.call('fetchData');
            this.querySelector('#content')!.innerHTML =
                `<pre class="text-sm">${JSON.stringify(data, null, 2)}</pre>`;
        } catch (error: any) {
            this.querySelector('#content')!.textContent = `加载失败: ${error.message}`;
        }
    }
}

customElements.define('myapp-entry-widget', MyAppEntryWidget);
```

### 5.2 渲染进程 API（`window.applicationAPI`）

在 `renderer/entry.ts` 中，可通过 `window.applicationAPI` 与主进程通信。这是渲染进程与后端逻辑交互的唯一入口，所有调用都经过 Electron 的 IPC 安全通道。

| 方法 | 说明 |
|------|------|
| `await window.applicationAPI.call(methodName, ...args)` | 调用当前应用 **Worker** 的方法，等待结果返回 |
| `await window.applicationAPI.callMainWorld(methodName, ...args)` | 调用当前应用**主进程实例**（`app.ts`）的方法，适合调用非耗时的主进程逻辑 |
| `window.applicationAPI.streamCall(methodName, ...args)` | 流式调用 Worker 方法，返回 `AsyncGenerator`，可使用 `for await...of` 逐步消费结果 |
| `window.applicationAPI.subscribe(eventName, callback)` | 订阅来自 Worker 的事件，`callback` 将在事件触发时被调用 |
| `window.applicationAPI.unsubscribe(eventName, callback)` | 取消事件订阅，建议在 `disconnectedCallback` 中调用，防止内存泄漏 |

### 5.3 样式规范

界面使用 **Tailwind CSS** 构建，已在项目中全局配置，无需额外导入。建议遵循以下视觉规范，与其他应用保持一致的风格：

- **背景**：主背景使用 `bg-gradient-to-br from-slate-50 via-white to-slate-100`
- **圆角**：大面积卡片使用 `rounded-3xl`，小元素使用 `rounded-2xl` 或 `rounded-xl`
- **卡片**：使用 `bg-white shadow-sm border border-gray-100` 或 `border border-[#F0F0F2]`
- **顶部 Header**：使用 `bg-white/80 backdrop-blur` 实现毛玻璃效果
- **文字颜色**：主标题用 `text-gray-800`，正文用 `text-gray-700`，次要信息用 `text-[#86868B]`

### 5.4 订阅 Worker 事件

当 Worker 中的后台任务产生数据更新时，不应由前端轮询，而应由 Worker 主动通过 `emitEvent()` 推送事件，前端订阅后实时更新界面。

在 `connectedCallback` 中订阅事件时，需要保存回调函数的引用，以便在 `disconnectedCallback` 中精确取消订阅。

```typescript
// renderer/entry.ts

private _onDataUpdated: ((newData: object[]) => void) | null = null;

connectedCallback() {
    this.render();

    // 保存回调函数引用，以便后续取消订阅
    this._onDataUpdated = (newData: object[]) => {
        this.currentData = newData;
        this.renderList();
    };
    window.applicationAPI.subscribe('dataUpdated', this._onDataUpdated);
}

disconnectedCallback() {
    // 组件销毁时必须取消订阅，否则会产生内存泄漏和重复回调
    if (this._onDataUpdated) {
        window.applicationAPI.unsubscribe('dataUpdated', this._onDataUpdated);
        this._onDataUpdated = null;
    }
}
```

---

## 6. 使用 Worker 执行后台任务

### 6.1 何时需要 Worker

Worker 运行在独立的 Node.js 线程中，与主进程完全隔离。当你的应用需要执行以下类型的操作时，应当将其放入 Worker 而不是直接在主进程中运行：

- 文件系统扫描、批量读写
- 数据库查询和索引构建
- 网络请求、邮件同步等 I/O 密集型任务
- 任何可能耗时超过几十毫秒、会阻塞主进程响应的操作

所有应用共用同一个 Worker 线程，框架负责按 `bundleName` 将消息路由到对应应用的 Worker 实例。

### 6.2 创建 Worker 类

Worker 类必须继承 `BaseWorker`。框架在 Worker 线程启动后，会自动创建每个应用的 Worker 实例并调用其 `initialize()` 方法。Worker 实例拥有 `appDataDirectory` 属性，指向该应用专属的数据目录，适合在此存储本地数据库文件或缓存。

Worker 类中定义的所有公开的 `async` 方法，都可以从主进程（通过 `this.callWorker()`）或渲染进程（通过 `window.applicationAPI.call()`）调用。

```typescript
// src/main/applications/myapp/worker.ts
import { BaseWorker } from "../base.js";
import { logger } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';

export default class MyAppWorker extends BaseWorker {

    private data: object[] = [];

    /**
     * Worker 初始化入口，在线程启动后自动调用。
     * 适合在此处建立数据库连接、读取本地缓存、启动后台监听等。
     * initialize() 中的异常会被框架捕获并记录，不会导致线程崩溃。
     */
    async initialize(): Promise<void> {
        logger.info('MyAppWorker 正在初始化...');
        const dataFile = path.join(this.appDataDirectory, 'data.json');
        if (fs.existsSync(dataFile)) {
            this.data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
        }
        logger.info(`MyAppWorker 初始化完成，已加载 ${this.data.length} 条数据`);
    }

    /**
     * 应用配置发生变化时，框架会自动调用此方法（与主进程的 onConfigChanged 同步触发）。
     * 如需根据新配置重新初始化某些资源，在此处理。
     */
    async applicationConfigChanged(config: object): Promise<void> {
        await super.applicationConfigChanged(config);
        // 例如：根据新配置重新建立网络连接
        // await this.reconnect((config as any).server_url);
    }

    /**
     * 供主进程或渲染进程调用的公开方法。
     * 方法名称即为 callWorker / applicationAPI.call 的第一个参数。
     */
    async fetchData(): Promise<object[]> {
        return this.data;
    }

    async searchItems(keyword: string): Promise<object[]> {
        return this.data.filter((item: any) =>
            JSON.stringify(item).includes(keyword)
        );
    }

    /**
     * 对于可能被并发调用、但需要串行执行的任务，使用 runSequentially() 包装。
     * 这会将任务加入内部队列，确保同一时刻只有一个任务在执行，避免数据竞争。
     */
    async processLargeTask(): Promise<string> {
        return await this.runSequentially(async () => {
            logger.info('开始执行大型任务...');
            await new Promise(resolve => setTimeout(resolve, 1000)); // 模拟耗时
            return 'done';
        });
    }

    /**
     * 流式方法：使用 async generator 逐步产生结果。
     * 渲染进程通过 window.applicationAPI.streamCall('streamResults', query) 调用，
     * 使用 for await...of 逐条消费。
     */
    async *streamResults(query: string): AsyncGenerator<object> {
        for (let i = 0; i < 10; i++) {
            yield { index: i, content: `第 ${i + 1} 条与 "${query}" 相关的结果` };
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
}
```

### 6.3 在 `app.ts` 中关联 Worker

在应用类中通过 `static getWorkerClass()` 返回 Worker 类，框架会自动处理后续的实例化和生命周期管理。工具执行器中可以通过 `this.callWorker()` 代理调用 Worker 的方法：

```typescript
// src/main/applications/myapp/app.ts
import MyAppWorker from "./worker";

export class MyAppApplication extends BaseApplication {

    // 告知框架此应用使用哪个 Worker 类
    static getWorkerClass() {
        return MyAppWorker;
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('myapp');

        const searchTool = new BaseTool(
            'searchItems',
            '在应用数据中搜索匹配的条目',
            z.object({ keyword: z.string().describe('搜索关键词') })
        );
        // 工具执行器通过 callWorker 将实际工作委托给 Worker 线程执行
        searchTool.setExecutor(async (args) => {
            const result = await this.callWorker('searchItems', args.keyword);
            return JSON.stringify(result);
        });

        toolset.addTool(searchTool);
        return [toolset];
    }
}
```

### 6.4 从渲染进程调用 Worker

渲染进程中可以直接通过 `window.applicationAPI` 调用当前应用 Worker 的方法，与工具执行器中的 `callWorker()` 本质相同，但前者可在组件的任意方法中使用：

```typescript
// renderer/entry.ts

async loadData() {
    // 普通调用：等待 Worker 返回完整结果
    const items = await window.applicationAPI.call('fetchData');
    this.renderList(items);
}

async streamSearch(query: string) {
    // 流式调用：使用 for await...of 逐步消费 Worker 产生的结果
    const resultContainer = this.querySelector('#results')!;
    resultContainer.innerHTML = '';

    for await (const chunk of window.applicationAPI.streamCall('streamResults', query)) {
        const div = document.createElement('div');
        div.textContent = JSON.stringify(chunk);
        resultContainer.appendChild(div);
    }
}
```

### 6.5 从 Worker 主动推送事件到渲染进程

Worker 中的方法执行完毕后，可以通过 `this.emitEvent()` 向所有订阅了该事件的渲染进程帧推送消息。这是实现"后台任务完成后自动刷新界面"的标准方式。

在 Worker 中，调用 `emitEvent(eventName, ...args)` 发送事件，第一个参数是事件名，后续参数会被原样传递给订阅者的回调函数：

```typescript
// worker.ts

async syncData(): Promise<void> {
    logger.info('开始同步数据...');
    const newData = await this.fetchRemoteData();
    this.data = newData;

    // 数据同步完成后，通知所有打开的界面刷新
    await this.emitEvent('dataUpdated', newData);
    logger.info('数据同步完成，已通知界面刷新');
}
```

渲染进程在 `connectedCallback` 中订阅同名事件，并在 `disconnectedCallback` 中取消（参见 [4.4 节](#44-订阅-worker-事件)）。

### 6.6 Worker 开发注意事项

- Worker 运行在独立的 Node.js 线程中，**无法访问** `window`、`document`、`localStorage` 等浏览器 API
- Worker 中可以使用全部 Node.js 内置模块（`fs`、`path`、`net`、`crypto` 等）以及通过 npm 安装的第三方包
- Worker 中应使用项目的 `logger` 工具记录日志，而非直接使用 `console`：`import { logger } from '../../utils/logger.js'`
- 对于需要串行执行的操作（如多步文件写入），使用 `this.runSequentially(task)` 包装，避免并发造成的数据损坏

---

## 7. 注册应用

OpenDesk 支持两种运行平台，每个平台维护各自独立的应用注册列表：

| 平台 | 文件 | 说明 |
|------|------|------|
| **Electron 图形界面** | `src/platforms/electron.ts` | 基于 Electron 运行的完整桌面客户端，支持图形界面 |
| **CLI 命令行** | `src/platforms/cli.ts` | 基于终端运行的纯命令行模式，不渲染任何界面 |

所有需要在 OpenDesk 中运行的应用，都必须在对应平台的配置文件中注册。注册时，框架会在启动时实例化应用类，并将其加入全局的应用注册表。

### 7.1 选择注册到哪个平台

在注册前，先根据应用的特性判断它应当注册到哪些平台：

**同时注册到两个平台**（最常见）：适合提供 Agent 工具的应用，例如邮件、文件管理、日历等。这类应用的核心价值是工具（Tool），在 CLI 和图形界面下均可正常工作。即使应用有界面（`renderer/entry.ts`），在 CLI 平台上运行时界面部分会被忽略，工具依然可用。

**仅注册到 Electron 平台**：适合强依赖图形渲染、在无界面环境下没有实际意义的应用，例如 PPT 生成器、图形设计工具等。

**仅注册到 CLI 平台**：目前较少见，适合专为终端场景设计、不需要图形界面的应用。

### 7.2 在 Electron 平台注册

打开 `src/platforms/electron.ts`，将新应用的类导入，然后在 `getApplicationClasses()` 方法的返回数组中追加：

```typescript
// src/platforms/electron.ts
import { MyAppApplication } from "../main/applications/myapp/app.js";

export class ElectronPlatform extends AbstractPlatform {
    getApplicationClasses(): typeof BaseApplication[] {
        return [
            // ... 现有应用 ...
            MyAppApplication,  // 在此追加新应用
        ];
    }
}
```

注册完成后，重新构建并运行项目，新应用的图标即会出现在侧边栏中。

### 7.3 在 CLI 平台注册

如果应用也需要在命令行模式下提供工具，同样打开 `src/platforms/cli.ts`，以相同方式导入并追加：

```typescript
// src/platforms/cli.ts
import { MyAppApplication } from "../main/applications/myapp/app.js";

export class CliPlatform extends AbstractPlatform {
    getApplicationClasses(): typeof BaseApplication[] {
        return [
            // ... 现有应用 ...
            MyAppApplication,  // 在此追加新应用
        ];
    }
}
```

> **注意**：CLI 平台不会渲染任何界面，即使应用定义了 `renderer/entry.ts`，在 CLI 模式下也不会被加载。但应用通过 `getToolsets()` 注册的主进程工具以及 Worker 逻辑均会正常运行。

---

## 8. 完整示例

以下是一个简单的"笔记"应用的完整 TypeScript 实现，综合展示了以上各节的核心概念。该应用支持新建笔记、列表展示、关键词搜索，并向 Agent 提供工具以便通过对话管理笔记。

### 目录结构

```
src/main/applications/notes/
├── app.ts
├── worker.ts
└── renderer/
    └── entry.ts

resources/renderer/applications/notes/
└── icon.png
```

### `app.ts` — 应用类

应用类是整个应用的入口，负责关联 Worker 并向 Agent 注册工具。工具的具体执行逻辑通过 `callWorker()` 委托给 Worker 线程。

```typescript
// src/main/applications/notes/app.ts
import { BaseApplication } from "../base.js";
import { BaseTool, BaseToolset } from "../../aikernel/tool";
import { z } from 'zod';
import NotesWorker from "./worker";

export class NotesApplication extends BaseApplication {
    constructor() {
        super('notes', '笔记');
    }

    static getWorkerClass() {
        return NotesWorker;
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('notes');

        // 工具一：搜索笔记
        const searchTool = new BaseTool(
            'searchNotes',
            '根据关键词搜索已有的笔记，返回匹配的笔记列表',
            z.object({ keyword: z.string().describe('搜索关键词') })
        );
        searchTool.setExecutor(async (args) => {
            const results = await this.callWorker('searchNotes', args.keyword);
            return JSON.stringify(results);
        });

        // 工具二：创建笔记
        const createTool = new BaseTool(
            'createNote',
            '根据提供的标题和内容创建一条新笔记',
            z.object({
                title: z.string().describe('笔记标题'),
                content: z.string().describe('笔记正文内容'),
            })
        );
        createTool.setExecutor(async (args) => {
            await this.callWorker('createNote', args.title, args.content);
            return '笔记已创建';
        });

        toolset.addTools(searchTool, createTool);
        return [toolset];
    }
}
```

### `worker.ts` — Worker 类

Worker 类负责所有涉及文件读写的逻辑。每次笔记数据发生变化后，Worker 通过 `emitEvent()` 通知界面刷新，无需前端轮询。

```typescript
// src/main/applications/notes/worker.ts
import { BaseWorker } from "../base.js";
import { logger } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';

interface Note {
    id: number;
    title: string;
    content: string;
    createdAt: string;
}

export default class NotesWorker extends BaseWorker {

    private notesFile!: string;
    private notes: Note[] = [];

    async initialize(): Promise<void> {
        this.notesFile = path.join(this.appDataDirectory, 'notes.json');
        if (fs.existsSync(this.notesFile)) {
            const raw = fs.readFileSync(this.notesFile, 'utf-8');
            this.notes = JSON.parse(raw);
        }
        logger.info(`NotesWorker 初始化完成，共 ${this.notes.length} 条笔记`);
    }

    async getNotes(): Promise<Note[]> {
        return this.notes;
    }

    async createNote(title: string, content: string): Promise<Note> {
        const note: Note = {
            id: Date.now(),
            title,
            content,
            createdAt: new Date().toISOString(),
        };
        this.notes.unshift(note);
        fs.writeFileSync(this.notesFile, JSON.stringify(this.notes, null, 2));

        // 通知所有打开的界面刷新笔记列表
        await this.emitEvent('notesUpdated', this.notes);
        return note;
    }

    async searchNotes(keyword: string): Promise<Note[]> {
        return this.notes.filter(n =>
            n.title.includes(keyword) || n.content.includes(keyword)
        );
    }
}
```

### `renderer/entry.ts` — 主界面

入口组件负责渲染界面、响应用户操作，并通过事件订阅实时反映 Worker 的数据变化。同时提供渲染进程工具，让 Agent 能够感知当前显示的笔记内容。

```typescript
// src/main/applications/notes/renderer/entry.ts
import { AgentOperableHTMLElement, RendererTool, RendererToolset } from '../../widget_utils.js';
import { z } from 'zod';

interface Note {
    id: number;
    title: string;
    content: string;
    createdAt: string;
}

class NotesEntryWidget extends AgentOperableHTMLElement {
    private notes: Note[] = [];
    private _onNotesUpdated: ((notes: Note[]) => void) | null = null;

    connectedCallback() {
        this.render();
        this.loadNotes();

        // 订阅来自 Worker 的笔记更新事件，实时刷新界面
        this._onNotesUpdated = (notes: Note[]) => {
            this.notes = notes;
            this.renderNoteList();
        };
        window.applicationAPI.subscribe('notesUpdated', this._onNotesUpdated);
    }

    disconnectedCallback() {
        if (this._onNotesUpdated) {
            window.applicationAPI.unsubscribe('notesUpdated', this._onNotesUpdated);
            this._onNotesUpdated = null;
        }
    }

    getAgentInstruct(): string {
        return '你是笔记助手，帮助用户管理、搜索和整理笔记。当前页面展示了用户的所有笔记。';
    }

    getToolset(): RendererToolset {
        const toolset = new RendererToolset('notes');

        // 提供读取当前笔记列表的工具，让 Agent 能感知界面内容
        const listTool = new RendererTool(
            'listCurrentNotes',
            '获取当前界面中显示的所有笔记的标题和摘要',
            z.object({})
        );
        listTool.setExecutor(async () => {
            return JSON.stringify(this.notes.map(n => ({
                id: n.id,
                title: n.title,
                preview: n.content.slice(0, 50),
            })));
        });
        toolset.addTool(listTool);

        return toolset;
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100">
            <header class="pl-6 pr-16 py-4 flex items-center justify-between border-b border-gray-200 bg-white/80 backdrop-blur">
                <div>
                    <p class="text-xs uppercase tracking-wide text-gray-400">Notes</p>
                    <h1 class="text-xl font-semibold text-gray-800">笔记</h1>
                </div>
                <button id="add-btn" class="px-4 py-2 rounded-full bg-blue-600 text-white text-sm hover:bg-blue-700 transition">
                    + 新建笔记
                </button>
            </header>
            <div id="note-list" class="flex-1 p-4 overflow-auto space-y-3">
                <p class="text-center text-gray-400 pt-8">加载中...</p>
            </div>
        </div>
        `;

        this.querySelector('#add-btn')!.addEventListener('click', () => this.handleCreate());
    }

    async loadNotes() {
        this.notes = await window.applicationAPI.call('getNotes');
        this.renderNoteList();
    }

    renderNoteList() {
        const list = this.querySelector('#note-list');
        if (!list) return;

        if (this.notes.length === 0) {
            list.innerHTML = `<p class="text-center text-gray-400 pt-8">暂无笔记，点击右上角新建一条吧</p>`;
            return;
        }

        list.innerHTML = this.notes.map(note => `
            <div class="bg-white rounded-2xl p-4 shadow-sm border border-[#F0F0F2]">
                <h3 class="font-semibold text-gray-800">${note.title}</h3>
                <p class="text-sm text-[#86868B] mt-1 line-clamp-2">${note.content}</p>
                <p class="text-xs text-gray-400 mt-2">${new Date(note.createdAt).toLocaleString()}</p>
            </div>
        `).join('');
    }

    async handleCreate() {
        const title = prompt('请输入笔记标题');
        const content = prompt('请输入笔记内容');
        if (title && content) {
            // Worker 创建笔记后会通过 emitEvent 通知界面，无需手动刷新
            await window.applicationAPI.call('createNote', title, content);
        }
    }
}

customElements.define('notes-entry-widget', NotesEntryWidget);
```

### 注册应用

笔记应用有图形界面，但其核心工具（搜索、创建笔记）在命令行模式下同样有意义，因此应同时注册到两个平台。

在 `src/platforms/electron.ts` 中导入并追加：

```typescript
// src/platforms/electron.ts
import { NotesApplication } from "../main/applications/notes/app.js";

// 在 getApplicationClasses() 的返回数组中追加：
NotesApplication,
```

在 `src/platforms/cli.ts` 中同样导入并追加：

```typescript
// src/platforms/cli.ts
import { NotesApplication } from "../main/applications/notes/app.js";

// 在 getApplicationClasses() 的返回数组中追加：
NotesApplication,
```

重新运行 `npm run dev`，笔记应用即会出现在侧边栏中；在 CLI 模式下，Agent 也可以通过工具调用来搜索和创建笔记。

---

## 附录：常见问题

**Q: `bundleName` 有什么命名要求？**

`bundleName` 是应用在整个平台内的唯一标识，建议只使用小写字母、数字和连字符（例如 `my-app`）。以下所有位置的命名必须与 `bundleName` 严格一致：
- Web Component 注册名：`<bundleName>-entry-widget`
- 图标资源目录：`resources/renderer/applications/<bundleName>/`
- Worker 中的 `super(bundleName, ...)` 调用

**Q: 如果我的应用只需要提供工具，不需要界面，怎么做？**

无需创建 `renderer/` 目录和 `entry.ts`。只需在 `app.ts` 的 `getToolsets()` 中返回工具集即可。Agent 在任何场景下都可以调用这些工具，不受界面是否打开的影响。

**Q: Worker 方法可以直接从渲染进程调用吗？**

可以，使用 `window.applicationAPI.call('methodName', ...args)` 即可直接调用当前应用 Worker 的公开方法，与在 `app.ts` 中使用 `this.callWorker()` 的效果相同。

**Q: 如何在 `app.ts`（主进程）中执行轻量操作而不经过 Worker？**

在 `app.ts` 中实现普通的公开方法，渲染进程通过 `window.applicationAPI.callMainWorld('methodName', ...args)` 调用。这些方法运行在主进程中，可以使用 Node.js API，但不应执行耗时操作——耗时操作请交给 Worker 处理。

**Q: 能否同时使用 TypeScript 和 JavaScript 开发同一个应用？**

可以，项目构建工具支持 `.ts` 和 `.js` 文件混合使用。例如，你可以用 TypeScript 编写 `app.ts` 和 `worker.ts` 以享受类型检查，同时用 JavaScript 编写 `renderer/entry.js`（渲染进程对类型系统的依赖相对较少）。
