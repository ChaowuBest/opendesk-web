# App 专属策略（security/policies）

常用 CLI 工具的 standard 模式自带策略，按 app 一文件：`git.ts` / `python.ts` /
`node.ts` / `uv.ts`（按需扩展），`index.ts` 聚合导出 `createAppPolicyRules()`。

## 生效方式

由 `enforcer.ts` 的 `createDefaultPermissionRules` 注入 standard 模式权限引擎：

- 读写文件等工具调用经引擎 check 直接生效；
- 动态沙箱启动时经 `enforcer.getRules()` 导出为沙箱策略文本，同样生效。

单一来源：terminal 沙箱实现层（dynabox-policy 等）不维护 app 专属路径清单。

## 新增 app 策略检查单

1. 路径用 `{home}` 占位符（跨平台/跨用户），glob 用正斜杠；
2. 仅放行 read（写仍由引擎兜底 ask 管控，防持久化攻击）；
3. 凭据类文件（token/密钥/机器凭据）必须 read **ask**，绝不 allow——
   `.git-credentials` / `.netrc` / `.npmrc` / `.pypirc` 为现例；
4. 沙箱判定层已通用放行三类"读不到内容"的访问，策略文件**无需**为它们
   添加规则：已存在目录的读探测、不存在路径的读（ENOENT 透传）、沙箱会话
   内自建文件的读回（见 native/windows/sandbox/README.md「通用读探测豁免」）；
5. 注释里不要写 `*/` 序列（会提前闭合块注释，esbuild 报语法错误）；
6. 在 `index.ts` 的 `ALL_APP_POLICY_FACTORIES` 注册，并在
   `src/tests/ut/aikernel/app-policies.test.ts` 补回归。
