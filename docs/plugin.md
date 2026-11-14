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
    ├── data/                            # 各插件的私有数据目录（插件代码之外的持久化区域）
    │   └── <插件ID>/
    └── trash/                           # 被替换或卸载的插件
```

### 插件私有数据目录

每个插件都可以通过 `ctx.dataDir` 拿到自己的私有数据目录：

```text
plugins/.pluginmgr/data/<插件ID>/
```

该目录从 0.3.10 起由宿主在插件激活前创建（创建失败不会阻断插件加载，插件写入时才会报错），适合
存放插件自己的状态文件、缓存、媒体文件等。它与插件代码目录（`plugins/<插件ID>/`）分离，因此：

- 覆盖安装、升级插件不会影响已有数据；
- 卸载插件默认**保留**数据目录，重新安装同一个插件 ID 后可以直接继承原有数据；
- 在插件中心卸载时，确认弹窗提供“同时删除该插件的数据目录”复选框（默认不勾选），
  勾选后数据目录会被直接删除且不可恢复（插件代码目录则照旧移入 `.pluginmgr/trash/`）。

插件不应把持久化数据写入 `ctx.pluginDir`：那是代码目录，会被覆盖或删除。

直接把插件目录或 `.js`、`.mjs`、`.cjs` 文件放进 `plugins/`，重启 OpenDesk
即可被发现，也可以在插件中心执行重新加载。扫描过程不会执行 `npm install`；直接放入目录的本地
插件必须已经包含自身所需依赖，并能从自己的 `node_modules` 中解析它们。

> 例外：`@bitclub.ai/opendesk-plugin-sdk`（含 `./package` 子路径）和其运行时
> 依赖 `zod` 以及账号插件使用的 `@bitclub.ai/opendesk-server-sdk` 由宿主进程内置。pluginmgr 启动时注册 ESM 解析映射：插件入口
> `import` 这些包时，先按插件自己的 `node_modules` 解析（尊重插件声明的版本）；
> 解析失败时回退到宿主内置的同名包。宿主内置包优先从主进程模块链的
> `node_modules` 解析；SDK 在 `node_modules` 下只是一个指向 workspace 目录的符号
> 链接，打包、复制或裁剪应用目录时可能不被保留，此时回退到应用根目录下的
> workspace 包（`packages/plugin-sdk`）。因此插件即使省略 SDK 的
> `node_modules`（例如鸿蒙端安装的目录插件无法执行 npm install）也能正常
> 加载。其他第三方依赖仍必须由插件自带。

除了随应用发布的内置插件目录与 `plugins/` 目录，还可以指定若干「附加插件目录」。三个来源
等价，按顺序合并去重：环境变量 `OPENDESK_PLUGINS_DIRECTORY`、CLI 参数 `--plugins-directory`、
`setting.json` 里的 `applications.pluginmgr.externalPaths`：

```bash
# 逗号分隔多个目录，只对本次进程生效
opendesk --plugins-directory ./team-plugins,./exp/plugins

# --plugins-directory 是根命令的全局选项，写在子命令之后同样生效
opendesk serve --plugins-directory ./team-plugins

