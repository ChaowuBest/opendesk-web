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
│  │   navigate / click / type / hover / pressKey / scrollTo / selectOption    │   │
│  │   snapshot / evaluate / waitFor / tabs / goBack / goForward / reload     │   │
│  │   requireCDP / readPageInfo / readPageState / waitForClickCompletion     │   │
│  │   _withExclusiveLock (action serialization, prevents CDP conflicts)       │   │
│  │   _beforeCallRenderer (injected UI hooks, e.g. expand sidebar)            │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│  ┌─ protocol.ts (跨进程共享) ────────────────────────────────────────────────┐   │
│  │ Channels: IPC channel 名称常量 (embedBrowser:navigate, ...)           ─   │   │
│  │ Types: BrowserState / TabInfo / PageSnapshot / BrowserBridgeAPI / ...    │   │
│  │ 新增: openDevTools / exportSnapshot / webviewCloseRequested              │   │
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

// 3. 绑定 IPC handler（只需调用一次）。可选的第二个参数注入 UI 准备 hooks。
BrowserManager.bind(ipcMain, openDeskScriptGenerators);

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

#### 注入 UI 准备逻辑（`BrowserScriptGenerators`）

`BrowserController` 本身是 UI 无关的——它不假设你的应用有侧边栏、工具栏或任何特定布局。
当你调用 `ctrl.navigate()` 或 `ctrl.click()` 时，`BrowserController` 会在每次 renderer
桥接调用前执行你注册的 `beforeCallRenderer` hooks。这些 hook 负责准备你的 UI（例如展开侧边栏、
激活浏览器标签页），使 webview 进入可交互状态。

**接口定义**（`main.ts`）：

```typescript
export interface BrowserScriptGenerators {
    /** 调用 renderer 桥接之前执行的脚本生成器列表，按注册顺序执行 */
    beforeCallRenderer: Array<(id: string) => string>;
}
```

每个 hook 接收一个 `id`（即 `BrowserController.id`，通常为任务或会话 ID），返回一段
将被注入到 renderer 进程的 JavaScript 代码。所有 hook **按数组顺序串行执行**。

**示例 — OpenDesk 的侧边栏展开 hook**：

```typescript
// src/main/applications/browser/utils.ts
import type { BrowserScriptGenerators } from '../../../common/embedBrowserUse/main.js';

function makeEnsureSidebarScript(id: string): string {
    const safeId = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
        var el = document.getElementById('task-${safeId}-artifacts');
        if (el) {
            var tv = el.closest('task-view');
            if (tv && typeof tv._ensureRightSidebarOpen === 'function') {
                tv._ensureRightSidebarOpen();
            }
            if (typeof el.ensureBrowserReady === 'function') el.ensureBrowserReady();
        }
    `;
}

export const openDeskScriptGenerators: BrowserScriptGenerators = {
    beforeCallRenderer: [makeEnsureSidebarScript]
};
```

**在 `BrowserManager.bind()` 时注入**：

```typescript
// src/main/main.ts
import { openDeskScriptGenerators } from './applications/browser/utils.js';

// 将 hooks 注入到 BrowserManager，所有 IPC handler 会自动使用
BrowserManager.bind(ipcMain, openDeskScriptGenerators);
```

**如果应用不需要任何 UI 准备逻辑**（例如浏览器的 webview 始终可见），可以完全不传 hooks：

```typescript
BrowserManager.bind(ipcMain); // 无 hooks — 所有功能仍然正常工作
```

同样的，不传 hooks 创建的 `BrowserController` 也能正常工作——所有 CDP 操作（snapshot、
click、type、evaluate 等）不受影响，只有 renderer 桥接调用前不会执行额外的 UI 脚本。

**多 hook 示例**（按顺序执行多个 UI 准备步骤）：

```typescript
const myHooks: BrowserScriptGenerators = {
    beforeCallRenderer: [
        (id) => `console.log('[before] preparing browser for', '${id}')`,
        (id) => `document.querySelector('.browser-panel')?.classList.add('active')`,
        (id) => `window.myApp.ensureBrowserVisible('${id}')`
    ]
};

BrowserManager.bind(ipcMain, myHooks);
```

> **设计要点**：`beforeCallRenderer` hooks 仅处理 UI 布局逻辑。通用的 renderer 桥接
> 脚本（查找 DOM 元素、调用方法、执行 webview 脚本）由库自身的 `makeCallBrowserScript`
> 和 `makeExecuteScriptOnBrowser` 函数提供，不与任何特定 UI 框架耦合。

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
await ctrl.scrollTo('e7');
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
    clearFirst?: boolean,  // true: 清空已有内容后输入（替换模式，默认）
                           // false: 将光标移到末尾后追加输入（追加模式）
    submit?: boolean,      // 输入后按 Enter，默认 false
    slowly?: boolean       // 逐字符输入（触发逐键事件），默认 false
}
```

