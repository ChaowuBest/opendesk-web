#!/usr/bin/env python3
"""
evaluate.py - 独立评估脚本，对已生成的 predictions.json 运行 SWE-bench harness。

用法:
  python evaluate.py --predictions <path> [--dataset <name>] [--split <split>]
                     [--max-workers <n>] [--run-id <id>] [--instance <id>]

也支持用 sb-cli 进行线上评估（远程服务器评估，无需本地 Docker）:
  python evaluate.py --predictions <path> --use-sb-cli --subset verified --split test
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath

DEFAULT_DATASET = "princeton-nlp/SWE-bench_Lite"
DEFAULT_SPLIT = "test"

IS_WINDOWS = sys.platform == "win32"


def _win_to_wsl_path(win_path: str) -> str:
    """将 Windows 路径转换为 WSL 路径，如 D:\\foo\\bar -> /mnt/d/foo/bar"""
    p = Path(win_path).resolve()
    drive = p.drive.rstrip(":").lower()
    rest = PurePosixPath(*p.parts[1:]) if len(p.parts) > 1 else PurePosixPath()
    return f"/mnt/{drive}/{rest}"


def _check_wsl_available() -> bool:
    """检查 WSL 是否可用。"""
    try:
        result = subprocess.run(
            ["wsl", "--status"],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=10,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def _check_wsl_swebench() -> bool:
    """检查 WSL 中是否安装了 swebench。"""
    try:
        result = subprocess.run(
            ["wsl", "python3", "-c", "import swebench; print('ok')"],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
        )
        return result.returncode == 0 and "ok" in result.stdout
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def _run_via_wsl(
    predictions_path: str,
    dataset_name: str,
    split: str,
    max_workers: int,
    run_id: str,
    instance_ids: list[str] | None = None,
):
    """通过 WSL 调用 swebench harness（Windows 专用）。"""
    if not _check_wsl_available():
        print("[错误] WSL 未安装或不可用")
        print("[提示] swebench harness 依赖 Linux（resource 模块），Windows 上需要 WSL")
        print("[提示] 安装 WSL: wsl --install")
        sys.exit(1)

    if not _check_wsl_swebench():
        print("[错误] WSL 中未安装 swebench")
        print("[提示] 在 WSL 中运行: pip install swebench")
        sys.exit(1)

    wsl_pred_path = _win_to_wsl_path(predictions_path)

    cmd = [
        "wsl", "python3", "-m", "swebench.harness.run_evaluation",
        "--dataset_name", dataset_name,
        "--predictions_path", wsl_pred_path,
        "--max_workers", str(max_workers),
        "--run_id", run_id,
        "--split", split,
    ]
    if instance_ids:
        cmd.extend(["--instance_ids"] + instance_ids)

    print(f"[评估] 检测到 Windows，通过 WSL 执行 swebench harness")
    print(f"[评估] 命令: {' '.join(cmd)}")
    print(f"[评估] 数据集: {dataset_name} (split={split})")
    print(f"[评估] predictions (WSL): {wsl_pred_path}")
    print(f"[评估] workers: {max_workers}")
    print()

    try:
        subprocess.run(cmd, check=True)
        print("\n[评估] 完成!")
    except subprocess.CalledProcessError as e:
        print(f"\n[评估] 失败: {e}")
        sys.exit(1)


def run_local_evaluation(
    predictions_path: str,
    dataset_name: str,
    split: str,
    max_workers: int,
    run_id: str,
    instance_ids: list[str] | None = None,
):
    """使用 swebench.harness.run_evaluation 本地评估。
    Windows 上自动转发到 WSL 执行。"""
    if IS_WINDOWS:
        _run_via_wsl(predictions_path, dataset_name, split, max_workers, run_id, instance_ids)
        return

    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--dataset_name", dataset_name,
        "--predictions_path", predictions_path,
        "--max_workers", str(max_workers),
        "--run_id", run_id,
        "--split", split,
    ]
    if instance_ids:
        cmd.extend(["--instance_ids"] + instance_ids)

    print(f"[评估] 命令: {' '.join(cmd)}")
    print(f"[评估] 数据集: {dataset_name} (split={split})")
    print(f"[评估] predictions: {predictions_path}")
    print(f"[评估] workers: {max_workers}")
    print()

    try:
        subprocess.run(cmd, check=True)
        print("\n[评估] 完成!")
    except subprocess.CalledProcessError as e:
        print(f"\n[评估] 失败: {e}")
        sys.exit(1)
    except FileNotFoundError:
        print("[错误] swebench 未安装")
        print("[提示] 请运行: pip install swebench")
        sys.exit(1)


# 友好名 -> sb-cli 原生 subset 名
SB_CLI_SUBSET_MAP = {
    "lite": "swe-bench_lite",
    "verified": "swe-bench_verified",
    "multimodal": "swe-bench-m",
    "swe-bench_lite": "swe-bench_lite",
    "swe-bench_verified": "swe-bench_verified",
    "swe-bench-m": "swe-bench-m",
}


def run_sb_cli_submit(
    predictions_path: str,
    subset: str,
    split: str,
    run_id: str,
):
    """使用 sb-cli 上传 predictions 到 SWE-bench API 进行线上评估。"""
    sb_subset = SB_CLI_SUBSET_MAP.get(subset, subset)
    cmd = [
        "sb-cli", "submit", sb_subset, split,
        "--predictions_path", predictions_path,
        "--run_id", run_id,
    ]
    print(f"[sb-cli] 命令: {' '.join(cmd)}")
    print()

    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"

    try:
        subprocess.run(cmd, check=True, env=env)
        print("\n[sb-cli] 提交完成!")
    except subprocess.CalledProcessError as e:
        print(f"\n[sb-cli] 失败: {e}")
        sys.exit(1)
    except FileNotFoundError:
        print("[错误] sb-cli 未安装")
        print("[提示] 请运行: pip install sb-cli")
        sys.exit(1)


def validate_predictions(predictions_path: str) -> int:
    """验证 predictions 文件格式。返回有效记录数。"""
    path = Path(predictions_path)
    if not path.exists():
        print(f"[错误] 文件不存在: {predictions_path}")
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, dict):
        # id-keyed dict 格式
        count = len(data)
        with_patch = sum(1 for v in data.values() if v.get("model_patch"))
    elif isinstance(data, list):
        count = len(data)
        with_patch = sum(1 for d in data if d.get("model_patch"))
    else:
        print("[错误] predictions 格式无效（应为 list 或 dict）")
        sys.exit(1)

    print(f"[验证] predictions: {count} 条记录, {with_patch} 条含有 patch")
    return count


def main():
    parser = argparse.ArgumentParser(
        description="SWE-bench 评估工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--predictions", type=str, required=True,
                        help="predictions.json 路径")
    parser.add_argument("--dataset", type=str, default=DEFAULT_DATASET,
                        help=f"数据集名称 (默认: {DEFAULT_DATASET})")
    parser.add_argument("--split", type=str, default=DEFAULT_SPLIT,
                        help=f"Split (默认: {DEFAULT_SPLIT})")
    parser.add_argument("--max-workers", type=int, default=4,
                        help="评估 worker 数 (默认: 4)")
    parser.add_argument("--run-id", type=str, default="opendesk-eval",
                        help="运行 ID")
    parser.add_argument("--instance", type=str, nargs="*", default=None,
                        help="只评估指定 instance_id")
    parser.add_argument("--use-sb-cli", action="store_true",
                        help="使用 sb-cli 提交官方评估")
    parser.add_argument("--subset", type=str, default="lite",
                        choices=["lite", "verified", "multimodal",
                                 "swe-bench_lite", "swe-bench_verified", "swe-bench-m"],
                        help="sb-cli 子集 (默认: lite -> swe-bench_lite)")
    parser.add_argument("--validate-only", action="store_true",
                        help="仅验证 predictions 格式")

    args = parser.parse_args()

    validate_predictions(args.predictions)

    if args.validate_only:
        return

    if args.use_sb_cli:
        run_sb_cli_submit(args.predictions, args.subset, args.split, args.run_id)
    else:
        run_local_evaluation(
            args.predictions, args.dataset, args.split,
            args.max_workers, args.run_id, args.instance,
        )


if __name__ == "__main__":
    main()
