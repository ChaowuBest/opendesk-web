# OpenDesk 插件开发指南

OpenDesk 插件由独立应用 `pluginmgr` 负责发现、安装、启停、校验和加载：

- 插件管理实现位于 `src/main/applications/pluginmgr/`。
- 插件可以扩展 OpenDesk 的 AI 运行时。

插件在 OpenDesk 主进程内作为受信任的 Node.js 代码执行。能力声明、授权和完整性检查用于
约束 OpenDesk contribution 的加载，不是操作系统级沙箱。安装第三方插件前仍应审查来源。

## 插件目录

`pluginmgr` 使用 OpenDesk 配置目录下的 `plugins` 作为全局插件目录，与 `extensions` 目录同级：

- Windows：`%APPDATA%\opendesk\plugins`
- Linux/macOS：`~/.opendesk/plugins`
- 使用 `--config-directory <dir>` 或 `OPENDESK_CONFIG_DIRECTORY` 后：`<dir>/plugins`

目录结构如下：

```text
plugins/
├── review-helper/                       # 手工放入的本地插件
├── standalone.mjs                       # 手工放入的单文件插件
├── installed-plugin-id/                 # 通过插件中心或 CLI 安装的插件容器
│   └── node_modules/
│       └── opendesk-plugin-example/
└── .pluginmgr/
    ├── registry.json                    # 安装、启用、配置和授权记录
    ├── staging/                         # 安装暂存目录
    ├── cache/
    └── trash/                           # 被替换或卸载的插件
```

直接把插件目录或 `.js`、`.mjs`、`.cjs` 文件放进 `plugins/`，重启 OpenDesk
即可被发现，也可以在插件中心执行重新加载。扫描过程不会执行 `npm install`；
本地插件必须已经包含自身所需依赖，并能从自己的 `node_modules` 中解析它们。

> 例外：`@bitclub.ai/opendesk-plugin-sdk`（含 `./package` 子路径）和其运行时
> 依赖 `zod` 由宿主进程内置。pluginmgr 启动时注册 ESM 解析映射：插件入口
> `import` 这些包时，先按插件自己的 `node_modules` 解析（尊重插件声明的版本）；
> 解析失败时回退到宿主内置的同名包。因此插件即使省略 SDK 的
> `node_modules`（例如鸿蒙端安装的目录插件无法执行 npm install）也能正常
> 加载。其他第三方依赖仍必须由插件自带。

还可以在 `setting.json` 中配置不复制到全局目录的外部插件路径：

```json
{
    "applications": {
        "pluginmgr": {
            "externalPaths": ["D:/projects/my-plugin", "./external-plugins"]
        }
    }
}
```

相对的 `externalPaths` 以 OpenDesk 配置目录为基准。

启动 TUI 时也可以临时指定一个额外的插件集合目录：

```bash
opendesk --plugins-directory ./plugins
```

OpenDesk 会扫描该目录的一级子目录和 `.js`、`.mjs`、`.cjs` 单文件插件，并在 TUI
启动前完成注册。相对路径以当前工作目录为基准；该参数只对本次进程生效，不修改全局插件目录或
`setting.json`。

## 内置插件

OpenDesk 可以在仓库的 `resources/plugins` 中维护随应用发布的内置插件源码。每个一级子目录是一个
独立插件，并且必须包含 `opendesk.plugin.json` 和其中声明的主入口：

```text
resources/plugins/
└── builtin-review/
    ├── opendesk.plugin.json
    ├── index.mjs
    └── helper.mjs
```

执行 `npm run build:plugins`、`npm run build` 或 `npm run build-cli` 时，OpenDesk 会先重建
`packages/plugin-sdk` 的产物（`npm run build:plugin-sdk`），再将每个内置插件
复制到只读运行时目录：

```text
dist/plugins/
└── builtin-review/
    ├── opendesk.plugin.json
    └── index.mjs
```

内置插件入口必须是可直接运行的 `.js`、`.mjs` 或 `.cjs` 文件；构建流程不会编译 TypeScript。
当前内置插件构建流程只负责复制插件目录；内置 Skill 和 MCP 的独立构建规则尚未纳入该流程。

内置插件按裸包名 `@bitclub.ai/opendesk-plugin-sdk` 引入 SDK，运行时解析到
`packages/plugin-sdk/dist`。该产物由独立的 rollup 构建生成，不在 electron-vite / esbuild
的编译图中，因此改动 SDK 源码后必须重新执行上述任一构建命令；否则新增的导出在运行时不存在，
插件会以 `does not provide an export named ...` 加载失败。

