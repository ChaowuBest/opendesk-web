# 语言包插件扩展设计规范（提案）

> 状态：**已实施（P0 + P1）**——评审决策（第 10 章 5 项开放问题）均已按推荐方案落地；
> 内置语言包以单个内置插件形式随宿主分发（`resources/plugins/language-packs/`，
> 插件「内置语言包」，同时携带土耳其语、德语、法语、印尼语与俄语，已全量覆盖主界面与
> 各内置应用词条，未覆盖 key 沿 `@fallback` 回退英文）。本文保留原始设计论证，
> 实现细节以 `docs/plugin.md`「语言包插件」章节与源码为准；P2（插件中心冲突报告
> 视图、Worker 增量注入、SDK 校验命令）仍未实施。

## 1. 背景

### 1.1 现状

OpenDesk 的 i18n 为自研实现（无第三方库），词典分两层：

| 层       | 词典位置                                                                | 消费方                                                                                              | 查找函数                                                                                                  |
| -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 全局词典 | `src/locale/zh-cn.ts` / `src/locale/en-us.ts`（扁平 key，各约 3005 条） | Electron main、TUI、CLI、headless、Worker（`t()`）；主窗口 renderer（`createRendererTranslator()`） | main 侧 `src/locale/index.ts` `t(key, params)`；renderer 侧 `src/renderer/locale.ts` `createTranslator()` |
| 应用词典 | `src/main/applications/<app>/locale/{zh-cn,en-us}.ts`（约 25 个应用）   | 各应用 main 侧本地 `t()`；8 个应用另有 `locale/renderer.ts` 包装                                    | 应用本地包装，回退 `dict[locale] → dict['zh-CN'] → key`                                                   |

语言枚举硬编码为 `'zh-CN' | 'en-US'`（`src/common/locale.ts:12`），并分散定义于：

- 设置 schema：`src/main/utils/setting.ts:457`（`z.enum(['auto','zh-CN','en-US'])`）
- GUI 设置页下拉框：`src/renderer/components/settingpanel.js:2381`
- TUI 语言配置页：`src/main/tui/components/config/languageConfig.ts:36`
- CLI `--language` 校验：`src/main/cli.ts:167`

语言切换刷新机制：设置变更 → `setting:changed` 广播 → 各 renderer 重建 translator 并刷新；main 侧 `t()` 每次调用现读 Setting，无需事件。

### 1.2 问题与需求

1. 社区/第三方无法为 OpenDesk 提供新语言（如 ja-JP），也无法对内置文案做补全或修正。
2. 需求方明确要求：插件可贡献语言包，**覆盖主界面与各应用的 locale 文案**，且**支持部分提供**——同一语言的文案可分布在不同插件中（例如插件 A 补全主界面、插件 B 补全笔记应用）。
3. 两层词典、多个运行环境（main/renderer/各应用窗口/worker）的查找链需要在不破坏现有行为的前提下统一接入插件增量。

## 2. 术语

| 术语                  | 含义                                                                |
| --------------------- | ------------------------------------------------------------------- |
| 语言包（locale pack） | 插件以 `resources.locales` 声明的一组 JSON 词典文件，纯数据、无代码 |
| 语言 tag              | BCP-47 语言标签，如 `zh-CN`、`ja`、`pt-BR`，由宿主规范化            |
| LocaleStore           | 宿主主进程内维护的"插件增量词典层"，位于内置词典之上                |
| 增量 map              | 某语言下所有已启用语言包合并后的 `Record<key, 文案>`                |
| 内置语言              | 宿主自带全量词典的两种语言：`zh-CN`、`en-US`                        |

## 3. 设计目标与非目标

### 3.1 目标