# 环境变量：对 CLI / TUI / GUI / serve 全部生效，语义与 CLI 参数一致
OPENDESK_PLUGINS_DIRECTORY=./team-plugins,./exp/plugins opendesk
```

```json
{
    "applications": {
        "pluginmgr": {
            "externalPaths": ["D:/projects/my-plugin", "./external-plugins"]
        }
    }
}
```

相对路径：CLI 与环境变量以当前工作目录为基准，`externalPaths` 以 OpenDesk 配置目录为基准。
外部目录中的插件同样按内置插件处理（来源 `builtin`、不允许卸载），但**优先级低于默认内置
插件目录**：与内置插件同 ID 的条目不参与发现（忽略并记一条 warning）；多个附加目录之间同 ID
时，靠前的目录优先。

想直接上手验证，仓库里的 `test/test-plugin` 就是一个最小样例（含 tool / command / hook 接线与
验证步骤，见其 README）。

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

`packages/plugin-sdk/dist` 在 Electron 打包布局下位于应用根；插件加载阶段通过
`package-mapping.ts` 的 workspace 兜底（见上文「内置模块」例外）直接从应用根定位该产物，
不依赖 `node_modules` 中 SDK 链接是否存在。

Electron 打包时，`dist/plugins` 会作为只读资源复制到 `process.resourcesPath/plugins`；独立
CLI/TUI 从可执行文件相邻的 `dist/plugins` 读取相同产物。开发环境也加载 `dist/plugins`，
因此修改内置插件源码后需要重新执行插件构建或重启开发命令。

内置插件在 pluginmgr 中的来源为 `builtin`，默认启用且不允许卸载。启停、权限和 options
只作为用户策略写入 pluginmgr 注册表，不会修改内置插件文件。内置插件 ID 具有最高优先级；
用户目录里安装到 plugins 目录的同 ID 插件不会覆盖内置插件。

### 附加插件目录

附加插件目录（见上文「插件目录」）与默认内置插件目录合并扫描，其中的插件同样按内置插件处理
（来源 `builtin`、不允许卸载、清单里的 `system` 生效），但优先级低于默认内置插件目录。

目录里的条目按「是否是合法插件」过滤：必须是包含 `opendesk.plugin.json`（或在 `package.json`
中声明 `opendesk.plugin` 入口）的目录；整个目录本身就是一个插件目录时也能直接识别。文档、散装
脚本等**不是插件**的条目直接跳过、不产生诊断，而**自称是插件却加载不了**的目录（清单入口写错、
入口文件缺失、清单损坏等）会留一条 warning，避免插件只是从列表里悄悄消失。

目录不存在或不是目录时其余目录照常加载：显式传入的 `--plugins-directory` 会在终端给出
`[warn]`，环境变量与 `externalPaths` 则记 warning 日志（TUI 日志面板 / GUI 日志可见）。

附加目录中的插件与内置插件一样只读：启停、权限与 options 写入 pluginmgr 注册表，插件文件
不会被修改。位于默认内置目录之外的附加目录插件以绝对路径写入注册表——不同目录之间可能有
同名容器目录，相对路径无法唯一还原到原目录。

生效范围：

- 附加目录只是补充，不覆盖内置插件：与内置插件同 ID 的条目不参与发现（忽略并记一条 warning）。
  多个附加目录之间同 ID 时，靠前的目录优先（环境变量 → CLI 参数 → `externalPaths`）。
- 「按内置插件处理」也包括清单里的 `system`：附加目录里的插件声明 `system: true` 后，启停同样
  由清单固定，pluginmgr 不再允许切换开关。
- 附加目录只在启动时生效。目录不再传入后，注册表里残留的启停/options 记录不会让插件继续加载；
  该目录里的插件重新被发现时会沿用旧记录里的启停与 options。

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

工具会以 `hello-greet` 的名字进入 OpenDesk 工具注册表，并放入名为 `plugin-hello` 的独立 Toolset；
Toolset 内部和插件中心都显示本地名 `greet`，模型侧最终名称为 `plugin-hello-greet`。`setup` 可以返回
清理函数或 `PluginRegistration`；插件停用、重载或宿主退出时会释放注册项。

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

Command 支持纯文本和结构化参数两种模式。未声明 `args` 时，命令名称之后的内容会作为一个完整字符串
传给 `execute`，适合简单的 Slash Command：

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

Command 的本地名称必须使用小写 kebab-case，只能包含小写字母、数字和 `-`，且必须以字母开头。
插件只填写本地名称，不要自行增加插件 ID 前缀。OpenDesk 注册时会自动增加插件 ID 前缀，上例的
完整命令名是 `command-example.plugin-status`。可以通过 CLI 或 TUI/GUI Slash Command 执行：

```bash
opendesk plugins run command-example.plugin-status hello world
```

```text
/command-example.plugin-status hello world
```

纯文本模式的 `execute` 接收 `args: string`，不进行类型转换和参数校验。需要必填参数、选项、默认值
或类型校验时，声明结构化 `args`：

```js
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'deploy-example',
    capabilities: ['command'],
    setup(ctx) {
        ctx.commands.register({
            name: 'deploy',
            description: '部署项目',
            args(command) {
                command
                    .argument('<environment>', '目标环境')
                    .option('-f, --force', '强制部署')
                    .option('-r, --replicas <count>', '副本数量', {
                        type: 'number',
                        defaultValue: 1
                    })
                    .option('--format <format>', '输出格式', {
                        choices: ['text', 'json'],
                        defaultValue: 'text'
                    });
            },
            execute(args, context) {
                return {
                    title: '部署参数',
                    output: JSON.stringify({ args, workspace: context.workspace }, null, 2)
                };
            }
        });
    }
});
```

```bash
opendesk plugins run deploy-example.deploy production --replicas 3 --force
```

结构化回调收到：

```js
{
    environment: 'production',
    force: true,
    replicas: 3,
    format: 'text'
}
```

`argument()` 与 Commander 一样使用 `<name>`、`[name]`、`<name...>` 和 `[name...]` 表示必填、可选
及可变长位置参数；第三个参数可声明 `string`/`number` 转换、默认值和候选值。`option()` 支持长短
选项、布尔开关、带值或可变长选项、默认值及候选值；必须出现的选项使用 `requiredOption()`。
OpenDesk 会拒绝未知选项、缺失的必填参数、无效数字和候选值，并在 CLI、TUI、GUI 中显示错误及
自动生成的 usage；解析失败时不会调用插件的 `execute`。

OpenDesk 全局参数应写在 `plugins` 之前：

```bash
opendesk --workspace D:/project plugins run deploy-example.deploy production --force
```

如果插件命令需要使用与 OpenDesk 全局参数同名的选项，在插件参数前增加 `--`：

```bash
opendesk --workspace D:/project plugins run deploy-example.deploy -- --workspace staging
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
        // 字符串不含 * 时按前缀匹配页面地址（不含协议部分）
        ctx.browser.hint.register('www.example.com', async (context) => [
            textHint('This site only supports English keywords.'),
            actionHint(
                'Search',
                'Fill the keyword and submit the search form in one step',
                { keyword: 'The keyword to search' },
                '(args) => { document.querySelector("#q").value = args.keyword; document.querySelector("#go").click(); }'
            )
        ]);
        // 字符串含 * 时按通配符整体匹配路径：* 匹配单段，** 跨段
        ctx.browser.hint.register('www.example.com/repo/*/issues', () => [textHint('Issues list page.')]);
        // RegExp 直接对去协议后的完整地址做正则匹配
        ctx.browser.hint.register(/^www\.example\.com\/wiki(\/.*)?$/, () => [textHint('Wiki page.')]);
    }
});
```

- 生成器签名为 `(context: BrowserContext) => BrowserHint[] | Promise<BrowserHint[]>`。
- `BrowserContext` 提供 `url`（含协议）、`domain`、`address`（去掉协议的地址，即地址匹配
  pattern 的作用对象）、`title`，以及按需拉取原始 DOM 的 `dom()`；不调用 `dom()` 就不会产生额外页面通信。
- 地址 pattern 支持三种写法：
    - 字符串不含 `*`：按前缀匹配，前缀需结束在 `/`、`?`、`#` 或地址末尾的边界上
      （因此 `www.example.com` 不会命中 `www.example.com.evil.com`）；
    - 字符串含 `*`：按通配符整体匹配路径，`*` 匹配单段（不含 `/`），`**` 跨段（中段的
      `/**/` 允许匹配零段），query 与 hash 不参与匹配；
    - RegExp：对去协议后的完整地址（含 query）做正则匹配。
