#!/usr/bin/env python3
"""
Headless OpenDesk node host.

Starts a non-interactive node that connects to the OpenDesk gateway and exposes
local shell and filesystem capabilities through node.invoke.

Usage:
    python3 docs/examples/node/node_headless.py --host 127.0.0.1 --port 18789
    python3 docs/examples/node/node_headless.py --url ws://127.0.0.1:18789 --cwd /path/to/workspace

Optional dependency:
    pip install websockets
    The script falls back to a small stdlib WebSocket client for ws:// URLs.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import glob
import hashlib
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


PROTOCOL_VERSION = 4
DEFAULT_PORT = 18789
DEFAULT_HOST = "127.0.0.1"


def make_id() -> str:
    return str(uuid.uuid4())


class StdlibWebSocketClient:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.reader = reader
        self.writer = writer

    @classmethod
    async def connect(cls, url: str) -> "StdlibWebSocketClient":
        parsed = urlparse(url)
        if parsed.scheme != "ws":
            raise RuntimeError("stdlib WebSocket fallback only supports ws:// URLs")
        host = parsed.hostname or DEFAULT_HOST
        port = parsed.port or DEFAULT_PORT
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        reader, writer = await asyncio.open_connection(host, port)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Connection: Upgrade\r\n"
            "Upgrade: websocket\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "\r\n"
        )
        writer.write(request.encode("ascii"))
        await writer.drain()

        response = await reader.readuntil(b"\r\n\r\n")
        header_text = response.decode("iso-8859-1")
        first_line = header_text.splitlines()[0] if header_text else ""
        if " 101 " not in first_line:
            raise RuntimeError(f"WebSocket upgrade failed: {first_line}")

        headers: dict[str, str] = {}
        for line in header_text.splitlines()[1:]:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
        expected_accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected_accept:
            raise RuntimeError("WebSocket upgrade failed: invalid Sec-WebSocket-Accept")
        return cls(reader, writer)

    async def send(self, message: str) -> None:
        await self._send_frame(message.encode("utf-8"), opcode=0x1)

    async def recv(self) -> str:
        while True:
            payload, opcode = await self._recv_frame()
            if opcode == 0x1:
                return payload.decode("utf-8")
            if opcode == 0x8:
                raise EOFError("WebSocket closed")
            if opcode == 0x9:
                await self._send_frame(payload, opcode=0xA)

    def __aiter__(self) -> "StdlibWebSocketClient":
        return self

    async def __anext__(self) -> str:
        try:
            return await self.recv()
        except EOFError as exc:
            raise StopAsyncIteration from exc

    async def _send_frame(self, payload: bytes, opcode: int) -> None:
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.extend(struct.pack("!BH", 0x80 | 126, length))
        else:
            header.extend(struct.pack("!BQ", 0x80 | 127, length))
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[idx % 4] for idx, byte in enumerate(payload))
        self.writer.write(bytes(header) + mask + masked)
        await self.writer.drain()

    async def _recv_frame(self) -> tuple[bytes, int]:
        first, second = await self.reader.readexactly(2)
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", await self.reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
        mask = await self.reader.readexactly(4) if masked else b""
        payload = await self.reader.readexactly(length) if length else b""
        if masked:
            payload = bytes(byte ^ mask[idx % 4] for idx, byte in enumerate(payload))
        if not fin:
            raise RuntimeError("fragmented WebSocket frames are not supported by stdlib fallback")
        return payload, opcode


async def open_websocket(url: str) -> Any:
    try:
        import websockets

        return await websockets.connect(url)
    except ModuleNotFoundError:
        return await StdlibWebSocketClient.connect(url)


def detect_shells() -> tuple[list[str], str]:
    shells: list[str] = []
    system = platform.system().lower()
    if system == "windows":
        if shutil.which("pwsh"):
            shells.append("pwsh")
            shells.append("powershell")
        if shutil.which("powershell"):
            shells.append("powershell")
        shells.append("cmd")
        return unique(shells), "powershell" if "powershell" in shells else "cmd"

    for shell in ["zsh", "bash", "sh"]:
        if shutil.which(shell):
            shells.append(shell)
    if "sh" not in shells:
        shells.append("sh")
    default_shell = "zsh" if "zsh" in shells else "bash" if "bash" in shells else "sh"
    return unique(shells), default_shell


def unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        normalized = value.strip().lower()
        if normalized and normalized not in seen:
            seen.add(normalized)
            out.append(normalized)
    return out


def resolve_path(raw: str | None, cwd: Path) -> Path:
    value = raw or "."
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return path.resolve()


def add_line_numbers(content: str, start_line: int) -> str:
    lines = content.splitlines()
    return "\n".join(f"{idx + start_line:>6}\t{line}" for idx, line in enumerate(lines))


def handle_read_text(params: dict[str, Any], cwd: Path) -> dict[str, Any]:
    file_path = resolve_path(params.get("file_path") or params.get("path"), cwd)
    if file_path.is_dir():
        return {"type": "error", "error": f"路径是目录，不是文件: {file_path}"}
    content = file_path.read_text(encoding="utf-8")
    all_lines = content.splitlines()
    offset = params.get("offset")
    limit = params.get("limit")
    start_line = max(1, int(offset)) if isinstance(offset, int) else 1
    start_idx = start_line - 1
    selected = all_lines[start_idx:]
    if isinstance(limit, int) and limit > 0:
        selected = selected[:limit]
    numbered = add_line_numbers("\n".join(selected), start_line)
    return {
        "type": "text",
        "file": {
            "filePath": str(file_path),
            "content": numbered,
            "numLines": len(selected),
            "startLine": start_line,
            "totalLines": len(all_lines)
        }
    }


def handle_write_text(params: dict[str, Any], cwd: Path) -> str:
    file_path = resolve_path(params.get("path"), cwd)
    content = str(params.get("content") or "")
    mode = params.get("mode")
    file_path.parent.mkdir(parents=True, exist_ok=True)
    if mode == "append":
        with file_path.open("a", encoding="utf-8") as f:
            f.write(content.rstrip() + "\n")
        return "文件内容追加成功"
    file_path.write_text(content.rstrip() + "\n", encoding="utf-8")
    return "文件内容写入成功"


def handle_edit_text(params: dict[str, Any], cwd: Path) -> str:
    file_path = resolve_path(params.get("filePath") or params.get("path"), cwd)
    old = str(params.get("oldString") or "")
    new = str(params.get("newString") or "")
    expected = int(params.get("expectedReplacements") or 1)
    if old == "":
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(new.rstrip() + "\n", encoding="utf-8")
        return f"文件已创建: {file_path}"
    content = file_path.read_text(encoding="utf-8")
    count = content.count(old)
    if count < expected:
        return f"错误: 文件中只找到 {count} 处匹配，但预期替换 {expected} 处。请检查 oldString 是否正确"
    result = content.replace(old, new, expected)
    file_path.write_text(result, encoding="utf-8")
    return f"成功替换 {expected} 处"


def handle_search_replace(params: dict[str, Any], cwd: Path) -> str:
    file_path = resolve_path(params.get("filePath") or params.get("path"), cwd)
    old = str(params.get("oldString") or "")
    new = str(params.get("newString") or "")
    content = file_path.read_text(encoding="utf-8")
    if old not in content:
        return "错误: 未找到搜索的文本。请确保 oldString 与文件内容完全匹配"
    file_path.write_text(content.replace(old, new, 1), encoding="utf-8")
    return "替换完成"


def handle_glob(params: dict[str, Any], cwd: Path) -> str:
    pattern = str(params.get("pattern") or "").strip()
    if not pattern:
        return "错误: 请提供 glob 模式"
    root = resolve_path(params.get("path"), cwd)
    if not pattern.startswith("**/") and "/" not in pattern and "\\" not in pattern:
        pattern = "**/" + pattern
    max_results = int(params.get("maxResults") or 200)
    matches = [
        str(Path(p).resolve())
        for p in glob.glob(str(root / pattern), recursive=True)
        if Path(p).is_file()
    ][:max_results]
    return f"找到 {len(matches)} 个文件:\n" + "\n".join(matches)


def handle_grep(params: dict[str, Any], cwd: Path) -> str:
    pattern = str(params.get("pattern") or "")
    if not pattern:
        return "错误: 请提供搜索模式"
    root = resolve_path(params.get("path"), cwd)
    file_pattern = str(params.get("filePattern") or "**/*")
    ignore_case = params.get("ignoreCase", True) is not False
    max_results = int(params.get("maxResults") or 50)
    flags = re.IGNORECASE if ignore_case else 0
    regex = re.compile(pattern, flags)
    files = [Path(p) for p in glob.glob(str(root / file_pattern), recursive=True) if Path(p).is_file()]
    matches: list[str] = []
    files_with_matches: set[str] = set()
    for file_path in files:
        try:
            lines = file_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except Exception:
            continue
        for idx, line in enumerate(lines, start=1):
            match = regex.search(line)
            if not match:
                continue
            files_with_matches.add(str(file_path))
            matches.append(f"> {file_path}:{idx}:{match.start() + 1}: {line}")
            if len(matches) >= max_results:
                break
        if len(matches) >= max_results:
            break
    return f"在 {len(files_with_matches)} 个文件中找到 {len(matches)} 处匹配:\n" + "\n".join(matches)


def shell_argv(shell: str, command: str, default_shell: str) -> list[str]:
    chosen = (shell or "auto").lower()
    if chosen == "auto":
        chosen = default_shell
    if chosen in ("powershell", "pwsh"):
        exe = shutil.which("pwsh") or shutil.which("powershell") or "powershell"
        return [exe, "-NoProfile", "-Command", command]
    if chosen in ("cmd", "cmd.exe"):
        return ["cmd.exe", "/d", "/s", "/c", command]
    if chosen == "zsh":
        return [shutil.which("zsh") or "zsh", "-lc", command]
    if chosen == "bash":
        return [shutil.which("bash") or "bash", "-lc", command]
    return [shutil.which("sh") or "/bin/sh", "-lc", command]


def handle_system_run(params: dict[str, Any], cwd: Path, default_shell: str) -> dict[str, Any]:
    command = str(params.get("command") or "")
    if not command:
        return {"success": False, "exitCode": None, "stdout": "", "stderr": "", "error": "command required"}
    timeout_ms = params.get("timeoutMs")
    timeout_sec = float(timeout_ms) / 1000.0 if isinstance(timeout_ms, (int, float)) and timeout_ms > 0 else None
    run_cwd = resolve_path(params.get("cwd"), cwd) if params.get("cwd") else cwd
    try:
        completed = subprocess.run(
            shell_argv(str(params.get("shell") or "auto"), command, default_shell),
            cwd=str(run_cwd),
            capture_output=True,
            text=True,
            timeout=timeout_sec
        )
        return {
            "success": completed.returncode == 0,
            "exitCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "error": None,
            "timedOut": False
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "success": False,
            "exitCode": None,
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
            "error": f"Command timed out after {timeout_ms}ms",
            "timedOut": True
        }


def dispatch_command(command: str, params: dict[str, Any], cwd: Path, default_shell: str) -> Any:
    if command == "system.run":
        return handle_system_run(params, cwd, default_shell)
    if command == "fs.readText":
        return handle_read_text(params, cwd)
    if command == "fs.writeText":
        return handle_write_text(params, cwd)
    if command == "fs.editText":
        return handle_edit_text(params, cwd)
    if command == "fs.searchReplace":
        return handle_search_replace(params, cwd)
    if command == "fs.glob":
        return handle_glob(params, cwd)
    if command == "fs.grep":
        return handle_grep(params, cwd)
    raise ValueError(f"command not supported: {command}")


async def send_request(ws: Any, method: str, params: dict[str, Any]) -> None:
    await ws.send(json.dumps({"type": "req", "id": make_id(), "method": method, "params": params}, ensure_ascii=False))


async def connect(args: argparse.Namespace, node_id: str, shells: list[str], default_shell: str, cwd: Path) -> Any:
    url = args.url or f"ws://{args.host}:{args.port}"
    ws = await open_websocket(url)
    challenge = json.loads(await ws.recv())
    if challenge.get("event") != "connect.challenge":
        raise RuntimeError(f"expected connect.challenge, got {challenge}")

    commands = [
        "system.run",
        "fs.readText",
        "fs.writeText",
        "fs.editText",
        "fs.searchReplace",
        "fs.glob",
        "fs.grep"
    ]
    req_id = make_id()
    await ws.send(json.dumps({
        "type": "req",
        "id": req_id,
        "method": "connect",
        "params": {
            "minProtocol": PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
            "client": {
                "id": node_id,
                "displayName": args.name,
                "version": "1.0.0",
                "platform": platform.system().lower(),
                "deviceFamily": platform.system().lower(),
                "mode": "node"
            },
            "role": "node",
            "caps": ["filesystem", "shell"],
            "commands": commands,
            "shells": shells,
            "defaultShell": default_shell,
            "workspace": str(cwd)
        }
    }, ensure_ascii=False))

    while True:
        frame = json.loads(await ws.recv())
        if frame.get("type") == "res" and frame.get("id") == req_id:
            if not frame.get("ok"):
                raise RuntimeError(f"connect failed: {frame.get('error')}")
            return ws


async def run_node(args: argparse.Namespace) -> None:
    cwd = Path(args.cwd or os.getcwd()).expanduser().resolve()
    shells, default_shell = detect_shells()
    node_id = args.node_id or f"opendesk-headless-{platform.node() or uuid.uuid4().hex[:8]}"
    print(f"node_id={node_id}")
    print(f"cwd={cwd}")
    print(f"shells={', '.join(shells)} default={default_shell}")

    ws = await connect(args, node_id, shells, default_shell, cwd)
    print("connected")

    async for raw in ws:
        frame = json.loads(raw)
        if frame.get("type") != "event":
            continue
        if frame.get("event") == "tick":
            continue
        if frame.get("event") != "node.invoke.request":
            continue
        payload = frame.get("payload") or {}
        invoke_id = payload.get("id")
        command = payload.get("command")
        try:
            params = json.loads(payload.get("paramsJSON") or "{}")
            result = dispatch_command(command, params, cwd, default_shell)
            await send_request(ws, "node.invoke.result", {
                "id": invoke_id,
                "nodeId": node_id,
                "ok": True,
                "payloadJSON": json.dumps(result, ensure_ascii=False),
                "error": None
            })
        except Exception as exc:
            await send_request(ws, "node.invoke.result", {
                "id": invoke_id,
                "nodeId": node_id,
                "ok": False,
                "payloadJSON": None,
                "error": {"code": "NODE_COMMAND_FAILED", "message": str(exc)}
            })


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a headless OpenDesk node host")
    parser.add_argument("--url", help="Gateway WebSocket URL, e.g. ws://127.0.0.1:18789")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Gateway host")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Gateway port")
    parser.add_argument("--node-id", help="Stable node id to advertise")
    parser.add_argument("--name", default=f"Headless Node ({platform.node() or platform.system()})", help="Display name")
    parser.add_argument("--cwd", help="Working directory for relative paths and shell commands")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        asyncio.run(run_node(parse_args()))
    except KeyboardInterrupt:
        print("stopped")
