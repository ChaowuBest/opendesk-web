# 模态弹窗设计规范

## 1. 概述

OpenDesk 中的模态弹窗（Modal / Confirm Dialog）采用统一的设计风格，遵循 macOS 原生 UI 的精致感与现代 Web 应用的流畅动效。所有需要用户确认的操作（危险操作、不可逆操作、关键状态变更）均应使用本规范中定义的模态弹窗，而非浏览器原生的 `window.confirm` / `window.alert`。

**设计原则：**

- **一致性**：全应用共用同一套弹窗视觉风格与动效曲线
- **非侵入**：弹窗可通过 Esc 键 / 点击蒙层关闭，不阻塞整个应用
- **有动效**：进入与退出均有平滑动画，避免突兀闪烁
- **可感知**：危险操作使用红色按钮，普通确认使用深色按钮；图标 + 颜色辅助用户快速理解语义

## 2. 视觉规范

### 2.1 蒙层（Overlay）

| 属性     | 值                                                            |
| -------- | ------------------------------------------------------------- |
| 背景色   | `rgba(0, 0, 0, 0.3)`                                          |
| 模糊     | `backdrop-filter: blur(6px)`                                  |
| 层级     | `z-index: 99999`                                              |
| 定位     | `position: fixed; inset: 0`                                   |
| 内容对齐 | `display: flex; align-items: center; justify-content: center` |

### 2.2 卡片（Card）

| 属性   | 值                                                      |
| ------ | ------------------------------------------------------- |
| 背景   | `#ffffff`                                               |
| 圆角   | `20px`                                                  |
| 阴影   | `0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1)` |
| 宽度   | `400px`（推荐），`max-width: 92vw`                      |
| 内边距 | `28px`                                                  |
| 溢出   | `overflow: hidden`                                      |

### 2.3 头部（Header）

- 包含一个**图标容器**和**标题文字**，水平排列，间距 `12px`
- 图标容器：`42×42px`，圆角 `12px`，彩色背景 + 居中图标
- 标题：`16px`，`font-weight: 700`，颜色 `#1d1d1f`

图标颜色建议：

| 语义      | 图标背景  | 图标颜色  | 示例图标                       |
| --------- | --------- | --------- | ------------------------------ |
| 危险/删除 | `#FEF2F2` | `#DC2626` | `fa-trash-can`                 |
| 移动/变更 | `#EEF2FF` | `#6366F1` | `fa-arrows-up-down-left-right` |
| 信息/确认 | `#EFF6FF` | `#2563EB` | `fa-circle-info`               |
| 警告      | `#FFFBEB` | `#D97706` | `fa-triangle-exclamation`      |
| 成功      | `#ECFDF5` | `#059669` | `fa-circle-check`              |

### 2.4 内容区域（Message）

| 属性      | 值                                  |
| --------- | ----------------------------------- |
| 字号      | `14px`                              |
| 颜色      | `#3C3C43`                           |
| 行高      | `1.6`                               |
| 底部间距  | `22px`（与按钮区域之间）            |
| 支持 HTML | 是（可使用 `<b>` 等标签高亮关键词） |

### 2.5 底部按钮区域（Footer）

- 顶部有 `1px solid #F0F0F0` 分隔线，上方内边距 `16px`
- 按钮右对齐，间距 `10px`
- 取消按钮在左，确认按钮在右

**按钮样式：**

| 类型              | 背景      | 文字色    | 边框                  | Hover                 |
| ----------------- | --------- | --------- | --------------------- | --------------------- |
| 取消（Secondary） | `#fff`    | `#1d1d1f` | `1.5px solid #E5E5EA` | `background: #F5F5F7` |
| 确认（Primary）   | `#1d1d1f` | `#fff`    | 无                    | `background: #333`    |
| 危险（Danger）    | `#DC2626` | `#fff`    | 无                    | `background: #B91C1C` |

所有按钮共享属性：

- `padding: 10px 24px`
- `border-radius: 12px`
- `font-size: 14px`
- `font-weight: 600`
- `transition: all 0.15s`
- 按下时 `transform: scale(0.97)`

## 3. 动效规范

### 3.1 进入动画

| 元素 | 动画名     | 时长    | 缓动函数                         |
| ---- | ---------- | ------- | -------------------------------- |
| 蒙层 | `fade-in`  | `250ms` | `ease-out`                       |
| 卡片 | `scale-in` | `250ms` | `cubic-bezier(0.23, 1, 0.32, 1)` |