- `textHint(content)` 产生 `TextHint`，作为一段约束或说明附加到快照上。
- `actionHint(name, description, args, functionStr)` 产生 `ActionHint`。`functionStr` 是页面内可
  `eval` 为函数的 JS 源码，模型通过 browser 的 `trigger` 工具调用，宿主以 `fn(args)` 形式执行它。
- 同一个 pattern 可以注册多次，多个插件的 hint 会被合并；单个生成器抛错只记录插件诊断，
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

### Account Backend

`account` capability 用于注册账号后端。账号页面、`personal` / `enterprise` 产品类型以及企业私有服务地址的配置仍由
OpenDesk 主程序管理；主程序在登录时把解析后的 `kind` 和 `baseUrl` 传给插件。插件负责客户端创建、登录、会话恢复、
刷新、登出和用户信息转换，并通过宿主提供的 opaque secret store 持久化私有凭据。返回给主程序的公开 session 不应包含 token。
浏览器登录可在 flow 的 `start()` 中调用 `context.accounts.auth.openExternal()`，并通过 `poll()` 返回后续状态。

当前宿主只允许注册一个账号后端，该后端同时作为启动时恢复会话和登录操作的默认实现。第二个后端注册会失败；
需要支持多个账号后端时，再扩展后端选择和会话路由协议。

```js
import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'example-account',
    capabilities: ['account'],
    setup(context) {
        context.accounts.registerBackend({
            id: 'example',
            kinds: ['personal', 'enterprise'],
            initialize() {},
            getSession() {
                return null;
            },
            async getLoginMethods() {
                return [
                    {
                        id: 'password',
                        type: 'form',
                        displayName: { en: 'Password', zh: '密码登录' },
                        fields: [
                            { id: 'username', type: 'text', label: { en: 'Username', zh: '用户名' }, required: true },
                            { id: 'password', type: 'password', label: { en: 'Password', zh: '密码' }, required: true }
                        ]
                    }
                ];
            },
            async createLoginFlow({ kind, baseUrl, methodId }) {
                let state = { status: 'ready' };
                return {
                    getState: () => state,
                    async submit(values) {
                        // Use context.accounts.network.fetch and persist private credentials through context.accounts.secrets.
                        state = { status: 'failed', errorCode: 'not_implemented' };
                        return state;
                    },
                    async cancel() {}
                };
            },
            async getUserInfo() {
                return null;
            },
            async updateDisplayName() {
                throw new Error('not_implemented');
            },
            async refreshToken() {
                throw new Error('not_implemented');
            },
            async logout() {
                context.accounts.secrets.clear();
            }
        });
    }
});
```

凭据存储按插件 id 隔离：`context.accounts.secrets` 的读写只作用于 `<opendesk-dir>/identity/secrets/<插件 id>.json`，
插件之间互不可见。`network`、`auth`、`secrets` 和 `registerBackend` 的每次调用都会校验插件已声明并获授 `account`
capability。

