# OpenDesk CI —— Jenkins + GitCode PR 自动构建

本目录包含 OpenDesk 项目的 CI 流水线配置和辅助脚本。当开发者向 GitCode 仓库提交 Pull Request 时，Jenkins 自动触发构建和测试，并将结果回报到 PR 页面。

## 目录结构

```
Jenkinsfile                  # 流水线定义（项目根目录）
ci/
├── README.md                # 本文件
└── scripts/
    └── gitcode-notify.sh    # GitCode API 回报脚本
```

## 流程概览

```
开发者提交/更新 PR
       │
       ▼
GitCode Webhook ──POST──▶ Jenkins (Generic Webhook Trigger)
       │
       ▼
Jenkins Pipeline:
  1. Notify Pending  → GitCode API: 设置 commit status = pending
  2. Build           → git merge PR 到 main → npm install → npm run build
  3. Test            → npm run test-cli
  4. Post            → GitCode API: 设置 status = success/failure + PR 评论
```

## Jenkins 侧配置

### 前置条件

- Jenkins 版本 >= 2.387
- 已安装以下插件：
    - **Generic Webhook Trigger Plugin** — 接收 GitCode Webhook
    - **Pipeline** — Pipeline 执行引擎（通常已预装）

### 步骤 1：配置 Node.js

确保 Jenkins 节点上已安装 Node.js >= 18，并修改 Jenkinsfile 中的 `NODEJS_HOME` 指向实际安装路径。如果 `node` 已在系统 PATH 中，可删除 `NODEJS_HOME` 和 `PATH` 相关行。

### 步骤 2：创建 Credentials

1. 进入 **Manage Jenkins → Credentials → (global)**
2. 点击 **Add Credentials**
3. 类型选择 **Secret text**
4. ID 填写 `gitcode-token`（必须与 Jenkinsfile 中 `credentials('gitcode-token')` 一致）
5. Secret 填写你的 **GitCode Personal Access Token**
    - Token 需要 `projects` 权限（读写仓库状态、评论）
6. 保存

### 步骤 3：创建 Pipeline 项目

1. **New Item → Pipeline**，命名为 `OpenDesk-PR-CI`
2. 配置 **Build Triggers**：
    - 勾选 **Generic Webhook Trigger**
    - Token 填写 `opendesk-ci`
    - 添加以下 **Post content parameters**（从 GitCode Webhook JSON payload 提取）：

        > GitCode 的 PR Webhook 使用 `object_attributes` 结构，与 GitHub 不同。

        | 变量名               | JSONPath 表达式                           | 说明                           |
        | -------------------- | ----------------------------------------- | ------------------------------ |
        | `PR_NUMBER`          | `$.object_attributes.iid`                 | PR 编号                        |
        | `PR_SOURCE_BRANCH`   | `$.object_attributes.source_branch`       | 源分支                         |
        | `PR_TARGET_BRANCH`   | `$.object_attributes.target_branch`       | 目标分支                       |
        | `PR_COMMIT_SHA`      | `$.object_attributes.last_commit.id`      | 最新 commit SHA                |
        | `PR_REPO_URL`        | `$.project.git_http_url`                  | 目标仓库 clone 地址            |
        | `PR_SOURCE_REPO_URL` | `$.object_attributes.source.git_http_url` | 源仓库 clone 地址（fork 场景） |
        | `PR_ACTION`          | `$.object_attributes.action`              | 操作类型（用于过滤）           |

    - **Optional filter**（推荐，仅触发打开/更新的 PR）：
        - Text: `$PR_ACTION`
        - Expression: `^(open|update)$`

3. 配置 **Pipeline**：
    - Definition: **Pipeline script from SCM**
    - SCM: **Git**
    - Repository URL: 你的仓库地址
    - Credentials: 如果是私有仓库，选择对应凭据
    - Branch Specifier: `*/main`
    - Script Path: `Jenkinsfile`
4. 保存

## GitCode 侧配置

### 创建 Webhook

1. 进入仓库 **Settings → WebHooks**
2. 点击 **添加 WebHook**
3. URL 填写：
    ```
    http://<jenkins-host>:<port>/generic-webhook-trigger/invoke?token=opendesk-ci
    ```