Electron 打包时，`dist/plugins` 会作为只读资源复制到 `process.resourcesPath/plugins`；独立
CLI/TUI 从可执行文件相邻的 `dist/plugins` 读取相同产物。开发环境也加载 `dist/plugins`，
因此修改内置插件源码后需要重新执行插件构建或重启开发命令。

内置插件在 pluginmgr 中的来源为 `builtin`，默认启用且不允许卸载。启停、权限和 options
只作为用户策略写入 pluginmgr 注册表，不会修改内置插件文件。内置插件 ID 具有最高优先级；
用户目录、安装到 plugins 目录或外部路径中的同 ID 插件不会覆盖内置插件。

## 最小 Tool 插件

插件入口默认导出由 `definePlugin` 创建的对象：

```ts
import { definePlugin, tool } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'hello',
    capabilities: ['tool'],
    setup(ctx) {
        ctx.tools.register(
            tool({
                name: 'greet',
                description: 'Generate a greeting',
                args: {
                    name: tool.schema.string()
                },
                async execute(args, context, result) {
                    result.attachResult(`Preparing greeting for ${args.name}`);
                    return {
                        output: `Hello ${args.name}`,
                        resultObject: {
                            workspace: context.workspace
                        }
                    };
                }
            })
        );
    }
});
```

工具会以 `hello-greet` 的名字进入 OpenDesk 工具注册表。`setup` 可以返回清理函数或
`PluginRegistration`；插件停用、重载或宿主退出时会释放注册项。

## 其他能力的最小入口

上一节已经给出 Tool 插件。以下示例分别是其余五种 capability 的独立最小 `index.mjs`；实际插件可以在
同一 `setup` 中组合多种 capability。若使用 TypeScript 编写，请先将源码编译为 manifest 指向的
`.js`、`.mjs` 或 `.cjs` 文件。

### Hook 插件

```js
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'request-header-example',
    capabilities: ['hook'],
    setup(ctx) {
        ctx.hooks.on('chat.headers', (_input, output) => {
            output.headers['x-example-plugin'] = 'enabled';
        });
    }
});
```

### Skill 插件

```js
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'review-skill-example',
    capabilities: ['skill'],
    setup(ctx) {
        ctx.skills.register({
            name: 'review-code',
            description: 'Review code changes and report actionable findings.',
            body: '# Review Code\n\nInspect the requested change and report findings.',
            userInvocable: true,
            modelInvocable: true
        });
    }
});
```

### MCP 插件

```js
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'project-mcp-example',
    capabilities: ['mcp'],
    setup(ctx) {
        ctx.mcps.registerServer({
            name: 'project-files',
            transport: 'stdio',
            command: process.execPath,
            args: ['./mcp-server.mjs'],
            cwd: ctx.pluginDir
        });
    }
});
```

`mcp-server.mjs` 必须位于插件目录中并实现对应的 MCP Server；也可以改用 `sse` 或
`streamableHttp` 并提供远程 `url`。

### Command 插件

```js
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'command-example',
    capabilities: ['command'],
    setup(ctx) {
        ctx.commands.register({
            name: 'plugin-status',
            description: 'Show the current plugin workspace.',
            execute(_args, context) {
                return {
                    title: 'Plugin status',
                    output: `Workspace: ${context.workspace ?? '<none>'}`
                };
            }
        });
    }
});
```

### Event 插件

```js
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'event-audit-example',
    capabilities: ['event'],
    setup(ctx) {
        ctx.events.onApplication({}, (event) => {
            console.info('[event-audit-example]', event.application, event.event, event.args);
        });
    }
});
```

传入空过滤器会订阅所有 Application 事件；可通过
`{ application: 'bundle-name', event: 'event-name' }` 限制到一个应用或事件名称，具体名称由对应
Application 定义。

### Browser 插件

`browser` capability 让插件为特定网站向 `use-browser` 注入页面提示（Browser Hints）：

```js
import { actionHint, definePlugin, textHint } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'browser-hint-example',
    capabilities: ['browser'],
    setup(ctx) {
        // urlPrefix 不含协议部分，按前缀匹配页面地址
        ctx.browser.hint.register('www.example.com', async (context) => [
            textHint('This site only supports English keywords.'),
            actionHint(
                'Search',
                'Fill the keyword and submit the search form in one step',
                { keyword: 'The keyword to search' },
                '(args) => { document.querySelector("#q").value = args.keyword; document.querySelector("#go").click(); }'
            )
        ]);
    }
});
```