1. **声明式语言包**：纯 JSON 文件，无需编写插件代码；一个插件可同时贡献多种语言、任意子集的 key。
2. **统一覆盖**：语言包增量优先于全部内置词典（全局域 + 各应用域），支持"补全缺失 key"与"修正已有文案"两类场景。
3. **部分提供与确定性合并**：同一语言允许多插件贡献，按 key 合并；冲突有确定的解析顺序并产生告警。
4. **动态语言注册**：新语言经语言包进入系统——设置页下拉框动态出现、`auto` 模式按 BCP-47 最佳匹配、可声明回退链。
5. **差量生效**：安装/卸载/启用/禁用语言包即时生效，不重启应用。
6. **安全与性能**：路径校验复用现有机制；JSON 无代码执行；仅激活语言才加载文件，启动期零额外 IO。

### 3.2 非目标

- 用户后装的外部 iframe 应用、browser 应用 `<webview>` 内的外部页面文案不受控（跨域，由应用作者自行本地化）。
- RTL 排版、复数/CLDR 格式化——插值沿用现有 `${param}` 约定。
- 运行时语言包注册 API（`ctx.locales.register*`）——本提案只做静态声明，接口预留不实现。
- 在线翻译平台协作流程。

## 4. 总体设计

```
插件 manifest "resources.locales"
        │ discovery 阶段仅读声明（启动零额外 IO）
        ▼
LocaleStore（main 进程，src/main/locale/packs.ts）
        │ 仅当语言被激活时读取对应 JSON 并合并
        ▼ 增量 map（per-locale）
        ├─→ main / TUI / CLI / headless：t() 查找链直接生效
        ├─→ renderer 各窗口：IPC 下发增量 map（locale:getLocalePacks 拉取 + locale:packsChanged 推送）
        └─→ Worker：workerData / 消息注入（P2）
```

统一查找链（所有端一致，按序取第一个命中）：

```
1. pack[locale][key]            ← 语言包增量（最高优先级）
2. dict[locale][key]            ← 内置词典（全局域或应用域，按调用方所属域）
3. pack[fallback][key]          ← 仅 locale 为非内置语言时；fallback 由语言包声明，默认 en-US
4. dict[fallback][key]          ← 同上
5. dict['zh-CN'][key]           ← 仅 locale 为 en-US 时（保持 renderer 现状兜底）
6. key                          ← 回显 key 本身
```

> 行为变更点：main 侧 `t()` 目前缺 key 直接回显，第 5 步使其与 renderer 对齐（en-US 缺失时回退 zh-CN）。影响面极小且更友好。

覆盖语义要点：**语言包永远覆盖内置**。这是"社区修正官方文案"场景的基础；语言包之间才存在冲突问题（见 5.1）。分层上系统内置文案视为 priority 0，语言包增量恒在其上（同 key 覆盖）。

## 5. 插件侧契约

### 5.1 manifest 声明

```json
{
    "id": "acme-language-pack-ja",
    "displayName": "日本語 Language Pack",
    "version": "1.0.0",
    "apiVersion": 1,
    "minOpenDeskVersion": "0.0.0",
    "capabilities": ["locale"],
    "resources": {
        "locales": ["locales"]
    }
}
```

- 新增 capability：`locale`（`packages/plugin-sdk/src/index.ts` 的 `OPENDESK_PLUGIN_CAPABILITIES` 增加，SDK 常量同步）。
- `resources.locales`：相对插件根的路径数组，元素可为**目录**（收集目录顶层的 `*.json`，文件名即语言 tag；与 skills 目录的平铺收集一致，不递归子目录）或**单个 `.json` 文件**。目录式是推荐形态。
- 复用现有闸门：`parsePluginManifest` 中"声明了 resources 却缺对应 capability 即报错"的校验（`src/main/applications/pluginmgr/discovery/manifest.ts:284`）扩展覆盖 `locales → locale`。
- 路径校验复用 `resolvePluginResourcePath`（插件根包含 + realpath 双重校验，防目录穿越）。

### 5.2 纯静态插件允许无 entry

语言包是最典型的纯声明插件。设计上允许：当 manifest 无 `entry` 且未声明任何需要代码的能力时，loader 跳过动态 `import`（`discovery/loader.ts` `loadPlugin` 小改）。仅贡献静态 `locales` 的插件不应被迫携带空 `index.js`。

### 5.3 词典文件格式

`locales/ja-JP.json`：