随产品包发布的 `opendesk-account` 是当前内置实现，约定始终启用且不可卸载；这一状态目前靠产品约定维持
（未在其清单里用 `system` 固定），用户仍可自行禁用。内置插件可以用清单里的 `system: true` 把启停状态
真正固定下来（见下文「system 与 enabled」），但插件管理层没有提供 `required` 这类「必备插件」机制。

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
    "id": "review-helper",
    "displayName": "Review Helper",
    "description": "审阅代码并给出可执行的修改建议。",
    "entry": "./index.js",
    "apiVersion": 1,
    "capabilities": ["skill", "mcp"],
    "homepage": "https://example.com/review-helper",
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
`hook`、`tool`、`skill`、`mcp`、`command`、`event`、`agent`、`browser`、`account`。声明静态 Skill、MCP
或 Agent 时，必须同时声明对应的 `skill`、`mcp` 或 `agent` capability。

清单里**没有** `schemaVersion` 字段：它不参与任何版本协商，写与不写解析结果一样
（旧清单里残留的这个键会按未知字段忽略）。

### 版本字段

`version`、`minOpenDeskVersion`、`maxOpenDeskVersion` 都是 **SemVer 版本号**（`1.2.3`，
可带 `-beta.1` 这类预发布标识，允许 `v` 前缀），解析失败会直接让清单校验报错
（`plugin.manifest_invalid_version` 等），不会退化成"跳过版本检查"。比较按 SemVer 优先级：
`1.2.3-beta < 1.2.3`，构建元数据 `+build` 不参与排序。

必须写足三段（`1.0.0`）：`1.0` 这类两段式不是合法 SemVer，会被拒绝而不是补齐成 `1.0.0`。

`minOpenDeskVersion` / `maxOpenDeskVersion` 分别是宿主版本的**下界与上界**（包含边界），
不是区间表达式：写 `0.2.0` 表示"宿主 ≥ 0.2.0"。未声明时不限制。

宿主在**安装期**就会用这两个字段拦截：无论从插件市场、本地目录/压缩包还是 npm 源安装，
当前 OpenDesk 版本不满足清单声明范围时安装直接失败，磁盘上不会留下这个包（市场界面按不满足的
方向弹「无法安装插件」的模态：宿主过低引导升级 OpenDesk，宿主过高引导寻找支持当前版本的
插件；CLI 与 AI 工具会输出带版本范围的原因）。安装期只读取清单
（`opendesk.plugin.json` / `package.json`）里的声明，不会执行插件代码；只在入口模块导出的
插件对象上声明的范围，由加载期诊断兜底。已装插件在宿主升级/降级后不再满足范围时，同样由
加载期的 `plugin.opendesk_version_too_old` / `plugin.opendesk_version_too_new`
诊断兜底（插件中心卡片与 `opendesk plugins status` 都会展示本地化后的原因）。

### system 与 enabled（仅内置插件）

随产品一起发布的内置插件可以在清单里声明两个布尔字段，把启停状态固定下来（当前 `opencodego`
即用该机制固定为始终启用）：

```json
{
    "id": "example-builtin",
    "entry": "./index.mjs",
    "apiVersion": 1,
    "capabilities": ["hook"],
    "system": true,
    "enabled": true
}
```

- `system: true`：该插件的开关由清单固定。插件中心（GUI / TUI）与 `opendesk plugins list`
  都会标出系统插件（GUI 开关置灰、TUI 不提供切换入口），`opendesk plugins enable/disable`
  与 `setPluginEnabled` 工具同样会被拒绝；
- `enabled`：`system` 固定时的实际状态。`true`（或缺省）表示始终启用；`false` 表示始终禁用，
  固定禁用的插件不会进入运行时，但仍会出现在插件列表里并标明原因。

这两个字段**只对内置插件生效**（含附加插件目录）。通过插件中心、`opendesk plugins install`
或手工放入 `plugins/` 目录的本地插件即使写了 `system` / `enabled`，宿主也只会在加载时记录一条
warning 并忽略它们，开关仍由用户控制。字段类型必须是布尔值，
否则清单校验失败（`plugin.manifest_invalid_system` / `plugin.manifest_invalid_enabled`）。

### displayName 与 description 本地化

`displayName` 与 `description` 支持两种形式，`opendesk.plugin.json`、`package.json#opendesk`
和插件入口对象均适用：

- 简单字符串：所有语言下显示同一文本；
- 本地化对象：按语言声明文本，键为 BCP 47 语言标签（如 `en`、`zh`、`zh-CN`），
  值为该语言下的文本。

```json
{
    "id": "locale-demo",
    "displayName": {
        "en": "Locale Demo",
        "zh": "本地化示例插件"
    },
    "description": {
        "en": "A demo plugin showing localized metadata.",
        "zh": "一个演示本地化元数据的示例插件。"
    },
    "entry": "./index.js",
    "apiVersion": 1,
    "capabilities": []
}
```

解析时只比较语言主标签（请求 `zh-CN` 时 `zh-CN` 与 `zh-TW` 等键都视为中文条目）；
没有匹配语言的条目时回退到对象中声明的第一个翻译；对象中的每个值都必须是非空字符串。
插件中心按当前界面语言显示插件名称与描述，并在应用切换语言后实时更新；
未声明 `displayName` 时回退到插件 ID，未声明 `description` 时不展示描述。

### category / author / homepage（市场展示）

`category`、`author`、`homepage` 是纯展示用元数据，不参与加载与权限判定：

