# GoalPanel CLI 常驻面板 — 重新设计规范

> 本文档面向实现者（人或大模型），描述 GoalPanel 常驻面板的重新设计方案。
> 需要修改的文件: `src/main/tui/components/goalpanel.ts`
> 可能涉及: `src/locale/en-us.ts`, `src/locale/zh-cn.ts`（新增 i18n key）
> Card 组件 (`src/main/tui/components/card.ts`) 无需修改，其 `CardStatus` 已支持任意 icon+text。

---

## 1. 设计目标

1. **移除 body 中 status 行** — 与 Card header 右上角的 status 重复，删除 body 中的 `Status: ◉ Active  Attempts 2` 行
2. **移除 evaluation "pending" 行** — 评估器未触发时不显示 evaluation 行；触发后不管结果如何（met / not_met / blocked）都显示
3. **elapsed 和 attempts 不再独占 body 行** — 合并到 Card header 右上角
4. **attempts 改为"评估历史轨迹"展示** — 用 emoji 序列可视化每次评估结果，而非 `×N` 数字

---

## 2. Header 右上角结构

Card 组件的 `status` 字段（`CardStatus: { icon, text }`）承载右上角所有紧凑指标。

格式: `{statusIcon} {statusLabel} ── {evalTrail} ── {elapsed}`

三段用 `──` (两个 en-dash) 分隔。当某段不存在时跳过该段及其前面的分隔符。

### 2.1 status 段（常驻）

| GoalStatus | icon | label (en-us) | label (zh-cn) | 颜色 hex |
| ---------- | ---- | ------------- | ------------- | -------- |
| active     | ◉    | Active        | 进行中        | #00E676  |
| paused     | ⏸    | Paused        | 已暂停        | #FFA726  |
| blocked    | ⊗    | Blocked       | 已阻塞        | #EF5350  |
| complete   | ✓    | Complete      | 已完成        | #66BB6A  |
| cleared    | ✕    | Cleared       | 已清除        | #9E9E9E  |

沿用现有的 `getGoalStatusIcon` / `getGoalStatusLabel` / `getGoalStatusColor`。

### 2.2 eval trail 段（条件显示）

**仅当 `goal.lastEvaluation` 存在时显示**。未触发 evaluator 时完全隐藏此段（无占位、无 "pending" 文字）。

#### 轨迹构建规则

从 `GoalState.attempts`（记录了 not_met 次数）和 `GoalState.lastEvaluation.status` 构建轨迹：

| 场景                          | attempts | lastEvaluation.status | trail    |
| ----------------------------- | -------- | --------------------- | -------- |
| 1次 not_met, 仍在继续         | 1        | not_met               | `⏳`     |
| 2次 not_met, 仍在继续         | 2        | not_met               | `⏳⏳`   |
| 2次 not_met, 第3次 met → 完成 | 2        | met                   | `⏳⏳✅` |
| 1次 blocked → 阻塞            | 0        | blocked               | `🚫`     |
| 1次 met → 完成（一次通过）    | 0        | met                   | `✅`     |

**构建逻辑**:

```
trail = repeat(⏳, attempts) + finalIcon(lastEvaluation.status)
```

其中:

- `⏳` = not_met（每次 not_met 触发 continuation 都是一个 ⏳）
- `✅` = met
- `🚫` = blocked
- `finalIcon`: 从 `lastEvaluation.status` 映射，复用现有 `getEvaluationIcon()` 函数

#### 折叠策略

当轨迹总长度 > 5 个 emoji 时折叠:

- 保留最前面 2 个 ⏳ + `…{N}` (N = 被省略的 ⏳ 数量) + 最终结果图标
- 示例: attempts=7, lastEvaluation=met → trail = `⏳⏳…5✅`
- attempts=8, lastEvaluation=not_met → trail = `⏳⏳…6⏳`（注意最后的 ⏳ 是当前 not_met）

折叠时 `…N` 中的 N = attempts - 2（如果 lastEvaluation 不是 not_met）或 attempts - 1（如果 lastEvaluation 是 not_met，因为最后的 ⏳ 已经是当前这次）。

更简化的规则: trail emoji 总数 = attempts + 1（not_met 次数 + 最终结果）。总数 > 5 时折叠:

- 保留前2个 + `…{total-3}` + 最终1个
- `…{total-3}` 用数字表示被省略的数量

### 2.3 elapsed 段（常驻）

格式沿用现有 `formatDuration(elapsedMs)`:

