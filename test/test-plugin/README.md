# test-plugin

用于验证 OpenDesk「附加插件目录」的最小插件（`id: test-plugin`）。它只做可观测的接线，方便确认
插件确实被加载、能启停、工具/命令/钩子都生效。

- **tool `ping`**：回显插件自身的加载位置、配置目录、数据目录与进程信息
- **command `status`**：`/test-plugin.status` 或 `opendesk plugins run test-plugin.status`
- **hook `chat.headers`**：给每次模型请求加 `x-test-plugin: enabled` 请求头

清单里没有声明 `enabled` / `system`，所以可以在插件中心正常启停。

## 怎么用

三条入口等价，按顺序合并去重：环境变量 → CLI 参数 → `setting.json` 的
`applications.pluginmgr.externalPaths`。目录既可以是「插件目录集合」，也可以直接就是这个插件目录。

```bash
# 1) 直接指向插件目录（本次进程生效）
opendesk --plugins-directory ./test/test-plugin

# 2) 指向包含它的目录（容器形式）
opendesk --plugins-directory ./test

# 3) 环境变量（CLI / TUI / GUI / serve 都生效，逗号分隔可挂多个目录）
OPENDESK_PLUGINS_DIRECTORY=./test/test-plugin opendesk

# 4) 持久化配置：setting.json
#    { "applications": { "pluginmgr": { "externalPaths": ["D:/path/to/test-plugin"] } } }
```

`--plugins-directory` 是根命令的全局选项，写在子命令之后同样生效：

```bash
opendesk serve --plugins-directory ./test/test-plugin
```

## 怎么确认生效

```bash
# 列表里应出现 test-plugin，来源标记为「内置」
opendesk plugins list

# 运行时条目里应为「已激活」
opendesk plugins doctor

# 工具已注册（名称是 pluginId-本地名）
opendesk plugins tools

# 直接调用工具
opendesk plugins call test-plugin-ping

# 执行插件命令
opendesk plugins run test-plugin.status
```

预期输出（`plugins call test-plugin-ping`）：

```text
pong
pluginId: test-plugin
pluginDir: <仓库>/test/test-plugin
configDir: ...
dataDir: ...
pid: ...
host: win32 x64
activatedAt: ...
```

## 可以顺手验证的边界行为

| 操作                                                            | 预期                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `opendesk plugins disable test-plugin`                          | 成功；注册表写入绝对路径 + `source: builtin`，目录文件不被修改       |
| `opendesk plugins enable test-plugin`                           | 成功，工具/命令/钩子重新可用                                         |
| `opendesk plugins uninstall test-plugin`                        | 失败：`内置插件，不能卸载`（即使当前是禁用状态）                     |
| `opendesk plugins install ./test/test-plugin`（目录同时配置着） | 失败：`plugin.install_builtin_conflict`                              |
| 不传 `--plugins-directory` 启动                                 | 插件不加载（目录只在启动时生效），但 `plugins list` 仍能看到残留记录 |
| 让本目录与某个内置插件同 ID                                     | 附加目录的同 ID 条目被忽略并告警，内置插件优先                       |

## 依赖说明

插件入口按裸包名 `@bitclub.ai/opendesk-plugin-sdk` 引入 SDK，由宿主的 ESM 解析映射兜底，因此本目录
**不需要** `node_modules`。`zod` 同理。`.ts` 入口不受支持，需要先编译成 `.js` / `.mjs` / `.cjs`。