```json
{
    "@priority": "1",
    "@fallback": "en-US",
    "renderer.sidebar.tagline": "ワンストップのスマートオフィス",
    "sp.general.language": "言語",
    "notes.editor.placeholder": "メモを入力..."
}
```

| 规则       | 说明                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结构       | 顶层必须为对象，扁平 `string → string`；嵌套对象/数组/数字值均拒绝（保留 key 除外），报错定位到文件与 key                                                                                                             |
| key        | 即现有全局/应用词典的扁平 key（如 `renderer.*`、`sp.*`、`notes.*`），语言包不做域区分——增量 map 是全局一层，先于域词典命中（见第 4 章查找链）                                                                         |
| 插值       | 沿用 `${param}` 约定，由 `t()` 现有逻辑处理                                                                                                                                                                           |
| 保留 key   | `@` 前缀的 key 为元数据，不参与查找。`@fallback`：该语言的回退 tag，可选，缺省 `en-US`（如 zh-TW 包声明 `"@fallback": "zh-CN"`）；`@priority`：合并优先级，0-999 整数（字符串或数字形式均可），缺省 1，数值越大越优先 |
| tag 规范化 | 文件名经 `Intl.Locale` 规范化为标准形式（`ja-jp.json` → `ja-JP`）；非法 tag 报错                                                                                                                                      |
| 大小限制   | 单文件 ≤ 2MB（与 `appearance` logo 上限对齐），超限拒绝加载该文件并告警                                                                                                                                               |

### 5.4 兼容性

- 老宿主遇到含 `resources.locales` 的新 manifest：宿主对未知 resources 字段**忽略并告警**（需在 `PluginManifestResources` 解析处确认宽松策略），插件侧用 `minOpenDeskVersion` 保护。`OPENDESK_PLUGIN_API_VERSION` 不递增（新增资源类型属向后兼容扩展）。
- 未声明 `@priority` 的语言包缺省 priority 1：既有语言包（含第三方）合并行为与引入 `@priority` 前完全一致，无需改动即可继续使用。
- 卸载提供当前激活语言的包后：`getLocale()` 运行时校验失败 → 回退 `auto` 并告警；不篡改 `setting.json` 存储值（重装后自动恢复）。

## 6. 宿主侧设计

### 6.1 LocaleStore 与合并算法

新模块：

- `src/common/locale/pack.ts`：纯函数与类型（供 main 与 renderer 共用）——`parseLocalePackJson(content, tag)`（结构校验）、`mergeLocalePacks(packs)`（返回 `{ merged, conflicts }`）。
- `src/main/locale/packs.ts`：`LocaleStore`——发现（从已启用插件收集 `{ pluginId, tag, path, fallback }`）、惰性加载（激活语言命中才 `readFileSync` + 解析 + 合并，结果缓存）、失效（插件增删改/启停时按 tag 精确清缓存）。

**合并与冲突策略（部分提供的核心语义）**：

- 同一语言多包：按语言包 `@priority` 声明的**合并优先级升序**（缺省 1）、同 priority 按**插件 ID 字典序**依次合并，**后者覆盖前者**——因此 priority 高者胜、平局时 ID 大者胜。平局裁决与安装顺序、启动顺序无关，卸载重装不改变结果，完全确定。
- 优先级分层：系统内置文案视为 priority 0（语言包增量恒覆盖内置词典），内置语言包插件声明 priority 1，第三方语言包缺省 priority 1、需要压过内置语言包或同层其它包时声明更高 priority。
- 冲突（多包声明同一 key）不视为错误：合并照常，同时输出 warn 日志（含 key、获胜插件、被覆盖插件清单）。后续可在插件中心展示冲突报告（P2）。
- 内置插件目录、附加目录、用户安装的插件一视同仁，按 priority 与 ID 参与排序。

### 6.2 各端查找链接入

