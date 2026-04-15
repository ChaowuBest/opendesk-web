#!/usr/bin/env python3
"""
run.py - 在 SWE-bench 上评估 OpenDesk 编码 Agent 能力。

工作流:
  1. 从 HuggingFace 加载 SWE-bench 数据集
  2. 为每个 instance checkout 目标仓库到 base_commit
  3. 启动 OpenDesk headless 模式，将 problem_statement 作为指令
  4. 收集 agent 产生的代码变更 (git diff)
  5. 生成 predictions.json
  6. (可选) 调用 swebench harness 做自动化评估

选项:
  --model ALIAS         指定测试的模型名字（与 ~/.opendesk/setting.json 一致）
  --dataset NAME        SWE-bench 数据集 (默认: princeton-nlp/SWE-bench_Lite)
  --split NAME          数据集 split (默认: test)
  --instance ID         只运行指定 instance_id 的单个任务
  -j/--jobs N           最大并发数 (默认: 1)
  -o/--output DIR       输出目录 (默认: ./jobs/<model>-<timestamp>)
  --timeout SEC         单个任务超时秒数 (默认: 1800)
  --evaluate            运行完后自动调用 swebench harness 评估
  --max-workers N       评估时 swebench harness 的最大 worker 数 (默认: 4)
  --skip-existing       跳过已有 patch 的 instance
  --analyze JOB_PATH    分析已有运行结果
"""

import argparse
import json
import os
import platform
import shlex
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

# SWE-bench 数据集默认值
DEFAULT_DATASET = "princeton-nlp/SWE-bench_Lite"
DEFAULT_SPLIT = "test"

# stub node_modules 目录（为编译时 --external 的包提供运行时 mock）
STUB_NODE_MODULES = SCRIPT_DIR / ".node_modules_stub"


# ──────────────────────────── 配置读取 ────────────────────────────


def get_setting_path() -> Path:
    """获取 OpenDesk setting.json 路径。"""
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", "")) / "opendesk" / "setting.json"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "opendesk" / "setting.json"
    else:
        return Path.home() / ".opendesk" / "setting.json"


