# Renderer 主题模块 (`src/renderer/theme`)

## 文件

| 文件 | 职责 |
|------|------|
| `system-theme.ts` | 系统深色模式：OHOS / macOS / Windows / Linux |
| `theme-manager.ts` | 应用主题偏好与 `data-theme` |
| `index.ts` | 导出 |

## 平台

| 平台 | 查询 | 监听 |
|------|------|------|
| **HarmonyOS** | `callArkTS('NativeThemeAdapter.GetSystemNativeTheme', 'number', [])` | 主进程挂接 `SetThemeSource` → `registerOhosNativeListener` |
| **macOS / Windows / Linux** | `nativeTheme.shouldUseDarkColors` | `nativeTheme.on('updated')` |

`OhosColorMode` 与 `@ohos.app.ability.ConfigurationConstant.ColorMode` 一致（`DARK=0`, `LIGHT=1`, `NOT_SET=-1`）。

## OHOS 主进程示例

```typescript
import { initSystemTheme, getSystemDarkMode, ThemeManager } from './theme/index.js';

initSystemTheme({
  platform: 'ohos',
  callArkTS: (method, returnType, args) =>
    systemPreferences.callArkTSFunction(method, returnType, args),
  registerOhosNativeListener: (listener) => {
    const onChange = () => listener(getSystemDarkMode());
    app.on('theme-source-changed', onChange); // 事件名以 Electron fork 为准
    return () => app.off('theme-source-changed', onChange);
  },
});
```

桌面端：`initSystemTheme()` 即可（或省略，首次 `getSystemDarkMode()` 自动检测平台）。

环境变量：`OPENDESK_PLATFORM=ohos`（当 `process.platform` 不是 `ohos` 时）。

## HAP 依赖

仅使用 web_engine 既有绑定，**无需** `EtsBridge.OpenDeskGetSystemDarkMode`：

- `NativeThemeAdapter.GetSystemNativeTheme`
- `onConfigurationUpdate` → `SetThemeSource`
