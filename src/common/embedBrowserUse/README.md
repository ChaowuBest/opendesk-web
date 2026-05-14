# Opendesk EmbedBrowserUse Kit

可复用的嵌入式浏览器控制库，为 Electron 应用提供完整的浏览器实例管理和 Agent 自动化操作能力。适用于Electron Agent应用开发者。

如果你不希望使用系统的浏览器，而是希望为你的Agent开发在Electron应用中嵌入的浏览器实例，且能够让Agent通过类似Playwright的标准化接口直接控制它，那么 _Opendesk EmbedBrowser Use Kit_ 将是一个很好的选项。

## 架构图

```
┌──────────────────────────────── embedBrowserUse ────────────────────────────────┐
│                                                                                 │
│  ┌─ renderer.ts (Renderer) ──────────────────────────────────────────────────┐  │
│  │ BrowserInstance (abstract)                                                │  │
│  │   navigateTo / goBack / goForward / refresh / goHome                      │  │
│  │   getState / getCurrentUrl / executeJavaScript                            │  │
│  │   listTabs / addTab / closeTab / switchToTab                              │  │
│  │   getWebContentsId / capturePage / destroy                                │  │
│  │   register(bridgeAPI) → 向主进程注册自己                                    │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│  ┌─ preload.ts (Preload) ────────────────────────────────────────────────────┐  │
│  │ defineBrowserBridge(apiName, contextBridge, ipcRenderer)                  │  │
│  │   → window[apiName] 上暴露 IPC 方法                                         │  │
│  │   → _registerInstance / _unregisterInstance 供 BrowserInstance 调用        │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│  ┌─ main.ts (Main Process) ────────────────────────────────────────────────-┐   │
│  │ BrowserManager (singleton)                                               │   │
│  │   bind(ipcMain) → 注册所有 IPC handler                                    │   │
│  │   getOrCreateController(id) / getController(id) / removeController(id)   │   │
│  │   initSession / persistSessionCookies                                    │   │
│  │ ───────────────────────────────────────────────────────────────────────- │   │
│  │ BrowserController (per-instance)                                         │   │
│  │   navigate / click / type / hover / pressKey / scroll / selectOption     │   │
│  │   snapshot / evaluate / waitFor / tabs / goBack / goForward / reload     │   │
│  │   requireCDP / readPageInfo / readPageState / waitForClickCompletion     │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│  ┌─ protocol.ts (跨进程共享) ────────────────────────────────────────────────┐   │
│  │ Channels: IPC channel 名称常量 (embedBrowser:navigate, ...)           ─   │   │
│  │ Types: BrowserState / TabInfo / PageSnapshot / BrowserBridgeAPI / ...    │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│  ┌─ cdp/ ──────────────────────────────────────────────────────────────────┐   │
│  │ session.ts   CDPSession / CDPSessionManager / setCDPLogger              │   │
│  │ snapshot.ts  captureSnapshot / resolveTargetCoords                      │   │
│  │ utils.ts     resolveKey / modifiersBitmask / sleep / withRetry          │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘

               调用关系
               ────────
  Application Layer                          Renderer Layer
  ┌──────────┐   ┌──────────┐         ┌──────────────────┐  ┌──────────────┐
  │ tools.ts │   │ app.ts   │         │ EmbeddedBrowser  │  │ preload.js   │
  │ (thin    │   │ (thin    │         │ extends          │  │ calls        │
  │  shell)  │   │  shell)  │         │ BrowserInstance  │  │ defineBrowser│
  └────┬─────┘   └────┬─────┘         └───────┬──────────┘  │ Bridge()     │
       │              │                       │             └──────────────┘
       │  getOrCreate │                       │ register()
       │  Controller  │                       ▼
       └──────────────┼──► BrowserManager    preload bridge
                      │                       │
                      │                       │ IPC (embedBrowser:*)
                      └───► BrowserController ◄┘
                              │
                              ▼
                           cdp/ (CDP session)
```

> **注意**：各层必须按进程边界独立导入。`renderer.ts` + `protocol.ts` 用于渲染进程；
> `main.ts` + `cdp/` 用于主进程；`preload.ts` + `protocol.ts` 用于 preload 脚本。
> 不要跨进程混合导入——没有 `index.ts` 统一入口正是为了防止这种错误。

## 使用方式

集成本库需要在 Electron 的三个进程侧分别初始化。

### 1. Preload 脚本

在 preload 脚本中调用 `defineBrowserBridge`，将浏览器控制 API 暴露到 `window` 上：

