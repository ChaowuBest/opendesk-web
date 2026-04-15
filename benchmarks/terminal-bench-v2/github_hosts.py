#!/usr/bin/env python3
"""
github_hosts.py - 从 github-hosts 项目获取 GitHub 相关的 hosts 映射。

在线获取地址（按优先级）:
  1. https://raw.githubusercontent.com/maxiaof/github-hosts/master/hosts
  2. https://cdn.jsdelivr.net/gh/maxiaof/github-hosts@master/hosts

若在线获取失败，则回退到本地 benchmarks/terminal-bench-v2/hosts.txt 文件。
"""

import re
import urllib.request
import urllib.error
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
LOCAL_HOSTS_FILE = SCRIPT_DIR / "hosts.txt"

# 在线源，按优先级排列
HOSTS_URLS = [
    "https://raw.githubusercontent.com/maxiaof/github-hosts/master/hosts",
    "https://cdn.jsdelivr.net/gh/maxiaof/github-hosts@master/hosts",
]

# 匹配 "IP  hostname" 格式的行
_HOST_LINE_RE = re.compile(r"^\s*(\d+\.\d+\.\d+\.\d+)\s+(\S+)", re.MULTILINE)


def _fetch_from_url(url: str, timeout: int = 15) -> str | None:
    """尝试从 URL 获取 hosts 文件内容。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "github-hosts-fetcher/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            content = resp.read().decode("utf-8", errors="replace")
            if _HOST_LINE_RE.search(content):
                return content
    except (urllib.error.URLError, OSError, ValueError):
        pass
    return None


def fetch_github_hosts(verbose: bool = True) -> str | None:
    """
    获取 GitHub hosts 内容。

    优先在线获取最新的 hosts，成功后自动保存到 hosts.txt 方便下次离线使用。
    若所有在线源都不可用，回退到本地 hosts.txt。

    返回 hosts 文件的原始文本内容，或 None（如果完全无法获取）。
    """
    for url in HOSTS_URLS:
        if verbose:
            print(f"[GitHub Hosts] 尝试从 {url} 获取 ...")
        content = _fetch_from_url(url)
        if content:
            if verbose:
                print("[GitHub Hosts] 在线获取成功")
            try:
                LOCAL_HOSTS_FILE.write_text(content, encoding="utf-8")
                if verbose:
                    print(f"[GitHub Hosts] 已保存到 {LOCAL_HOSTS_FILE}")
            except OSError as e:
                if verbose:
                    print(f"[GitHub Hosts] 保存到本地失败: {e}")
            return content

    if verbose:
        print("[GitHub Hosts] 在线获取失败，尝试使用本地 hosts.txt ...")

    if LOCAL_HOSTS_FILE.exists():
        try:
            content = LOCAL_HOSTS_FILE.read_text(encoding="utf-8")
            if _HOST_LINE_RE.search(content):
                if verbose:
                    print(f"[GitHub Hosts] 使用本地文件: {LOCAL_HOSTS_FILE}")
                return content
        except OSError:
            pass

    if verbose:
        print(
            f"[GitHub Hosts] 无法获取 hosts 内容。\n"
            f"  请手动从 https://github.com/maxiaof/github-hosts 复制 hosts 内容，\n"
            f"  保存到 {LOCAL_HOSTS_FILE}"
        )
    return None


def parse_host_lines(raw: str) -> list[str]:
    """
    从 hosts 原始文本中提取有效的 'IP hostname' 行（去除注释和空行）。
    返回的每一行格式为 'IP hostname'。
    """
    lines = []
    for line in raw.splitlines():
        m = _HOST_LINE_RE.match(line)
        if m:
            lines.append(f"{m.group(1)} {m.group(2)}")
    return lines
