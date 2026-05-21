# 主题模块 (`src/renderer/theme`)

主题相关代码与样式统一放在本目录；主进程通过 `main.ts` 引用 `main-theme-service.ts`，渲染进程引用 `theme-renderer.ts`。

## 架构

```text

系统深色 (OHOS NativeThemeAdapter / 桌面 nativeTheme)

        ↓

system-theme.ts

        ↓

theme-manager.ts（偏好 system | light | dark → effective）

        ↓

main-theme-service.ts（主进程：持久化、IPC）  ← 仅 main.ts import

        ↓

theme-renderer.ts + theme-iframe-bridge.ts + theme.css / theme-app-dark.css（渲染）

        ↓ postMessage THEME_SETTINGS → application.html 子应用 iframe

```

子应用传递与字体 `FONT_SETTINGS` / `broadcastFontSettings` 相同：

- 主窗口 `window.__appFrameCache` + `broadcastThemeToAppFrames`

- iframe 首次 `onload` 与**再次切换显示**时 `syncThemeToAppFrame` 补发

- `application.html` 调用 `initApplicationThemeHost()`（postMessage + `themeAPI.onThemeChanged`）

- 子应用深色：`theme-app-dark.css`（仅 `*-entry-widget` / notes / cal / tm 等作用域）
- 主窗口深色：`theme-shell-dark.css`（仅 index.html 加载）

- Shadow DOM：`skillmgr-entry-widget` 经 `theme-shadow-overrides.ts` 注入

- 浏览器为**主窗口内联**组件，不走 iframe，样式见 `theme-app-dark.css` 中 `browser-entry-widget`

## 文件

| 文件 | 运行进程 | 职责 |

|------|----------|------|

| `system-theme.ts` | 主进程（经 main-theme-service） | 跨平台系统深色模式 |

| `theme-manager.ts` | 主进程 | 解析 effective 主题 |

| `main-theme-service.ts` | **主进程** | Setting 持久化、`theme:*` IPC |

| `theme-renderer.ts` | 渲染进程 | 主窗口初始化、`data-theme` |

| `theme-iframe-bridge.ts` | 渲染进程 | `THEME_SETTINGS` postMessage、子应用监听；**侧效 import 主题 CSS** |

| `theme.css` | 渲染进程 | 语义色变量、`data-theme` 壳层样式 |

| `theme-app-dark.css` | 渲染进程（子应用页） | 深色下子应用作用域覆盖 |
| `theme-shell-dark.css` | 渲染进程（主窗口） | 侧栏、任务、浏览器等主壳样式 |

| `index.ts` | 按需导出 | 勿在渲染进程 `import` 整个 index（会带入 electron） |

渲染进程请直接：`import { initRendererTheme } from './theme/theme-renderer.ts'`。

样式加载：

- `theme-iframe-bridge.ts`：`theme.css` + `theme-app-dark.css`（子应用页）。

- `scripts/index.js`：另加 `theme-shell-dark.css`（主窗口专用）。

- **禁止** `color-scheme: dark`（会触发 WebView 自动深色化，子应用控件消失）；`data-theme` 仅驱动 CSS 变量。
- 子应用页使用 `data-od-app-frame` + `color-scheme: only light`（含 `<meta name="color-scheme">`），与主进程 `disable-features=WebContentsForceDark` 配合，避免 `nativeTheme.themeSource` 为 `dark`/`system` 时 iframe 控件空白。
- 桌面端 `nativeTheme.themeSource`：`system` 时跟随 OS（`shouldUseDarkColors`）；`light`/`dark` 偏好时固定为 `light`，避免 Chromium 强制反色，深色外观仅由 `data-theme` + `theme-app-dark.css` 驱动。
- 子应用 iframe 的 preload 须暴露 `themeAPI`，以便启动时拉取主题（不能仅依赖 postMessage）。

- **禁止**在 `theme-app-dark.css` 使用全局 `[class*='bg-white']` / `.border` 等。

- **禁止**在 `theme*.css` 中写布局/尺寸（`width`/`height`/`min-height`/`display`/`flex`/`overflow` 等）；深色适配只改颜色相关属性（`color`、`background`、`border-color`、`box-shadow`、`color-scheme` 等）。子应用 webview 尺寸见 `custom.css` / `index.html`。

- 主窗口：`index.html` 引入 `theme.css` + `theme-shell-dark.css`；子应用 iframe：`application.html` 引入 `theme.css` + `theme-app-dark.css`（勿引 shell）。

- **不要**在 `common.css` 里 `@import` 主题文件（Tailwind v4 会误解析部分选择器）。

## 设置页

「通用设置 → 外观主题」→ `gui_config.theme_preference`。

## OHOS / 桌面

见上文架构；OHOS 使用 `NativeThemeAdapter.GetSystemNativeTheme`，桌面使用 `nativeTheme`。