```typescript
// src/renderer/preload.js (或 .ts)
import { contextBridge, ipcRenderer } from 'electron';
import { defineBrowserBridge } from '../common/embedBrowserUse/preload';

// 在 window.browserAPI 上暴露 IPC 方法 + 实例注册机制
defineBrowserBridge('browserAPI', contextBridge, ipcRenderer);
```

调用后 `window.browserAPI` 即可用，包含 `navigate`、`getState`、`listTabs` 等
IPC 转发方法，以及 `_registerInstance` / `_unregisterInstance` 供 BrowserInstance
在渲染侧完成注册。

### 2. Renderer 进程 — 实现 BrowserInstance

继承 `BrowserInstance` 抽象基类，实现所有抽象方法。以本项目的 `EmbeddedBrowser`
为例：

```typescript
// src/renderer/browser.ts
import { BrowserInstance } from '../common/embedBrowserUse/renderer';
import type { BrowserState, TabInfo } from '../common/embedBrowserUse/protocol';

export class EmbeddedBrowser extends BrowserInstance {
    private container: HTMLElement;
    // ... 内部状态 ...

    constructor(container: HTMLElement, id: string) {
        super(id); // ← 必须传入实例 id（通常是 taskId）
        this.container = container;
        this.init();
    }

    // ── 导航 ──────────────────────────────────────────────
    navigateTo(url: string): void {
        /* 设置 webview.src = url */
    }
    goBack(): void {
        /* webview.goBack() */
    }
    goForward(): void {
        /* webview.goForward() */
    }
    refresh(): void {
        /* webview.reload() */
    }
    goHome(): void {
        /* navigateTo(HOME_PAGE) */
    }

    // ── 状态 ──────────────────────────────────────────────
    getState(): BrowserState {
        return {
            currentUrl: this.activeWebview?.getURL() ?? '',
            canGoBack: this.activeWebview?.canGoBack() ?? false,
            canGoForward: this.activeWebview?.canGoForward() ?? false,
            isFullscreen: this._isFullscreen
        };
    }
    getCurrentUrl(): string {
        return this.getState().currentUrl;
    }

    // ── 脚本执行 ──────────────────────────────────────────
    async executeJavaScript(script: string): Promise<unknown> {
        return this.activeWebview?.executeJavaScript(script);
    }

    // ── WebContents & 截图 ────────────────────────────────
    getWebContentsId(): number | null {
        return (this.activeWebview as any)?.getWebContentsId?.() ?? null;
    }
    async capturePage(): Promise<string | null> {
        // 通过 preload bridge 调用主进程截图
        return (window as any).browserAPI?.captureScreenshot(this.getWebContentsId());
    }

    // ── 标签页管理 ────────────────────────────────────────
    listTabs(): TabInfo[] {
        /* 返回 tabs 列表 */
    }
    addTab(url?: string): number {
        /* 创建新 tab，返回 tabId */
    }
    closeTab(tabId: number): void {
        /* 关闭指定 tab */
    }
    switchToTab(tabId: number): void {
        /* 切换到指定 tab */
    }

    // ── 生命周期 ──────────────────────────────────────────
    destroy(): void {
        /* 移除所有 webview、清理事件监听 */
    }
}
```

创建实例后，需要调用 `register()` 将其注册到 preload bridge：

```typescript
const browser = new EmbeddedBrowser(containerElement, taskId);
browser.register(window.browserAPI);
// → 主进程的 BrowserController 现在可以通过 IPC 驱动这个实例了

// 销毁时取消注册
browser.unregister(window.browserAPI);
browser.destroy();
```

### 3. Main Process — 初始化 BrowserManager

在应用启动时完成三步初始化：

```typescript
// src/main/main.ts
import { ipcMain, BrowserWindow } from 'electron';
import { BrowserManager, setCDPLogger } from '../common/embedBrowserUse/main';
import { logger } from './utils/logger';

// 1. 设置日志（可选，默认用 console）
setCDPLogger(logger);

// 2. 初始化共享浏览器 Session（cookies 持久化等）
BrowserManager.initSession('persist:my-browser');

// 3. 绑定 IPC handler（只需调用一次）
BrowserManager.bind(ipcMain);

// 4. 创建窗口后设置 mainWindow 引用
const mainWindow = new BrowserWindow({
    /* ... */
});
BrowserManager.setMainWindow(mainWindow);

// 应用退出前保存 session cookies
app.on('before-quit', async () => {
    await BrowserManager.persistSessionCookies();
});
```

### 4. Main Process — 使用 BrowserController

Agent 工具或业务代码通过 `BrowserManager` 获取控制器，然后调用其方法：

