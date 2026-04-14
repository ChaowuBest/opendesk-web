#!/usr/bin/env python3
"""
prefetch.py - 预下载 SWE-bench 数据集和 Docker 镜像。

用法:
  python prefetch.py dataset              # 下载数据集到本地缓存
  python prefetch.py dataset --dataset <name> --split <split>
  python prefetch.py images               # 构建/拉取 swebench 评估镜像
  python prefetch.py images --instance <id>
  python prefetch.py validate             # 验证本地环境
"""

import argparse
import importlib
import importlib.util
import platform
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_DATASET = "princeton-nlp/SWE-bench_Lite"
DEFAULT_SPLIT = "test"


def prefetch_dataset(dataset_name: str, split: str):
    """预下载 SWE-bench 数据集到 HuggingFace 缓存。"""
    try:
        from datasets import load_dataset
    except ImportError:
        print("[错误] 请先安装: pip install datasets")
        sys.exit(1)

    print(f"[数据集] 下载 {dataset_name} (split={split})...")
    ds = load_dataset(dataset_name, split=split)
    print(f"[数据集] 下载完成: {len(ds)} 条记录")

    # 打印样本统计
    repos = set()
    for row in ds:
        repos.add(row.get("repo", ""))
    print(f"[数据集] 涉及 {len(repos)} 个仓库:")
    for r in sorted(repos):
        count = sum(1 for row in ds if row.get("repo") == r)
        print(f"  {r}: {count} 个实例")


def prefetch_swebench_images(dataset_name: str, split: str, instance_id: str | None = None):
    """使用 swebench 工具构建评估用 Docker 镜像。"""
    try:
        import swebench
    except ImportError:
        print("[错误] swebench 未安装")
        print("[提示] 请运行: pip install swebench")
        sys.exit(1)

    print("[镜像] 使用 swebench 构建评估 Docker 镜像...")
    print("[镜像] 这可能需要较长时间（首次构建）...")

    cmd = [
        sys.executable, "-m", "swebench.harness.run_evaluation",
        "--dataset_name", dataset_name,
        "--predictions_path", "gold",
        "--max_workers", "1",
        "--run_id", "prefetch-validate",
        "--split", split,
    ]
    if instance_id:
        cmd.extend(["--instance_ids", instance_id])

    print(f"[镜像] 命令: {' '.join(cmd)}")
    try:
        subprocess.run(cmd, check=True)
        print("[镜像] 构建完成")
    except subprocess.CalledProcessError as e:
        print(f"[镜像] 构建失败: {e}")
        print("[提示] 确保 Docker 已启动且有足够磁盘空间")


def validate_environment():
    """验证本地环境是否就绪。"""
    print("=" * 60)
    print("SWE-bench 环境检查")
    print("=" * 60)

    checks = []

    # Python 版本
    py_ver = platform.python_version()
    ok = sys.version_info >= (3, 10)
    checks.append(("Python >= 3.10", ok, py_ver))

    # git
    git_ok = shutil.which("git") is not None
    checks.append(("git", git_ok, shutil.which("git") or "未找到"))

    # docker
    docker_ok = shutil.which("docker") is not None
    if docker_ok:
        try:
            result = subprocess.run(["docker", "info"], capture_output=True, text=True, timeout=10)
            docker_ok = result.returncode == 0
        except Exception:
            docker_ok = False
    checks.append(("docker (运行中)", docker_ok, shutil.which("docker") or "未找到"))

    # datasets
    ds_ok = importlib.util.find_spec("datasets") is not None
    checks.append(("datasets (pip)", ds_ok, "已安装" if ds_ok else "pip install datasets"))

    # swebench
    swe_ok = importlib.util.find_spec("swebench") is not None
    checks.append(("swebench (pip)", swe_ok, "已安装" if swe_ok else "pip install swebench"))

    # OpenDesk setting
    from run import get_setting_path
    setting_path = get_setting_path()
    setting_ok = setting_path.exists()
    checks.append(("OpenDesk setting.json", setting_ok, str(setting_path)))

    # OpenDesk binary
    from run import find_opendesk_binary
    binary = find_opendesk_binary()
    bin_ok = binary is not None
    checks.append(("OpenDesk 二进制", bin_ok, str(binary) if binary else "未找到"))

    # 打印结果
    all_ok = True
    for name, ok, detail in checks:
        status = "✓" if ok else "✗"
        print(f"  {status} {name}: {detail}")
        if not ok:
            all_ok = False

    print()
    if all_ok:
        print("环境检查通过!")
    else:
        print("存在问题，请修复后再运行评估。")
    print("=" * 60)

    return all_ok


def main():
    parser = argparse.ArgumentParser(description="SWE-bench 预下载工具")
    subparsers = parser.add_subparsers(dest="command")

    # dataset 子命令
    ds_parser = subparsers.add_parser("dataset", help="预下载数据集")
    ds_parser.add_argument("--dataset", default=DEFAULT_DATASET)
    ds_parser.add_argument("--split", default=DEFAULT_SPLIT)

    # images 子命令
    img_parser = subparsers.add_parser("images", help="构建评估 Docker 镜像")
    img_parser.add_argument("--dataset", default=DEFAULT_DATASET)
    img_parser.add_argument("--split", default=DEFAULT_SPLIT)
    img_parser.add_argument("--instance", type=str, default=None)

    # validate 子命令
    subparsers.add_parser("validate", help="验证本地环境")

    args = parser.parse_args()

    if args.command == "dataset":
        prefetch_dataset(args.dataset, args.split)
    elif args.command == "images":
        prefetch_swebench_images(args.dataset, args.split, getattr(args, "instance", None))
    elif args.command == "validate":
        validate_environment()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