```json
{
    "id": "review-helper",
    "entry": "./index.js",
    "apiVersion": 1,
    "capabilities": [],
    "category": ["办公文档"],
    "author": {
        "name": { "zh-CN": "张三", "en-US": "Zhang San" },
        "institution": { "zh-CN": "开放原子开源基金会", "en-US": "OpenAtom Foundation" },
        "homepage": "https://example.com/team"
    },
    "homepage": "https://example.com/review-helper"
}
```

- `category`：字符串数组。取值必须与插件所在市场（registry）`categories` 里声明的分类一致才会被归入
  该分类；未声明或没有命中任何分类时，插件仍出现在「全部插件」里。内置插件不声明它也能正常工作。
- `author.name` 必填、`author.institution` 可选，两者都支持简单字符串或本地化对象（规则同
  `displayName`）；`author.homepage` 只接受 http(s) 地址。
- `homepage` 是**插件自身**的站点地址（`author.homepage` 是作者/机构的主页），同样只接受 http(s)；
  插件详情会把两者都渲染成可点链接，点击交给系统浏览器打开。
- 展示位置：插件市场的卡片上显示「插件名 + 版本」与「`@作者 (机构)`」，插件详情的基本信息里追加
  作者 / 机构 / 作者主页 / 插件主页。
- 类型不符时清单校验失败：`plugin.manifest_invalid_category` / `plugin.manifest_invalid_author` /
  `plugin.manifest_invalid_homepage`。

### iconUrl（插件图标）

`iconUrl` 是插件的展示图标，出现在插件中心与插件市场的卡片上；不参与加载与权限判定，
未声明时按插件名渲染首字母图标。接受两种写法：

- **http(s) 图片链接**（`"iconUrl": "https://example.com/icon.png"`）：由界面直接加载；
- **包内相对路径**（`"iconUrl": "icon.png"`、`"./assets/icon.png"`，相对插件根目录）：
  指向随包分发的图片文件，宿主读取后转成 data URL 交给界面显示。

支持 `png` / `jpg` / `jpeg` / `gif` / `webp` / `svg` / `bmp` 扩展名；文件超过 1MB 或读不到时
按未声明处理（回退首字母图标），不影响插件加载。绝对路径、根相对路径与目录穿越（`..`）
都会让清单校验失败（`plugin.manifest_invalid_icon_url`）：图标由宿主读文件，
不能借这个字段读到插件目录之外。

### 与市场条目的一致性

插件市场条目（`plugins.json`）里的 `displayName` / `description` / `version` / `apiVersion` /
`platforms` / `category` / `author` / `homepage` / `minOpenDeskVersion` / `maxOpenDeskVersion` 与插件清单
同义。安装时主进程会拿包内清单与市场条目逐项核对，**两边都声明了**的
`version` / `minOpenDeskVersion` / `maxOpenDeskVersion` / `homepage` / `author` 必须一致
（版本类字段按 SemVer 比，`v1.0.0` 与 `1.0.0` 等价；URL 忽略结尾斜杠；本地化文本按主语言标签逐项
比较，只比两边都声明的语言）。

核对发生在**下载解压之后、落盘之前**：对不上就整单失败，磁盘上不会留下这一版，已安装的旧版本保持
不动；界面用模态弹窗告诉用户「插件信息与实际数据不匹配」并列出差异字段。`id` 不一致同样报错。

`displayName` / `description` 允许市场只提供部分语言，`category` 允许市场自行归类，因此不参与比较。

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

## 插件市场与插件渠道

插件中心按渠道拉取插件清单，每个启用的渠道都是一个独立市场，并在插件中心顶部**独占一个 Tab**
（Tab 名用渠道展示名，与「已安装」「内置插件」并列，和测评集应用的导航一致）；Tab 下面是该市场的
搜索框、分类切换与插件卡片：

- **设置 → 渠道设置 → 插件渠道**：官方市场固定排第一（地址写死，只能启用或禁用，不能改名、改地址、删除）；
  用户可以添加最多 20 个三方渠道，添加/编辑时主进程会把清单完整解析一遍，验证不过不落配置。
- 渠道配置保存在 `setting.json` 的 `applications.pluginmgr.channels`；被禁用的渠道既不拉清单，
  也不在插件中心里占 Tab。
- 环境变量 `OPENDESK_PLUGIN_CATEGORY` 可以把官方市场指向本地文件或自建 registry，便于调试。

清单格式（`plugins.json`）：

```json
{
    "categories": ["办公文档"],
    "plugins": [
        {
            "id": "opendesk-wps-slides",
            "displayName": { "zh-CN": "OpenDesk WPS Slides", "en-US": "OpenDesk WPS Slides" },
            "description": {
                "zh-CN": "在 WPS 演示里用自然语言生成幻灯片。",
                "en-US": "Generate WPS slides in natural language."
            },
            "version": "1.0.1",
            "apiVersion": 1,
            "platforms": ["win32", "openharmony"],
            "category": ["办公文档"],
            "author": { "name": "OpenDesk 团队", "institution": "开放原子开源基金会" },
            "homepage": "https://example.com/plugin",
            "downloadUrl": "https://example.com/static/plugins/opendesk-wps-slides-1.0.1.zip"
        }
    ]
}
```