```css
@keyframes od-modal-fade-in {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}
@keyframes od-modal-scale-in {
    from {
        opacity: 0;
        transform: scale(0.95) translateY(10px);
    }
    to {
        opacity: 1;
        transform: scale(1) translateY(0);
    }
}
```

### 3.2 退出动画

| 元素 | 动画名      | 时长    | 缓动函数  |
| ---- | ----------- | ------- | --------- |
| 蒙层 | `fade-out`  | `180ms` | `ease-in` |
| 卡片 | `scale-out` | `180ms` | `ease-in` |

```css
@keyframes od-modal-fade-out {
    from {
        opacity: 1;
    }
    to {
        opacity: 0;
    }
}
@keyframes od-modal-scale-out {
    from {
        opacity: 1;
        transform: scale(1) translateY(0);
    }
    to {
        opacity: 0;
        transform: scale(0.95) translateY(10px);
    }
}
```

## 4. 交互行为

| 触发方式     | 行为                               |
| ------------ | ---------------------------------- |
| 点击确认按钮 | 执行操作，关闭弹窗（带退出动画）   |
| 点击取消按钮 | 取消操作，关闭弹窗                 |
| 按 `Esc` 键  | 等同取消                           |
| 点击蒙层区域 | 等同取消                           |
| 焦点管理     | 弹窗打开时确认按钮获得焦点（可选） |

## 5. API 接口

通用确认弹窗组件位于 `src/renderer/components/confirmModal.ts`，导出 `showConfirmModal` 函数：

```typescript
interface ConfirmModalOptions {
    icon?: string; // FontAwesome class，如 'fa-trash-can'
    iconBg?: string; // 图标容器背景色
    iconColor?: string; // 图标颜色
    title: string; // 弹窗标题
    message: string; // 内容（支持 HTML）
    confirmText?: string; // 确认按钮文本，默认 "确认"
    cancelText?: string; // 取消按钮文本，默认 "取消"
    danger?: boolean; // 确认按钮是否为危险样式（红色）
    mountTarget?: HTMLElement; // 挂载目标，默认 document.body
}

function showConfirmModal(options: ConfirmModalOptions): Promise<boolean>;
```

**使用示例：**

```javascript
import { showConfirmModal } from '../../../../renderer/components/confirmModal';

const confirmed = await showConfirmModal({
    icon: 'fa-trash-can',
    iconBg: '#FEF2F2',
    iconColor: '#DC2626',
    title: '删除文件',
    message: '确定要将文件「<b>readme.md</b>」移动到回收站吗？',
    confirmText: '删除',
    cancelText: '取消',
    danger: true
});

if (confirmed) {
    // 执行删除
}
```

## 6. 参考实现文件

以下文件包含现有的模态弹窗实现，可供参考和学习：

| 文件路径                                           | 说明                                                         |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `src/renderer/components/confirmModal.ts`          | **通用确认弹窗组件**（本规范的标准实现）                     |
| `src/main/applications/calendar/renderer/entry.js` | 日历 app 拖动日程确认弹窗（行 265–303 CSS，行 1814–1883 JS） |
| `src/main/applications/skillmgr/renderer/entry.js` | 技能中心删除确认（使用 `showConfirmModal`）                  |
| `src/renderer/components/fileExplorer.ts`          | 工作空间文件删除确认（使用 `showConfirmModal`）              |
| `src/renderer/components/askUserPrompt.ts`         | Agent 向用户询问时的弹窗（另一种交互模态，可参考布局）       |
| `src/renderer/components/permissionPrompt.ts`      | 权限确认弹窗（较复杂的多状态模态，可参考结构）               |

## 7. 何时使用模态弹窗

✅ **应该使用**：

- 删除文件、文件夹
- 删除/卸载技能
- 移动/修改日程（时间变更）
- 清空聊天记录
- 重置设置
- 任何不可逆或代价较高的操作

❌ **不应该使用**：

- 简单的信息提示（用 Toast / Notification）
- 输入表单（用完整的表单弹窗或侧面板）
- 需要复杂多步操作的流程（用向导 Wizard）

## 8. 注意事项

1. **不要使用** `window.confirm` / `window.alert` / `window.prompt`——它们会阻塞 JS 执行且样式不可控
2. 弹窗内的文案应当清晰告知操作后果（如 "此操作可从回收站恢复" 或 "删除后需重新安装"）
3. 危险操作的确认按钮务必使用红色 `danger` 样式
4. 保证动画在所有场景都能正确播放退出动效（使用 `setTimeout` 等待动画完成后再移除 DOM）
5. 弹窗的 `z-index` 设为 `99999`，确保始终在最上层