| 消费上下文                                                                                    | 现状入口                                              | 接入方式                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main / TUI / CLI / headless                                                                   | `src/locale/index.ts` `t()`                           | `t()` 内部查找链改为第 4 章统一链；`getLocale()` 增加动态语言校验。Worker 中运行的 `t()`（如 `applications/worker.ts`）P0 暂只用内置词典，P2 经 workerData 注入增量 |
| 主窗口 renderer                                                                               | `src/renderer/locale.ts` `createRendererTranslator()` | 新增 preload API：`locale:getLocalePacks()` 返回当前激活语言的 `{ increments, fallbackIncrements, locale, fallback }`；translator 构造时注入增量 map，查询先查增量  |
| 应用独立窗口 / 浮窗                                                                           | `application_window.html` / `floatpage.html` 组件     | 同上，走同一 preload 通道                                                                                                                                           |
| 各应用 renderer（约 8 个 `locale/renderer.ts` 包装 + `application-host.ts` 动态加载的 entry） | 各应用 `createTranslator(appDict)`                    | 包装函数统一改为从 `window.localeAPI` 取增量后传入；`src/main/applications/*/locale/index.ts` 的应用域包装（main 侧）改为经统一查找链                               |
| 应用 `<webview>` / 外部 iframe                                                                | —                                                     | 不接入（见 3.2 非目标）                                                                                                                                             |

IPC 通道：`locale:getLocalePacks`（拉取）与 `locale:packsChanged`（推送）。推送事件携带新增量，或通知组件重拉（与 `setting:changed` 订阅模式一致，复用 `src/renderer/settingChangedSubscription.ts` 的分发器思路）。

### 6.3 动态语言注册

新增 `src/common/locale` 的 `getAvailableLocales()`：`['zh-CN', 'en-US'] ∪ 已启用语言包声明的全部 tag`，作为唯一的"受支持语言"判定来源。连锁改造：

