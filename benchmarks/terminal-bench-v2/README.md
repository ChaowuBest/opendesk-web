# Terminal Bench 2.0

使用 [Harbor](https://github.com/codegenresearch/harbor) 框架运行 TerminalBench 2.0 评估，
通过 Docker 容器在隔离环境中让 OpenDesk 完成终端任务。

## 准备工作

1. 安装 [uv](https://docs.astral.sh/uv/) 并配置国内 PyPI 镜像源；
2. 安装 Docker 并配置国内镜像源：
    - Windows 上可使用 Docker Desktop，参考 [腾讯云教程](https://cloud.tencent.com/developer/article/2516747) 配置镜像加速；
3. 确保 `~/.opendesk/setting.json`（Windows 为 `%APPDATA%/opendesk/setting.json`）已配置好模型和 Provider。

## 构建 Linux 二进制

容器内运行的是 Linux 环境，需要交叉编译 OpenDesk CLI 二进制：

```bash
# x64（必须）
bun build --compile --minify-whitespace --sourcemap \
  --target=bun-linux-x64 src/main/cli.ts \
  --outfile dist/cli/opendesk-linux-x64 \
  --external node-screenshots --external esbuild --external vectra

# arm64（可选，如果容器运行在 ARM 机器上）
bun build --compile --minify-whitespace --sourcemap \
  --target=bun-linux-arm64 src/main/cli.ts \
  --outfile dist/cli/opendesk-linux-arm64 \
  --external node-screenshots --external esbuild --external vectra
```

> **注意：** `--external vectra` 不可省略，否则 vectra 内部的 `gpt-3-encoder` 会在编译时硬编码宿主机文件路径，导致容器内运行失败。

## 预下载 Docker 镜像

TerminalBench 的每个任务都使用不同的 Docker 镜像。首次运行前建议先预下载：

```bash
# 预下载所有任务镜像（默认并发 4）
python prefetch.py download

# 指定并发数
python prefetch.py download --concurrency 8

# 清理所有已下载的镜像
python prefetch.py clear
```

`prefetch.py` 内置了国内 Docker 加速镜像，会自动尝试多个源。

## 运行评估

```bash
python run.py --model <模型别名> -j <并发数> --timeout-mul <超时倍率> -o <输出目录>
```

### 参数说明

| 参数                | 说明                                       | 默认值                   |
| ------------------- | ------------------------------------------ | ------------------------ |
| `--model ALIAS`     | 模型别名，需与 `setting.json` 中一致       | 配置中的 `default_model` |
| `-j / --jobs N`     | 最多同时运行的任务数                       | 4                        |
| `-o / --output DIR` | 结果输出目录                               | 无                       |
| `--dataset NAME`    | 数据集名称                                 | `terminal-bench@2.0`     |
| `--task NAME`       | 只运行指定名称的单个任务                   | 无（运行全部）           |
| `--timeout-mul N`   | 全局超时倍率，乘以任务自身的 `timeout_sec` | 1.0                      |

### 示例

```bash
# 用 qwen3.6-plus 模型，6 并发，4 倍超时
python run.py --model qwen3.6-plus -j 6 --timeout-mul 4.0 -o ./jobs/qwen3.6-plus

# 只跑单个任务调试
python run.py --model qwen3.6-plus --task regex-chess --timeout-mul 4.0 -o ./jobs/debug
```

超时计算：实际超时 = 任务 `task.toml` 中的 `timeout_sec` × `--timeout-mul`。
例如 `timeout_sec=900s`，`--timeout-mul 8` → 实际超时 7200s = 2h。

## 输出结构

```
<output-dir>/
  summary.json          # 运行摘要（成功率、模型、时间等）
  <timestamp>/
    config.json         # Harbor 运行配置
    result.json         # Harbor 结果汇总
    job.log             # 总日志
    <task-name>__<id>/
      config.json       # 任务配置
      exception.txt     # 异常信息（如果失败）
      result.json       # 任务结果
      trial.log         # 任务日志
      agent/            # Agent 日志
      artifacts/        # 任务产物
      verifier/         # 验证器输出
```

## 文件说明

| 文件                | 用途                                             |
| ------------------- | ------------------------------------------------ |
| `run.py`            | 主入口，准备挂载目录、调用 Harbor 运行评估       |
| `opendesk_agent.py` | Harbor Agent 适配器，在容器内安装并运行 OpenDesk |
| `prefetch.py`       | 预下载 Docker 镜像，支持国内加速                 |
