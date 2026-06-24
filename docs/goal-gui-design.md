# Goal 机制 GUI 设计方案（最终版）

> 基于反馈更新：移除 GUI 操作按钮触发，关键词触发 → 默认确认弹窗 → Goal 信息集成在「任务计划」tab 内

---

## 1. 设计原则变更

| 项目     | 原方案                              | 最终方案                                                       |
| -------- | ----------------------------------- | -------------------------------------------------------------- |
| 触发方式 | 工具栏/侧边栏/GUI 按钮              | **仅通过自然语言关键词**触发，无 GUI 入口                      |
| 创建流程 | 直接弹出创建表单                    | 关键词检测 → **默认 `showConfirmModal` 弹窗** → 用户确认后创建 |
| 展示位置 | taskview 聊天历史顶部               | **集成在右侧栏「任务计划」tab 内**，位于待办列表下方           |
| 展示组件 | 独立的 `<goal-panel>` Web Component | **作为 `_renderTaskPlanPanel()` 中的一个 section**，无新 tab   |

---

## 2. 触发流程

```
用户输入 "帮我重构认证模块..."
         │
         ▼
┌──────────────────────────────────┐
│  AI Kernel 处理用户消息            │
│  检测到 goal-like intent          │
│  (LLM 输出 createGoal 工具调用)    │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  拦截 createGoal 调用             │
│  检查 source: 'chat' (非 GUI)     │
│  不立即执行，改为向 GUI 发送事件    │
│  IPC: 'goal:requestConfirmation' │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  渲染进程弹出确认弹窗               │
│  ┌──────────────────────────┐    │
│  │  🎯 启用 Goal 机制？      │    │
│  │                          │    │
│  │  检测到目标: "重构认证模块"  │    │
│  │  目标描述（可编辑）         │    │
│  │  [重构认证模块...]         │    │
│  │                          │    │
│  │  Goal 机制将跟踪执行进度...  │    │
│  │                          │    │
│  │       [取消]  [启用 →]    │    │
│  └──────────────────────────┘    │
└──────────────┬───────────────────┘
               │
        ┌──────┴──────┐
        ▼              ▼
    用户取消         用户确认
        │              │
        ▼              ▼
    放弃创建       创建 Goal（source: 'gui_confirm'）
                    │
                    ▼
              Goal Scheduler 启动执行
                    │
                    ▼
              右侧栏出现 "Goal" tab
              自动展开右侧栏并切换
              显示 goal-panel 内容
```

### 关键词检测位置

**在 AI Kernel 层（主进程）检测**，而非在 GUI 侧做正则匹配。具体位置：

```
src/main/aikernel/goal/service.ts (或 hooks.ts) 中:

1. LLM 输出 createGoal 工具调用
2. 检查工具调用来源: source === 'chat'（来自用户消息输入）
3. 若来自 chat → 拦截，向 GUI 发送 'goal:requestConfirmation' IPC 事件
4. 若来自 GUI 确认回调 (source: 'gui_confirm') → 正常执行 createGoal
5. 若用户使用 /goal 斜杠命令 → 直接创建，绕开确认弹窗
```

### 绕过确认弹窗的方式

- 使用 `/goal "目标描述"` 斜杠命令直接创建
- 从 Chat 消息中明确表达指令式 intent（如 "创建一个 goal：重构认证模块"）

---

## 3. 右侧栏 Goal 集成（任务计划 tab 内）

### 组件关系

```
<task-view>
  ├── 左侧: 聊天历史 + agent input
  └── 右侧: <task-artifacts>       ← 已有组件
       ├── 任务计划 (dynamic)      ← Goal section 集成于此
       │   ├── [任务级待办]        ← 已有
       │   └── [Goal section]     ← 🆕 仅 goal 活跃时显示
       ├── 工作空间
       ├── 浏览器
       ├── 变更
       └── 任务记忆 (dynamic)
```

### 无需新增 tab，无新增 Web Component

Goal 的信息直接渲染在 `_renderTaskPlanPanel()` 的待办列表下方，用一个浅灰色分割线与待办区分。

### Goal section 可见性规则

| 条件            | 行为                                                      |
| --------------- | --------------------------------------------------------- |
| Goal 首次创建   | 自动展开右侧栏，切换到「任务计划」tab                     |
| Goal 执行中     | Goal section 保持可见，随 `reload()` 自动更新             |
| Goal 完成或清除 | Goal section 保留但显示已完成状态，30秒后自动移除 section |
| 无 Goal         | Goal section 不渲染（`_taskPlanPanel` 回到现有行为）      |

### 渲染内容（参考 2.1 `<goal-panel>` 设计）

| 区域             | 内容                                   | 说明                             |
| ---------------- | -------------------------------------- | -------------------------------- |
| Header           | 状态徽章 + revision + Pause/Clear 按钮 | 按钮仅在 goal 非 terminal 时显示 |
| Objective        | 目标描述文本                           | 固定区域，白色背景               |
| Progress         | Attempts 和 Tokens 双进度条            | 实时更新                         |
| Success Criteria | 可勾选的 chips 列表                    | 已完成 ✓ 标记                    |
| Evaluation       | 蓝色信息栏：最近评估结果               | 含时间戳                         |
| Continuation     | 琥珀色警告栏：pending continuation     | 仅在 continuation 存在时显示     |
| Timeline         | 折叠式事件历史                         | `<details>` 组件                 |