| 位置                                        | 改造                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common/locale.ts` 类型                 | `SupportedLocale` 放宽为 BCP-47 字符串（保留 `zh-CN`/`en-US` 便捷常量）；`isSupportedLocale` 改查动态集合（集合经参数注入，保持该模块无 Electron 依赖）             |
| 设置 schema `src/main/utils/setting.ts:457` | `z.enum([...])` → `z.union([z.literal('auto'), z.string().regex(BCP47正则)])`；运行时 `getLocale()` 再按动态集合校验，非法回退 `auto`（兼容语言包被卸载后的残留值） |
| `resolvePreferredLocale`（auto 匹配）       | 由"仅识别中文"改为与动态集合做 BCP-47 最佳匹配（exact tag → 语言主 tag → 未命中默认 `en-US`），实现于 `src/common/locale.ts`（保持纯函数可测）                      |
| GUI 设置页 `settingpanel.js`                | 下拉框选项由 `locale:getLocalePacks` 返回的可用语言列表动态渲染；显示名用 `Intl.DisplayNames`（如 `ja-JP → 日本語`），失败时显示原始 tag                            |
| TUI `languageConfig.ts`                     | 选项列表同样动态化                                                                                                                                                  |
| CLI `--language`                            | 校验改为动态集合；`--help` 文案顺带接入 `t('cli.*')`（现状为硬编码英文）                                                                                            |

### 6.4 生效与刷新

语言包变更全部走现有插件差量刷新链路，新增一个派发点：

1. 插件安装/卸载/启用/禁用 → `runtime/bootstrap.ts` 的 `applyPlugin*` 差量路径 → `syncPluginDerivedRegistries`（`bootstrap.ts:488`）中追加 `localeStore.invalidate(pluginId)` → 计算新激活语言增量。
2. `pluginmgr/app.ts` 经 `notifyPluginsChanged` 已广播 `pluginsChanged`；同时新增 `localePacksChanged` WebContents 广播（携带变更摘要或令组件重拉）。
3. 各 renderer 收到后重拉增量 → 重建 translator → `refreshAll()`（复用组件现有 `onSettingChanged` 处理路径，把"语言包变更"视同一次 locale 变更处理）。
4. 用户切换到新装语言包提供的语言：走既有 `setting:changed` 流程 + 增量拉取，无需额外事件。

### 6.5 安全与性能

- **安全**：JSON.parse 无代码执行；路径经 `resolvePluginResourcePath` 防穿越；文件大小上限；key/value 类型强校验。语言包属受信插件生态（插件本就运行于主进程），不做沙箱级隔离。
- **性能**：启动期仅读 manifest 声明（discovery 本就读 manifest，零额外 IO）；激活语言匹配的包才读盘解析，一插件多语言时装 20 个语言包只激活 1 个也无开销；增量 map 按 locale 缓存，切换语言时重建一次。
- **健壮性（dev 辅助）**：加载时可对比内置词典 key 全集，对语言包中"任何内置词典都不存在"的 key 输出告警（不阻断——应用未来新增 key 时语言包提前放置是合法的）。此校验后续可下沉到 SDK 的 `validateOpenDeskPluginDirectory`。

## 7. 边界与例外

| 场景                                | 行为                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| 多插件提供同一语言                  | 合并；同 key 冲突按 `@priority` 优先级裁决（缺省 1），平局按插件 ID 字典序后者胜 + warn |
| 插件提供部分 key（部分提供）        | 正常按 key 合并，其余 key 落到内置词典                                                  |
| 包声明 `@fallback` 指向不存在的语言 | 忽略该声明，使用默认 `en-US`，告警                                                      |
| 当前语言包被禁用/卸载               | 增量即时移除；若该语言因此不再受支持，运行时回退 `auto` 并告警                          |
| 语言包 key 与应用词典 key 重叠      | 属合法覆盖场景（增量 map 优先于域词典）                                                 |
| 外部 iframe 应用 / webview 外部页面 | 不受语言包影响                                                                          |
| `resolved_locale` 字段              | 语义不变（仍为解析后的实际 locale），动态语言解析结果同样经 `withResolvedLocale()` 下发 |
| 保留 key（`@` 前缀）                | 不参与查找、不参与冲突统计                                                              |

## 8. 分期计划

| 阶段          | 内容                                                                                                                                                            | 交付验收                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P0 核心链路   | manifest/capability/校验；LocaleStore + 合并算法；main 侧 `t()` 统一查找链；preload IPC 下发 + 主窗口/应用窗口 renderer 接入；差量刷新；无 entry 纯静态插件支持 | 语言包插件可对 zh-CN/en-US 做补全与覆盖，主界面 + 各应用文案即时生效 |
| P1 动态语言   | `SupportedLocale`/schema/auto 匹配/回退链改造；设置页、TUI、CLI 语言选项动态化；残留 locale 回退                                                                | 安装 ja-JP 语言包后设置页可选、auto 可匹配、切换即时生效             |
| P2 体验与治理 | 插件中心语言包视图（贡献语言/key 数/冲突报告）；Worker 增量注入；SDK `validateOpenDeskPluginDirectory` 校验语言包；未知 key 告警工具化                          | 管理可见性与开发期质量工具                                           |

## 9. 测试计划（TDD）

新增（遵循仓库测试规范，置于 `src/tests/ut/`）：

| 测试                                                | 覆盖                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/tests/ut/locale/locale-pack.test.ts`           | JSON 结构校验、tag 规范化、保留 key（`@fallback`/`@priority`）、多包合并、冲突解析（priority 优先级，平局 ID 字典序） |
| `src/tests/ut/pluginmgr/manifest-locale.test.ts`    | `resources.locales` 解析、capability 闸门、路径穿越拒绝、无 entry 纯静态插件加载                                      |
| `src/tests/ut/locale/locale-chain.test.ts`          | 统一查找链各分支（增量优先、域词典、fallback、zh-CN 兜底、key 回显）                                                  |
| `src/tests/ut/setting/locale-schema-compat.test.ts` | schema 放行 BCP-47、卸载残留值回退 auto                                                                               |
| 集成（pluginmgr）                                   | 安装/启用/禁用/卸载语言包后 `t()` 输出与 IPC 下发内容差量正确                                                         |

