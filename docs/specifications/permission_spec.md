# 权限系统设计规范

## 1. 概述

OpenDesk 的权限系统用于控制 AI Agent 对外部资源的访问。当 Agent 调用工具（如读写文件、删除技能等）时，系统根据预设规则和用户授权决定是否放行。

权限系统的核心是**三态判定模型**：

| 判定结果 | 含义 | 行为                               |
| -------- | ---- | ---------------------------------- |
| `allow`  | 允许 | 直接执行，无需用户干预             |
| `deny`   | 拒绝 | 阻止执行，向 Agent 返回权限错误    |
| `ask`    | 询问 | 暂停执行，弹出确认 UI 等待用户决策 |

**设计原则：**

- **deny > ask(显式保护) > allow > ask(隐式)**：deny 最优先，其次是显式 ask 保护规则（如敏感路径），然后是 allow，都不匹配时隐式回退到 ask
- **基于路径，不绑定工具**：权限规则作用于资源路径，与哪个工具发起请求无关
- **不落盘**：`harnessContext`（包括权限引擎）不参与序列化，每次任务启动由宿主重新构建
- **封装实现**：外部模块只依赖 `permission.ts` 中的接口，不感知具体引擎实现
- **dotfiles 正常匹配**：glob 匹配启用 `dot: true`，工作空间内 `.gitignore`、`.eslintrc` 等 dotfiles 正常读写

## 2. 类型定义

所有公共类型定义在 `aikernel/security/permission.ts`，任何模块只需引用此文件。

### 2.1 资源类别与操作

```
PermissionResourceType = 'file' | 'network' | 'skill'
PermissionAction       = 'read' | 'write' | 'execute' | 'access'
```

各资源类别的常用操作：

| 资源类别 | read          | write              | execute       | access       |
| -------- | ------------- | ------------------ | ------------- | ------------ |
| file     | 读取文件内容  | 创建/修改/删除文件 | 执行脚本/命令 | —            |
| network  | —             | —                  | —             | 发起网络请求 |
| skill    | 加载/查看技能 | 删除/修改技能      | —             | —            |

### 2.2 核心接口

```typescript
// 工具声明的单条权限请求
interface PermissionRequest {
    resourceType: PermissionResourceType;
    action: PermissionAction;
    resourcePath: string; // 具体路径或 URL
}

// 权限引擎检查结果
interface PermissionCheckResult {
    effect: PermissionEffect; // 'allow' | 'deny' | 'ask'
    reason?: string;
    request: PermissionRequest;
}

// 规则定义（支持 glob 匹配）
interface PermissionRule {
    resourceType: PermissionResourceType;
    action: PermissionAction;
    pathPattern: string; // glob 风格，如 "/workspace/**"
    effect: PermissionEffect;
}

// 用户对 ask 请求的响应
interface PermissionUserResponse {
    decision: 'allow' | 'deny';
    rememberScope: 'none' | 'exact' | 'type';
}
```

### 2.3 `rememberScope` 语义

当用户对 ask 请求选择允许时，可选择记忆范围：

| 值      | 含义                         | 写入规则                                        |
| ------- | ---------------------------- | ----------------------------------------------- |
| `none`  | 仅本次允许                   | 不写入任何规则                                  |
| `exact` | 始终允许对上述路径的同类操作 | 为每个请求的 `resourcePath` 写入一条 allow 规则 |
| `type`  | 始终允许所有同类操作         | 写入一条 `pathPattern: '**'` 的 allow 规则      |

> **注意**：`exact` 写入的是路径级规则，不绑定工具。例如用户对 `globFiles` 授权了 `~/.ssh/**` 的读取，之后 `readFiles` 读取 `~/.ssh/config` 也会被自动 allow——因为路径匹配了。

## 3. 权限引擎

### 3.1 三态实现策略

OpenDesk 通过维护**三组独立的规则列表**实现四级判定（基于 picomatch 的 glob 匹配）：