def get_setting() -> dict:
    """读取完整配置。"""
    setting_path = get_setting_path()
    if not setting_path.exists():
        raise FileNotFoundError(
            f"OpenDesk 配置文件不存在: {setting_path}\n"
            "请先配置 OpenDesk（运行一次 opendesk CLI 即可生成）"
        )
    with open(setting_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_setting_models() -> list[str]:
    """读取可用模型别名列表。"""
    data = get_setting()
    return [m.get("alias", "?") for m in data.get("models", [])]


def validate_model(model_alias: str) -> bool:
    """验证模型别名是否存在于配置中。"""
    return model_alias in get_setting_models()


# ──────────────────────────── OpenDesk 二进制定位 ────────────────────────────


def find_opendesk_binary() -> Path | None:
    """查找本地 OpenDesk CLI 二进制。"""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "windows":
        candidates = [
            PROJECT_ROOT / "dist" / "cli" / "opendesk-win-x64.exe",
            PROJECT_ROOT / "dist" / "cli" / "opendesk.exe",
        ]
    elif system == "darwin":
        arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
        candidates = [
            PROJECT_ROOT / "dist" / "cli" / f"opendesk-darwin-{arch}",
            PROJECT_ROOT / "dist" / "cli" / "opendesk",
        ]
    else:
        arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
        candidates = [
            PROJECT_ROOT / "dist" / "cli" / f"opendesk-linux-{arch}",
            PROJECT_ROOT / "dist" / "cli" / "opendesk",
        ]

    for c in candidates:
        if c.exists():
            return c

    # 尝试 PATH 中的 opendesk
    opendesk_cmd = "opendesk.exe" if system == "windows" else "opendesk"
    result = shutil.which(opendesk_cmd)
    if result:
        return Path(result)

    return None


def find_or_build_opendesk() -> Path:
    """查找或提示构建 OpenDesk 二进制。"""
    binary = find_opendesk_binary()
    if binary:
        print(f"[准备] OpenDesk 二进制: {binary}")
        return binary

    print("[错误] 未找到 OpenDesk CLI 二进制")
    print("[提示] 请先构建（以当前平台为例）:")
    system = platform.system().lower()
    if system == "windows":
        print("  bun build --compile --minify-whitespace --sourcemap "
              "--target=bun-windows-x64 src/main/cli.ts "
              "--outfile dist/cli/opendesk-win-x64.exe "
              "--external node-screenshots --external esbuild --external vectra")
    elif system == "darwin":
        arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
        print(f"  bun build --compile --minify-whitespace --sourcemap "
              f"--target=bun-darwin-{arch} src/main/cli.ts "
              f"--outfile dist/cli/opendesk-darwin-{arch} "
              f"--external node-screenshots --external esbuild --external vectra")
    else:
        print("  bun build --compile --minify-whitespace --sourcemap "
              "--target=bun-linux-x64 src/main/cli.ts "
              "--outfile dist/cli/opendesk-linux-x64 "
              "--external node-screenshots --external esbuild --external vectra")
    print("\n  或者直接使用 bun 运行:")
    print("  bun run src/main/cli.ts --headless -c <指令>")
    sys.exit(1)


def prepare_node_modules() -> Path:
    """创建 stub node_modules（vectra、number-to-alphabet 的 mock），
    供 bun --external 编译产物在运行时通过 NODE_PATH 引用。"""
    nm = STUB_NODE_MODULES
    nm.mkdir(parents=True, exist_ok=True)

    # vectra stub
    vectra_dir = nm / "vectra"
    vectra_dir.mkdir(exist_ok=True)
    vectra_index = vectra_dir / "index.js"
    if not vectra_index.exists():
        vectra_index.write_text(
            "// Stub: vectra is not needed in headless swe-bench mode\n"
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

    # number-to-alphabet stub
    n2a_dir = nm / "number-to-alphabet"
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

    return nm


# ──────────────────────────── 数据集加载 ────────────────────────────


def load_dataset(dataset_name: str, split: str, instance_id: str | None = None) -> list[dict]:
    """加载 SWE-bench 数据集。"""
    try:
        from datasets import load_dataset as hf_load
    except ImportError:
        print("[错误] 请先安装 datasets: pip install datasets")
        sys.exit(1)

    print(f"[数据集] 加载 {dataset_name} (split={split})...")
    ds = hf_load(dataset_name, split=split)
    instances = [dict(row) for row in ds]

    if instance_id:
        instances = [inst for inst in instances if inst["instance_id"] == instance_id]
        if not instances:
            print(f"[错误] instance_id '{instance_id}' 未在数据集中找到")
            sys.exit(1)

    print(f"[数据集] 共 {len(instances)} 个实例")
    return instances


# ──────────────────────────── 单任务执行 ────────────────────────────


def _force_rmtree(path: Path):
    """强制删除目录（Windows 上处理只读 .git 文件）。"""
    def _on_error(_func, _path, _exc_info):
        try:
            os.chmod(_path, 0o777)
            os.remove(_path)
        except Exception:
            pass
    if path.exists():
        shutil.rmtree(path, onerror=_on_error)


def _is_repo_at_commit(repo_dir: Path, commit: str) -> bool:
    """检查 repo_dir 是否是有效的 git 仓库且已位于指定 commit。"""
    git_dir = repo_dir / ".git"
    if not git_dir.exists():
        return False
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_dir), capture_output=True, text=True, encoding="utf-8", timeout=10,
        )
        return result.returncode == 0 and result.stdout.strip().startswith(commit[:12])
    except Exception:
        return False