- < 1h: `MM:SS` (如 `02:35`)
- ≥ 1h: `HH:MM:SS` (如 `01:02:35`)

### 2.4 CardStatus.text 组合

```typescript
// 组合右上角文本
const parts: string[] = [];
const statusColor = getGoalStatusColor(goal.status);
parts.push(`${getGoalStatusIcon(goal.status)} ${chalk.hex(statusColor)(getGoalStatusLabel(goal.status))}`);

if (goal.lastEvaluation) {
    const trail = buildEvalTrail(goal);
    parts.push(trail); // trail 本身已带颜色
}

parts.push(formatDuration(this.data.elapsedMs));

const statusText = parts.join(chalk.dim(' ── '));
// CardStatus: { icon: chalk.hex(GOAL_ACCENT_COLOR)('🎯'), text: statusText }
// 注意: icon 仍然是 🎯，但 text 现在承载了 status+trail+elapsed
```

**关键**: Card header 的 icon+title 部分保持 `🎯 Goal` 不变，但 `CardStatus.text` 从原来仅显示状态，变为显示 `status ── trail ── elapsed` 三段组合。这利用了 Card 组件已有的 header 右侧空间。

**注意 CardStatus.icon**: 由于右上角现在承载更多信息，icon 字段可以设为空字符串（或保持现有 status icon），让 text 字段包含完整的组合文本。推荐方案: icon 设为空，让 text 承载所有右上角信息。这样 header 格式变为:

```
╭─ 🎯 Goal ────── ◉ Active ── ⏳⏳ ── 02:35 ─╮
```

---

## 3. Body 行结构

Body 从原来的固定 5 行精简为 2~4 条件行。

### 3.1 行列表

| 序号 | 行         | label key (en-us)                                                         | label key (zh-cn) | 条件                                             | 样式                                                 |
| ---- | ---------- | ------------------------------------------------------------------------- | ----------------- | ------------------------------------------------ | ---------------------------------------------------- |
| 1    | objective  | `goal.panel.objective`: Objective                                         | 目标              | **常驻**                                         | `chalk.dim(label) + objective`                       |
| 2    | reason     | `goal.panel.blocked_reason`: Blocked / `goal.panel.paused_reason`: Paused | 阻塞 / 暂停       | 仅 paused(pauseReason) 或 blocked(blockedReason) | `chalk.dim(label) + chalk.hex(color)(text)`          |
| 3    | evaluation | `goal.panel.evaluation`: Evaluation                                       | 评估              | 仅 `lastEvaluation` 存在时                       | `chalk.dim(label) + evalIcon + chalk.italic(reason)` |
| 4    | tokens     | `goal.renderer.tokens`: Tokens                                            | Token             | **常驻**                                         | `chalk.dim(label) + formatTokens(n)`                 |

### 3.2 已移除的行

- **status 行** (`goal.panel.status`) — 移除，信息已在右上角
- **elapsed 行** (`goal.panel.elapsed`) — 移除，信息已在右上角
- **evaluation pending** (`goal.panel.evaluation.pending`) — 移除，未触发时不显示 evaluation 行

### 3.3 evaluation 行的条件渲染

```typescript
if (goal.lastEvaluation) {
    const evalIcon = getEvaluationIcon(goal.lastEvaluation.status);
    const evalReason = truncateToWidth(goal.lastEvaluation.reason, contentWidth - 12, '…', true);
    lines.push(`${chalk.dim(`${t('goal.panel.evaluation')}:`)} ${evalIcon} ${chalk.italic(evalReason)}`);
}
// else: 不输出任何行，不显示 "pending"
```

### 3.4 reason 行的条件渲染

沿用现有 `buildReasonLines()` 方法，不修改逻辑，只确保它在 body 中的位置正确（在 objective 和 evaluation 之间）。

---

## 4. 边框颜色

面板边框颜色随 status 变化，强化视觉状态信号:

| status   | borderColorFn             |
| -------- | ------------------------- |
| active   | `chalk.hex(#00E676)` (绿) |
| paused   | `chalk.hex(#FFA726)` (橙) |
| blocked  | `chalk.hex(#EF5350)` (红) |
| complete | `chalk.hex(#66BB6A)` (绿) |

当前代码使用固定的 `GOAL_ACCENT_COLOR (#7C4DFF)`，需改为动态:

```typescript
// render() 中:
const borderColorFn = chalk.hex(getGoalStatusColor(goal.status));
const card = new Card({
    icon: chalk.hex(getGoalStatusColor(goal.status))('🎯'),
    title: chalk.bold('Goal'),
    status: statusIndicator, // 新的组合格式
    body: bodyLines,
    border: { style: 'rounded', colorFn: borderColorFn }
});
```

