# 内置技能（Bundled Skills）

本目录存放**随安装包分发**的内置技能。每个子目录是一个符合
[Agent Skills 规范](https://agentskills.io/specification)的技能（必须包含 `SKILL.md`）。

## 定位

- 由 `BuiltinApplication` 在启动时扫描加载（bundle 为 `builtin`）；
- 同步注册进 skillmgr 的 `SkillRegistry`（source 为 `bundled`），
  在技能中心的「内置技能」页展示：**可以被用户禁用，但不能被删除**；
- 用户目录（`apps/skills/resources`）中的同名技能优先于内置版本。

## 布局解析

| 环境                                       | 目录位置                                                  |
| ------------------------------------------ | --------------------------------------------------------- |
| 开发态（electron-vite dev / CLI / 测试）   | 仓库根 `resources/skills`（从模块目录向上回溯 appRoot）   |
| Electron 发布态（Windows / macOS / Linux） | `<安装目录>/resources/skills`（forge extraResource 复制） |
| 鸿蒙 HAP                                   | `resources/app/resources/skills`（整仓打包）              |

可用环境变量 `OPENDESK_BUILTIN_SKILLS_DIRECTORY` 显式指定目录（测试与特殊部署）。

## 修改须知

- 技能内容随版本发布，运行时不落盘、不可变；
- 新增技能后无需修改代码，重启应用即可生效；
- 解析逻辑见 `src/main/applications/skillmgr/builtin-skills.ts`。