4. 事件勾选：**Pull Request**（或 Merge Request）
5. （可选）配置密码/签名用于安全校验
6. 保存

### GitCode Personal Access Token

1. 进入 **个人设置 → 访问令牌**
2. 创建新令牌，勾选 `projects` 权限
3. 将生成的 Token 填入 Jenkins Credentials 的 `gitcode-token` 中

## 环境要求

Jenkins 构建节点需预装：

| 组件    | 版本要求 | 说明                                |
| ------- | -------- | ----------------------------------- |
| Node.js | >= 18    | 推荐通过 Jenkins NodeJS Plugin 管理 |
| npm     | >= 9     | 随 Node.js 一起安装                 |
| Git     | >= 2.20  | 用于分支操作和 merge                |
| curl    | 任意     | 用于调用 GitCode API                |
| Bash    | >= 4.0   | 回报脚本运行环境                    |

### 关于 test-cli

`npm run test-cli` 依赖 `setting.json` 配置文件。请确保 Jenkins 构建节点的对应路径已放置正确的配置文件，或通过环境变量指定配置路径。

## 辅助脚本说明

### `ci/scripts/gitcode-notify.sh`

封装了 GitCode API 的两个功能：

> **注意**：GitCode 不支持 Commit Status API（`/statuses/:sha`），所有 CI 结果通过 PR Comment 回报。

```bash
# 发布 PR 评论（纯文本/Markdown）
ci/scripts/gitcode-notify.sh comment <markdown_body>

# 发布带构建日志的 PR 评论（自动提取 ci-logs/ 下的日志文件）
ci/scripts/gitcode-notify.sh comment-with-logs <success|failure|aborted>
```

`comment-with-logs` 会自动：

- 根据构建结果生成阶段状态表格（Build / Test）
- 从 `$CI_LOG_DIR` 提取各阶段日志（npm-install、build、test）
- 失败时附加完整日志（最后 80 行），成功时仅附加测试摘要（最后 20 行）
- 日志以 `<details>` 折叠块形式展示，避免 PR 评论过长
- 附带 Jenkins 完整日志链接

如果 PR Comment API 不可用（如非 PR 触发），脚本会尝试回退到 Commit Comment。

## Jenkinsfile 关键设计

- **Merge 策略**：使用 `git merge --no-ff` 代替 cherry-pick，对多 commit PR 更可靠，也更贴近真实合入效果
- **超时控制**：全局 30 分钟超时
- **并发控制**：`disableConcurrentBuilds(abortPrevious: true)` 确保同一 PR 新推送会取消旧构建
- **构建日志回报**：各阶段通过 `tee` 将输出同时写入日志文件和控制台，post 阶段提取日志摘要附带在 PR 评论中
- **环境清理**：post.cleanup 阶段按以下顺序清理：
    1. 删除 `node_modules` 目录
    2. 删除 `dist` 构建产物
    3. 删除 CI merge 临时分支（`ci-merge-${PR_NUMBER}`）
    4. 删除 CI 日志目录
    5. `cleanWs()` 最终清理整个工作空间

## 故障排除

| 问题                   | 可能原因                  | 解决方法                                                                             |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| Webhook 未触发         | URL 或 Token 不匹配       | 检查 GitCode Webhook 配置和 Jenkins 触发器 Token 是否一致                            |
| PR 变量为空            | JSONPath 配置错误         | GitCode 使用 `$.object_attributes.iid` 等路径，参考上方 Post content parameters 表格 |
| `gitcode-token` 找不到 | Credentials ID 不匹配     | 确认 Jenkins Credentials ID 与 Jenkinsfile 中 `credentialsId` 一致                   |
| `node` 未找到          | NODEJS_HOME 路径错误      | 修改 Jenkinsfile 中的 `NODEJS_HOME` 为实际安装路径                                   |
| merge 冲突             | PR 与 main 存在冲突       | 开发者需先在本地 rebase/merge 解决冲突                                               |
| PR 评论发布失败        | Token 权限不足或 API 限流 | 检查 Token 权限，脚本会自动尝试 commit comment 回退                                  |
| test-cli 失败          | 缺少 setting.json         | 确保构建节点已配置正确的 setting.json                                                |
