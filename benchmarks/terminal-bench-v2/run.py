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

超时计算: 实际超时 = 任务task.toml中的timeout_sec × timeout-mul
例: regex-log 的 timeout_sec=900s, --timeout-mul 8 → 实际超时 7200s = 2h
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent


def get_setting() -> dict | None:
    """从 ~/.opendesk/setting.json 读取完整配置。"""
    setting_path = Path("~/.opendesk/setting.json").expanduser()
    if not setting_path.exists():
        return None
    try:
        with open(setting_path, "r") as f:
            return json.load(f)
    except Exception:
        return None


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
            "--external node-screenshots --external esbuild"
        )
        print(
            "  bun build --compile --minify-whitespace --sourcemap "
            "--target=bun-linux-arm64 src/main/cli.ts "
            "--outfile dist/cli/opendesk-linux-arm64 "
            "--external node-screenshots --external esbuild"
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

    print(f"[准备] 挂载目录: {mount_dir}")
    return mount_dir


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

    # 确保 opendesk_agent.py 所在目录在 PYTHONPATH 中
    agent_dir = str(SCRIPT_DIR)
    env = os.environ.copy()
    python_path = env.get("PYTHONPATH", "")
    if agent_dir not in python_path:
        env["PYTHONPATH"] = (
            f"{agent_dir}:{python_path}" if python_path else agent_dir
        )

    # harbor 的 supabase 客户端不支持 SOCKS 代理，需要清除
    for proxy_var in [
        "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
        "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY",
    ]:
        env.pop(proxy_var, None)

    # 抑制 pydantic 序列化警告
    env["PYTHONWARNINGS"] = "ignore::UserWarning"

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

    elapsed_s = int(time.time() - start_time)
    elapsed_m, elapsed_s = divmod(elapsed_s, 60)
    elapsed_h, elapsed_m = divmod(elapsed_m, 60)
    if elapsed_h > 0:
        elapsed_str = f"{elapsed_h}h{elapsed_m:02d}m{elapsed_s:02d}s"
    else:
        elapsed_str = f"{elapsed_m:02d}m{elapsed_s:02d}s"

    # 从 harbor 的 result.json 读取真实结果
    harbor_result = _read_harbor_result(args.output) if args.output else None

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

    # 打印总结
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

    sys.exit(0 if failed == 0 and ret == 0 else 1)


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

    args = parser.parse_args()
    run_evaluation(args)


if __name__ == "__main__":
    main()