- `categories` 可选：声明该市场支持哪些分类（界面上的「全部插件 / 分类A / 分类B」就来自它），
  省略表示这个市场不支持按分类显示。分类名是自由文本，需要与插件的 `category` 取值一致。
- 展示字段与插件清单（`opendesk.plugin.json`）同一口径，不再有「市场宽松、包内严格」的落差：
    - `version` 必须是合法 SemVer；
    - `apiVersion` 只接受宿主支持的插件 API 版本（当前为 `1`），省略表示不声明；
    - `minOpenDeskVersion` / `maxOpenDeskVersion` 可选，语义与插件清单同义（SemVer、**包含边界**、
      省略表示该侧不限）；
    - `platforms` 取自同一套枚举（`win32` / `darwin` / `linux` / `android` / `openharmony`）；
    - `author` 必须是 `{ name, institution?, homepage? }` 对象（不再支持字符串简写），`name` 必填、
      `homepage` 只接受 http(s)。
    - `iconUrl` 可选：插件图标。http(s) 图片链接原样保留；相对链接与 `downloadUrl` 同一套基准解析
      （相对清单地址），本地调试清单解析成本地文件路径后由宿主读出并内联成 data URL 交给界面，
      读不到按未声明处理（卡片回退首字母图标）。
- `platforms` 声明的平台不含当前平台时，这条插件在市场上**不展示、也不允许安装**（未声明表示全平台）。
- `minOpenDeskVersion` / `maxOpenDeskVersion` 不含当前宿主时，条目**仍然展示但标成不可安装**
  （卡片上写「需要 OpenDesk ≥ x.y.z」，按钮禁用）——平台不匹配是「跟这台机器没关系」，
  宿主版本不匹配则是「升级 OpenDesk 就能装」，藏起来反而让人以为市场上没有这个插件。
- 市场卡片的底部胶囊：**已安装** / **可更新**（清单版本高于已装版本时，按钮从「重新安装」变成「更新」，
  详情里同时给出本地版本）/ **与内置插件冲突**、**需要 OpenDesk ≥ x.y.z**（这两种情况按钮禁用、文案变
  「无法安装」）；未安装且可安装时不显示胶囊。
- `plugins[].id` 必须等于插件包内清单的 `id`，不一致时安装会报错（卡片上的「已安装」会对不上）。
- `downloadUrl` 必须是 `.zip` / `.tgz` / `.tar.gz` 归档包：安装流程是下载 → 解包 → 校验 → 注册；
  https 清单只接受 https 下载地址，只有非 https 清单（内网市场、本地调试）才放行明文 http。
- `downloadUrl` 也可以写成**相对清单的地址**（如 `plugins/demo.zip`、`./plugins/demo.tgz`、
  `/static/plugins/demo.zip`）：清单是 http(s) 地址时按 URL 规则相对解析（换域名/换分支不用改清单），
  清单是本地调试文件时解析成同级目录下的绝对路径。归档包与清单放在同一个仓库里时最省事。
- 单条写坏的条目会被跳过；整份清单一条都用不了时按「清单加载失败」处理，并回退到上次成功的缓存。
- 清单缓存 5 分钟（`apps/pluginmgr/plugin-catalog-cache/`），市场页右上角的刷新会强制重新拉取。
- 清单顶层**不写** `schemaVersion`：它没有任何版本协商作用，客户端也不读。

从市场安装时：下载走平台 `fetch`（继承代理设置），进度通过 `marketInstallProgress` 事件回传给
卡片上的进度条；与内置插件同 ID 会在**下载前**就被拒绝（`builtin_conflict`，内置优先，既不白下载，
也不会为此先把运行中的内置插件停掉再装回去）；覆盖安装会先释放旧实例。

官方市场清单托管在 `../OpenDesk-Pages` 仓库的 `public/static/categories/plugins.json`，插件包放在
`public/static/plugins/` 下随站点发布，改完部署即可，客户端不需要发版。

### registry 扩展点

每个渠道对应一个 registry 实现（`BasePluginRegistry`：`name` / `displayName` / 可选 `categories` /
`getCatalog(query?)` / `getPluginCount` / 可选 `invalidate`）。`getCatalog` 的查询参数是
`{ startAt?, limit?, categories? }`：`startAt` / `limit` 与 benchmark 的
`getCatalog(startAt, limit)` 同义（`startAt` 默认 0、省略 `limit` 表示取到末尾、`0` 表示不取，
切片由 registry 完成），分类过滤先于分页。内置实现 `PlainPluginRegistry` 只负责
「一份 HTTP 上的 `plugins.json`」：内存 + 文件缓存、并发去重、断网回退上次成功清单、单条容错；
界面上目前一次取全量（与 benchmark 一致），大型市场接入后可以直接按页取而不改契约。