def prepare_repo(instance: dict, work_dir: Path) -> Path:
    """为单个 instance 准备仓库环境（clone + checkout）。
    如果 repo 已在本地且 commit 正确，会重置到干净状态复用，避免重复 clone。"""
    repo = instance["repo"]
    base_commit = instance["base_commit"]
    instance_id = instance["instance_id"]
    repo_dir = work_dir / "repo"

    # 如果仓库已存在且 commit 正确，直接复用（重置到干净状态）
    if _is_repo_at_commit(repo_dir, base_commit):
        print(f"  [{instance_id}] 复用已有仓库，重置到 {base_commit[:12]}...")
        subprocess.run(
            ["git", "checkout", "--", "."],
            cwd=str(repo_dir), capture_output=True, text=True, encoding="utf-8",
        )
        subprocess.run(
            ["git", "clean", "-fd"],
            cwd=str(repo_dir), capture_output=True, text=True, encoding="utf-8",
        )
        return repo_dir

    # 清理残留目录
    _force_rmtree(repo_dir)

    repo_url = f"https://github.com/{repo}.git"
    print(f"  [{instance_id}] Clone {repo}...")

    try:
        subprocess.run(
            ["git", "clone", "--depth", "50", repo_url, str(repo_dir)],
            check=True, capture_output=True, text=True, encoding="utf-8", timeout=300,
        )
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
        _force_rmtree(repo_dir)
        subprocess.run(
            ["git", "clone", repo_url, str(repo_dir)],
            check=True, capture_output=True, text=True, encoding="utf-8", timeout=600,
        )

    # checkout base_commit（可能需要 fetch 更深的历史）
    try:
        subprocess.run(
            ["git", "checkout", base_commit],
            cwd=str(repo_dir), check=True, capture_output=True, text=True, encoding="utf-8",
        )
    except subprocess.CalledProcessError:
        print(f"  [{instance_id}] Commit 不在 shallow clone 中，正在获取完整历史...")
        subprocess.run(
            ["git", "fetch", "--unshallow"],
            cwd=str(repo_dir), check=True, capture_output=True, text=True, encoding="utf-8", timeout=600,
        )
        subprocess.run(
            ["git", "checkout", base_commit],
            cwd=str(repo_dir), check=True, capture_output=True, text=True, encoding="utf-8",
        )

    print(f"  [{instance_id}] Checked out {base_commit[:12]}")
    return repo_dir


def build_prompt(instance: dict) -> str:
    """构建给 OpenDesk agent 的提示词。"""
    problem = instance["problem_statement"]
    repo = instance["repo"]
    instance_id = instance["instance_id"]

    return (
        f"You are working on the GitHub repository '{repo}'.\n"
        f"The current working directory contains the repository code checked out at a specific commit.\n\n"
        f"Please fix the following issue:\n\n"
        f"--- Issue ({instance_id}) ---\n"
        f"{problem}\n"
        f"--- End of Issue ---\n\n"
        f"Instructions:\n"
        f"1. Analyze the issue carefully.\n"
        f"2. Find the relevant source files and understand the root cause.\n"
        f"3. Make the minimal code changes needed to fix the issue.\n"
        f"4. Do NOT modify any test files.\n"
        f"5. Do NOT add new dependencies.\n"
        f"6. After making changes, verify your fix is correct.\n"
    )