- 生成器签名为 `(context: BrowserContext) => BrowserHint[] | Promise<BrowserHint[]>`。
- `BrowserContext` 提供 `url`（含协议）、`domain`、`address`（去掉协议的地址，即与 `urlPrefix`
  匹配的字段）、`title`，以及按需拉取原始 DOM 的 `dom()`；不调用 `dom()` 就不会产生额外页面通信。
- `textHint(content)` 产生 `TextHint`，作为一段约束或说明附加到快照上。
- `actionHint(name, description, args, functionStr)` 产生 `ActionHint`。`functionStr` 是页面内可
  `eval` 为函数的 JS 源码，模型通过 browser 的 `trigger` 工具调用，宿主以 `fn(args)` 形式执行它。
- 同一个 `urlPrefix` 可以注册多次，多个插件的 hint 会被合并；单个生成器抛错只记录插件诊断，
  不影响其他插件与快照本身。

快照会在最前面按分类输出命中的提示：

```text
## Browser Hints

### Text Hints

- This site only supports English keywords.

### Action Hints

Actions are only available in this page and should be invoked by the 'trigger' tool.

- Search(keyword): Fill the keyword and submit the search form in one step
  - keyword: The keyword to search
```

Browser 插件的最小实现参考见 `src/tests/ut/applications/browser-hint-tools.test.ts`
中的内联 fixture（注册、快照渲染、trigger 执行的完整链路）。

## 使用 opendesk.plugin.json

推荐的本地插件结构：

```text
review-helper/
├── opendesk.plugin.json
├── index.js
├── skills/
│   └── review-code/
│       └── SKILL.md
└── mcps/
    └── project-files.js
```

`opendesk.plugin.json` 示例：

```json
{
    "schemaVersion": 1,
    "id": "review-helper",
    "displayName": "Review Helper",
    "entry": "./index.js",
    "apiVersion": 1,
    "capabilities": ["skill", "mcp"],
    "resources": {
        "skills": ["./skills/review-code"],
        "mcpServers": [
            {
                "name": "project-files",
                "transport": "stdio",
                "command": "node",
                "args": ["./mcps/project-files.js"],
                "cwd": "."
            }
        ]
    }
}
```

即使插件只有静态 Skill 或 MCP 声明，仍需要一个入口。最小的 `index.js` 可以只包含：

```js
export default {
    id: 'review-helper',
    setup() {}
};
```

manifest 中的 `id` 必须与入口导出的插件 `id` 一致。`capabilities` 可使用：
`hook`、`tool`、`skill`、`mcp`、`command`、`event`、`agent`、`browser`。声明静态 Skill、MCP
或 Agent 时，必须同时声明对应的 `skill`、`mcp` 或 `agent` capability。

### displayName 本地化

`displayName` 支持两种形式，`opendesk.plugin.json`、`package.json#opendesk` 和插件入口对象均适用：

- 简单字符串：所有语言下显示同一名称；
- 本地化对象：按语言声明名称，键为 BCP 47 语言标签（如 `en`、`zh`、`zh-CN`），
  值为该语言下的显示名称。

```json
{
    "schemaVersion": 1,
    "id": "locale-demo",
    "displayName": {
        "en": "Locale Demo",
        "zh": "本地化示例插件"
    },
    "entry": "./index.js",
    "apiVersion": 1,
    "capabilities": []
}
```

解析时只比较语言主标签（请求 `zh-CN` 时 `zh-CN` 与 `zh-TW` 等键都视为中文条目）；
没有匹配语言的条目时回退到对象中声明的第一个翻译；对象中的每个值都必须是非空字符串。
插件中心按当前界面语言显示插件名称，并在应用切换语言后实时更新；
未声明 `displayName` 时回退到插件 ID。

### Skill 路径

`resources.skills` 中每一项都必须是插件根目录内的目录，不能直接指向
`SKILL.md` 文件：

- `SKILL.md` 就在插件根目录：`"skills": ["."]`
- 文件位于 `skill/SKILL.md`：`"skills": ["./skill"]`
- `skills/` 下有多个各自包含 `SKILL.md` 的一级子目录：`"skills": ["./skills"]`

扫描某个父目录时只读取它的一级 Skill 子目录，不会递归搜索更深层级。

