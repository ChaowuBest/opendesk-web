# 主题模块 (`src/renderer/theme`)

主题相关代码统一放在本目录；主进程通过 `main.ts` 引用 `main-theme-service.ts`，渲染进程引用 `theme-renderer.ts`。

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
theme-renderer.ts + styles/theme.css（渲染）
```

## 文件

| 文件 | 运行进程 | 职责 |
|------|----------|------|
| `system-theme.ts` | 主进程（经 main-theme-service） | 跨平台系统深色模式 |
| `theme-manager.ts` | 主进程 | 解析 effective 主题 |
| `main-theme-service.ts` | **主进程** | Setting 持久化、`theme:*` IPC |
| `theme-renderer.ts` | 渲染进程 | `data-theme`、iframe 广播 |
| `index.ts` | 按需导出 | 勿在渲染进程 `import` 整个 index（会带入 electron） |

渲染进程请直接：`import { initRendererTheme } from './theme/theme-renderer.ts'`。

## 设置页

「通用设置 → 外观主题」→ `gui_config.theme_preference`。

## OHOS / 桌面

见上文架构；OHOS 使用 `NativeThemeAdapter.GetSystemNativeTheme`，桌面使用 `nativeTheme`。
