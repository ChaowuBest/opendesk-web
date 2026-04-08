#!/usr/bin/env python3
"""
prefetch.py - 预下载 TerminalBench 2.0 运行所需的 Docker 镜像。

子命令:
  download  预拉取所有任务的 Docker 基础镜像（支持 --concurrency 指定并发数）
  clear     删除所有已拉取的 TerminalBench 相关镜像
  hosts     预下载 GitHub hosts 文件（解决国内 GitHub 网络问题）
  tools     预下载 uv 二进制到 mount 目录（加速容器内安装）
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


SCRIPT_DIR = Path(__file__).resolve().parent
MOUNT_STAGING_DIR = SCRIPT_DIR / ".mount-staging"

# uv 下载地址模板（国内镜像优先，经测试无代理可用）
UV_DOWNLOAD_URLS = [
    "https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-{arch}.tar.gz",
    "https://ghfast.top/https://github.com/astral-sh/uv/releases/latest/download/uv-{arch}.tar.gz",
    "https://github.com/astral-sh/uv/releases/latest/download/uv-{arch}.tar.gz",
]

UV_LINUX_ARCHS = [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
]


def _download_url(url: str, timeout: int = 120) -> bytes | None:
    """使用 urllib 下载 URL，返回字节内容或 None。"""
    import urllib.request
    import urllib.error
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "uv-prefetch/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            if len(data) > 1000:
                return data
            print(f"    响应过小: {len(data)} bytes")
    except urllib.error.HTTPError as e:
        print(f"    HTTP 错误: {e.code} {e.reason}")
    except urllib.error.URLError as e:
        print(f"    连接错误: {e.reason}")
    except OSError as e:
        print(f"    网络错误: {e}")
    return None


def _extract_tar_gz(data: bytes, dest_dir: Path) -> bool:
    """从内存中的 tar.gz 数据解压到目标目录。"""
    import io
    import tarfile
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            tar.extractall(path=dest_dir, filter="data")
        return True
    except (tarfile.TarError, OSError) as e:
        print(f"    解压错误: {e}")
        return False


def prefetch_uv_binaries():
    """预下载 uv 二进制到 mount staging 目录。

    在宿主机上为每种 Linux 架构下载 uv，解压后放到
    .mount-staging/uv-{arch}/ 目录中，容器启动时直接复制即可。
    """
    MOUNT_STAGING_DIR.mkdir(parents=True, exist_ok=True)
    downloaded = 0

    for arch in UV_LINUX_ARCHS:
        dest_dir = MOUNT_STAGING_DIR / f"uv-{arch}"
        uv_bin = dest_dir / "uv"
        if uv_bin.exists():
            print(f"  [跳过] uv-{arch} 已存在")
            downloaded += 1
            continue

        dest_dir.mkdir(parents=True, exist_ok=True)
        success = False
        for url_template in UV_DOWNLOAD_URLS:
            url = url_template.format(arch=arch)
            print(f"  [下载] uv-{arch} from {url} ...")
            data = _download_url(url)
            if data is None:
                print(f"  [重试] {arch} 从该源下载失败")
                continue

            print(f"    下载完成: {len(data) / 1024 / 1024:.1f} MB，正在解压...")
            if not _extract_tar_gz(data, dest_dir):
                print(f"  [重试] {arch} 解压失败")
                continue

            # tar 可能会创建子目录 uv-xxx/，把文件提到顶层
            if not uv_bin.exists():
                for candidate in dest_dir.rglob("uv"):
                    if candidate.is_file() and candidate.name == "uv":
                        import shutil
                        shutil.move(str(candidate), str(uv_bin))
                        uvx_candidate = candidate.parent / "uvx"
                        if uvx_candidate.exists():
                            shutil.move(str(uvx_candidate), str(dest_dir / "uvx"))
                        # 清理空的子目录
                        for d in sorted(dest_dir.iterdir(), reverse=True):
                            if d.is_dir():
                                try:
                                    d.rmdir()
                                except OSError:
                                    pass
                        break

            if uv_bin.exists():
                print(f"  [完成] uv-{arch}")
                success = True
                downloaded += 1
                break
            else:
                print(f"  [重试] {arch} 解压后未找到 uv 二进制")

        if not success:
            print(f"  [失败] uv-{arch} 所有源均失败")

    return downloaded


def cmd_tools(args):
    """tools 子命令入口：预下载容器内工具（uv 二进制）。"""
    print("[工具预下载] 开始预下载容器内工具...")
    downloaded = prefetch_uv_binaries()
    print(f"[工具预下载] 完成: {downloaded}/{len(UV_LINUX_ARCHS)} 个架构")
    if downloaded == 0:
        print("[工具预下载] 警告: 未能下载任何 uv 二进制，容器内将从网络下载")


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

    # 预下载容器内工具（uv 二进制）
    prefetch_uv_binaries()

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

    tools_parser = subparsers.add_parser("tools", help="预下载容器内工具（uv 二进制）")
    tools_parser.set_defaults(func=cmd_tools)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