```
┌───────────┐     ┌───────────┐     ┌────────────┐
│ denyRules │     │ askRules  │     │ allowRules │
│ (deny规则) │     │ (保护规则) │     │ (allow规则) │
└─────┬─────┘     └─────┬─────┘     └─────┬──────┘
      │                  │                  │
      ▼                  ▼                  ▼
  匹配 → deny       匹配 → ask        匹配 → allow
  不匹配 ──────→ 不匹配 ──────→ 不匹配 → ask(隐式)
```

判定顺序：

1. 先查 denyRules，匹配则返回 `deny`
2. 再查 askRules（显式保护规则），匹配则返回 `ask`
3. 再查 allowRules，匹配则返回 `allow`
4. 都不匹配，返回 `ask`（隐式回退）

### 3.2 匹配引擎

使用 [picomatch](https://github.com/micromatch/picomatch) 进行 glob 匹配，配置 `dot: true`：

- 支持 `*`、`**`、`?` 等标准 glob 语法
- **启用 dot 匹配**：`workspace/**` 可正确匹配 `.gitignore`、`.eslintrc` 等 dotfiles
- 每条规则在添加时预编译为 matcher 函数，运行时匹配开销极小

### 3.3 路径规范化

- Windows 反斜杠统一转为正斜杠：`C:\Users\foo` → `C:/Users/foo`
- 工具层面展开 `~` 为 `os.homedir()` 后再传入权限系统

### 3.4 默认规则

通过 `createDefaultPermissionRules(workspace)` 生成：

| 资源    | 操作               | 路径模式               | 判定            |
| ------- | ------------------ | ---------------------- | --------------- |
| file    | read               | `${workspace}/**`      | allow           |
| file    | write              | `${workspace}/**`      | allow           |
| file    | execute            | `${workspace}/**`      | allow           |
| skill   | read               | `**`                   | allow           |
| file    | read/write/execute | `~/.ssh/**` 等敏感路径 | ask（显式保护） |
| file    | read/write/execute | `**/.env`、`**/.env.*` | ask（显式保护） |
| file    | read/write/execute | 工作空间外             | ask（隐式）     |
| network | access             | \*                     | ask（隐式）     |
| skill   | write              | \*                     | ask（隐式）     |

### 3.5 敏感路径保护

当工作空间范围较大（例如 `$HOME`）时，`workspace/**` 的 allow 规则会覆盖大量本不应被无条件允许的路径。
敏感路径保护规则（定义在 `utils/permissionRules.ts`）以 `ask` 效果注入，优先级高于 allow：

| 保护路径             | 说明             |
| -------------------- | ---------------- |
| `~/.ssh/**`          | SSH 密钥与配置   |
| `~/.gnupg/**`        | GPG 密钥         |
| `~/.aws/**`          | AWS 凭证         |
| `~/.docker/**`       | Docker 凭证      |
| `~/.kube/**`         | Kubernetes 配置  |
| `~/.git-credentials` | Git 凭证存储     |
| `~/.npmrc`           | npm 配置与 token |
| `**/.env`            | 环境变量文件     |
| `**/.env.*`          | 环境变量文件     |

扩展方式：在 `SENSITIVE_PATH_PATTERNS` 数组中添加新条目即可。

### 3.6 可读目录注册表

`ReadableDirectoryRegistry` 是进程级的只读目录白名单，用于放行框架自己管理、且位于工作空间之外的目录。
应用层（如技能中心）在初始化时注册目录，`HarnessContext` 创建权限引擎时会自动追加这些目录的
`file:read` allow 规则（pattern 为 `<dir>{,/**}`），因此不受工作空间范围限制。

技能目录的开放时机取决于技能来源：

| 技能来源                                                 | 可读时机                                       |
| -------------------------------------------------------- | ---------------------------------------------- |
| 内置技能根、用户技能根（`apps/skills/resources`）        | 技能中心初始化时整根注册                       |
| `external_paths` 配置目录、`--mount-skill` 挂载目录      | 技能被加载时按该技能的目录注册并补授权当前任务 |
| 自定义 Agent、Staff 私有技能等其它运行期才发现的技能目录 | 同上                                           |

`external_paths` / `--mount-skill` 目录不整根放行的原因：它们可以指向任意大的用户目录（配置目录按
递归扫描），整根设为全局可读属于过度授权；且它们运行期可变，而技能中心只在应用初始化时注册一次，
改配置后注册结果与实际情况不一致。按技能目录精确放行既够用也不会过期。

「加载时开放」由 `SkillRegistry.getToolset()` 暴露的 `LoadSkill` 工具与 `/skillname` 预加载
（`TaskState.preloadSlashSkills`）共同完成：注册进可读目录注册表（影响后续新建任务），
同时给当前任务的权限引擎追加一条 `file:read` allow 规则（当前引擎早于注册创建，拿不到注册表规则）。
因此技能正文把「Skill 的安装路径」告知模型后，模型读取技能目录内的 `scripts/`、`references/`、
`assets/` 以及 `test/` 等自定义子目录不会再触发权限询问。写入与执行不在放行范围内，仍按既有规则判定。

技能目录名来自文件系统（`external_paths` 递归扫描、自定义 Agent / Staff 私有技能），`C++ (v2)`、
`a[1]` 这类名字里的 glob 语法字符必须经 `escapeGlobLiteralPath` 转义后再拼 `{,/**}`，否则 pattern
匹配不到目录自身，授权静默失效。所有生成可读目录规则的地方（注册表 `getReadRules`、任务管理器
监听器、加载时补授权）统一走 `createReadableDirectoryRules`，保证口径一致。

未加载的技能不一定可读：内置技能根与用户技能根下的源文件因整根注册而始终可读；`external_paths`、
`--mount-skill`、自定义 Agent / Staff 私有技能等目录下的源文件，在技能被加载前读取会触发一次确认
（可记住），子 Agent 等无确认 UI 的场景直接拒绝。

## 4. HarnessContext

`HarnessContext` 是除了聊天信息之外，由宿主环境提供给 Agent 的信息与约束的集合。

```typescript
class HarnessContext {
    environ: Record<string, string>; // 环境变量
    permission: PermissionEnforcer | null; // 权限引擎
    permissionPrompt: PermissionPromptProvider | null; // 确认 UI
    workspace?: string; // 工作空间路径
}
```

- **不落盘**：`harnessContext` 不参与 `toJSON()` / 任务导入导出，避免泄露敏感数据
- **任务创建时注入**：由 TUI / Electron 的入口代码调用 `HarnessContext.createWithDefaults(workspace)` 创建并挂载到 TaskState
- **子任务继承**：fork 子任务时共享父任务的 `harnessContext` 引用

### 4.1 turn 级交互归属

`harnessContext.permissionPrompt` 与 `TaskState.interactionToolset` 是**任务默认**的交互 provider，由创建任务的宿主入口注入。具体某一轮 turn 的审批发给谁，由该轮 turn 的发起入口现场声明：

```typescript
interface TurnInteractionBinding {
    interactive: boolean; // 本 turn 是否由用户交互发起（决定是否挂载 askUser / exitPlanMode）
    permissionPrompt?: PermissionPromptProvider | null; // 省略沿用任务默认；null 表示本轮直接拒绝
    interactionToolset?: InteractiveToolset | null; // 省略沿用任务默认；null 表示本轮无入口侧工具集
}

task.setTurnInteractionBinding({ interactive: true, permissionPrompt: channelProvider, interactionToolset });
```

- **现场绑定、不持久化**：绑定是 turn 级的运行时状态，不落盘也不跨 turn 复用。每个 turn 起点（`submitUserMessage` / `startInternalTurn`）重置绑定，turn 被 `stop()` / `interruptForNewMessage()` 收尾时清空。所以渠道入站 turn 结束后用户回到桌面继续对话，审批会重新走桌面 provider
- **读取统一走访问器**：业务代码取 provider 用 `task.getActivePermissionPrompt()`，取交互工具集用 `task.getActiveInteractionToolset()`，turn 绑定优先、任务默认兜底；直接读 `harnessContext.permissionPrompt` 会绕过本轮绑定
- **不污染任务默认**：任何入口都不要为了单轮 turn 改写 `harnessContext.permissionPrompt` / `task.interactionToolset`（模式切换、工作空间切换重建 harness 时的默认值维护除外）
- **不残留**：turn 起点同步受控工具集（interaction / entry），本轮不挂载的会从 `chat_context.toolsets` 移除，避免上一个交互 turn 的 askUser / exitPlanMode 继续可用
- **内部 turn 用任务默认**：定时任务、goal 继续、工作流投递等 `startInternalTurn` 不属于任何用户入口，一律使用任务默认 provider

## 5. 工具权限声明

每个工具通过重写 `BaseTool.getDeclaredPermissions(args, taskState)` 声明运行时所需权限：

```typescript
// 示例：readFiles 声明每个待读取文件的 file:read 权限
getDeclaredPermissions(args) {
    return args.files.map(f => ({
        resourceType: 'file',
        action: 'read',
        resourcePath: sanitizePath(f.path)
    }));
}
```

默认实现返回空数组，表示不需要特殊权限。

### 5.1 各工具的权限声明

| 工具          | 资源类别 | 操作         | 路径来源               |
| ------------- | -------- | ------------ | ---------------------- |
| readFiles     | file     | read         | 每个文件路径           |
| writeFile     | file     | write        | 目标文件路径           |
| editFile      | file     | read + write | 目标文件路径           |
| searchReplace | file     | read + write | 目标文件路径           |
| applyPatch    | file     | read + write | patch 中涉及的每个文件 |
| globFiles     | file     | read         | `searchPath/**`        |
| grepFiles     | file     | read         | `searchPath/**`        |
| deleteSkills  | skill    | write        | 每个 skillId           |
| LoadSkillTool | skill    | read         | `bundleName/skillName` |
| CallSkillTool | —        | —            | 委托给内部工具的声明   |

> `CallSkillTool` 不自行声明权限。它解析出内部工具后调用该工具的 `getDeclaredPermissions`，如果内部工具无声明则整个调用不需要权限检查。这保证了 `listSkills`、`refreshSkills` 等只读操作不触发权限提示。

## 6. 执行流程

### 6.1 processToolCalls 两阶段执行

当一轮对话产生多个工具调用时，采用两阶段处理避免多个权限提示同时弹出：

```
阶段 1（串行）：遍历所有 pending 工具调用
  ├─ 解析参数
  ├─ 调用 handleToolPermissions 进行权限检查
  │   ├─ deny → 标记工具为 error，记录到 permissionResults
  │   └─ ask  → 弹出确认 UI，等待用户响应
  └─ 记录每个工具的检查结果

阶段 2（并行）：执行所有通过检查的工具
  ├─ 已拒绝的 → 跳过，直接渲染错误结果
  └─ 已通过的 → processToolCall(skipPermission=true)
```

### 6.2 handleToolPermissions 详细流程

```
1. 获取工具声明的权限列表 getDeclaredPermissions(args)
   └─ 空列表 → 直接放行

2. 调用 enforcer.checkAllDetailed(permissions) 逐条检查
   └─ 全部 allow → 直接放行

3. 如有 deny 结果 → 拒绝整个工具调用

4. 收集所有 ask 结果，按 (resourceType, action) 分组合并

5. 逐组弹出权限确认 UI
   ├─ 用户选择拒绝 → 拒绝整个工具调用
   └─ 用户选择允许 → 根据 rememberScope 写回规则
       ├─ none  → 不写规则（仅本次生效）
       ├─ exact → 为每个路径写入 allow 规则
       └─ type  → 写入 pathPattern='**' 的 allow 规则
```

### 6.3 权限合并示例

Agent 调用 `deleteSkills({ skillIds: ['a', 'b', 'c'] })`：

1. `getDeclaredPermissions` 返回 3 条 `skill:write` 请求
2. `checkAllDetailed` 发现 3 条都是 `ask`
3. 按 `skill:write` 分组后只有 1 组
4. 弹出 1 次权限确认，展示全部 3 个 skill 名称
5. 用户一次操作即可授权/拒绝全部

## 7. 确认 UI

权限系统定义了 `PermissionPromptProvider` 接口，各宿主环境各自实现。

### 7.1 TUI 实现

`PermissionPromptWidget` 是一个内联组件，在需要确认时：

1. 临时隐藏输入框（Editor）
2. 在输入框位置渲染确认 widget
3. 用户选择后恢复输入框和焦点

确认界面展示：

- 标题标签：操作类型（如"编辑技能"、"读取文件"）
- 资源路径列表（紧凑排列，每行一个）
- 提示问句：`{toolName} 请求{操作}{资源类型}，是否允许？`
- 四个选项：本次允许 / 始终允许上述路径 / 始终允许所有同类操作 / 拒绝
- Esc 取消（等同拒绝）

配色采用固定的深灰蓝背景 (`#2e3440`)，在深色和浅色终端下均有良好可读性。

### 7.2 Electron 实现

通过 `dialog.showMessageBox` 显示原生对话框，按钮文案与 TUI 选项对应。

### 7.3 Headless 实现

无交互能力，自动拒绝所有 `ask` 请求并输出日志。适用于 CI/CD 或非交互式脚本场景。

### 7.4 渠道实现

消息渠道（微信 / 飞书等）把审批转成渠道侧的确认卡片：

- 渠道声明 `capabilities.interactive` 并实现 `sendInteraction` 时，权限审批与 askUser 透传到渠道用户侧，用户点击后经 `ChannelInteractionService` 回投结果
- 渠道不支持交互时，使用自动拒绝 provider，且该轮 turn 不挂载交互工具集
- 渠道 provider 不会写进任务默认：只在渠道入站消息发起的那一轮 turn 生效，该轮派生的子任务 / 工作流按创建时继承（见 `agent_spec.md` 的父任务权限继承）；用户回到桌面或其他入口发起的 turn 一律走任务默认 provider（见 4.1）

参考实现：`src/main/applications/channelmgr/channel-task-interactions.ts`。

## 8. 文件结构

```
aikernel/security/
├── permission.ts       # 公共类型定义与接口（唯一的外部依赖点）
├── enforcer.ts         # picomatch 实现（外部不应直接引用）
├── harness.ts          # HarnessContext 定义
└── electronPrompt.ts  # Electron 环境的确认 UI

utils/
└── permissionRules.ts  # 敏感路径保护规则定义

tui/components/
└── permission.ts       # TUI 环境的确认 widget

tui/
└── headless.ts         # Headless 环境的确认实现（内嵌）
```

## 9. 扩展指南

### 添加新的资源类别

1. 在 `permission.ts` 的 `PermissionResourceType` 中添加新类别
2. 在 `enforcer.ts` 的 `createDefaultPermissionRules` 中添加默认规则
3. 在各 UI provider 的 `RESOURCE_TYPE_LABELS` 中添加中文标签
4. 在相关工具的 `getDeclaredPermissions` 中声明新类别的权限

### 为现有工具添加权限声明

1. 在工具类中重写 `getDeclaredPermissions(args, taskState)`
2. 根据参数返回 `PermissionRequest[]`
3. 路径需经过 `sanitizePath` 处理（展开 `~`、规范化斜杠）

### 添加新的确认 UI

实现 `PermissionPromptProvider` 接口的 `prompt(requests, toolName)` 方法，在宿主入口中注入到 `harnessContext.permissionPrompt`，作为任务默认 provider。

若某个入口需要按 turn 切换审批归属（例如渠道入站消息），在 turn 起点调用 `task.setTurnInteractionBinding()` 声明本轮绑定，不要直接改写 `harnessContext.permissionPrompt`。
