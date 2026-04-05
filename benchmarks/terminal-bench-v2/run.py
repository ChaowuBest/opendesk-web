#!/usr/bin/env python3
"""
run.py - 启动一次 TerminalBench 2.0 评估运行。

选项:
  -o/--output DIR       将运行结果保存到输出目录
  --model ALIAS         指定测试的模型名字（与 ~/.opendesk/setting.json 一致）
  -j/--jobs N           最多同时运行多少个测试任务 (默认: 4)
  --dataset NAME        数据集名称 (默认: terminal-bench@2.0)
  --task NAME           只运行指定名称的单个任务
  --timeout-mul N       全局超时倍率，乘以任务的 timeout_sec (默认: 1.0)
  --resume JOB_PATH     从已有 job 恢复（复用成功结果，重跑异常/失败）
  --retry-errors        恢复时只重跑异常错误的任务（不重跑正常失败）
  --analyze JOB_PATH    分析一个已有 job 的结果，报告异常和改进建议

超时计算: 实际超时 = 任务task.toml中的timeout_sec × timeout-mul
例: regex-log 的 timeout_sec=900s, --timeout-mul 8 → 实际超时 7200s = 2h
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from github_hosts import fetch_github_hosts, parse_host_lines

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

# verifier 网络失败的特征模式
VERIFIER_NET_FAIL_PATTERNS = [
    r"curl:.*Failure when receiving data",
    r"SSL_ERROR_SYSCALL",
    r"stream.*not closed cleanly",
    r"uvx: command not found",
    r"uv: command not found",
    r"/root/\.local/bin/env: No such file or directory",
    r"failed to download.*github\.com",
    r"tls handshake eof",
]

# Agent 异常类型（这些算基础设施/运行异常，而非能力不足）
INFRA_EXCEPTION_TYPES = {
    "NonZeroAgentExitCodeError",
    "VerifierTimeoutError",
}


def get_setting() -> dict | None:
    """从 ~/.opendesk/setting.json 读取完整配置。"""
    if sys.platform == "win32":
        setting_path = Path(os.environ["APPDATA"]) / "opendesk" / "setting.json"
    else:
        setting_path = Path("~/.opendesk/setting.json").expanduser()

    print(f"setting_path: {setting_path}")
    if not setting_path.exists():
        raise FileNotFoundError(
            f"OpenDesk 配置文件不存在: {setting_path}\n"
            "请先在宿主机上配置 OpenDesk"
        )

    with open(setting_path, "r") as f:
        return json.load(f)


def get_setting_models() -> list[str]:
    """读取可用模型别名列表。"""
    data = get_setting()
    if data is None:
        return []
    return [m.get("alias", "?") for m in data.get("models", [])]


def validate_model(model_alias: str) -> bool:
    """验证模型别名是否存在于配置中。"""
    return model_alias in get_setting_models()


def build_setting_for_model(full_setting: dict, model_alias: str) -> dict:
    """根据 model alias 构造精简的 setting.json。"""
    models = full_setting.get("models", [])
    target_model = None
    for m in models:
        if m.get("alias") == model_alias:
            target_model = m
            break

    if target_model is None:
        raise ValueError(f"模型 '{model_alias}' 未找到")

    provider_name = target_model.get("provider_name")
    providers = full_setting.get("providers", [])
    target_provider = None
    for p in providers:
        if p.get("name") == provider_name:
            target_provider = p
            break

    if target_provider is None:
        raise ValueError(f"provider '{provider_name}' 未找到")

    return {
        "default_model": model_alias,
        "default_intent_parsing_model": "",
        "default_embedding_model": "",
        "default_reranker_model": "",
        "default_vision_model": "",
        "providers": [target_provider],
        "models": [target_model],
        "applications": {},
    }


def prepare_mount_dir(model_alias: str) -> Path:
    """准备挂载目录，包含 opendesk 二进制和 setting.json。"""
    mount_dir = SCRIPT_DIR / ".mount-staging"
    mount_dir.mkdir(parents=True, exist_ok=True)

    # 复制 Linux 二进制 (x64 + arm64)
    bin_variants = {
        "opendesk-linux-x64": "bun-linux-x64",
        "opendesk-linux-arm64": "bun-linux-arm64",
    }
    found_any = False
    for bin_name, target_name in bin_variants.items():
        linux_bin = PROJECT_ROOT / "dist" / "cli" / bin_name
        if linux_bin.exists():
            target_bin = mount_dir / bin_name
            if (
                not target_bin.exists()
                or target_bin.stat().st_mtime < linux_bin.stat().st_mtime
            ):
                print(f"[准备] 复制 {bin_name} 到挂载目录...")
                shutil.copy2(linux_bin, target_bin)
            found_any = True

    if not found_any:
        print("[错误] 未找到任何 Linux 二进制文件")
        print("[提示] 请先运行以下命令构建:")
        print(
            "  bun build --compile --minify-whitespace --sourcemap "
            "--target=bun-linux-x64 src/main/cli.ts "
            "--outfile dist/cli/opendesk-linux-x64 "
            "--external node-screenshots --external esbuild --external vectra"
        )
        print(
            "  bun build --compile --minify-whitespace --sourcemap "
            "--target=bun-linux-arm64 src/main/cli.ts "
            "--outfile dist/cli/opendesk-linux-arm64 "
            "--external node-screenshots --external esbuild --external vectra"
        )
        sys.exit(1)

    # 生成精简的 setting.json
    full_setting = get_setting()
    if full_setting is None:
        print("[错误] ~/.opendesk/setting.json 不存在")
        sys.exit(1)

    container_setting = build_setting_for_model(full_setting, model_alias)
    setting_path = mount_dir / "setting.json"
    with open(setting_path, "w") as f:
        json.dump(container_setting, f, indent=2, ensure_ascii=False)

    # 创建外部依赖的 mock node_modules（vectra, number-to-alphabet）
    node_modules_dir = mount_dir / "node_modules"
    node_modules_dir.mkdir(parents=True, exist_ok=True)

    vectra_dir = node_modules_dir / "vectra"
    vectra_dir.mkdir(exist_ok=True)
    vectra_index = vectra_dir / "index.js"
    if not vectra_index.exists():
        vectra_index.write_text(
            "// Stub: vectra is not needed in headless terminal-bench mode\n"
            "class LocalIndex {\n"
            "  constructor() {}\n"
            "  async createIndex() {}\n"
            "  async deleteIndex() {}\n"
            "  async beginUpdate() { return { insertItem() {}, deleteItem() {}, endUpdate() {} }; }\n"
            "  async queryItems() { return []; }\n"
            "  async listItems() { return []; }\n"
            "  async listItemsByMetadata() { return []; }\n"
            "  async getItem() { return null; }\n"
            "  async isIndexCreated() { return false; }\n"
            "  async getIndexStats() { return { version: 1, metadata_config: {}, items: 0 }; }\n"
            "}\n"
            "module.exports = { LocalIndex };\n"
        )
        (vectra_dir / "package.json").write_text(
            '{"name":"vectra","version":"0.0.0-stub","main":"index.js"}\n'
        )

    n2a_dir = node_modules_dir / "number-to-alphabet"
    n2a_dir.mkdir(exist_ok=True)
    n2a_index = n2a_dir / "index.js"
    if not n2a_index.exists():
        n2a_index.write_text(
            "module.exports = function numberToAlphabet(n) { return String.fromCharCode(65 + (n % 26)); };\n"
            "module.exports.default = module.exports;\n"
        )
        (n2a_dir / "package.json").write_text(
            '{"name":"number-to-alphabet","version":"0.0.0-stub","main":"index.js"}\n'
        )

    # 准备 GitHub hosts 文件（用于容器内加速 GitHub 访问）
    hosts_content = fetch_github_hosts(verbose=True)
    hosts_file = mount_dir / "github-hosts.txt"
    if hosts_content:
        host_lines = parse_host_lines(hosts_content)
        if host_lines:
            hosts_file.write_text("\n".join(host_lines) + "\n", encoding="utf-8")
            print(f"[准备] GitHub hosts: {len(host_lines)} 条记录")
        else:
            print("[警告] GitHub hosts 文件内容无效，容器内可能无法访问 GitHub")
    else:
        print("[警告] 未获取到 GitHub hosts，容器内可能无法访问 GitHub")

    print(f"[准备] 挂载目录: {mount_dir}")
    return mount_dir


def _make_harbor_env() -> dict:
    """构建 harbor 子进程的环境变量。"""
    env = os.environ.copy()

    agent_dir = str(SCRIPT_DIR)
    python_path = env.get("PYTHONPATH", "")
    if agent_dir not in python_path:
        sep = ";" if sys.platform == "win32" else ":"
        env["PYTHONPATH"] = (
            f"{agent_dir}{sep}{python_path}" if python_path else agent_dir
        )

    # 只清除 SOCKS 代理（harbor 的 supabase 客户端不支持 SOCKS），保留 HTTP 代理
    # 容器内的 verifier 需要通过 HTTP 代理访问 github.com 下载 uv
    for proxy_var in ["all_proxy", "ALL_PROXY"]:
        val = env.get(proxy_var, "")
        if val and "socks" in val.lower():
            env.pop(proxy_var, None)
    for proxy_var in ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]:
        val = env.get(proxy_var, "")
        if val and "socks" in val.lower():
            env.pop(proxy_var, None)

    # 抑制 pydantic 序列化警告
    env["PYTHONWARNINGS"] = "ignore::UserWarning"

    return env


def build_harbor_command(args, mount_dir: Path) -> list[str]:
    """构建 harbor run 命令行。"""
    cmd = ["uvx", "harbor", "run"]

    # 数据集
    cmd.extend(["-d", args.dataset])

    # 自定义 agent
    cmd.extend(["--agent-import-path", "opendesk_agent:OpenDeskAgent"])

    # 传递 model alias 给 agent
    if args.model:
        cmd.extend(["--ak", f"model_alias={args.model}"])

    # 并发数
    cmd.extend(["-n", str(args.jobs)])

    # 输出目录
    if args.output:
        cmd.extend(["-o", str(args.output)])

    # 超时倍率
    cmd.extend(["--timeout-multiplier", str(args.timeout_mul)])

    # 指定单个任务 (用 include filter)
    if args.task:
        cmd.extend(["-i", args.task])

    # 挂载 opendesk 二进制和配置到容器
    mount_spec = f"{mount_dir.resolve()}:/opendesk-host:ro"
    cmd.extend(["--mounts-json", json.dumps([mount_spec])])

    # 不删除容器镜像（保留 prefetch 预下载的镜像）
    cmd.append("--no-delete")

    # 自动确认环境变量
    cmd.append("-y")

    return cmd


def build_harbor_resume_command(job_path: str, mount_dir: Path,
                                error_types: list[str] | None = None) -> list[str]:
    """构建 harbor job resume 命令行。"""
    cmd = ["uvx", "harbor", "job", "resume", "-p", str(job_path)]

    if error_types:
        for et in error_types:
            cmd.extend(["-f", et])

    return cmd


def _read_harbor_result(output_dir: str) -> dict | None:
    """从 harbor 输出目录中读取 result.json。"""
    output_path = Path(output_dir)
    if not output_path.exists():
        return None

    # harbor 会在输出目录下创建一个日期时间子目录
    for subdir in sorted(output_path.iterdir(), reverse=True):
        if subdir.is_dir() and subdir.name != "__pycache__":
            result_file = subdir / "result.json"
            if result_file.exists():
                try:
                    with open(result_file, "r") as f:
                        return json.load(f)
                except Exception:
                    pass
    return None


def _format_elapsed(seconds: int) -> str:
    """格式化耗时。"""
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}h{m:02d}m{s:02d}s"
    return f"{m:02d}m{s:02d}s"


def _print_summary(harbor_result: dict | None, elapsed_str: str):
    """打印运行总结。"""
    total = 0
    succeeded = 0
    failed = 0

    if harbor_result:
        stats = harbor_result.get("stats", {})
        total = stats.get("n_trials", 0)
        n_errors = stats.get("n_errors", 0)

        for eval_data in stats.get("evals", {}).values():
            reward_stats = eval_data.get("reward_stats", {}).get("reward", {})
            for reward_val, trial_ids in reward_stats.items():
                if float(reward_val) >= 1.0:
                    succeeded += len(trial_ids)
                else:
                    failed += len(trial_ids)

        if failed == 0 and n_errors > 0:
            failed = n_errors

    print()
    print("=" * 60)
    print(f"TerminalBench 2.0 运行总结 [{elapsed_str}]")
    print("=" * 60)
    print(f"  总任务数: {total}")
    print(f"  成功: {succeeded}")
    print(f"  失败: {failed}")
    if total > 0:
        rate = succeeded / total * 100
        print(f"  成功率: {rate:.1f}%")
    print("=" * 60)

    return total, succeeded, failed


# ──────────────────────────── 异常分析 ────────────────────────────


def _check_verifier_net_fail(trial_dir: Path) -> bool:
    """检查 trial 的 verifier 是否因网络问题失败。"""
    stdout_file = trial_dir / "verifier" / "test-stdout.txt"
    if not stdout_file.exists():
        return False
    try:
        content = stdout_file.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False

    for pattern in VERIFIER_NET_FAIL_PATTERNS:
        if re.search(pattern, content):
            return True
    return False


def _get_trial_task_name(trial_name: str) -> str:
    """从 trial_name 中提取 task_name (去掉 __hash 后缀)。"""
    return trial_name.rsplit("__", 1)[0]


def analyze_job(job_dir: str | Path) -> dict:
    """分析一个 job 的运行结果，返回分类信息。"""
    job_dir = Path(job_dir)
    result_file = job_dir / "result.json"

    if not result_file.exists():
        print(f"[错误] result.json 不存在: {result_file}")
        return {}

    with open(result_file, "r") as f:
        result = json.load(f)

    stats = result.get("stats", {})
    eval_key = next(iter(stats.get("evals", {})), None)
    if not eval_key:
        print("[错误] result.json 中没有评测数据")
        return {}

    eval_data = stats["evals"][eval_key]
    reward_stats = eval_data.get("reward_stats", {}).get("reward", {})
    exception_stats = eval_data.get("exception_stats", {})

    success_trials = reward_stats.get("1.0", [])
    fail_trials = reward_stats.get("0.0", [])

    # 对所有失败和异常的 trial 做分类
    analysis = {
        "success": [],
        "fail_real": [],            # 正常失败（agent 能力不足）
        "fail_verifier_net": [],    # verifier 网络问题
        "error_timeout": [],        # Agent 超时
        "error_exit_code": [],      # Agent 非零退出码
        "error_verifier_timeout": [],  # Verifier 超时
        "error_other": [],          # 其他异常
    }

    analysis["success"] = [
        {"trial": t, "task": _get_trial_task_name(t)} for t in success_trials
    ]

    # 归类异常 trials
    exception_trials = {}
    for exc_type, trials in exception_stats.items():
        for t in trials:
            exception_trials[t] = exc_type

    for trial_name in fail_trials:
        trial_dir = job_dir / trial_name
        task_name = _get_trial_task_name(trial_name)
        entry = {"trial": trial_name, "task": task_name}

        exc_type = exception_trials.get(trial_name)

        if exc_type == "AgentTimeoutError":
            if _check_verifier_net_fail(trial_dir):
                entry["note"] = "AgentTimeout + verifier网络失败"
                analysis["error_timeout"].append(entry)
            else:
                analysis["error_timeout"].append(entry)
        elif exc_type == "NonZeroAgentExitCodeError":
            exc_file = trial_dir / "exception.txt"
            if exc_file.exists():
                content = exc_file.read_text(errors="replace")
                if "No such file or directory" in content:
                    entry["note"] = "容器工作目录不存在"
                entry["exception_snippet"] = content[-300:]
            analysis["error_exit_code"].append(entry)
        elif exc_type == "VerifierTimeoutError":
            analysis["error_verifier_timeout"].append(entry)
        elif exc_type:
            entry["exception_type"] = exc_type
            analysis["error_other"].append(entry)
        elif _check_verifier_net_fail(trial_dir):
            analysis["fail_verifier_net"].append(entry)
        else:
            analysis["fail_real"].append(entry)

    return analysis


def print_analysis(analysis: dict):
    """打印分析结果。"""
    if not analysis:
        return

    n_success = len(analysis["success"])
    n_real_fail = len(analysis["fail_real"])
    n_net_fail = len(analysis["fail_verifier_net"])
    n_timeout = len(analysis["error_timeout"])
    n_exit = len(analysis["error_exit_code"])
    n_vtimeout = len(analysis["error_verifier_timeout"])
    n_other = len(analysis["error_other"])
    total = n_success + n_real_fail + n_net_fail + n_timeout + n_exit + n_vtimeout + n_other

    anomaly_count = n_net_fail + n_exit + n_vtimeout + n_other

    print()
    print("=" * 60)
    print("异常分析报告")
    print("=" * 60)
    print(f"  总任务数: {total}")
    print(f"  成功: {n_success} ({n_success/total*100:.1f}%)" if total else "")
    print(f"  正常失败（能力不足）: {n_real_fail}")
    print(f"  Agent 超时: {n_timeout}")
    print()
    print(f"  --- 异常错误（非能力问题）: {anomaly_count} ---")
    print(f"  Verifier 网络失败: {n_net_fail}")
    print(f"  Agent 非零退出码: {n_exit}")
    print(f"  Verifier 超时: {n_vtimeout}")
    if n_other:
        print(f"  其他异常: {n_other}")
    print()

    if n_net_fail:
        print("  [Verifier 网络失败] (uv/curl 下载失败):")
        for e in analysis["fail_verifier_net"]:
            print(f"    - {e['task']}")
    if n_exit:
        print("  [Agent 非零退出码]:")
        for e in analysis["error_exit_code"]:
            note = f" ({e['note']})" if e.get("note") else ""
            print(f"    - {e['task']}{note}")
    if n_vtimeout:
        print("  [Verifier 超时]:")
        for e in analysis["error_verifier_timeout"]:
            print(f"    - {e['task']}")
    print()

    if anomaly_count:
        print(f"  如果异常错误全部修复，预估最高成功率: "
              f"{(n_success + anomaly_count) / total * 100:.1f}%")


def get_tasks_to_rerun(analysis: dict, errors_only: bool = False) -> list[str]:
    """获取需要重跑的 task 名称列表。

    errors_only=True: 只重跑异常错误（网络/退出码/verifier超时）
    errors_only=False: 重跑异常错误 + 正常失败 + Agent超时
    """
    tasks = set()

    # 异常错误始终重跑
    for entry in analysis.get("fail_verifier_net", []):
        tasks.add(entry["task"])
    for entry in analysis.get("error_exit_code", []):
        tasks.add(entry["task"])
    for entry in analysis.get("error_verifier_timeout", []):
        tasks.add(entry["task"])
    for entry in analysis.get("error_other", []):
        tasks.add(entry["task"])

    if not errors_only:
        for entry in analysis.get("fail_real", []):
            tasks.add(entry["task"])
        for entry in analysis.get("error_timeout", []):
            tasks.add(entry["task"])

    return sorted(tasks)


# ──────────────────────── resume 功能 ──────────────────────────


def _find_latest_job_dir(model_output_dir: str | Path) -> Path | None:
    """查找模型输出目录下最新的 job 目录。"""
    model_dir = Path(model_output_dir)
    if not model_dir.exists():
        return None
    job_dirs = [
        d for d in sorted(model_dir.iterdir(), reverse=True)
        if d.is_dir() and d.name != "__pycache__" and (d / "result.json").exists()
    ]
    return job_dirs[0] if job_dirs else None


def run_resume(args):
    """从已有 job 恢复运行。"""
    resume_path = Path(args.resume)
    if not resume_path.exists():
        print(f"[错误] 恢复路径不存在: {resume_path}")
        sys.exit(1)

    # 如果指定的是模型目录而不是具体 job 目录，找最新的
    if not (resume_path / "result.json").exists():
        job_dir = _find_latest_job_dir(resume_path)
        if job_dir is None:
            print(f"[错误] 在 {resume_path} 中未找到有效的 job 目录")
            sys.exit(1)
        resume_path = job_dir

    print(f"[恢复] 分析旧 job: {resume_path}")
    analysis = analyze_job(resume_path)
    print_analysis(analysis)

    tasks_to_rerun = get_tasks_to_rerun(analysis, errors_only=args.retry_errors)
    if not tasks_to_rerun:
        print("[恢复] 没有需要重跑的任务")
        sys.exit(0)

    print(f"\n[恢复] 需要重跑 {len(tasks_to_rerun)} 个任务:")
    for t in tasks_to_rerun:
        print(f"  - {t}")
    print()

    # 读取旧 job 的配置确定模型
    config_file = resume_path / "config.json"
    model = args.model
    if not model and config_file.exists():
        with open(config_file) as f:
            config = json.load(f)
        agents = config.get("agents", [])
        if agents:
            model = agents[0].get("kwargs", {}).get("model_alias", "")
    if not model:
        print("[错误] 无法确定模型名称，请通过 --model 指定")
        sys.exit(1)

    # 创建新的输出目录
    if args.output:
        output_dir = Path(args.output)
    else:
        output_dir = resume_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)

    # 准备新的 job 目录
    job_name = datetime.now().strftime("%Y-%m-%d__%H-%M-%S")
    new_job_dir = output_dir / job_name
    new_job_dir.mkdir(parents=True, exist_ok=True)

    # 复制成功的 trial 结果到新目录
    success_tasks = {e["task"] for e in analysis.get("success", [])}
    copied = 0
    for entry in analysis.get("success", []):
        trial_name = entry["trial"]
        src = resume_path / trial_name
        dst = new_job_dir / trial_name
        if src.exists() and not dst.exists():
            shutil.copytree(src, dst)
            copied += 1

    # 如果 retry_errors 模式，也复制正常失败和 Agent 超时的结果
    if args.retry_errors:
        for category in ["fail_real", "error_timeout"]:
            for entry in analysis.get(category, []):
                trial_name = entry["trial"]
                src = resume_path / trial_name
                dst = new_job_dir / trial_name
                if src.exists() and not dst.exists():
                    shutil.copytree(src, dst)
                    copied += 1

    print(f"[恢复] 已复制 {copied} 个 trial 结果到新目录")

    # 使用 harbor job resume 重跑失败的任务
    mount_dir = prepare_mount_dir(model)
    env = _make_harbor_env()

    # 构建 harbor resume 命令
    # harbor job resume 会自动检测哪些 trial 需要重跑
    error_types = [
        "AgentTimeoutError",
        "NonZeroAgentExitCodeError",
        "VerifierTimeoutError",
    ]
    cmd = build_harbor_resume_command(
        str(resume_path), mount_dir, error_types=error_types
    )

    print(f"\n[启动] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"[命令] {' '.join(cmd)}")
    print(f"[模型] {model}")
    print()

    start_time = time.time()
    ret = subprocess.call(cmd, env=env)
    elapsed_str = _format_elapsed(int(time.time() - start_time))

    harbor_result = _read_harbor_result(str(output_dir))
    _print_summary(harbor_result, elapsed_str)

    # 保存合并后的摘要
    if harbor_result:
        summary = {
            "timestamp": datetime.now().isoformat(),
            "model": model,
            "resumed_from": str(resume_path),
            "tasks_rerun": tasks_to_rerun,
            "harbor_result": harbor_result,
        }
        summary_path = output_dir / "summary.json"
        with open(summary_path, "w") as f:
            json.dump(summary, f, indent=2, ensure_ascii=False)
        print(f"\n[保存] 结果摘要已保存到 {summary_path}")


def run_evaluation(args):
    """执行评估并实时监控输出。"""
    model = args.model
    if not model:
        setting = get_setting()
        if setting:
            model = setting.get("default_model", "")
        if not model:
            print("[错误] 未指定模型，且 setting.json 中无默认模型")
            sys.exit(1)
        print(f"[信息] 使用默认模型: {model}")

    if not validate_model(model):
        available = get_setting_models()
        print(f"[错误] 模型 '{model}' 不在配置中")
        if available:
            print(f"[提示] 可用模型: {', '.join(available)}")
        sys.exit(1)

    # 确保输出目录存在
    if args.output:
        Path(args.output).mkdir(parents=True, exist_ok=True)

    # 准备挂载目录
    mount_dir = prepare_mount_dir(model)
    env = _make_harbor_env()

    cmd = build_harbor_command(args, mount_dir)
    print(f"\n[启动] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"[命令] {' '.join(cmd)}")
    print(f"[模型] {model}")
    print(f"[并发] {args.jobs}")
    print(f"[数据集] {args.dataset}")
    if args.task:
        print(f"[单任务] {args.task}")
    print()

    start_time = time.time()

    # 直接让 harbor 输出到终端（harbor 使用 rich 库，通过 PIPE 捕获会丢失进度条）
    ret = subprocess.call(cmd, env=env)

    elapsed_str = _format_elapsed(int(time.time() - start_time))

    # 从 harbor 的 result.json 读取真实结果
    harbor_result = _read_harbor_result(args.output) if args.output else None
    total, succeeded, failed = _print_summary(harbor_result, elapsed_str)

    # 保存结果摘要
    if args.output:
        summary = {
            "timestamp": datetime.now().isoformat(),
            "model": model,
            "dataset": args.dataset,
            "total": total,
            "succeeded": succeeded,
            "failed": failed,
            "success_rate": (
                succeeded / total * 100 if total > 0 else 0
            ),
        }
        if harbor_result:
            summary["harbor_result"] = harbor_result
        summary_path = Path(args.output) / "summary.json"
        with open(summary_path, "w") as f:
            json.dump(summary, f, indent=2, ensure_ascii=False)
        print(f"\n[保存] 结果摘要已保存到 {summary_path}")

    # 运行后自动分析异常
    if args.output:
        latest_job = _find_latest_job_dir(args.output)
        if latest_job:
            analysis = analyze_job(latest_job)
            print_analysis(analysis)

    sys.exit(0 if failed == 0 and ret == 0 else 1)


def run_analyze(args):
    """分析已有 job 结果。"""
    job_path = Path(args.analyze)
    if not job_path.exists():
        print(f"[错误] 路径不存在: {job_path}")
        sys.exit(1)

    # 如果是模型目录，查找最新 job
    if not (job_path / "result.json").exists():
        job_dir = _find_latest_job_dir(job_path)
        if job_dir is None:
            print(f"[错误] 在 {job_path} 中未找到有效的 job 目录")
            sys.exit(1)
        job_path = job_dir

    print(f"[分析] {job_path}")
    analysis = analyze_job(job_path)
    print_analysis(analysis)

    tasks = get_tasks_to_rerun(analysis, errors_only=True)
    if tasks:
        print(f"\n可使用以下命令重跑异常错误的任务:")
        print(f"  python run.py --resume {job_path} --retry-errors --model <MODEL>")


def main():
    parser = argparse.ArgumentParser(
        description="TerminalBench 2.0 评估运行工具"
    )
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        help="将运行结果保存到输出目录",
    )
    parser.add_argument(
        "--model",
        type=str,
        help="指定测试的模型别名（与 ~/.opendesk/setting.json 一致）",
    )
    parser.add_argument(
        "-j",
        "--jobs",
        type=int,
        default=4,
        help="最多同时运行多少个测试任务 (默认: 4)",
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default="terminal-bench@2.0",
        help="数据集名称 (默认: terminal-bench@2.0)",
    )
    parser.add_argument(
        "--task",
        type=str,
        help="只运行指定名称的单个任务",
    )
    parser.add_argument(
        "--timeout-mul",
        type=float,
        default=1.0,
        help="全局超时倍率，乘以任务自身的 timeout_sec (默认: 1.0)",
    )
    parser.add_argument(
        "--resume",
        type=str,
        metavar="JOB_PATH",
        help="从已有 job 恢复（复用成功结果，重跑异常/失败）",
    )
    parser.add_argument(
        "--retry-errors",
        action="store_true",
        help="恢复时只重跑异常错误的任务（不重跑正常失败和超时）",
    )
    parser.add_argument(
        "--analyze",
        type=str,
        metavar="JOB_PATH",
        help="分析一个已有 job 的结果，报告异常和改进建议",
    )

    args = parser.parse_args()

    if args.analyze:
        run_analyze(args)
    elif args.resume:
        run_resume(args)
    else:
        run_evaluation(args)


if __name__ == "__main__":
    main()