def run_opendesk_agent(
    opendesk_bin: Path,
    repo_dir: Path,
    prompt: str,
    model_alias: str | None,
    timeout: int,
    log_dir: Path,
) -> tuple[int, str]:
    """运行 OpenDesk headless 模式处理单个 instance。返回 (exit_code, stderr)。"""
    log_dir.mkdir(parents=True, exist_ok=True)
    result_json = log_dir / "opendesk-result.json"
    profile_json = log_dir / "profile.json"
    stdout_log = log_dir / "opendesk-stdout.txt"

    cmd = [str(opendesk_bin)]
    if model_alias:
        cmd.extend(["--model", model_alias])
    cmd.extend([
        "--headless",
        "--export-json", str(result_json),
        "--profile", str(profile_json),
        "-c", prompt,
    ])

    env = os.environ.copy()
    env["TERM"] = "dumb"
    env["NO_COLOR"] = "1"
    env["NODE_PATH"] = str(STUB_NODE_MODULES)

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(repo_dir),
            timeout=timeout,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        stdout_log.write_text(proc.stdout, encoding="utf-8")
        if proc.stderr:
            (log_dir / "opendesk-stderr.txt").write_text(proc.stderr, encoding="utf-8")
        return proc.returncode, proc.stderr
    except subprocess.TimeoutExpired:
        stdout_log.write_text("TIMEOUT", encoding="utf-8")
        return -1, "TIMEOUT"
    except Exception as e:
        return -2, str(e)


def collect_patch(repo_dir: Path) -> str:
    """收集 agent 产生的代码变更（unified diff）。"""
    try:
        # 包含 untracked 新文件
        subprocess.run(
            ["git", "add", "-N", "."],
            cwd=str(repo_dir), capture_output=True, text=True, encoding="utf-8",
        )
        result = subprocess.run(
            ["git", "diff", "HEAD"],
            cwd=str(repo_dir), capture_output=True, text=True, encoding="utf-8",
        )
        return result.stdout.strip()
    except Exception:
        return ""


def run_single_instance(
    instance: dict,
    opendesk_bin: Path,
    model_alias: str | None,
    output_dir: Path,
    timeout: int,
) -> dict:
    """运行单个 SWE-bench instance，返回结果。"""
    instance_id = instance["instance_id"]
    work_dir = output_dir / "workspaces" / instance_id
    log_dir = output_dir / "logs" / instance_id
    work_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "instance_id": instance_id,
        "model_patch": "",
        "status": "pending",
        "exit_code": None,
        "elapsed_sec": 0,
        "error": None,
    }

    start = time.time()
    try:
        # 1. 准备仓库
        repo_dir = prepare_repo(instance, work_dir)

        # 2. 构建提示词
        prompt = build_prompt(instance)
        (log_dir).mkdir(parents=True, exist_ok=True)
        (log_dir / "prompt.txt").write_text(prompt, encoding="utf-8")

        # 3. 运行 agent
        print(f"  [{instance_id}] 运行 OpenDesk agent...")
        exit_code, stderr = run_opendesk_agent(
            opendesk_bin, repo_dir, prompt, model_alias, timeout, log_dir,
        )
        result["exit_code"] = exit_code

        if exit_code == -1:
            result["status"] = "timeout"
            result["error"] = f"超时 ({timeout}s)"
            print(f"  [{instance_id}] ⏱ 超时")
        elif exit_code != 0:
            result["status"] = "error"
            result["error"] = f"exit_code={exit_code}"
            print(f"  [{instance_id}] ✖ 退出码 {exit_code}")
        else:
            result["status"] = "completed"

        # 4. 收集 patch
        patch = collect_patch(repo_dir)
        result["model_patch"] = patch
        if patch:
            (log_dir / "model_patch.diff").write_text(patch, encoding="utf-8")
            patch_lines = len(patch.splitlines())
            print(f"  [{instance_id}] 生成 patch: {patch_lines} 行")
        else:
            print(f"  [{instance_id}] 未生成 patch")
            if result["status"] == "completed":
                result["status"] = "no_patch"

    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)
        print(f"  [{instance_id}] ✖ 异常: {e}")

    result["elapsed_sec"] = round(time.time() - start, 1)
    return result


# ──────────────────────────── 结果生成 & 评估 ────────────────────────────


def write_predictions(results: list[dict], output_dir: Path, model_name: str) -> Path:
    """生成 swebench 格式的 predictions.json。"""
    predictions = []
    for r in results:
        predictions.append({
            "instance_id": r["instance_id"],
            "model_patch": r["model_patch"],
            "model_name_or_path": model_name,
        })

    pred_path = output_dir / "predictions.json"
    with open(pred_path, "w", encoding="utf-8") as f:
        json.dump(predictions, f, indent=2, ensure_ascii=False)
    print(f"\n[输出] predictions.json: {pred_path}")
    return pred_path