```typescript
// 获取或创建控制器（同一 id 返回同一实例）
const ctrl = BrowserManager.getOrCreateController(taskId);

// 导航
const page = await ctrl.navigate('https://github.com');
console.log(page.url, page.title);

// 获取页面快照（ARIA 树 + 元素 ref）
const snap = await ctrl.snapshot();
console.log(snap.ariaSnapshot);

// 点击快照中 ref 为 e3 的元素
await ctrl.click('e3');

// 在搜索框中输入并提交
await ctrl.type('e5', 'opendesk', { submit: true });

// 滚动、等待、标签页管理 ...
await ctrl.scroll('down', 500);
await ctrl.waitFor({ text: '搜索结果' });
await ctrl.tabs('new', undefined, 'https://example.com');

// 任务结束后清理
BrowserManager.removeController(taskId);
```

## BrowserController 接口

BrowserController 是开发者在主进程侧实际使用的核心类。每个实例对应一个浏览器
实例（由 `id` 标识），封装了全部 CDP 自动化操作。

### 导航

| 方法        | 签名                                                                | 说明                                                                                        |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `navigate`  | `(url: string, newTab?: boolean) → Promise<{ url, title, error? }>` | 导航到指定 URL。自动补全协议（`https://`）。`newTab=true` 时在新标签页打开。内置 20s 超时。 |
| `goBack`    | `() → Promise<{ url, title, error? }>`                              | 浏览器后退                                                                                  |
| `goForward` | `() → Promise<{ url, title, error? }>`                              | 浏览器前进                                                                                  |
| `reload`    | `() → Promise<{ url, title, error? }>`                              | 刷新当前页面（通过 renderer bridge，非 CDP Page.reload，避免 webview 宿主帧被刷新）         |

### 页面快照

| 方法       | 签名                         | 说明                                                                                                                                                                                    |
| ---------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot` | `() → Promise<PageSnapshot>` | 获取当前页面的完整 ARIA 无障碍快照。返回值包含 `url`、`title`、`viewport`、`scroll`、`ariaSnapshot`（YAML 格式）。快照中每个可交互元素标注 `[ref=eN]`，用于 `click`/`type` 等操作定位。 |

`PageSnapshot` 结构：

```typescript
interface PageSnapshot {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    ariaSnapshot: string; // YAML 格式的 ARIA 树
}
```

### 元素交互

所有 `target` 参数均支持两种形式：

- **ref**（推荐）：快照中的元素引用，如 `e3`、`e12`
- **CSS 选择器**：如 `#search-input`、`.btn-primary`

| 方法           | 签名                                                         | 说明                                                                                                |
| -------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `click`        | `(target, options?) → Promise<{ target, tag, text, page? }>` | 点击元素。通过 CDP 发送真实鼠标事件（兼容 React/Vue 等框架）。自动等待导航完成。                    |
| `type`         | `(target, text, options?) → Promise<{ target, typed }>`      | 在输入框中输入文本。先点击聚焦，可选清空已有内容、逐字符输入、输入后按 Enter 提交。                 |
| `hover`        | `(target) → Promise<{ target, tag, text }>`                  | 鼠标悬停在元素上，触发 hover 效果 / tooltip / 下拉菜单等。                                          |
| `pressKey`     | `(key, modifiers?) → Promise<{ key }>`                       | 按下指定按键。支持功能键（Enter、Tab、Escape、方向键等）和修饰键组合（Control、Shift、Alt、Meta）。 |
| `selectOption` | `(target, values) → Promise<{ selected }>`                   | 在 `<select>` 中选择指定选项。通过 `value` 值匹配。                                                 |

**click options：**

```typescript
{
    button?: 'left' | 'right' | 'middle',  // 默认 'left'
    doubleClick?: boolean,                  // 默认 false
    modifiers?: ('Alt'|'Control'|'Meta'|'Shift')[]
}
```

**type options：**

```typescript
{
    clearFirst?: boolean,  // 输入前清空，默认 true
    submit?: boolean,      // 输入后按 Enter，默认 false
    slowly?: boolean       // 逐字符输入（触发逐键事件），默认 false
}
```

### 滚动

| 方法     | 签名                                                                | 说明                                                  |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `scroll` | `(direction: 'up'\|'down', amount?: number) → Promise<ScrollState>` | 滚动页面。`amount` 默认 500px。返回滚动后的位置信息。 |

返回值包含 `scrollY`、`scrollHeight`、`viewportHeight`、`atTop`、`atBottom`、`percentScrolled`。

### 等待条件

| 方法      | 签名                                 | 说明                                                                                               |
| --------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `waitFor` | `(options) → Promise<{ condition }>` | 等待页面满足条件。`text`: 等待文本出现；`textGone`: 等待文本消失；`timeout`: 超时秒数（默认 10）。 |

