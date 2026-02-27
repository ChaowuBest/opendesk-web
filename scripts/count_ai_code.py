#!/usr/bin/env python3
"""
统计git仓库中由AI提交的代码行比例
AI提交的判断标准：最后一个commit中包含"Co-authored-by"字样
"""

import subprocess
import os
import re
import json
import hashlib
from collections import defaultdict
from pathlib import Path
from datetime import datetime, timedelta

# 缓存文件路径
COMMIT_CACHE_FILE = ".ai_code_commit_cache.json"

def get_commit_time(commit_hash):
    """获取commit的时间戳"""
    output = run_git_command([
        'show',
        '-s',
        '--format=%ct',
        commit_hash
    ])
    if not output:
        return None
    try:
        return int(output.strip())
    except ValueError:
        return None

def run_git_command(args):
    """执行git命令并返回输出"""
    try:
        result = subprocess.run(
            ['git'] + args,
            capture_output=True,
            text=False,  # 先不解码，避免编码问题
            check=True
        )
        # 尝试用utf-8解码，如果失败则尝试其他编码
        try:
            return result.stdout.decode('utf-8')
        except UnicodeDecodeError:
            # 尝试用gbk解码（Windows常见编码）
            try:
                return result.stdout.decode('gbk', errors='replace')
            except:
                # 最后尝试用latin-1解码（不会失败）
                return result.stdout.decode('latin-1')
    except subprocess.CalledProcessError as e:
        print(f"Git命令执行失败: {' '.join(args)}")
        try:
            stderr = e.stderr.decode('utf-8', errors='replace')
        except:
            stderr = str(e.stderr)
        print(f"错误: {stderr}")
        return None