> 内部实现已改用 JavaScript DOM 操作清空内容（`.value = ''` + dispatch `input`/`change` 事件），
> 而非 CDP 键盘快捷键（Ctrl+A / Backspace）。这更加可靠，且不会受页面自定义快捷键拦截影响。
> 追加模式下会先读取 `activeElement.value` 再拼接新文本，然后一次性写入。

### 滚动

| 方法       | 签名                                                                         | 说明                                                                                                       |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `scrollTo` | `(ref: string, options?: { block?, inline? }) → Promise<{ ref, tag, text }>` | 滚动指定元素到可见区域。`block`/`inline` 可选 `'start'` `'center'` `'end'` `'nearest'`，默认 `'nearest'`。 |

`ref` 支持嵌套 ref（如 `"e5-e3"`），方法内部自动处理 iframe 导航和容器滚动链。

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

### 并发控制 (Controller Lock)

`BrowserController` 内部使用 `_withExclusiveLock()` 机制对所有公开操作方法进行串行化。
同一个 controller 实例上的 `navigate`、`click`、`type`、`snapshot` 等操作不会并发执行，
后续调用会自动排队等待前一个操作完成。

这可以避免两个 `type()` 调用交替发送击键到错误的元素，或 `click` + `snapshot` 的
CDP 命令交错导致竞态。

> **对使用者透明**：调用方无需额外加锁，所有 public 方法自动串行。

### 调试与快照导出

`BrowserBridgeAPI` 暴露了两个非实例绑定的工具方法，直接操作 webContents（无需 instanceId）。

| 方法             | 签名                                | 说明                                                                 |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `openDevTools`   | `(webContentsId: number) → Promise` | 为指定 webview 打开 Chrome DevTools 窗口。适合调试页面问题。         |
| `exportSnapshot` | `(webContentsId: number) → Promise` | 获取当前页面的可访问性快照并弹出系统保存对话框，导出为 `.txt` 文件。 |

**使用方式**（在 BrowserInstance 子类中）：

```typescript
// 打开 DevTools
const wcId = this.getWebContentsId();
if (wcId != null) {
    await bridgeAPI.openDevTools(wcId);
}

// 导出快照
const wcId = this.getWebContentsId();
if (wcId != null) {
    await bridgeAPI.exportSnapshot(wcId); // 弹出保存对话框
}
```

> `openDevTools` 和 `exportSnapshot` 通过 IPC 直接操作 webContents，无需通过
> `callBrowserOnTask` 的 renderer 桥接。这使它们可以用于调试尚未完全初始化完成的页面。

### 窗口事件处理

库通过 preload bridge 将主进程的窗口管理事件转发为 DOM CustomEvent，方便
BrowserInstance 子类响应弹窗、窗口关闭等场景。

| DOM 事件名                        | 触发场景                                                     | `detail` 字段            |
| --------------------------------- | ------------------------------------------------------------ | ------------------------ |
| `browser-popup-blocked`           | webview 中 `window.open()` 被 Electron 拦截为新窗口          | `{ url, webContentsId }` |
| `browser-webview-close-requested` | webview guest 页面调用 `window.close()`（如 OAuth 授权完成） | `{ webContentsId }`      |

**BrowserInstance 子类适配示例**：

```typescript
// 弹窗拦截 → 新建 tab 并记录 opener 关系
window.addEventListener('browser-popup-blocked', (e: Event) => {
    const { url, webContentsId } = (e as CustomEvent).detail;
    const myWcId = this.getWebContentsId();
    if (myWcId === webContentsId) {
        this.addTab(url, this.activeTabId); // openerTabId = 当前活跃 tab
    }
});

// webview 调用 window.close() → 自动关闭对应 tab
window.addEventListener('browser-webview-close-requested', (e: Event) => {
    const { webContentsId } = (e as CustomEvent).detail;
    for (const tab of this.tabs) {
        if (tab.webContentsId === webContentsId) {
            this.closeTab(tab.id);
            break;
        }
    }
});
```

> 这些事件由 preload.ts 中的 `defineBrowserBridge()` 统一注册。只要调用了
> `defineBrowserBridge`，DOM Event 就会被自动转发到 renderer 的 `window` 上。
> BrowserInstance 无需任何额外适配即可收到这些事件。

## IPC 协议

所有通道以 `embedBrowser:` 为前缀，完整列表见 `protocol.ts`。

| 通道                                   | 方向            | 说明                             |
| -------------------------------------- | --------------- | -------------------------------- |
| `embedBrowser:navigate`                | renderer → main | 导航到指定 URL                   |
| `embedBrowser:getState`                | renderer → main | 获取浏览器状态                   |
| `embedBrowser:executeScript`           | renderer → main | 执行 JavaScript                  |
| `embedBrowser:goBack`                  | renderer → main | 后退                             |
| `embedBrowser:goForward`               | renderer → main | 前进                             |
| `embedBrowser:refresh`                 | renderer → main | 刷新                             |
| `embedBrowser:captureScreenshot`       | renderer → main | 截图                             |
| `embedBrowser:listTabs`                | renderer → main | 列出标签页                       |
| `embedBrowser:addTab`                  | renderer → main | 新建标签页                       |
| `embedBrowser:closeTab`                | renderer → main | 关闭标签页                       |
| `embedBrowser:switchTab`               | renderer → main | 切换标签页                       |
| `embedBrowser:getWebContentsId`        | renderer → main | 获取 webContentsId               |
| `embedBrowser:openDevTools`            | renderer → main | 打开 webview DevTools            |
| `embedBrowser:exportSnapshot`          | renderer → main | 导出页面可访问性快照到文件       |
| `embedBrowser:popup-blocked`           | main → renderer | 弹窗拦截通知                     |
| `embedBrowser:webview-close-requested` | main → renderer | webview 调用 window.close() 通知 |