def write_summary(results: list[dict], output_dir: Path, args, elapsed: float):
    """写入运行摘要。"""
    completed = sum(1 for r in results if r["status"] == "completed")
    with_patch = sum(1 for r in results if r["model_patch"])
    timeout_count = sum(1 for r in results if r["status"] == "timeout")
    error_count = sum(1 for r in results if r["status"] == "error")
    no_patch = sum(1 for r in results if r["status"] == "no_patch")

    summary = {
        "timestamp": datetime.now().isoformat(),
        "model": args.model or "default",
        "dataset": args.dataset,
        "split": args.split,
        "total": len(results),
        "completed": completed,
        "with_patch": with_patch,
        "no_patch": no_patch,
        "timeout": timeout_count,
        "error": error_count,
        "elapsed_sec": round(elapsed, 1),
        "platform": {
            "system": platform.system(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
    }

    summary_path = output_dir / "summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    print()
    print("=" * 60)
    print(f"SWE-bench 运行总结")
    print("=" * 60)
    print(f"  数据集: {args.dataset} ({args.split})")
    print(f"  模型: {args.model or 'default'}")
    print(f"  总实例数: {len(results)}")
    print(f"  完成: {completed}")
    print(f"  生成 patch: {with_patch}")
    print(f"  无 patch: {no_patch}")
    print(f"  超时: {timeout_count}")
    print(f"  错误: {error_count}")
    m, s = divmod(int(elapsed), 60)
    h, m = divmod(m, 60)
    elapsed_str = f"{h}h{m:02d}m{s:02d}s" if h else f"{m:02d}m{s:02d}s"
    print(f"  耗时: {elapsed_str}")
    if len(results) > 0:
        print(f"  Patch 生成率: {with_patch / len(results) * 100:.1f}%")
    print("=" * 60)

    return summary


def _win_to_wsl_path(win_path: str) -> str:
    """将 Windows 路径转换为 WSL 路径，如 D:\\foo\\bar -> /mnt/d/foo/bar"""
    from pathlib import PurePosixPath
    p = Path(win_path).resolve()
    drive = p.drive.rstrip(":").lower()
    rest = PurePosixPath(*p.parts[1:]) if len(p.parts) > 1 else PurePosixPath()
    return f"/mnt/{drive}/{rest}"


def run_evaluation(pred_path: Path, dataset_name: str, split: str, max_workers: int, run_id: str):
    """调用 swebench harness 进行评估。
    Windows 上自动通过 WSL 执行（swebench 依赖 Linux 的 resource 模块）。"""
    print(f"\n[评估] 使用 swebench harness 评估...")

    if sys.platform == "win32":
        try:
            wsl_check = subprocess.run(
                ["wsl", "python3", "-c", "import swebench; print('ok')"],
                capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=30,
            )
            wsl_ok = wsl_check.returncode == 0 and "ok" in wsl_check.stdout
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            wsl_ok = False

        if not wsl_ok:
            print("[错误] Windows 上 swebench harness 需要 WSL 环境")
            print("[提示] 1. 安装 WSL: wsl --install")
            print("[提示] 2. 在 WSL 中安装: pip install swebench")
            print("[提示] 3. 确保 WSL 中 Docker 可用")
            return

        wsl_pred = _win_to_wsl_path(str(pred_path))
        cmd = [
            "wsl", "python3", "-m", "swebench.harness.run_evaluation",
            "--dataset_name", dataset_name,
            "--predictions_path", wsl_pred,
            "--max_workers", str(max_workers),
            "--run_id", run_id,
            "--split", split,
        ]
        print(f"[评估] 检测到 Windows，通过 WSL 执行")
        print(f"[评估] 命令: {' '.join(cmd)}")
    else:
        cmd = [
            sys.executable, "-m", "swebench.harness.run_evaluation",
            "--dataset_name", dataset_name,
            "--predictions_path", str(pred_path),
            "--max_workers", str(max_workers),
            "--run_id", run_id,
            "--split", split,
        ]
        print(f"[评估] 命令: {' '.join(cmd)}")

    try:
        subprocess.run(cmd, check=True)
        print("[评估] 完成")
    except subprocess.CalledProcessError as e:
        print(f"[评估] 失败: {e}")
    except FileNotFoundError:
        print("[评估] swebench 未安装，请运行: pip install swebench")


# ──────────────────────────── 结果分析 ────────────────────────────


def analyze_job(job_dir: str):
    """分析已有运行结果。"""
    job_path = Path(job_dir)
    summary_file = job_path / "summary.json"
    pred_file = job_path / "predictions.json"
    results_file = job_path / "results.json"

    if summary_file.exists():
        with open(summary_file, "r", encoding="utf-8") as f:
            summary = json.load(f)
        print(f"\n{'=' * 60}")
        print(f"运行摘要: {job_dir}")
        print(f"{'=' * 60}")
        for k, v in summary.items():
            if k != "platform":
                print(f"  {k}: {v}")
        if "platform" in summary:
            p = summary["platform"]
            print(f"  平台: {p.get('system')} {p.get('machine')} Python {p.get('python')}")

    if results_file.exists():
        with open(results_file, "r", encoding="utf-8") as f:
            results = json.load(f)

        statuses = {}
        for r in results:
            s = r.get("status", "unknown")
            statuses[s] = statuses.get(s, 0) + 1

        print(f"\n状态分布:")
        for s, count in sorted(statuses.items()):
            print(f"  {s}: {count}")

        # 耗时 TOP 10
        sorted_by_time = sorted(results, key=lambda r: r.get("elapsed_sec", 0), reverse=True)
        print(f"\n耗时 TOP 10:")
        for r in sorted_by_time[:10]:
            print(f"  {r['instance_id']}: {r['elapsed_sec']:.0f}s [{r['status']}]")

        # 无 patch 的 completed
        no_patch = [r for r in results if r["status"] == "no_patch"]
        if no_patch:
            print(f"\n完成但无 patch ({len(no_patch)}):")
            for r in no_patch[:20]:
                print(f"  {r['instance_id']}")

    if pred_file.exists():
        with open(pred_file, "r", encoding="utf-8") as f:
            preds = json.load(f)
        with_patch = sum(1 for p in preds if p.get("model_patch"))
        print(f"\npredictions.json: {len(preds)} 条, 有 patch: {with_patch}")

    print()


# ──────────────────────────── 主入口 ────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="在 SWE-bench 上评估 OpenDesk 编码 Agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--model", type=str, default=None,
                        help="模型别名，需与 setting.json 中一致")
    parser.add_argument("--dataset", type=str, default=DEFAULT_DATASET,
                        help=f"SWE-bench 数据集名称 (默认: {DEFAULT_DATASET})")
    parser.add_argument("--split", type=str, default=DEFAULT_SPLIT,
                        help=f"数据集 split (默认: {DEFAULT_SPLIT})")
    parser.add_argument("--instance", type=str, default=None,
                        help="只运行指定 instance_id")
    parser.add_argument("-j", "--jobs", type=int, default=1,
                        help="最大并发数 (默认: 1)")
    parser.add_argument("-o", "--output", type=str, default=None,
                        help="输出目录")
    parser.add_argument("--timeout", type=int, default=1800,
                        help="单个任务超时秒数 (默认: 1800)")
    parser.add_argument("--evaluate", action="store_true",
                        help="运行完后自动调用 swebench harness 评估")
    parser.add_argument("--max-workers", type=int, default=4,
                        help="swebench harness 评估 worker 数 (默认: 4)")
    parser.add_argument("--skip-existing", action="store_true",
                        help="跳过已有 patch 结果的 instance")
    parser.add_argument("--analyze", type=str, default=None,
                        help="分析已有运行结果目录")

    args = parser.parse_args()

    # 分析模式
    if args.analyze:
        analyze_job(args.analyze)
        return

    # 验证模型
    if args.model and not validate_model(args.model):
        available = get_setting_models()
        print(f"[错误] 模型 '{args.model}' 未在 setting.json 中找到")
        print(f"[提示] 可用模型: {', '.join(available)}")
        sys.exit(1)

    # 查找 OpenDesk 二进制
    opendesk_bin = find_or_build_opendesk()

    # 准备 stub node_modules（vectra 等外部依赖的 mock）
    prepare_node_modules()
    print(f"[准备] NODE_PATH: {STUB_NODE_MODULES}")

    # 准备输出目录
    model_name = args.model or "default"
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    if args.output:
        output_dir = Path(args.output)
    else:
        output_dir = SCRIPT_DIR / "jobs" / f"{model_name}-{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"[输出] 目录: {output_dir}")

    # 加载数据集
    instances = load_dataset(args.dataset, args.split, args.instance)

    # 跳过已有结果：加载已有 results，保留成功的，重跑失败/超时/出错的
    existing_results_map: dict[str, dict] = {}
    if args.skip_existing:
        existing_results_file = output_dir / "results.json"
        if existing_results_file.exists():
            with open(existing_results_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
            for r in existing:
                if r.get("model_patch"):
                    existing_results_map[r["instance_id"]] = r
            before = len(instances)
            instances = [i for i in instances if i["instance_id"] not in existing_results_map]
            print(f"[跳过] 已有 patch 的 {before - len(instances)} 个，剩余 {len(instances)} 个")

    if not instances:
        print("[完成] 没有需要运行的实例")
        return

    # 执行（以已有成功结果为基础，追加新结果）
    all_results = list(existing_results_map.values())
    start_time = time.time()

    if args.jobs <= 1:
        # 串行执行
        for i, instance in enumerate(instances, 1):
            print(f"\n[{i}/{len(instances)}] {instance['instance_id']}")
            result = run_single_instance(
                instance, opendesk_bin, args.model, output_dir, args.timeout,
            )
            all_results.append(result)
            # 增量保存
            _save_results(all_results, output_dir)
    else:
        # 并发执行
        with ThreadPoolExecutor(max_workers=args.jobs) as executor:
            futures = {}
            for i, instance in enumerate(instances, 1):
                future = executor.submit(
                    run_single_instance,
                    instance, opendesk_bin, args.model, output_dir, args.timeout,
                )
                futures[future] = (i, instance["instance_id"])

            for future in as_completed(futures):
                idx, iid = futures[future]
                try:
                    result = future.result()
                    all_results.append(result)
                    print(f"  [{idx}/{len(instances)}] {iid} → {result['status']}")
                except Exception as e:
                    print(f"  [{idx}/{len(instances)}] {iid} → 异常: {e}")
                    all_results.append({
                        "instance_id": iid,
                        "model_patch": "",
                        "status": "error",
                        "exit_code": None,
                        "elapsed_sec": 0,
                        "error": str(e),
                    })
                # 增量保存
                _save_results(all_results, output_dir)

    elapsed = time.time() - start_time

    # 最终保存
    _save_results(all_results, output_dir)
    pred_path = write_predictions(all_results, output_dir, model_name)
    write_summary(all_results, output_dir, args, elapsed)

    # 评估
    if args.evaluate:
        run_id = f"opendesk-{model_name}-{timestamp}"
        run_evaluation(pred_path, args.dataset, args.split, args.max_workers, run_id)


def _save_results(results: list[dict], output_dir: Path):
    """增量保存 results.json。"""
    results_path = output_dir / "results.json"
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
