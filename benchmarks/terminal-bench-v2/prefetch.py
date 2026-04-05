#!/usr/bin/env python3
"""
prefetch.py - 预下载 TerminalBench 2.0 运行所需的 Docker 镜像。

子命令:
  download  预拉取所有任务的 Docker 基础镜像（支持 --concurrency 指定并发数）
  clear     删除所有已拉取的 TerminalBench 相关镜像
  hosts     预下载 GitHub hosts 文件（解决国内 GitHub 网络问题）
"""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from github_hosts import fetch_github_hosts, parse_host_lines

DATASET_NAME = "terminal-bench@2.0"
HARBOR_CACHE_DIR = Path("~/.cache/harbor/tasks").expanduser()

# 国内 Docker 加速镜像列表
MIRROR_REGISTRIES = [
    "https://docker.1ms.run",
    "https://docker.xuanyuan.me",
    "https://dockerpull.org",
]


def configure_docker_mirrors():
    """配置国内 Docker 加速镜像（仅在 daemon.json 中没有 mirror 配置时）。"""
    daemon_json_path = Path("/etc/docker/daemon.json")

    if daemon_json_path.exists():
        try:
            with open(daemon_json_path, "r") as f:
                config = json.load(f)
        except (json.JSONDecodeError, OSError):
            config = {}
    else:
        config = {}

    existing_mirrors = config.get("registry-mirrors", [])
    if existing_mirrors:
        print(f"[镜像加速] 已有 {len(existing_mirrors)} 个镜像配置，跳过")
        return

    config["registry-mirrors"] = MIRROR_REGISTRIES
    print(f"[镜像加速] 正在写入 {daemon_json_path} ...")
    try:
        daemon_json_path.parent.mkdir(parents=True, exist_ok=True)
        with open(daemon_json_path, "w") as f:
            json.dump(config, f, indent=2)
        print("[镜像加速] 请手动重启 Docker Desktop 以应用加速镜像配置")
    except PermissionError:
        print(
            f"[镜像加速] 无写入权限，请手动将以下内容添加到 {daemon_json_path}:"
        )
        print(json.dumps({"registry-mirrors": MIRROR_REGISTRIES}, indent=2))