## BrowserInstance 适配指南

如果库使用者有自己的 `BrowserInstance` 实现（而非本项目内置的 `EmbeddedBrowser`），
需要适配以下能力才能让新增功能正常工作。

### 1. 弹窗支持（popup → tab）

当 webview 内调用 `window.open()` 或点击 `target="_blank"` 链接时，Electron
会触发 `new-window` 事件。主进程将其通过 `popupBlocked` 通道发送到 renderer，
在 `defineBrowserBridge` 中转为 `browser-popup-blocked` DOM 事件。

**适配步骤**：

```typescript
// 在 BrowserInstance 子类初始化时监听
window.addEventListener('browser-popup-blocked', (e: Event) => {
    const { url, webContentsId } = (e as CustomEvent).detail;
    // 匹配是否为本实例的 webview
    if (this.getWebContentsId() !== webContentsId) return;
    // 新建 tab，传入 openerTabId 建立父子关系
    const newTabId = this.addTab(url, this.activeTabId);
});
```

### 2. window.close() 处理

OAuth 等场景下，授权完成后页面调用 `window.close()`。主进程检测到后通过
`webviewCloseRequested` → `browser-webview-close-requested` 链路通知 renderer。

**适配步骤**：

```typescript
window.addEventListener('browser-webview-close-requested', (e: Event) => {
    const { webContentsId } = (e as CustomEvent).detail;
    // 找到对应 tab 并关闭
    const tab = this.tabs.find((t) => t.webContentsId === webContentsId);
    if (tab) this.closeTab(tab.id);
});
```

### 3. DevTools & Snapshot 导出

这两个功能通过 `window.browserAPI` 直接调用：

```typescript
// 打开 DevTools
const wcId = this.getWebContentsId();
if (wcId != null) {
    await (window as any).browserAPI.openDevTools(wcId);
}

// 导出快照到文件
if (wcId != null) {
    await (window as any).browserAPI.exportSnapshot(wcId);
}
```

### 4. Tab 生命周期管理

在embedBrowserUse中我们使用Tab来承载弹窗。换言之，如果一个窗口通过window.open方式弹出
窗口，实际上你会看到一个新增Tab。为支持弹窗链的正确生命周期管理，我们在 `TabInfo` 和
`BrowserTab` 中都增加了 `openerTabId` 字段：

```typescript
interface BrowserTab {
    id: number;
    // ... 其他字段 ...
    openerTabId?: number; // 若由弹窗产生，记录父 tab ID
}
```

关闭弹窗 tab 时，应通知 opener tab（例如更新"弹窗已关闭"状态），并在
opener tab 的 webview 中触发自定义事件使页面内的 `window.open` 返回的
proxy 对象的 `.closed` 属性变为 `true`。

## 封装性说明

embedBrowserUse 的设计原则是各文件严格按 Electron 进程边界分离：

- `protocol.ts` — 纯类型和常量，无平台依赖（可跨进程安全导入）
- `preload.ts` — 仅依赖 `protocol.ts`，与 renderer 和 main 解耦
- `renderer.ts` — 仅依赖 `protocol.ts`，可在任何 renderer 上下文中继承 `BrowserInstance`
- `main.ts` — 依赖 `protocol.ts` + `cdp/`，负责 CDP 自动化和 IPC handler 注册

本次新增功能遵循了相同的分层原则：

| 新增能力                  | 涉及模块                    | 是否引入新耦合                                                       |
| ------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Controller Lock           | `main.ts` 内部              | 无 — 纯内部实现，对外透明                                            |
| `openDevTools`            | protocol / preload / main   | 无 — 通过标准 IPC 通道，与浏览器操作方法模式一致                     |
| `exportSnapshot`          | protocol / preload / main   | 无 — 同上。`main.ts` handler 内使用动态 import 延迟加载 Electron API |
| 窗口事件转发              | protocol / preload / main   | 无 — DOM CustomEvent 是 renderer 侧标准模式                          |
| 截图改用原生 API          | `main.ts` handler 内部      | 降低耦合 — 去除 CDP debugger attach，避免触发反调试检测              |
| `BrowserScriptGenerators` | `main.ts` 接口 + 消费者注入 | 无 — 通过依赖注入，库不依赖特定 UI 框架的 DOM 结构                   |
| Snapshot 可见性修复       | `cdp/snapshot.ts` 内部      | 无                                                                   |
| option value 修复         | `cdp/snapshot.ts` 内部      | 无                                                                   |

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