未来出现别的市场协议时（分页 RPC、需要认证的私有市场、增量索引……），**不需要改
`createPluginRegistries` 或应用层**：在主进程里注册一个 provider 认领对应渠道即可，
与 mcpmgr / skillmgr 的 provider 机制同一套写法：

```ts
registerPluginRegistryProvider({
    id: 'enterprise-rpc',
    // 认领哪些渠道由 provider 自己判断；官方渠道同样可以被接管
    supports: (channel) => channel.url.startsWith('https://market.corp.example/'),
    // 返回 undefined 表示不接管，交给后面的 provider 或内置实现
    create: (channel, { dataDirectory, fetchImpl }) => new MyRpcRegistry(channel, { dataDirectory, fetchImpl })
});
```

未注册任何 provider 时行为与今天完全一致（全部走内置实现）；provider 的 `supports` / `create`
抛错只会让该渠道回落到内置实现，不会把整个市场列表拖空。

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

## 在 Skill 中挂载内部工具与内部 MCP

Skill 除了说明文本，还可以自带「内部工具」。内部工具不走 `ctx.tools.register`，不占用任务顶层工具位，
而是随 Skill 正文渐进式披露：模型先通过 `LoadSkill` 加载 Skill，加载后的正文末尾会出现 `<tools>` 清单
（逐个列出工具名、描述与参数 Schema），模型再用 `CallSkillTool`（参数 `bundleName`、`skillName`、
`toolName`、`arguments`）按名调用。`bundleName` + `skillName` 已经承担了命名空间，因此 `toolName`
使用工具本名，不会出现插件 id。

内部工具分两类：`tools` 字段是插件代码实现的函数工具；`mcps` 字段是把 MCP server 挂到
Skill 名下的内部 MCP。`mcps` 在 `setup` 阶段求值，server 参数可以按插件配置或运行环境动态生成。

### tools 字段：代码实现的函数工具

```ts
import { definePlugin, tool } from '@bitclub.ai/opendesk-plugin-sdk';

export default definePlugin({
    id: 'report-skill',
    capabilities: ['skill'],
    setup(ctx) {
        ctx.skills.register({
            name: 'weekly-report',
            description: 'Generate weekly reports with built-in helpers.',
            body: [
                '# Weekly Report',
                '',
                'Call the render_table tool to render collected rows into the report body.'
            ].join('\n'),
            tools: [
                tool({
                    name: 'render_table',
                    description: 'Render rows as a Markdown table',
                    args: {
                        title: tool.schema.string(),
                        rows: tool.schema.array(tool.schema.record(tool.schema.string()))
                    },
                    async execute(args, context, result) {
                        const rows = args.rows.map((cells) => Object.values(cells).join(' | '));
                        result.attachResult(`Rendering ${rows.length} rows`);
                        return { output: [args.title, ...rows].join('\n') };
                    }
                })
            ]
        });
    }
});
```

同一 Skill 内 `tools` 的名字净化后必须唯一（净化规则：`[^a-zA-Z0-9_-]` 转为 `-`），冲突会在插件激活时
报 `plugin.skill_tool_name_conflict`。

### mcps 字段：挂在 Skill 名下的内部 MCP

```ts
ctx.skills.register({
    name: 'weekly-report',
    description: 'Generate weekly reports backed by an internal MCP server.',
    body: '# Weekly Report\n\nCall the query_drafts tool to read report drafts.',
    mcps: [
        {
            name: 'report-db',
            transport: 'stdio',
            command: 'node',
            args: [`${ctx.pluginDir}/mcps/report-server.mjs`],
            cwd: ctx.pluginDir
        }
    ]
});
```

内部 MCP server 交给 MCPMgr 统一管理，但与全局 server 有三点差异：

- **连接懒加载**：Skill 被模型加载、或用户在技能中心查看该 Skill 详情时才建立连接；Skill 列表态不会
  拉起子进程。
- **空闲自动断开**：连续 30 分钟没有任何工具调用会断开连接释放子进程，后续调用按需重连。
- **不进入全局工具视角**：内部 MCP 的工具不会出现在 MCP 网关的搜索/调用范围内，MCP 管理器中可见但
  只读，由插件拥有（随插件停用/卸载而移除）。

### 模型可见名

| 场景                                                  | `toolName` 形态                  | 示例                      |
| ----------------------------------------------------- | -------------------------------- | ------------------------- |
| `tools` 字段的静态工具                                | 工具本名（净化后）               | `echo`                    |
| 仅一个内部 MCP，且展平名不与 `tools` 工具名冲突       | 工具本名                         | `read_file`               |
| 多个内部 MCP server                                   | `<server>__<工具名>`（前缀消歧） | `fs__read`、`git__commit` |
| 单个 MCP 但与 `tools` 工具重名（含连字符/下划线近形） | 回退 `<server>__<工具名>`        | `fs__echo`                |

展平的 MCP 工具描述会保留 `[MCP: <server>]` 前缀说明来源。同一技能内的重名会在注册阶段校验
（`mcps` 的 server 名净化后同名报 `plugin.skill_mcp_name_conflict`）；MCP 工具与 `tools` 工具的
运行时冲突则按上表回退带前缀形态。