def download_dataset():
    """使用 harbor download 拉取数据集到本地缓存。"""
    print(f"[下载数据集] 正在下载 {DATASET_NAME} ...")
    result = subprocess.run(
        ["uvx", "harbor", "download", DATASET_NAME],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        # 尝试 no-proxy 方式
        env = os.environ.copy()
        env.pop("http_proxy", None)
        env.pop("https_proxy", None)
        env.pop("HTTP_PROXY", None)
        env.pop("HTTPS_PROXY", None)
        env.pop("all_proxy", None)
        env.pop("ALL_PROXY", None)
        print("[下载数据集] 首次尝试失败，尝试不使用代理...")
        result = subprocess.run(
            ["uvx", "harbor", "download", DATASET_NAME],
            capture_output=True,
            text=True,
            env=env,
        )
        if result.returncode != 0:
            print(f"[下载数据集] 失败: {result.stderr.strip()}")
            return False
    print("[下载数据集] 完成")
    return True


def find_task_dirs() -> list[Path]:
    """在 harbor 缓存中查找已下载的任务目录。"""
    task_dirs = []
    if not HARBOR_CACHE_DIR.exists():
        return task_dirs

    for candidate in HARBOR_CACHE_DIR.rglob("task.toml"):
        task_dirs.append(candidate.parent)

    return task_dirs


def extract_docker_images(task_dirs: list[Path]) -> set[str]:
    """从任务目录的 Dockerfile / task.toml 中提取需要的 Docker 镜像。"""
    images = set()

    for task_dir in task_dirs:
        # 先检查 task.toml 里是否有 docker_image
        task_toml = task_dir / "task.toml"
        if task_toml.exists():
            try:
                import tomllib
            except ImportError:
                import tomli as tomllib  # type: ignore[no-redef]
            try:
                with open(task_toml, "rb") as f:
                    config = tomllib.load(f)
                docker_image = (
                    config.get("environment", {}).get("docker_image")
                )
                if docker_image:
                    images.add(docker_image)
                    continue
            except Exception:
                pass

        # 解析 Dockerfile 中的 FROM 指令
        dockerfile = task_dir / "environment" / "Dockerfile"
        if dockerfile.exists():
            try:
                content = dockerfile.read_text()
                for match in re.finditer(
                    r"^FROM\s+(\S+)", content, re.MULTILINE
                ):
                    image = match.group(1)
                    if image.startswith("$"):
                        continue
                    images.add(image)
            except OSError:
                pass

        # docker-compose.yaml
        compose_file = task_dir / "environment" / "docker-compose.yaml"
        if compose_file.exists():
            try:
                import yaml

                with open(compose_file, "r") as f:
                    compose = yaml.safe_load(f)
                if compose and "services" in compose:
                    for service in compose["services"].values():
                        img = service.get("image")
                        if img:
                            images.add(img)
            except Exception:
                pass

    return images


async def pull_image(image: str, semaphore: asyncio.Semaphore) -> bool:
    """异步拉取单个 Docker 镜像。"""
    async with semaphore:
        print(f"  [拉取] {image} ...")
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "pull",
            image,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode == 0:
            print(f"  [完成] {image}")
            return True
        else:
            err = stderr.decode().strip()
            print(f"  [失败] {image}: {err}")
            return False


async def pull_all_images(
    images: set[str], concurrency: int
) -> tuple[int, int]:
    """并发拉取所有镜像，返回 (成功数, 失败数)。"""
    semaphore = asyncio.Semaphore(concurrency)
    tasks = [pull_image(img, semaphore) for img in sorted(images)]
    results = await asyncio.gather(*tasks)
    ok = sum(1 for r in results if r)
    fail = sum(1 for r in results if not r)
    return ok, fail


def cmd_hosts(args):
    """hosts 子命令入口：预下载 GitHub hosts 文件。"""
    content = fetch_github_hosts(verbose=True)
    if content:
        lines = parse_host_lines(content)
        print(f"[GitHub Hosts] 共 {len(lines)} 条有效 hosts 记录")
    else:
        sys.exit(1)


def cmd_download(args):
    """download 子命令入口。"""
    # 预获取 GitHub hosts（加速后续 git clone 等网络操作）
    fetch_github_hosts(verbose=True)

    # 尝试配置镜像加速
    if args.mirror:
        configure_docker_mirrors()

    # 下载数据集
    if not download_dataset():
        print("[错误] 数据集下载失败，尝试仅使用本地缓存中的任务...")

    # 查找任务目录
    task_dirs = find_task_dirs()
    if not task_dirs:
        print("[错误] 未找到任何任务目录，请确保数据集已下载")
        sys.exit(1)

    print(f"[发现] {len(task_dirs)} 个任务")

    # 提取镜像列表
    images = extract_docker_images(task_dirs)
    if not images:
        print("[信息] 所有任务都使用自定义 Dockerfile 构建，无需预拉取基础镜像")
        print("[信息] 任务镜像将在首次运行时自动构建")
        return

    print(f"[镜像] 需要预拉取 {len(images)} 个 Docker 镜像:")
    for img in sorted(images):
        print(f"  - {img}")

    # 并发拉取
    ok, fail = asyncio.run(pull_all_images(images, args.concurrency))
    print(f"\n[结果] 成功: {ok}, 失败: {fail}")
    if fail > 0:
        sys.exit(1)


def cmd_clear(args):
    """clear 子命令入口。"""
    # 查找任务目录
    task_dirs = find_task_dirs()
    if not task_dirs:
        print("[信息] 未找到任何已缓存的任务")
        return

    # 提取并删除镜像
    images = extract_docker_images(task_dirs)

    # 同时也清理 harbor 构建的镜像（hb__ 前缀）
    result = subprocess.run(
        ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        for line in result.stdout.strip().split("\n"):
            if line.startswith("hb__"):
                images.add(line)

    if not images:
        print("[信息] 没有找到需要清理的镜像")
        return

    print(f"[清理] 将删除 {len(images)} 个 Docker 镜像:")
    for img in sorted(images):
        print(f"  - {img}")

    for img in sorted(images):
        result = subprocess.run(
            ["docker", "rmi", "-f", img],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            print(f"  [已删除] {img}")
        else:
            print(f"  [跳过] {img}: {result.stderr.strip()}")

    print("[清理] 完成")


def main():
    parser = argparse.ArgumentParser(
        description="TerminalBench 2.0 Docker 镜像管理工具"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    dl_parser = subparsers.add_parser("download", help="预拉取 Docker 镜像")
    dl_parser.add_argument(
        "--concurrency",
        "-j",
        type=int,
        default=4,
        help="并发下载数 (默认: 4)",
    )
    dl_parser.add_argument(
        "--mirror",
        action="store_true",
        help="尝试配置国内 Docker 加速镜像",
    )
    dl_parser.set_defaults(func=cmd_download)

    clear_parser = subparsers.add_parser("clear", help="删除所有已下载的镜像")
    clear_parser.set_defaults(func=cmd_clear)

    hosts_parser = subparsers.add_parser("hosts", help="预下载 GitHub hosts 文件")
    hosts_parser.set_defaults(func=cmd_hosts)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