---

## 4. 确认弹窗设计

### 直接复用 `showConfirmModal`

位置：`src/renderer/components/confirmModal.ts`，**不做任何修改**。

调用方式：

```typescript
import { showConfirmModal } from './confirmModal.ts';

const confirmed = await showConfirmModal({
    icon: 'fa-bullseye',
    iconBg: '#E6F1FB',
    iconColor: '#378ADD',
    title: '启用 Goal 机制？',
    message: `检测到任务目标：<strong>${escapeHtml(objective)}</strong>。<br /><br />Goal 机制将在每次 AI 回复后自动评估目标是否达成，并在预算上限时自动暂停。`,
    confirmText: '启用',
    cancelText: '取消'
});
```

弹窗交互：点击蒙层 / Esc / 取消 → 关闭弹窗，不创建 goal。确认 → IPC 通知主进程创建 goal（source: `'gui_confirm'`）。

---

## 5. IPC 接口变更

### 新增 IPC 事件

```typescript
// Main → Renderer：请求用户确认
// 在 preload.js 中注册
ipcMain.handle('goal:requestConfirmation', async (event, { taskId, detectedObjective }) => {
    // 向 GUI 发送弹窗请求
    // GUI 通过 invoke 返回确认结果
});

// Renderer → Main：用户确认结果
window.taskManagerAPI.confirmGoalCreation(taskId, {
    confirmed: true,
    objective: '用户编辑后的目标描述'
});
```

### 扩展现有接口

```typescript
// 新增 createGoal 的 source 值
type GoalEventSource = 'api' | 'chat' | 'gui' | 'gui_confirm' | 'system' | 'evaluator';
// 新增 'gui_confirm'：来自确认弹窗的用户确认
```

---

## 6. 需要修改的文件清单

| 文件                                         | 修改内容                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/renderer/preload.js`                    | 新增 `confirmGoalCreation` IPC 暴露                                                           |
| `src/renderer/components/taskartifacts.ts`   | `_renderTaskPlanPanel()` 底部追加 goal section，新增 `setGoalState()`、`_renderGoalSection()` |
| `src/renderer/components/taskview.js`        | 监听 `goal:requestConfirmation` 事件，调用 `showConfirmModal`                                 |
| `src/main/aikernel/goal/service.ts`          | 拦截 source='chat' 的 createGoal，发送确认请求                                                |
| `src/main/aikernel/goal/state.ts`            | 扩展 GoalEventSource 类型                                                                     |
| `src/main/main.ts`                           | 新增 `goal:requestConfirmation` IPC handler                                                   |
| `src/locale/zh-cn.ts`, `src/locale/en-us.ts` | 新增确认弹窗相关文本                                                                          |

### 不需要修改的文件

- `sidebar.js` / `agentinput.js` / `homepage.js` / `shortcutManager.ts` — 所有 GUI 按钮触发均去掉
- `confirmModal.ts` — 直接复用，不做任何修改
- 无新增 Web Component 定义

---

## 7. 状态同步机制

Goal section 的数据更新依赖 `taskartifacts.ts` 的 `setGoalState()` 方法，由 `taskview.js` 的 `reload()` 驱动：

```typescript
// taskview.js 中
async reload() {
    const task_state = await window.taskManagerAPI.getTaskState(this.task_id);
    this._currentGoal = task_state.goal || null;

    // 传递给 task-artifacts
    const artifacts = this.querySelector(`#task-${this.task_id}-artifacts`);
    if (artifacts && typeof artifacts.setGoalState === 'function') {
        artifacts.setGoalState(this._currentGoal);
    }
}
```

```typescript
// taskartifacts.ts - setGoalState
private _goalState: GoalState | null = null;

setGoalState(goal: GoalState | null) {
    this._goalState = goal;
    const hasGoal = goal && goal.status !== 'cleared';

    if (hasGoal) {
        // 确保 task-plan tab 可见并切换到它
        if (!this._taskPlanVisible) {
            this._taskPlanVisible = true;
            this._rebuildTabBar();
        }
        this._expandParentSidebar();
        this._switchTab('task-plan');
    }
    // 重新渲染 task-plan 面板（含 goal section）
    this._renderTaskPlanPanel();
}

// 修改 _renderTaskPlanPanel() 在底部追加 goal section
private _renderTaskPlanPanel(): void {
    // ... 现有 todo 渲染逻辑不变 ...

    // 追加 goal section
    if (this._goalState) {
        panel.innerHTML += this._renderGoalSection(this._goalState);
    }
}

private _renderGoalSection(goal: GoalState): string {
    // 渲染状态徽章、目标文本、progress bar、criteria、eval、timeline
    // 内容参考上方 mockup
}
```
