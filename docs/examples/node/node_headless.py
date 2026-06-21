#!/usr/bin/env python3
"""
Headless OpenDesk node host.

Starts a non-interactive node that connects to the OpenDesk gateway and exposes
local shell and filesystem capabilities through node.invoke.

Usage:
    python3 docs/examples/node/node_headless.py start --host 127.0.0.1 --port 19010
    python3 docs/examples/node/node_headless.py --url ws://127.0.0.1:19010 --cwd /path/to/workspace
    sudo python3 docs/examples/node/node_headless.py install --host 192.168.1.100 --port 19010 --cwd /path/to/workspace
    sudo python3 docs/examples/node/node_headless.py uninstall
    python3 docs/examples/node/node_headless.py install --shell-autorun

Optional dependency:
    pip install websockets
    The script falls back to a small stdlib WebSocket client for ws:// URLs.
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import base64
import glob
import hashlib
import json
import mimetypes
import os
import platform
import plistlib
import re
import shlex
import shutil
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


PROTOCOL_VERSION = 4
DEFAULT_PORT = 19010
DEFAULT_HOST = "127.0.0.1"
DEFAULT_SERVICE_NAME = "opendesk-headless-node"
COMMANDS = ("start", "install", "uninstall")
SERVICE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@-]*$")
SHELL_AUTORUN_MARKER = "# >>> opendesk-headless-node >>>"
SHELL_AUTORUN_MARKER_END = "# <<< opendesk-headless-node <<<"
FILE_TRANSFER_DEFAULT_MAX_BYTES = 8 * 1024 * 1024
FILE_TRANSFER_HARD_MAX_BYTES = 16 * 1024 * 1024


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

    async def close(self) -> None:
        self.writer.close()
        await self.writer.wait_closed()

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


async def close_websocket(ws: Any) -> None:
    close = getattr(ws, "close", None)
    if not callable(close):
        return
    result = close()
    if hasattr(result, "__await__"):
        await result


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


def read_absolute_path(raw: Any) -> Path | dict[str, Any]:
    if not isinstance(raw, str) or not raw:
        return {"ok": False, "code": "INVALID_PATH", "message": "path is required"}
    if "\0" in raw:
        return {"ok": False, "code": "INVALID_PATH", "message": "path must not contain NUL bytes"}
    file_path = Path(raw).expanduser()
    if not file_path.is_absolute():
        return {"ok": False, "code": "INVALID_PATH", "message": "path must be absolute"}
    return file_path


def clamp_transfer_max_bytes(value: Any) -> int:
    if not isinstance(value, (int, float)) or value <= 0:
        return FILE_TRANSFER_DEFAULT_MAX_BYTES
    return min(int(value), FILE_TRANSFER_HARD_MAX_BYTES)


def first_symlink_component(file_path: Path) -> Path | None:
    parts = file_path.parts
    if not parts:
        return None
    current = Path(file_path.anchor) if file_path.is_absolute() else Path(parts[0])
    start_index = 1 if file_path.is_absolute() else 1
    for part in parts[start_index:]:
        if not part or part == os.curdir:
            continue
        current = current / part
        try:
            if current.is_symlink():
                return current
            if not current.exists():
                return None
        except OSError:
            return None
    return None


def symlink_redirect_error(symlink_path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "ok": False,
        "code": "SYMLINK_REDIRECT",
        "message": "path traverses a symlink; refusing because followSymlinks=false"
    }
    try:
        result["canonicalPath"] = str(symlink_path.resolve(strict=False))
    except OSError:
        pass
    return result


def is_likely_text(data: bytes) -> bool:
    if not data:
        return True
    sample = data[:8192]
    if b"\0" in sample:
        return False
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError:
        return False
    control = sum(1 for byte in sample if byte < 0x20 and byte not in (0x09, 0x0A, 0x0D))
    return control / len(sample) < 0.01


def detect_mime(file_path: Path, data: bytes) -> str:
    guessed, _ = mimetypes.guess_type(str(file_path))
    if guessed:
        return guessed
    return "text/plain" if is_likely_text(data) else "application/octet-stream"


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


def handle_file_fetch(params: dict[str, Any], cwd: Path) -> dict[str, Any]:
    raw_path = read_absolute_path(params.get("path"))
    if isinstance(raw_path, dict):
        return raw_path
    follow_symlinks = params.get("followSymlinks") is True
    try:
        if not follow_symlinks:
            symlink_path = first_symlink_component(raw_path)
            if symlink_path is not None:
                return symlink_redirect_error(symlink_path)
        file_path = raw_path.resolve(strict=True)
        if file_path.is_dir():
            return {"ok": False, "code": "IS_DIRECTORY", "message": "path is a directory", "canonicalPath": str(file_path)}
        max_bytes = clamp_transfer_max_bytes(params.get("maxBytes"))
        size = file_path.stat().st_size
        if size > max_bytes:
            return {
                "ok": False,
                "code": "FILE_TOO_LARGE",
                "message": f"file size {size} exceeds limit {max_bytes}",
                "canonicalPath": str(file_path)
            }
        if params.get("preflightOnly") is True:
            return {
                "ok": True,
                "path": str(file_path),
                "size": size,
                "mimeType": "",
                "base64": "",
                "sha256": "",
                "preflightOnly": True
            }
        data = file_path.read_bytes()
        if len(data) > max_bytes:
            return {
                "ok": False,
                "code": "FILE_TOO_LARGE",
                "message": f"read {len(data)} bytes exceeds limit {max_bytes}",
                "canonicalPath": str(file_path)
            }
        sha256 = hashlib.sha256(data).hexdigest()
        return {
            "ok": True,
            "path": str(file_path),
            "size": len(data),
            "mimeType": detect_mime(file_path, data),
            "base64": base64.b64encode(data).decode("ascii"),
            "sha256": sha256
        }
    except FileNotFoundError:
        return {"ok": False, "code": "NOT_FOUND", "message": "file not found"}
    except PermissionError as exc:
        return {"ok": False, "code": "PERMISSION_DENIED", "message": str(exc)}
    except OSError as exc:
        return {"ok": False, "code": "READ_ERROR", "message": str(exc)}


def decode_strict_base64(value: str) -> bytes | None:
    try:
        padded = value + "=" * ((4 - len(value) % 4) % 4)
        return base64.b64decode(padded.replace("-", "+").replace("_", "/"), validate=True)
    except Exception:
        return None


def handle_file_write(params: dict[str, Any], cwd: Path) -> dict[str, Any]:
    raw_path = read_absolute_path(params.get("path"))
    if isinstance(raw_path, dict):
        return raw_path
    if not isinstance(params.get("contentBase64"), str):
        return {"ok": False, "code": "INVALID_BASE64", "message": "contentBase64 is required"}

    data = decode_strict_base64(params["contentBase64"])
    if data is None:
        return {"ok": False, "code": "INVALID_BASE64", "message": "contentBase64 is not valid base64"}
    if len(data) > FILE_TRANSFER_HARD_MAX_BYTES:
        return {
            "ok": False,
            "code": "FILE_TOO_LARGE",
            "message": f"decoded content is {len(data)} bytes; maximum is {FILE_TRANSFER_HARD_MAX_BYTES} bytes (16 MB)"
        }

    computed_sha256 = hashlib.sha256(data).hexdigest()
    expected_sha256 = params.get("expectedSha256")
    if isinstance(expected_sha256, str) and expected_sha256.lower() != computed_sha256:
        return {
            "ok": False,
            "code": "INTEGRITY_FAILURE",
            "message": f"sha256 mismatch: expected {expected_sha256.lower()}, got {computed_sha256}"
        }

    follow_symlinks = params.get("followSymlinks") is True
    create_parents = params.get("createParents") is True
    overwrite = params.get("overwrite") is True
    preflight_only = params.get("preflightOnly") is True
    try:
        if not follow_symlinks:
            symlink_path = first_symlink_component(raw_path)
            if symlink_path is not None:
                return symlink_redirect_error(symlink_path)
        target_path = raw_path.resolve(strict=False)
        parent = target_path.parent
        if not parent.exists():
            if not create_parents:
                return {
                    "ok": False,
                    "code": "PARENT_NOT_FOUND",
                    "message": f"parent directory does not exist: {parent}"
                }
            if preflight_only:
                return {
                    "ok": True,
                    "path": str(target_path),
                    "size": len(data),
                    "sha256": computed_sha256,
                    "overwritten": False
                }
            parent.mkdir(parents=True, exist_ok=True)
        if target_path.exists():
            if target_path.is_symlink():
                return {
                    "ok": False,
                    "code": "SYMLINK_TARGET_DENIED",
                    "message": f"path is a symlink; refusing to write through it: {target_path}"
                }
            if target_path.is_dir():
                return {"ok": False, "code": "IS_DIRECTORY", "message": f"path resolves to a directory: {target_path}"}
            if not overwrite:
                return {
                    "ok": False,
                    "code": "EXISTS_NO_OVERWRITE",
                    "message": f"file already exists and overwrite is false: {target_path}"
                }
            overwritten = True
        else:
            overwritten = False

        if preflight_only:
            return {
                "ok": True,
                "path": str(target_path),
                "size": len(data),
                "sha256": computed_sha256,
                "overwritten": overwritten
            }

        temp_path = parent / f".{target_path.name}.opendesk-tmp-{uuid.uuid4().hex}"
        try:
            temp_path.write_bytes(data)
            os.replace(temp_path, target_path)
        finally:
            if temp_path.exists():
                temp_path.unlink()
        return {
            "ok": True,
            "path": str(target_path.resolve(strict=True)),
            "size": len(data),
            "sha256": computed_sha256,
            "overwritten": overwritten
        }
    except PermissionError as exc:
        return {"ok": False, "code": "PERMISSION_DENIED", "message": str(exc)}
    except OSError as exc:
        return {"ok": False, "code": "WRITE_ERROR", "message": str(exc)}


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


async def handle_system_run_async(params: dict[str, Any], cwd: Path, default_shell: str) -> dict[str, Any]:
    command = str(params.get("command") or "")
    if not command:
        return {"success": False, "exitCode": None, "stdout": "", "stderr": "", "error": "command required"}
    timeout_ms = params.get("timeoutMs")
    timeout_sec = float(timeout_ms) / 1000.0 if isinstance(timeout_ms, (int, float)) and timeout_ms > 0 else None
    run_cwd = resolve_path(params.get("cwd"), cwd) if params.get("cwd") else cwd
    timed_out = False
    try:
        proc = await asyncio.create_subprocess_exec(
            *shell_argv(str(params.get("shell") or "auto"), command, default_shell),
            cwd=str(run_cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            timed_out = True
            proc.kill()
            stdout, stderr = await proc.communicate()
        return {
            "success": proc.returncode == 0,
            "exitCode": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace") if stdout else "",
            "stderr": stderr.decode("utf-8", errors="replace") if stderr else "",
            "error": f"Command timed out after {timeout_ms}ms" if timed_out else None,
            "timedOut": timed_out
        }
    except Exception as exc:
        return {
            "success": False,
            "exitCode": None,
            "stdout": "",
            "stderr": "",
            "error": str(exc),
            "timedOut": False
        }


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


async def dispatch_command(command: str, params: dict[str, Any], cwd: Path, default_shell: str) -> Any:
    if command == "system.run":
        return await handle_system_run_async(params, cwd, default_shell)
    if command == "fs.readText":
        return handle_read_text(params, cwd)
    if command == "fs.writeText":
        return handle_write_text(params, cwd)
    if command == "file.fetch":
        return handle_file_fetch(params, cwd)
    if command == "file.write":
        return handle_file_write(params, cwd)
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
        "file.fetch",
        "file.write",
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


async def serve_node(ws: Any, node_id: str, cwd: Path, default_shell: str) -> None:
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
            result = await dispatch_command(command, params, cwd, default_shell)
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
    raise EOFError("gateway connection closed")


async def run_node(args: argparse.Namespace) -> None:
    cwd = Path(args.cwd or os.getcwd()).expanduser().resolve()
    shells, default_shell = detect_shells()
    node_id = args.node_id or f"opendesk-headless-{platform.node() or uuid.uuid4().hex[:8]}"
    retry_interval = max(0.1, float(args.retry_interval))
    max_retry_interval = max(retry_interval, float(args.max_retry_interval))
    retry_delay = retry_interval

    # 单实例守护：如果已有 node_headless.py start 在运行，直接退出
    if is_another_instance_running():
        print("opendesk-headless-node is already running, exiting", flush=True)
        return

    # 退出时自动清理 PID 文件
    atexit.register(cleanup_pid_file)

    print(f"node_id={node_id}", flush=True)
    print(f"cwd={cwd}", flush=True)
    print(f"shells={', '.join(shells)} default={default_shell}", flush=True)

    while True:
        ws = None
        try:
            ws = await connect(args, node_id, shells, default_shell, cwd)
            retry_delay = retry_interval
            print("connected", flush=True)
            await serve_node(ws, node_id, cwd, default_shell)
        except Exception as exc:
            if ws is not None:
                await close_websocket(ws)
            if not args.retry:
                raise
            print(
                f"gateway disconnected or unavailable: {exc}; retrying in {retry_delay:g}s",
                file=sys.stderr,
                flush=True
            )
            await asyncio.sleep(retry_delay)
            retry_delay = min(max_retry_interval, retry_delay * 2)


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be greater than 0")
    return parsed


def normalize_service_name(name: str) -> str:
    service_name = name.strip()
    if service_name.endswith(".service"):
        service_name = service_name[:-8]
    if not SERVICE_NAME_RE.fullmatch(service_name):
        raise ValueError(
            "service name must start with an alphanumeric character "
            "and contain only letters, digits, '.', '_', '@', or '-'"
        )
    return service_name


def require_system_service_privileges() -> None:
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        raise PermissionError("installing a system service requires root; rerun with sudo or pass --user-service")


def service_cwd(args: argparse.Namespace) -> Path:
    return Path(args.cwd or os.getcwd()).expanduser().resolve()


def command_arg(value: str | int | float) -> str:
    return str(value)


def format_number(value: float) -> str:
    return f"{value:g}"


def service_start_command(args: argparse.Namespace) -> list[str]:
    python_value = args.python or sys.executable or shutil.which("python3") or "python3"
    python_path = Path(python_value).expanduser()
    python_executable = str(python_path.resolve()) if python_path.exists() else str(python_path)
    command = [python_executable, str(Path(__file__).expanduser().resolve()), "start"]
    if args.url:
        command.extend(["--url", args.url])
    else:
        command.extend(["--host", args.host, "--port", command_arg(args.port)])
    if args.node_id:
        command.extend(["--node-id", args.node_id])
    command.extend(["--name", args.name])
    command.extend(["--cwd", str(service_cwd(args))])
    command.extend(["--retry-interval", format_number(args.retry_interval)])
    command.extend(["--max-retry-interval", format_number(args.max_retry_interval)])
    if not args.retry:
        command.append("--no-retry")
    return command


def run_checked(command: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, capture_output=True, text=True)
    if check and completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        detail = stderr or stdout or f"exit code {completed.returncode}"
        raise RuntimeError(f"{' '.join(command)} failed: {detail}")
    return completed


def escape_systemd_specifiers(value: str) -> str:
    return value.replace("%", "%%")


def quote_exec(command: list[str]) -> str:
    return " ".join(shlex.quote(escape_systemd_specifiers(part)) for part in command)


def systemd_escape_path(path: Path) -> str:
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/._-:@")
    escaped: list[str] = []
    for char in str(path):
        if char == "%":
            escaped.append("%%")
        elif char in allowed:
            escaped.append(char)
        else:
            escaped.extend(f"\\x{byte:02x}" for byte in char.encode("utf-8"))
    return "".join(escaped)


def systemd_unit_text(args: argparse.Namespace, command: list[str], user_service: bool) -> str:
    wanted_by = "default.target" if user_service else "multi-user.target"
    return (
        "[Unit]\n"
        f"Description=OpenDesk Headless Node ({args.name})\n"
        "After=network-online.target\n"
        "Wants=network-online.target\n"
        "\n"
        "[Service]\n"
        "Type=simple\n"
        f"WorkingDirectory={systemd_escape_path(service_cwd(args))}\n"
        f"ExecStart={quote_exec(command)}\n"
        "Restart=always\n"
        "RestartSec=5\n"
        "Environment=PYTHONUNBUFFERED=1\n"
        "\n"
        "[Install]\n"
        f"WantedBy={wanted_by}\n"
    )


def install_linux_service(args: argparse.Namespace) -> None:
    if not shutil.which("systemctl"):
        raise RuntimeError("systemd is required for Linux service installation, but systemctl was not found")

    user_service = bool(args.user_service)
    if user_service:
        unit_dir = Path.home() / ".config" / "systemd" / "user"
        systemctl = ["systemctl", "--user"]
    else:
        require_system_service_privileges()
        unit_dir = Path("/etc/systemd/system")
        systemctl = ["systemctl"]

    service_name = normalize_service_name(args.service_name)
    unit_name = f"{service_name}.service"
    unit_path = unit_dir / unit_name
    unit_dir.mkdir(parents=True, exist_ok=True)
    unit_path.write_text(systemd_unit_text(args, service_start_command(args), user_service), encoding="utf-8")

    run_checked([*systemctl, "daemon-reload"])
    run_checked([*systemctl, "enable", unit_name])
    if not args.no_start:
        run_checked([*systemctl, "restart", unit_name])
    print(f"installed {unit_name} at {unit_path}")
    if user_service:
        print("user service autostarts with the user session; use sudo without --user-service for boot-time system service")


def uninstall_linux_service(args: argparse.Namespace) -> None:
    if not shutil.which("systemctl"):
        raise RuntimeError("systemd is required for Linux service uninstallation, but systemctl was not found")

    user_service = bool(args.user_service)
    if user_service:
        unit_dir = Path.home() / ".config" / "systemd" / "user"
        systemctl = ["systemctl", "--user"]
    else:
        require_system_service_privileges()
        unit_dir = Path("/etc/systemd/system")
        systemctl = ["systemctl"]

    service_name = normalize_service_name(args.service_name)
    unit_name = f"{service_name}.service"
    unit_path = unit_dir / unit_name
    run_checked([*systemctl, "disable", "--now", unit_name], check=False)
    if unit_path.exists():
        unit_path.unlink()
    run_checked([*systemctl, "daemon-reload"], check=False)
    run_checked([*systemctl, "reset-failed", unit_name], check=False)
    print(f"uninstalled {unit_name}")


def launchd_paths(args: argparse.Namespace) -> tuple[str, Path, str, Path, Path]:
    user_service = bool(args.user_service)
    label = normalize_service_name(args.service_name)
    if user_service:
        plist_dir = Path.home() / "Library" / "LaunchAgents"
        domain = f"gui/{os.getuid()}"
        log_dir = Path.home() / "Library" / "Logs"
    else:
        require_system_service_privileges()
        plist_dir = Path("/Library/LaunchDaemons")
        domain = "system"
        log_dir = Path("/var/log")
    plist_path = plist_dir / f"{label}.plist"
    return label, plist_path, domain, log_dir / f"{label}.out.log", log_dir / f"{label}.err.log"


def install_macos_service(args: argparse.Namespace) -> None:
    if not shutil.which("launchctl"):
        raise RuntimeError("launchctl was not found")

    label, plist_path, domain, stdout_path, stderr_path = launchd_paths(args)
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": label,
        "ProgramArguments": service_start_command(args),
        "WorkingDirectory": str(service_cwd(args)),
        "RunAtLoad": True,
        "KeepAlive": True,
        "EnvironmentVariables": {
            "PYTHONUNBUFFERED": "1"
        },
        "StandardOutPath": str(stdout_path),
        "StandardErrorPath": str(stderr_path)
    }
    with plist_path.open("wb") as f:
        plistlib.dump(plist, f)
    plist_path.chmod(0o644)
    if not args.user_service and hasattr(os, "chown"):
        os.chown(plist_path, 0, 0)

    if not args.no_start:
        run_checked(["launchctl", "bootout", domain, str(plist_path)], check=False)
        run_checked(["launchctl", "bootstrap", domain, str(plist_path)])
        run_checked(["launchctl", "enable", f"{domain}/{label}"], check=False)
        run_checked(["launchctl", "kickstart", "-k", f"{domain}/{label}"], check=False)
    print(f"installed {label} at {plist_path}")
    if args.user_service:
        print("user service autostarts with the user login session; use sudo without --user-service for boot-time system service")


def uninstall_macos_service(args: argparse.Namespace) -> None:
    if not shutil.which("launchctl"):
        raise RuntimeError("launchctl was not found")

    label, plist_path, domain, _stdout_path, _stderr_path = launchd_paths(args)
    run_checked(["launchctl", "bootout", domain, str(plist_path)], check=False)
    run_checked(["launchctl", "disable", f"{domain}/{label}"], check=False)
    if plist_path.exists():
        plist_path.unlink()
    print(f"uninstalled {label}")


def install_service(args: argparse.Namespace) -> None:
    system = platform.system().lower()
    if system == "linux":
        install_linux_service(args)
        return
    if system == "darwin":
        install_macos_service(args)
        return
    raise RuntimeError(f"service installation is not supported on {platform.system()}")


def uninstall_service(args: argparse.Namespace) -> None:
    system = platform.system().lower()
    if system == "linux":
        uninstall_linux_service(args)
        return
    if system == "darwin":
        uninstall_macos_service(args)
        return
    raise RuntimeError(f"service uninstallation is not supported on {platform.system()}")


def kill_existing_node_processes() -> int:
    """Kill any running node_headless.py processes. Returns number of processes killed."""
    try:
        # First, find all matching processes and filter them
        result = subprocess.run(
            ["pgrep", "-f", "node_headless.py"],
            capture_output=True,
            text=True,
            check=False
        )
        if result.returncode != 0 or not result.stdout.strip():
            return 0

        pids_to_kill: list[int] = []

        for line in result.stdout.strip().splitlines():
            try:
                pid = int(line.strip())
                # Don't kill ourselves
                if pid == os.getpid():
                    continue

                # Read process info to filter
                exe_path = Path(f"/proc/{pid}/exe")
                cmdline_path = Path(f"/proc/{pid}/cmdline")
                exe_target = exe_path.readlink() if exe_path.exists() else ""
                cmdline = cmdline_path.read_text() if cmdline_path.exists() else ""

                # Skip install/uninstall processes
                if "install" in cmdline or "uninstall" in cmdline:
                    continue

                # Kill both python processes and shell wrapper processes
                # (shell wrapper should die when its child python process dies,
                # but we kill it explicitly to ensure cleanup)
                pids_to_kill.append(pid)
            except Exception:
                continue

        if not pids_to_kill:
            return 0

        # Now kill the filtered processes
        killed = 0
        for pid in pids_to_kill:
            try:
                os.kill(pid, 15)  # SIGTERM
                killed += 1
                print(f"Terminated existing node process (PID {pid})")
            except (ProcessLookupError, PermissionError):
                continue

        if killed > 0:
            time.sleep(0.5)

        return killed

    except Exception:
        return 0


def install_shell_autorun(args: argparse.Namespace) -> None:
    """Install as shell autorun: copy script and add to .bashrc/.zshrc."""
    home = Path.home()
    nodes_dir = home / ".opendesk" / "nodes"
    logs_dir = home / ".opendesk" / "logs"
    nodes_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    dest_script = nodes_dir / "node_headless.py"
    src_script = Path(__file__).expanduser().resolve()

    # Kill any existing node_headless.py processes before updating
    kill_existing_node_processes()
    cleanup_pid_file()

    # Copy script to destination
    shutil.copy2(src_script, dest_script)
    print(f"Copied script to {dest_script}")

    # Build the autorun command
    python_exec = args.python or sys.executable or shutil.which("python3") or "python3"
    log_file = logs_dir / "node.log"
    autorun_cmd = f"{shlex.quote(python_exec)} {shlex.quote(str(dest_script))} start"

    if args.url:
        autorun_cmd += f" --url {shlex.quote(args.url)}"
    else:
        autorun_cmd += f" --host {shlex.quote(args.host)} --port {args.port}"

    if args.node_id:
        autorun_cmd += f" --node-id {shlex.quote(args.node_id)}"

    autorun_cmd += f" --name {shlex.quote(args.name)}"
    autorun_cmd += f" --cwd {shlex.quote(str(Path(args.cwd or os.getcwd()).expanduser().resolve()))}"
    autorun_cmd += f" --retry-interval {args.retry_interval}"
    autorun_cmd += f" --max-retry-interval {args.max_retry_interval}"

    if not args.retry:
        autorun_cmd += " --no-retry"

    autorun_cmd += f" >> {shlex.quote(str(log_file))} 2>&1 &"

    # Build the block to add to rc files
    rc_block = f'''{SHELL_AUTORUN_MARKER}
# This block was added by opendesk-headless-node install --shell-autorun
# To remove, run: python3 {dest_script} uninstall --shell-autorun
{autorun_cmd}
{SHELL_AUTORUN_MARKER_END}
'''

    # Detect available shells and modify rc files
    modified_files: list[str] = []

    for rc_name, rc_path in [("bash", home / ".bashrc"), ("zsh", home / ".zshrc")]:
        if not rc_path.exists():
            continue

        content = rc_path.read_text(encoding="utf-8")

        # If already installed, remove old block first (update/overwrite)
        if SHELL_AUTORUN_MARKER in content:
            lines = content.splitlines(keepends=True)
            new_lines: list[str] = []
            in_block = False
            for line in lines:
                if SHELL_AUTORUN_MARKER in line and not in_block:
                    in_block = True
                    continue
                if SHELL_AUTORUN_MARKER_END in line and in_block:
                    in_block = False
                    continue
                if not in_block:
                    new_lines.append(line)
            # Remove trailing empty lines
            while new_lines and new_lines[-1].strip() == "":
                new_lines.pop()
            content = "".join(new_lines)
            print(f"Removing existing autorun from {rc_path} to update")

        # Add the block at the end
        with rc_path.open("w", encoding="utf-8") as f:
            f.write(content)
            if not content.endswith("\n"):
                f.write("\n")
            f.write(rc_block)

        modified_files.append(str(rc_path))
        print(f"Added autorun to {rc_path}")

    if not modified_files:
        print("Warning: No .bashrc or .zshrc found, autorun not configured")
        return

    print(f"\nShell autorun installed successfully!")
    print(f"Script: {dest_script}")
    print(f"Log file: {log_file}")
    print("The node will start automatically when you open a new terminal.")
    print("To uninstall, run: python3 node_headless.py uninstall --shell-autorun")

    # Start the node process now (in background)
    start_node_process(autorun_cmd)


def start_node_process(autorun_cmd: str) -> None:
    """Start the node process in background using the autorun command."""
    # Check if a node process is already running
    existing = count_existing_node_processes()
    if existing > 0:
        print(f"Node process already running ({existing} instance(s)), skipping start.")
        return

    try:
        subprocess.Popen(
            autorun_cmd.rstrip("&").strip(),
            shell=True,
            start_new_session=True
        )
        print("Node process started in background.")
    except Exception as exc:
        print(f"Warning: Failed to start node process: {exc}")


def count_existing_node_processes() -> int:
    """Count running node_headless.py processes (excluding install/uninstall)."""
    count = 0
    try:
        result = subprocess.run(
            ["pgrep", "-f", "node_headless.py"],
            capture_output=True,
            text=True,
            check=False
        )
        if result.returncode != 0 or not result.stdout.strip():
            return 0

        for line in result.stdout.strip().splitlines():
            try:
                pid = int(line.strip())
                if pid == os.getpid():
                    continue

                exe_path = Path(f"/proc/{pid}/exe")
                cmdline_path = Path(f"/proc/{pid}/cmdline")
                exe_target = exe_path.readlink() if exe_path.exists() else ""
                cmdline = cmdline_path.read_text() if cmdline_path.exists() else ""

                # Skip install/uninstall processes and shell processes
                if "install" in cmdline or "uninstall" in cmdline:
                    continue
                if "python" not in exe_target.lower():
                    continue

                count += 1
            except (ValueError, ProcessLookupError, PermissionError):
                continue

    except Exception:
        pass

    return count


def get_pid_file() -> Path:
    return Path.home() / ".opendesk" / "nodes" / "node.pid"


def cleanup_pid_file() -> None:
    pid_file = get_pid_file()
    try:
        if pid_file.exists():
            pid_file.unlink()
    except Exception:
        pass


def is_another_instance_running() -> bool:
    """检查是否已有 node_headless.py start 实例在运行（基于 PID 文件）。"""
    pid_file = get_pid_file()

    if pid_file.exists():
        try:
            old_pid = int(pid_file.read_text().strip())
            # 检查该 PID 对应的进程是否仍然存活
            os.kill(old_pid, 0)
            # 额外验证：确认该进程确实是 node_headless.py（防止 PID 被重用）
            if _is_pid_node_headless(old_pid):
                return True
            # 进程存在但不是 node_headless.py，清理过期 PID 文件
            cleanup_pid_file()
        except (ValueError, OSError, ProcessLookupError):
            pass  # PID 文件过期或进程已死

    # 写入当前 PID
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()))
    return False


def _is_pid_node_headless(pid: int) -> bool:
    """检查给定 PID 是否对应 node_headless.py 进程。"""
    try:
        # Linux: 读取 /proc/{pid}/cmdline
        cmdline_path = Path(f"/proc/{pid}/cmdline")
        if cmdline_path.exists():
            cmdline = cmdline_path.read_text(errors="replace")
            return "node_headless.py" in cmdline
    except Exception:
        pass
    # macOS / 其他系统：用 ps 命令
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True, text=True
        )
        return "node_headless.py" in result.stdout
    except Exception:
        pass
    return False


def uninstall_shell_autorun(args: argparse.Namespace) -> None:
    """Remove shell autorun from .bashrc/.zshrc and delete the script."""
    # Kill any running node_headless.py processes
    kill_existing_node_processes()
    cleanup_pid_file()

    home = Path.home()
    nodes_dir = home / ".opendesk" / "nodes"
    dest_script = nodes_dir / "node_headless.py"

    # Remove from rc files
    modified_files: list[str] = []

    for rc_name, rc_path in [("bash", home / ".bashrc"), ("zsh", home / ".zshrc")]:
        if not rc_path.exists():
            continue

        content = rc_path.read_text(encoding="utf-8")

        if SHELL_AUTORUN_MARKER not in content:
            continue

        # Find and remove the block
        lines = content.splitlines(keepends=True)
        new_lines: list[str] = []
        in_block = False

        for line in lines:
            if SHELL_AUTORUN_MARKER in line and not in_block:
                in_block = True
                continue
            if SHELL_AUTORUN_MARKER_END in line and in_block:
                in_block = False
                continue
            if not in_block:
                new_lines.append(line)

        # Remove trailing empty lines at the end
        while new_lines and new_lines[-1].strip() == "":
            new_lines.pop()

        rc_path.write_text("".join(new_lines), encoding="utf-8")
        modified_files.append(str(rc_path))
        print(f"Removed autorun from {rc_path}")

    # Remove the script
    if dest_script.exists():
        dest_script.unlink()
        print(f"Removed script {dest_script}")

    if not modified_files:
        print("No shell autorun found to remove")
    else:
        print("\nShell autorun uninstalled successfully!")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run or install a headless OpenDesk node host",
        epilog=(
            "Commands: start (default), install, uninstall. "
            "install/uninstall use systemd on Linux and launchd on macOS. "
            "Use --shell-autorun for shell-based autorun instead of system service."
        )
    )
    parser.add_argument("command", nargs="?", choices=COMMANDS, default="start", help="Command to run")
    parser.add_argument("--url", help="Gateway WebSocket URL, e.g. ws://127.0.0.1:19010")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Gateway host")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Gateway port")
    parser.add_argument("--node-id", help="Stable node id to advertise")
    parser.add_argument("--name", default=f"Headless Node ({platform.node() or platform.system()})", help="Display name")
    parser.add_argument("--cwd", help="Working directory for relative paths and shell commands")
    parser.add_argument("--retry-interval", type=positive_float, default=5.0, help="Initial gateway reconnect delay in seconds")
    parser.add_argument("--max-retry-interval", type=positive_float, default=60.0, help="Maximum gateway reconnect delay in seconds")
    parser.add_argument("--no-retry", dest="retry", action="store_false", help="Exit when gateway connection fails")
    parser.add_argument("--service-name", default=DEFAULT_SERVICE_NAME, help="systemd unit base name or launchd label")
    parser.add_argument("--user-service", action="store_true", help="Install as a per-user service instead of a system service")
    parser.add_argument("--no-start", action="store_true", help="Install the service without starting it immediately")
    parser.add_argument("--python", help="Python interpreter path used by the installed service")
    parser.add_argument("--shell-autorun", action="store_true", help="Install as shell autorun (modifies .bashrc/.zshrc) instead of system service")
    parser.set_defaults(retry=True)
    args = parser.parse_args(argv)
    if args.max_retry_interval < args.retry_interval:
        parser.error("--max-retry-interval must be greater than or equal to --retry-interval")
    return args


def main() -> int:
    args = parse_args()
    if args.command == "install":
        if args.shell_autorun:
            install_shell_autorun(args)
        else:
            install_service(args)
        return 0
    if args.command == "uninstall":
        if args.shell_autorun:
            uninstall_shell_autorun(args)
        else:
            uninstall_service(args)
        return 0
    asyncio.run(run_node(args))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("stopped")
        raise SystemExit(0)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