注意: goal icon 🎯 也改为跟随 status 颜色，与边框统一。

---

## 5. 完整渲染示例

### 5.1 刚创建（无 evaluation）— 2 行 body

```
╭─ 🎯 Goal ────────────── ◉ Active ── 00:00 ─╮
│ 目标: 实现用户登录功能                        │
│ Token: 800                                    │
╰───────────────────────────────────────────────╯
```

### 5.2 1 次 not_met — 3 行 body

```
╭─ 🎯 Goal ──────── ◉ Active ── ⏳ ── 01:20 ─╮
│ 目标: 实现用户登录功能                        │
│ 评估: ⏳ 部分功能尚未完成                      │
│ Token: 8.2K                                    │
╰───────────────────────────────────────────────╯
```

### 5.3 2 次 not_met, 仍在继续 — 3 行 body

```
╭─ 🎯 Goal ────── ◉ Active ── ⏳⏳ ── 02:35 ─╮
│ 目标: 实现用户登录功能                        │
│ 评估: ⏳ 数据库连接尚未修复                    │
│ Token: 12.5K                                   │
╰───────────────────────────────────────────────╯
```

### 5.4 Paused（有 pause reason）— 3 行 body

```
╭─ 🎯 Goal ────── ⏸ Paused ── ⏳ ── 01:20 ─╮
│ 目标: 实现用户登录功能                      │
│ 暂停: 用户手动暂停                            │
│ Token: 5.8K                                    │
╰───────────────────────────────────────────────╯
```

### 5.5 Blocked（最极端）— 4 行 body

```
╭─ 🎯 Goal ─── ⊗ Blocked ── ⏳🚫 ── 03:45 ─╮
│ 目标: 实现用户登录功能                      │
│ 阻塞: 外部依赖服务不可用                      │
│ 评估: 🚫 无法继续推进                        │
│ Token: 18.3K                                   │
╰───────────────────────────────────────────────╯
```

### 5.6 Complete（2次 not_met 后 met）— 3 行 body

```
╭─ 🎯 Goal ── ✓ Complete ── ⏳⏳✅ ── 05:12 ─╮
│ 目标: 实现用户登录功能                        │
│ 评估: ✅ 目标已达成                            │
│ Token: 25.8K                                   │
╰───────────────────────────────────────────────╯
```

---

## 6. 需新增的 i18n key

| key                             | en-us       | zh-cn       | 备注               |
| ------------------------------- | ----------- | ----------- | ------------------ |
| `goal.panel.eval_trail.omitted` | `…${count}` | `…${count}` | 折叠时省略数量标记 |

无需新增 key: `goal.panel.status`, `goal.panel.evaluation.pending`, `goal.panel.elapsed` 仍保留在 locale 中（其他组件可能使用），只是 GoalPanel body 不再使用它们。

---

## 7. 不需要修改的部分

- `Card` 组件 — 其 `CardStatus.text` 已支持任意长文本，header 渲染逻辑自动处理宽度分配
- `GoalPanelData` 接口 — 无需变更
- `updateVisibility()` — 无需变更
- `GoalState` / `GoalEvaluation` 类型 — 无需变更
- `formatDuration()` / `formatTokens()` / `getEvaluationIcon()` 等工具函数 — 沿用
- `buildReasonLines()` — 沿用，逻辑不变

---

## 8. 实现要点 checklist

1. 新增 `buildEvalTrail(goal: GoalState): string` 函数，按 §2.2 规则构建轨迹文本
2. 轨迹 emoji 需带颜色: ⏳ 用 `chalk.hex(#FFA726)`（amber），✅ 保持原色，🚫 用 `chalk.hex(#EF5350)`
3. 修改 `render()` 方法: CardStatus 从仅 status 改为 status+trail+elapsed 组合
4. 修改 `buildBodyLines()`: 移除 status 行、elapsed 行、evaluation pending 行
5. 修改 `render()` 中 Card icon 颜色和 border colorFn 为动态（跟随 status）
6. 新增 i18n key `goal.panel.eval_trail.omitted`
7. 轨迹折叠: 总 emoji 数 > 5 时保留前 2 + `…{omittedCount}` + 最终 1 个
8. 确保窄屏下 Card header 右上角不会溢出 — Card 的 `renderHeader()` 已有 truncateToWidth 保护