def load_commit_cache():
    """加载commit缓存"""
    if os.path.exists(COMMIT_CACHE_FILE):
        try:
            with open(COMMIT_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_commit_cache(cache):
    """保存commit缓存"""
    try:
        with open(COMMIT_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
    except Exception as e:
        print(f"保存缓存失败: {e}")

def get_all_tracked_files():
    """获取所有git跟踪的文件"""
    output = run_git_command(['ls-files'])
    if not output:
        return []
    return [f.strip() for f in output.strip().split('\n') if f.strip()]

def get_file_blame_info(file_path):
    """一次性获取整个文件的blame信息，返回行号->commit_hash的映射"""
    output = run_git_command([
        'blame',
        '--porcelain',
        '--',
        file_path
    ])
    if not output:
        return {}

    line_commit_map = {}
    current_commit = None
    current_line = 0

    lines = output.split('\n')
    i = 0

    while i < len(lines):
        line = lines[i]
        if not line:
            i += 1
            continue

        # 检查是否是commit hash行（40个字符十六进制）
        if len(line) >= 40 and all(c in '0123456789abcdefABCDEF' for c in line[:40]):
            # 提取commit hash（可能后面有行号信息）
            current_commit = line[:40]
            i += 1
            continue

        # 检查是否是代码行（以\t开头）
        if line.startswith('\t'):
            current_line += 1
            if current_commit:
                line_commit_map[current_line] = current_commit
            i += 1
            continue

        # 其他信息行，直接跳过
        i += 1

    return line_commit_map

def check_commit_has_co_author(commit_hash):
    """检查commit是否包含Co-authored-by"""
    output = run_git_command([
        'show',
        '-s',
        '--format=%B',
        commit_hash
    ])
    if not output:
        return False

    return 'Co-authored-by' in output

def count_lines_in_file(file_path):
    """统计文件中的代码行数（排除空行）"""
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()
        # 排除空行和只包含空白字符的行
        code_lines = [i+1 for i, line in enumerate(lines) if line.strip()]
        return code_lines
    except Exception as e:
        print(f"读取文件失败 {file_path}: {e}")
        return []

def main():
    print("开始统计AI提交的代码行比例...")
    print("=" * 60)

    # 加载缓存
    commit_cache = load_commit_cache()
    cache_updated = False

    # commit时间戳缓存（内存中）
    commit_time_cache = {}

    # 获取所有跟踪的文件
    files = get_all_tracked_files()
    if not files:
        print("未找到任何git跟踪的文件")
        return

    print(f"找到 {len(files)} 个文件")

    # 计算1个月前的时间戳
    one_month_ago = datetime.now() - timedelta(days=30)
    one_month_ago_ts = int(one_month_ago.timestamp())

    total_lines = 0
    ai_lines = 0
    # 最近1个月的统计
    recent_total_lines = 0
    recent_ai_lines = 0
    file_stats = []
    missing_commit_count = 0

    for file_path in files:
        if not os.path.exists(file_path):
            continue

        # 获取文件中的所有非空行号
        line_numbers = count_lines_in_file(file_path)
        if not line_numbers:
            continue

        file_total = len(line_numbers)
        file_ai = 0
        file_missing = 0

        # 一次性获取整个文件的blame信息
        blame_info = get_file_blame_info(file_path)

        for line_num in line_numbers:
            total_lines += 1

            # 获取该行的最后一次commit
            commit_hash = blame_info.get(line_num)
            if not commit_hash:
                file_missing += 1
                continue

            # 检查commit是否包含Co-authored-by（使用缓存）
            if commit_hash not in commit_cache:
                commit_cache[commit_hash] = check_commit_has_co_author(commit_hash)
                cache_updated = True

            # 获取commit时间（使用内存缓存）
            if commit_hash not in commit_time_cache:
                commit_time_cache[commit_hash] = get_commit_time(commit_hash)
            commit_time = commit_time_cache[commit_hash]

            # 判断是否在最近1个月内
            is_recent = commit_time is not None and commit_time >= one_month_ago_ts
            if is_recent:
                recent_total_lines += 1

            if commit_cache[commit_hash]:
                ai_lines += 1
                file_ai += 1
                if is_recent:
                    recent_ai_lines += 1

        missing_commit_count += file_missing

        if file_total > 0:
            file_stats.append((file_path, file_total, file_ai))

        # 每处理10个文件输出一次进度并保存缓存
        if len(file_stats) % 10 == 0:
            print(f"进度: {len(file_stats)}/{len(files)} 文件, 已处理 {total_lines} 行")
            if cache_updated:
                save_commit_cache(commit_cache)
                cache_updated = False

    # 最后保存一次缓存
    if cache_updated:
        save_commit_cache(commit_cache)

    print("\n" + "=" * 60)
    print("统计结果（全部历史）")
    print("=" * 60)
    print(f"总代码行数: {total_lines}")
    print(f"AI提交的代码行数: {ai_lines}")

    if total_lines > 0:
        ai_percentage = (ai_lines / total_lines) * 100
        print(f"AI提交比例: {ai_percentage:.2f}%")
    else:
        print("AI提交比例: 0.00%")

    print("\n" + "=" * 60)
    print("统计结果（最近1个月）")
    print("=" * 60)
    print(f"最近1个月修改的代码行数: {recent_total_lines}")
    print(f"其中AI提交的代码行数: {recent_ai_lines}")

    if recent_total_lines > 0:
        recent_ai_percentage = (recent_ai_lines / recent_total_lines) * 100
        print(f"最近1个月AI提交比例: {recent_ai_percentage:.2f}%")
    else:
        print("最近1个月AI提交比例: 0.00%")

    print(f"\n缓存的commit数量: {len(commit_cache)}")

    print("\n" + "=" * 60)
    print("文件级别统计（前20个文件）")
    print("=" * 60)

    # 按AI代码行数排序，显示前20个
    file_stats.sort(key=lambda x: x[2], reverse=True)
    for file_path, total, ai_count in file_stats[:20]:
        percentage = (ai_count / total * 100) if total > 0 else 0
        print(f"{file_path}: {ai_count}/{total} 行 ({percentage:.1f}%)")

if __name__ == '__main__':
    main()