### MCP 声明

支持 `stdio`、`sse` 和 `streamableHttp` transport。相对的 `command` 与 `cwd` 必须留在
插件根目录内；上例通过将 `cwd` 设为 `"."`，让 Node 从插件根目录解析相对参数。

插件贡献的 MCP 会出现在 GUI 的 MCP 管理器中，来源优先显示插件的
`displayName`（支持本地化对象形式，按当前界面语言解析），未声明时回退到插件 ID。
这类配置由插件拥有，因此在 MCP 管理器中只读；应通过插件中心启停插件或修改插件配置。

## 使用 package.json#opendesk

npm 插件包必须包含标准 `package.json`。它既可以保留独立的 `opendesk.plugin.json`，
也可以把同样的声明放在 `package.json` 的 `opendesk` 字段：

```json
{
    "name": "opendesk-plugin-review-helper",
    "version": "1.0.0",
    "type": "module",
    "opendesk": {
        "plugin": "./dist/plugin.js",
        "schemaVersion": 1,
        "id": "review-helper",
        "displayName": "Review Helper",
        "apiVersion": 1,
        "capabilities": ["skill", "mcp"],
        "resources": {
            "skills": ["./skills/review-code"],
            "mcpServers": [
                {
                    "name": "project-files",
                    "transport": "stdio",
                    "command": "node",
                    "args": ["./mcps/project-files.js"],
                    "cwd": "."
                }
            ]
        }
    },
    "dependencies": {
        "@bitclub.ai/opendesk-plugin-sdk": "^0.3.4"
    }
}
```

两种文件分工不同：

- `package.json` 是 npm/Node.js 的包元数据和依赖清单。
- `opendesk.plugin.json` 是 OpenDesk 插件协议，可用于没有 npm 包元数据的本地插件。

如果两处同时声明，入口和 id 必须一致。通过插件中心或 CLI 安装要求包中存在有效 `package.json`，
并且具有 `opendesk.plugin.json` 或 `package.json#opendesk` 声明；仅有
`package.json#exports["./opendesk"]` 不能通过安装校验。

发布前可校验包结构：

```bash
opendesk-plugin-sdk validate ./opendesk-plugin-review-helper
```

## 在 setup 中动态注册 Skill 和 MCP

不使用静态 resources 声明时，也可以完全在 `setup` 中注册：

```ts
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'review-helper',
    capabilities: ['skill', 'mcp'],
    setup(ctx) {
        ctx.skills.register({
            name: 'review-code',
            description: 'Review code changes and report actionable findings.',
            body: [
                '# Review Code',
                '',
                'Inspect the requested change, prioritize correctness and security,',
                'and report findings with concrete file locations.'
            ].join('\n'),
            userInvocable: true,
            modelInvocable: true
        });

        ctx.mcps.registerServer({
            name: 'project-files',
            transport: 'stdio',
            command: 'node',
            args: [`${ctx.pluginDir}/mcps/project-files.js`],
            cwd: ctx.pluginDir
        });
    }
});
```

这种方式适合根据 `ctx.options`、操作系统或运行环境动态决定 contribution。静态 manifest
更适合可在执行插件代码之前校验的固定资源；两种方式可以同时使用。

## 无 manifest 的本地插件

手工放入 `plugins/` 的单个 `.js`、`.mjs`、`.cjs` 文件不要求 manifest。
目录插件没有声明入口时，会依次查找：

```text
index.js
index.mjs
index.cjs
```

这类插件只能通过入口的 `setup` 动态注册 contribution，`pluginmgr` 不会根据约定自动扫描
旁边的 `skills/` 或 `mcps/`。如果要声明静态资源，可为目录增加
`opendesk.plugin.json`；单文件 `hello.mjs` 也可以使用同目录下的
`hello.opendesk.plugin.json` sidecar manifest。

OpenDesk 不会编译 TypeScript 插件入口。第三方依赖仍需要插件自己的 `node_modules`，入口必须是
Node.js 可以直接运行的 `.js`、`.mjs` 或 `.cjs` 文件。

## 安装和管理

通过 GUI“插件中心”或 CLI 显式安装时，`pluginmgr` 会把插件安装到 `plugins/` 目录下的独立容器；
npm spec 由 npm 安装，ZIP 和 TGZ 则只在声明了运行时依赖时调用 npm：