### 标签页管理

| 方法   | 签名                                           | 说明                   |
| ------ | ---------------------------------------------- | ---------------------- |
| `tabs` | `(action, tabId?, url?) → Promise<TabsResult>` | 统一的标签页操作接口。 |

`action` 取值：

| action     | 必选参数 | 返回值                | 说明             |
| ---------- | -------- | --------------------- | ---------------- |
| `'list'`   | —        | `{ tabs: TabInfo[] }` | 列出所有标签页   |
| `'new'`    | `url?`   | `{ tabId, url }`      | 新建标签页       |
| `'close'`  | `tabId`  | `{ closed }`          | 关闭指定标签页   |
| `'switch'` | `tabId`  | `{ switched }`        | 切换到指定标签页 |

`TabInfo` 结构：`{ id: number; title: string; url: string; active: boolean }`

### 脚本执行

| 方法       | 签名                                  | 说明                                                                              |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `evaluate` | `(expression: string) → Promise<any>` | 在页面中执行任意 JS 表达式并返回结果（通过 CDP `Runtime.evaluate`，支持 await）。 |

### CDP 会话访问

| 方法            | 签名                               | 说明                                                     |
| --------------- | ---------------------------------- | -------------------------------------------------------- |
| `getCDPSession` | `() → Promise<CDPSession \| null>` | 获取当前活动 webview 的 CDP 会话（可能为 null）。        |
| `requireCDP`    | `() → Promise<CDPSession>`         | 获取健康的 CDP 会话，内置重试（最多 4 次）。失败抛异常。 |

### 页面信息辅助

| 方法                     | 签名                                                                                 | 说明                                                      |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `readPageInfo`           | `(session) → Promise<{ url, title, error? }>`                                        | 读取当前页面 URL + 标题，自动检测 Chrome 错误页。         |
| `readPageState`          | `(session) → Promise<{ url, title, scrollY, scrollHeight, viewportHeight } \| null>` | 读取紧凑的页面状态信息。                                  |
| `waitForClickCompletion` | `(session, callback) → Promise<void>`                                                | 执行 callback（通常是点击），然后等待可能的页面导航完成。 |

### 生命周期

| 方法      | 签名        | 说明                                                                                       |
| --------- | ----------- | ------------------------------------------------------------------------------------------ |
| `dispose` | `() → void` | 释放所有 CDP 会话，清空 mainWindow 引用。由 `BrowserManager.removeController()` 自动调用。 |

## IPC 协议

所有通道以 `embedBrowser:` 为前缀，完整列表见 `protocol.ts`。

| 通道                             | 方向            | 说明               |
| -------------------------------- | --------------- | ------------------ |
| `embedBrowser:navigate`          | renderer → main | 导航到指定 URL     |
| `embedBrowser:getState`          | renderer → main | 获取浏览器状态     |
| `embedBrowser:executeScript`     | renderer → main | 执行 JavaScript    |
| `embedBrowser:goBack`            | renderer → main | 后退               |
| `embedBrowser:goForward`         | renderer → main | 前进               |
| `embedBrowser:refresh`           | renderer → main | 刷新               |
| `embedBrowser:captureScreenshot` | renderer → main | 截图               |
| `embedBrowser:listTabs`          | renderer → main | 列出标签页         |
| `embedBrowser:addTab`            | renderer → main | 新建标签页         |
| `embedBrowser:closeTab`          | renderer → main | 关闭标签页         |
| `embedBrowser:switchTab`         | renderer → main | 切换标签页         |
| `embedBrowser:getWebContentsId`  | renderer → main | 获取 webContentsId |
| `embedBrowser:popup-blocked`     | main → renderer | 弹窗拦截通知       |

## 文件结构

```
src/common/embedBrowserUse/
├── README.md          ← 本文件
├── protocol.ts        ← IPC 通道 + 共享类型（跨进程安全）
├── renderer.ts        ← BrowserInstance 抽象基类（仅 Renderer 进程）
├── preload.ts         ← defineBrowserBridge()（仅 Preload 脚本）
├── main.ts            ← BrowserController + BrowserManager（仅 Main 进程）
└── cdp/               ← CDP 自动化（仅 Main 进程）
    ├── session.ts     ← CDPSession / CDPSessionManager
    ├── snapshot.ts    ← ARIA 快照 / 坐标解析
    └── utils.ts       ← 按键映射 / 工具函数
```

各文件按 Electron 进程边界分离，使用时按需导入对应模块，不要跨进程混用。