### 边界

- `tools` / `mcps` 只能通过 `setup` 中的 `ctx.skills.register` 携带；manifest `resources.skills`
  静态声明的 SKILL.md 不支持这两个字段——`tools` 依赖代码实现，需要为静态 Skill 挂载内部 MCP 时，
  改为在 `setup` 中用 `ctx.skills.register` 动态注册。
- 内部工具的执行结果会以 `CallSkillTool` 的调用记录呈现，内部 MCP 工具的执行统一经由 MCPMgr worker。

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
npm spec 由 npm 安装，本地目录、ZIP 和 TGZ 则只在声明了运行时依赖时调用 npm：

```bash
opendesk plugins install opendesk-plugin-review-helper@latest
opendesk plugins list
opendesk plugins disable review-helper
opendesk plugins enable review-helper
opendesk plugins uninstall review-helper
opendesk plugins uninstall review-helper --remove-data
```

安装源可以是 npm spec、本地路径、ZIP、tarball 或 URL。GUI 中的 npm、目录、ZIP、TGZ 和 URL
入口都会校验后复制到全局 `plugins` 目录并写入注册记录，因此可以通过 GUI 或 CLI 卸载。
`externalPaths` / `--plugins-directory` 只用于显式指向不复制到 `plugins/` 的插件目录（见上文
「插件目录」），其中的插件按内置插件处理。

CLI 安装命令接收的本地目录同样直接校验并复制包含 `opendesk.plugin.json` 或
`package.json#opendesk` 声明的插件目录，不要求 `package.json`。目录内容会直接复制到
`plugins/<插件ID>/`，不会增加额外的 `plugin/` 中间层。目录、ZIP 和 TGZ 共用运行时依赖安装规则：
如果根目录 `package.json` 声明了 `dependencies` 或 `peerDependencies`，就在插件暂存目录安装这些
依赖；无运行时依赖的插件不要求 npm。ZIP 和 TGZ 位于同一归档层，统一下载、解压和校验。
所有 npm 安装路径都传递 `--omit=dev`、`--no-optional` 和 `--ignore-scripts`，不会安装开发依赖、
可选依赖，也不会运行插件或依赖的 npm 生命周期脚本。卸载适用于 `plugins/` 目录中的全部插件，
包括手工放入的插件文件或目录；内置插件与附加插件目录里的插件不能卸载，后者需要从
`externalPaths` 或 `--plugins-directory` 中移除。
卸载默认保留插件的私有数据目录（`plugins/.pluginmgr/data/<插件ID>/`），仅在 GUI 确认弹窗中
勾选“同时删除该插件的数据目录”，或 CLI 显式传入 `--remove-data` 时才会一并清理。

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
启停和卸载（卸载时可选择是否一并删除插件数据目录）。`opendesk plugins` CLI、GUI、TUI、headless CLI 和 serve 模式共用同一套
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
手工放入（`plugins/` 目录）的插件没有基线，标记为 unmanaged，不进行内容锁定；附加插件目录里的
插件按内置插件处理，同样不做完整性锁定。

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

`skill.list.after` 在 SkillMgr 首次完成本地技能加载，以及技能安装、删除、启停或刷新后触发。
输入中的 `skills` 只包含用户提供的本地技能，不包含 Application、Soul 或插件贡献的技能；每项包含
`name`、绝对 `directory`、`source`（`installed`、`config` 或 `mounted`）和最终的 `enabled` 状态。
该 Hook 是只读通知。

GUI 单项安装使用以下调用链，实际下载、解压、状态更新和 Registry 同步仍由既有 Worker 完成：

```text
GUI callMainWorld
  -> SkillMgrApplication
  -> skill.install.before
  -> SkillMgr Worker
  -> skill.install.after
```

### Task Hooks

`task.review` 复用 AIKernel 的 `onTaskReview` 生命周期，在主任务达到空闲审查阈值或用户手动触发
任务审查时执行。输入包含 `taskId` 和本次审查范围内的 `messages`；消息只保留非内部的用户文本和
Assistant 可见文本，不包含 reasoning、工具调用、工具结果、子任务或内部任务内容。该 Hook 是只读通知。

插件 Hook 定义在 `packages/plugin-sdk` 的 `PluginHookMap` 中，并在 `setup(ctx)` 内注册。

当前运行时 Hook 包括：

- `chat.headers`：在当前模型请求前追加或改写 HTTP Header。
- `chat.params`：在当前模型请求前调整推理强度和最大输出 token。
- `task.review`：主任务进入会话审查阶段时提供本次审查范围内的可见对话。
- `skill.load.before`：在 Agent 明确加载某个 Skill 时触发，可通过 `output.operation = 'deny'` 拒绝本次加载。
- `skill.load.after`：某个 Skill 成功加载并生成完整正文后触发，仅用于观测和审计。
- `skill.list.after`：SkillMgr 本地技能列表首次加载或发生变化后触发，仅用于观测。
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