```bash
opendesk plugins install opendesk-plugin-review-helper@latest
opendesk plugins list
opendesk plugins disable review-helper
opendesk plugins enable review-helper
opendesk plugins uninstall review-helper
```

安装源可以是 npm spec、本地路径、ZIP、tarball 或 URL。GUI 中的 npm、目录、ZIP、TGZ 和 URL
入口都会校验后复制到全局 `plugins` 目录并写入注册记录，因此可以通过 GUI 或 CLI 卸载。
`externalPaths` 仅用于在配置文件中显式指向不复制的开发插件。

CLI 安装命令接收的本地目录同样直接校验并复制包含 `opendesk.plugin.json` 或
`package.json#opendesk` 声明的插件目录，不要求 `package.json`，也不会执行 npm；目录插件依赖的
第三方包需要已经位于该目录的 `node_modules` 中。目录内容会直接复制到 `plugins/<插件ID>/`，
不会增加额外的 `plugin/` 中间层。ZIP 和 TGZ 位于同一归档层：统一下载、解压和校验；如果根目录
`package.json` 声明了 `dependencies` 或 `peerDependencies`，再安装这些运行时依赖，无运行时依赖的
归档不要求 npm。
所有 npm 安装路径都传递 `--omit=dev`、`--no-optional` 和 `--ignore-scripts`，不会安装开发依赖、
可选依赖，也不会运行插件或依赖的 npm 生命周期脚本。卸载适用于 `plugins/` 目录中的全部插件，
包括手工放入的插件文件或目录；内置插件不能卸载，外部目录插件应从 `externalPaths` 移除。

其他常用 CLI：

```bash
opendesk plugins status
opendesk plugins reload
opendesk plugins commands
opendesk plugins tools
opendesk plugins config review-helper '{"strict":true}'
opendesk plugins permissions review-helper
opendesk plugins grant review-helper skill mcp
opendesk plugins revoke review-helper mcp
opendesk plugins verify review-helper
opendesk plugins doctor
```

需要机器可读输出的 `status`、`reload`、`verify` 和 `doctor` 支持 `--json`。

GUI 中通过“插件中心”应用安装和管理插件；TUI 中通过“设置 → 插件中心”查看、重新加载、
启停和卸载。`opendesk plugins` CLI、GUI、TUI、headless CLI 和 serve 模式共用同一套
`pluginmgr` 注册表和插件宿主。

`pluginmgr` Application 还会向 Agent 提供 `manage-plugins` Skill，其中包含
`listPlugins`、`getPluginDetails`、`installPlugin`、`uninstallPlugin`、
`setPluginEnabled` 和 `reloadPlugins` 工具。插件列表和详情读取默认允许；安装、卸载、
启停和重新加载会通过 `plugin` 权限资源请求用户确认。Agent 安装仍遵循上述 OpenDesk
插件校验、plugins 目录和 `--ignore-scripts` 规则。

## 生命周期和安全边界

插件按以下流程加载：

```text
discover
  -> resolve entry
  -> validate path containment and recorded integrity
  -> read manifest and static resources
  -> verify the entry is directly runnable
  -> import plugin
  -> validate API version, capability grants and options
  -> register static resources
  -> setup(ctx)
```

`setup` 失败会释放本次激活已创建的注册项。插件停用或宿主重载时，Hook、工具、Skill、MCP、
命令和事件监听都会随所属插件释放。

Hook 按插件激活顺序串行执行。默认 `failureMode: 'open'` 会记录失败并继续主流程；
安全或认证场景可以在注册 Hook 时指定 `failureMode: 'closed'`，让异常阻止对应操作。
带有完整性基线（安装时写入的 integrity 记录）的插件在 import 前检查安装内容完整性；
手工放入和外部插件没有基线，标记为 unmanaged，不进行内容锁定。

## Runtime Hooks

### Skill Hooks

`skill.load.before` 和 `skill.load.after` 的输入只描述被加载的 Skill：`bundleName`、`skillName`、
`skillDirectory`、`source` 和 `frontmatter`。它们不暴露 `taskId`、`workspace`、`agentId` 或 Skill 正文；
`skill.load.after` 仅表示具体 Skill 已成功加载。

`skill.load.before` 的输出结构如下。`message` 和 `metadata` 对 `allow`、`deny` 使用同一组顶层字段；
只有 `operation: 'deny'` 会阻止加载，`allow` 携带的消息仅供插件链中的后续 Hook 观察。

```ts
{
    operation: 'allow' | 'deny';
    message?: string;
    metadata?: Record<string, unknown>;
}
```

