# SWE-bench for OpenDesk

在 [SWE-bench](https://www.swebench.com/) 上评估 OpenDesk 编码 Agent 的代码修复能力。

SWE-bench 是一个基于真实 GitHub Issue 的基准测试，要求 Agent 阅读 Issue 描述后在对应仓库代码中生成修复补丁。本适配器将 OpenDesk CLI 的 headless 模式接入 SWE-bench 工作流：**加载 Issue → 检出仓库 → 运行 Agent → 收集 Patch → 评估结果**。

## 支持平台

| 平台                        | Agent 运行 | Harness 评估                            |
| --------------------------- | ---------- | --------------------------------------- |
| Windows (x64)               | ✅         | ✅ (自动通过 WSL 执行，需 WSL + Docker) |
| macOS (Intel/Apple Silicon) | ✅         | ✅ (需 Docker Desktop)                  |
| Linux (x64/arm64)           | ✅         | ✅                                      |

> **说明**：Agent 运行（步骤 1-5）在本地直接执行，不依赖 Docker。Harness 评估（步骤 6）需要 Docker 来构建隔离测试环境。
>
> **Windows 特别说明**：swebench harness 依赖 Linux 的 `resource` 模块，无法直接在 Windows Python 上运行。脚本会自动检测 Windows 环境并通过 WSL 转发执行。需要预先在 WSL 中安装 `swebench` 和 Docker。

## 准备工作

### 1. 安装 Python 依赖

```bash
# 基础依赖（Agent 运行）
pip install datasets huggingface-hub

# 评估依赖（Harness 评估，需要 Docker）
pip install swebench

# 或一次性安装
pip install -r requirements.txt
```

### 2. 安装系统工具

- **Git** ≥ 2.20（用于 clone/checkout 仓库）
- **Docker**（仅评估阶段需要）
    - Windows：[Docker Desktop](https://www.docker.com/products/docker-desktop/)（启用 WSL 2 后端）
    - macOS：`brew install --cask docker` 或 Docker Desktop
    - Linux：`sudo apt install docker.io` 或参考[官方文档](https://docs.docker.com/engine/install/)
- **WSL**（仅 Windows 评估阶段需要）
    ```powershell
    # 安装 WSL
    wsl --install
    # 在 WSL 中安装 swebench
    wsl pip install swebench
    # 确认 Docker 在 WSL 中可用
    wsl docker info
    ```

### 3. 配置 OpenDesk

确保以下路径存在 `setting.json`（模型和 Provider 配置）：

| 平台    | 路径                                                  |
| ------- | ----------------------------------------------------- |
| Windows | `%APPDATA%\opendesk\setting.json`                     |
| macOS   | `~/Library/Application Support/opendesk/setting.json` |
| Linux   | `~/.opendesk/setting.json`                            |

> 运行一次 `opendesk` CLI 即可自动生成配置文件。

### 4. 构建 OpenDesk CLI 二进制（可选）

如果已有编译好的二进制可跳过。脚本会自动查找 `dist/cli/` 下的二进制或 PATH 中的 `opendesk` 命令。

```bash
# Windows
bun build --compile --minify-whitespace --sourcemap \
  --target=bun-windows-x64 src/main/cli.ts \
  --outfile dist/cli/opendesk-win-x64.exe \
  --external node-screenshots --external esbuild --external vectra

# macOS (Apple Silicon)
bun build --compile --minify-whitespace --sourcemap \
  --target=bun-darwin-arm64 src/main/cli.ts \
  --outfile dist/cli/opendesk-darwin-arm64 \
  --external node-screenshots --external esbuild --external vectra

# macOS (Intel)
bun build --compile --minify-whitespace --sourcemap \
  --target=bun-darwin-x64 src/main/cli.ts \
  --outfile dist/cli/opendesk-darwin-x64 \
  --external node-screenshots --external esbuild --external vectra

# Linux (x64)
bun build --compile --minify-whitespace --sourcemap \
  --target=bun-linux-x64 src/main/cli.ts \
  --outfile dist/cli/opendesk-linux-x64 \
  --external node-screenshots --external esbuild --external vectra
```

### 5. 环境验证

```bash
python prefetch.py validate
```

这会检查所有依赖是否就绪。

## 运行评估

```bash
python run.py --model <模型别名> [选项]
```

### 参数说明

| 参数                | 说明                                   | 默认值                         |
| ------------------- | -------------------------------------- | ------------------------------ |
| `--model ALIAS`     | 模型别名，对应 `setting.json` 中的配置 | `default_model`                |
| `--dataset NAME`    | SWE-bench 数据集                       | `princeton-nlp/SWE-bench_Lite` |
| `--split NAME`      | 数据集 split                           | `test`                         |
| `--instance ID`     | 只运行指定 instance_id（调试用）       | 全部                           |
| `-j / --jobs N`     | 最大并发数                             | 1                              |
| `-o / --output DIR` | 输出目录                               | `./jobs/<model>-<timestamp>`   |
| `--timeout SEC`     | 单个任务超时（秒）                     | 1800                           |
| `--evaluate`        | 运行后自动调用 Harness 评估            | 否                             |
| `--max-workers N`   | Harness 评估并发数                     | 4                              |
| `--skip-existing`   | 跳过已有结果的 instance                | 否                             |
| `--analyze PATH`    | 分析已有运行结果                       | —                              |

### 示例

```bash
# 1. 用 gpt-4o 跑完整 SWE-bench Lite 测试集
python run.py --model gpt-4o -o ./jobs/gpt-4o

# 2. 调试单个 instance
python run.py --model gpt-4o --instance django__django-16379 --timeout 3600

# 3. 跑 SWE-bench Verified 子集
python run.py --model claude-sonnet \
  --dataset princeton-nlp/SWE-bench_Verified \
  -o ./jobs/claude-verified

# 4. 2 并发 + 自动评估
python run.py --model gpt-4o -j 2 --evaluate --max-workers 4

# 5. 分析已有结果
python run.py --analyze ./jobs/gpt-4o-20260409-120000
```

## 预下载

### 数据集

```bash
# 预下载 SWE-bench Lite（缓存到 HuggingFace 本地）
python prefetch.py dataset

# 指定其他数据集
python prefetch.py dataset --dataset princeton-nlp/SWE-bench_Verified
```

### Docker 镜像（评估用）

```bash
# 构建/拉取 swebench 评估镜像（需要 Docker）
python prefetch.py images

# 只构建单个 instance 的镜像
python prefetch.py images --instance django__django-16379
```

> ⚠️ 首次构建镜像需要较大磁盘空间（建议 120GB+）和较长时间。

## 独立评估

对已生成的 `predictions.json` 单独运行评估：

```bash
python evaluate.py --predictions ./jobs/gpt-4o/predictions.json \
  --dataset princeton-nlp/SWE-bench_Lite \
  --max-workers 4 \
  --run-id opendesk-gpt4o
```

### 使用 sb-cli 线上评估

通过 SWE-bench 官方 API 进行远程评估（无需本地 Docker 环境）：

```bash
# 安装 sb-cli
pip install sb-cli

# 线上评估（需要 API key，通过 sb-cli login 登录）
python evaluate.py --predictions ./jobs/gpt-4o/predictions.json \
  --use-sb-cli --subset lite --split test
```

> **提交到 Leaderboard** 需要额外步骤：fork [swe-bench/experiments](https://github.com/swe-bench/experiments) 仓库，
> 创建 `metadata.yaml`，然后提交 PR 由 SWE-bench 团队审核。详见 [官方指南](https://www.swebench.com/sb-cli/submit-to-leaderboard/)。

## 输出结构

```
<output-dir>/
  summary.json          # 运行摘要（模型、成功率、耗时、平台信息）
  results.json          # 每个 instance 的详细结果
  predictions.json      # SWE-bench 标准格式（可直接用于评估）
  workspaces/           # 各 instance 的仓库工作目录
    <instance_id>/
      repo/             # 检出的仓库代码（含 agent 修改）
  logs/                 # 各 instance 的日志
    <instance_id>/
      prompt.txt        # 发送给 agent 的完整提示
      opendesk-stdout.txt   # agent 标准输出
      opendesk-stderr.txt   # agent 标准错误
      opendesk-result.json  # agent 导出的结构化结果
      profile.json          # agent 性能 profile
      model_patch.diff      # 生成的 patch 文件
```

## 数据集子集

| 数据集                             | 规模  | 说明                 |
| ---------------------------------- | ----- | -------------------- |
| `princeton-nlp/SWE-bench_Lite`     | ~300  | **推荐**，快速迭代   |
| `princeton-nlp/SWE-bench_Verified` | ~500  | 人工验证，可靠性更高 |
| `princeton-nlp/SWE-bench`          | ~2294 | 完整数据集           |

## 工作流详解

```
┌─────────────────────────────────────────────────────────────────┐
│                     run.py 主流程                                │
│                                                                   │
│  1. 加载数据集 (HuggingFace)                                     │
│     └→ princeton-nlp/SWE-bench_Lite (test split)                 │
│                                                                   │
│  2. 对每个 instance:                                              │
│     ├→ git clone + checkout base_commit                           │
│     ├→ 构建 prompt (problem_statement + 修复指令)                 │
│     ├→ 运行 opendesk --headless -c <prompt>                      │
│     ├→ git diff 收集 patch                                       │
│     └→ 保存到 results.json                                       │
│                                                                   │
│  3. 生成 predictions.json (SWE-bench 标准格式)                    │
│                                                                   │
│  4. (可选) 调用 swebench harness 评估                             │
│     └→ Docker 容器中: apply patch → run tests → grade             │
└─────────────────────────────────────────────────────────────────┘
```

## 与 terminal-bench-v2 的区别

| 方面           | terminal-bench-v2            | swe-bench                     |
| -------------- | ---------------------------- | ----------------------------- |
| 框架           | Harbor (Docker 容器内 Agent) | 本地 Agent + swebench harness |
| 任务类型       | 终端操作任务                 | GitHub Issue 代码修复         |
| Agent 运行环境 | Docker 容器                  | 本地（直接在宿主机）          |
| 评估方式       | Harbor verifier              | swebench harness (Docker)     |
| 输出格式       | Harbor result.json           | predictions.json (标准格式)   |
| 跨平台         | 仅 Linux (容器)              | Windows / macOS / Linux       |

## 文件说明

| 文件               | 用途                                      |
| ------------------ | ----------------------------------------- |
| `run.py`           | 主入口：数据集加载、Agent 调度、结果收集  |
| `evaluate.py`      | 独立评估：调用 swebench harness 或 sb-cli |
| `prefetch.py`      | 预下载数据集和 Docker 镜像                |
| `requirements.txt` | Python 依赖列表                           |

## 常见问题

### Q: git clone 失败（网络问题）

设置 Git 代理：

```bash
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
```

或使用 GitHub 镜像（在 `run.py` 中修改 `repo_url`）。

### Q: OpenDesk 二进制未找到

脚本按以下顺序查找：

1. `dist/cli/opendesk-<platform>-<arch>`（项目内编译产物）
2. `dist/cli/opendesk`（通用名）
3. PATH 中的 `opendesk` 命令

### Q: 评估阶段 Docker 构建失败

- 确保 Docker Desktop 已启动
- 检查磁盘空间（建议 120GB+）
- 检查内存（建议 16GB+）
- ARM 架构目前为实验性支持

### Q: Windows 上评估报 `No module named 'resource'`

`resource` 是 Linux 专有的 Python 标准库模块。脚本已内置 WSL 自动转发，确保：

1. 已安装 WSL：`wsl --install`
2. WSL 中已安装 swebench：`wsl pip install swebench`
3. WSL 中 Docker 可用：`wsl docker info`

脚本会自动将 Windows 路径（如 `D:\foo\bar`）转换为 WSL 路径（`/mnt/d/foo/bar`）。

### Q: 单个 instance 超时

增加超时时间：`--timeout 3600`（1 小时）。

部分复杂 Issue 可能需要更长时间，建议调试时先用 `--instance` 指定单个任务。

### Q: 如何只评估部分 instance

```bash
# 运行时指定
python run.py --instance django__django-16379

# 评估时指定
python evaluate.py --predictions predictions.json --instance django__django-16379
```