回归：`src/tests/ut/locale/locale-resolution.test.ts`、各应用 locale 测试（7 个）、`settingpanel-locale-switch.test.ts`、`agentoffice-locale-switch.test.ts`、`terminal-locale.test.ts` 等。

## 10. 开放问题（评审决策点）

| #   | 问题                                             | 推荐                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 语言包是否允许**覆盖**内置文案（而非仅补全缺失） | 允许——社区修正/润色官方文案是语言包生态的核心场景；覆盖行为已在冲突告警中可见                                                                                                                                                               |
| 2   | 多包同 key 冲突的解析顺序                        | 插件 ID 字典序、后者胜——结果确定、与安装顺序无关；备选"加载顺序"会随重装变化。后续演进：语言包经 `@priority` 声明 0-999 合并优先级（缺省 1），priority 高者胜、平局仍按 ID 字典序；系统内置文案视为 priority 0，内置语言包插件为 priority 1 |
| 3   | 新语言回退链的声明方式                           | JSON 保留 key `@fallback`，默认 `en-US`——不增加 manifest 复杂度；备选是 manifest 对象式声明（含 displayName 等元数据，P2 可演进）                                                                                                           |
| 4   | 语言显示名来源                                   | `Intl.DisplayNames` 自动生成，本期不引入自定义显示名元数据；有强需求再加 manifest meta                                                                                                                                                      |
| 5   | main 侧 `t()` 是否补上 zh-CN 兜底                | 补上（与 renderer 对齐），行为变更点已在 4 章标注                                                                                                                                                                                           |

## 11. 预计改动清单（P0/P1）

| 文件                                                                  | 改动                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/plugin-sdk/src/index.ts`                                    | `OPENDESK_PLUGIN_CAPABILITIES` 增加 `locale`；类型同步        |
| `src/main/applications/pluginmgr/discovery/manifest.ts`               | `PluginManifestResources.locales`；解析/校验；capability 闸门 |
| `src/main/applications/pluginmgr/discovery/loader.ts`                 | 无 entry 纯静态插件跳过 import；加载 locale 声明              |
| `src/common/locale/pack.ts`（新）                                     | pack 解析与合并纯函数                                         |
| `src/main/locale/packs.ts`（新）                                      | LocaleStore（发现/惰性加载/缓存/失效）                        |
| `src/locale/index.ts`                                                 | `t()` 统一查找链；`getLocale()` 动态校验                      |
| `src/common/locale.ts`                                                | `SupportedLocale` 放宽；BCP-47 匹配；`getAvailableLocales`    |
| `src/main/utils/setting.ts`                                           | locale schema 放宽                                            |
| preload（`setting:changed` 通道所在 preload）                         | `locale:getLocalePacks` / `locale:packsChanged`               |
| `src/renderer/locale.ts`                                              | translator 接受增量 map                                       |
| `src/renderer/components/settingpanel.js`                             | 语言选项动态渲染                                              |
| `src/main/tui/components/config/languageConfig.ts`、`src/main/cli.ts` | 同上                                                          |
| `src/main/runtime/bootstrap.ts`（pluginmgr）                          | `syncPluginDerivedRegistries` 派发 LocaleStore 失效           |
| `src/main/applications/*/locale/renderer.ts`（8 个）                  | 包装接入增量                                                  |

## 12. 实施检查表

- [ ] 修改 `t()` 查找链时，保持第 4 章顺序（增量 → 域词典 → fallback → zh-CN 兜底 → key），顺序回归测试为准。
- [ ] 新增消费 locale 的上下文（新窗口类型、新进程）必须接入增量下发链路，否则该上下文只能显示内置文案。
- [ ] 新增应用词典或应用时，无需改动语言包机制（增量 map 与域词典解耦）。
- [ ] 词典文件校验失败必须定位到文件与 key，不允许静默丢弃整个语言包。
- [ ] 语言包相关用户可见文本（设置页选项、冲突提示等）接入 `t('config.language.*')` 等既有命名空间。
- [ ] `OPENDESK_PLUGIN_API_VERSION` 不因本特性递增；文档 `docs/plugin.md` 同步 resources.locales 与 capability `locale`。