`skill.install.before` 在单个用户 Skill 写入前触发，可通过同样的输出结构拒绝安装；
`skill.install.after` 仅在安装成功后触发，并在输入中增加最终的 `skillName`。安装上下文通过 `source`
区分 `directory`、`zip`、`url` 和 `registry`，并按来源提供 `path`、`url`、`skillRelPath`、`force`
或 `customName`。

GUI 单项安装使用以下调用链，实际下载、解压、状态更新和 Registry 同步仍由既有 Worker 完成：

```text
GUI callMainWorld
  -> SkillMgrApplication
  -> skill.install.before
  -> SkillMgr Worker
  -> skill.install.after
```

插件 Hook 定义在 `packages/plugin-sdk` 的 `PluginHookMap` 中，并在 `setup(ctx)` 内注册。

当前运行时 Hook 包括：

- `chat.headers`：在当前模型请求前追加或改写 HTTP Header。
- `chat.params`：在当前模型请求前调整推理强度和最大输出 token。
- `skill.load.before`：在 Agent 明确加载某个 Skill 时触发，可通过 `output.operation = 'deny'` 拒绝本次加载。
- `skill.load.after`：某个 Skill 成功加载并生成完整正文后触发，仅用于观测和审计。
- `skill.install.before`：用户 Skill 安装前触发，可拒绝安装。
- `skill.install.after`：用户 Skill 安装成功后触发，仅用于观测和审计。
- `tool.definition`：调整工具在模型侧可见的描述和参数 Schema。
- `tool.validate.before`：在参数校验前修改工具参数或拒绝本次执行（对应 aikernel 的 `beforeToolCallValidate`）。
- `tool.execute.before`：在执行前（权限检查之后）拒绝本次执行或读取参数做审计（**不可修改参数**，以免绕过权限检查）（对应 aikernel 的 `beforeToolCall`）。
- `tool.execute.after`：在工具完成后修改状态、文本结果或结构化结果。
- `permission.ask`：对权限请求返回 `ask`、`allow` 或 `deny`。
- `shell.env`：为终端 Shell 请求调整环境变量。

当前插件 API 暂不提供 `chat.message` 和 `chat.messages.transform`。JavaScript 插件注册未知 Hook 名时会在
`setup` 阶段失败；TypeScript 插件可以使用 `PluginHookName` 或 `OPENDESK_PLUGIN_HOOK_NAMES` 获得同一套有效名称。
`chat.headers` 和 `chat.params` 共享 `PluginChatRequestInput`，但使用独立输出对象并依次执行。单个 Hook
回调失败时，只回滚该 Hook 的修改；`chat.headers` 不会改写模型参数，`chat.params` 也不会改写 Header。

`skill.load.before` 和 `skill.load.after` 只对应一次具体的 Skill 加载请求，例如 Agent 调用 `LoadSkill` 或用户通过
`/skill-name` 预加载。Skill 列举、目录扫描、registry refresh，以及 `CallSkillTool` 调用已加载 Skill 的内部工具，
都不会触发这组 Hook。`before` 拒绝时不会执行 Skill 的环境变量合并，也不会触发 `after`；插件异常是否阻止加载仍由
插件注册时的 `failureMode` 决定。

工具调用顺序如下：

```text
解析模型参数
  -> tool.validate.before（参数校验前，可修改参数或拒绝）
  -> 参数校验（使用修改后的参数）
  -> 权限检查
  -> tool.execute.before（执行前，仅可拒绝，不可修改参数）
  -> 执行工具
  -> tool.execute.after
```

`failureMode` 是插件运行时的错误策略：`open` 会记录错误并继续后续插件，`closed` 会抛出插件 Hook 错误并停止当前
插件 Hook 链。插件可以在单个 Hook 注册时覆盖默认值：

```ts
ctx.hooks.on('permission.ask', callback, { failureMode: 'closed' });
```

插件 API 不提供其他错误调度选项；插件作者只需要按上述语义配置 `failureMode`。

通过 `ctx.hooks.on`、`ctx.tools.register`、`ctx.skills.register`、`ctx.mcps.registerServer`、`ctx.commands.register`
和 `ctx.events.onApplication` 创建的注册项，都会在插件停用、重载或宿主退出时按逆序释放。
`setup` 返回的清理函数也会在同一生命周期执行。插件自行注册到进程或第三方库的监听器必须在该清理函数中主动移除。
