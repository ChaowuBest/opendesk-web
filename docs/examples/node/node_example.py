#!/usr/bin/env python3
"""
OpenDesk 节点协议示例客户端

通过 WebSocket 连接到 OpenDesk 网关，实现交互式 AI 对话。
支持流式输出，类似 CLI 体验。

使用方法:
    python3 node_example.py
    python3 node_example.py --host 192.168.1.100 --port 18789

依赖:
    pip install websockets

协议版本: OpenClaw Node Protocol v4
"""

import asyncio
import base64
import json
import mimetypes
import sys
import uuid
from pathlib import Path
from typing import Optional

import websockets
from websockets.asyncio.client import ClientConnection


# ── 默认配置 ──────────────────────────────────────────────────────────────

DEFAULT_HOST = "localhost"
DEFAULT_PORT = 18789
PROTOCOL_VERSION = 4

# ANSI 颜色
RESET = "\033[0m"
DIM = "\033[2m"
GREEN = "\033[32m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
RED = "\033[31m"
BOLD = "\033[1m"


def make_id() -> str:
    """生成 UUID v4 短标识符。"""
    return str(uuid.uuid4())


def make_short_id() -> str:
    """生成 8 位短标识符。"""
    return uuid.uuid4().hex[:8]


def encode_image_to_base64(file_path: str) -> Optional[dict]:
    """读取图片文件，返回 base64 编码及 MIME 类型。

    返回格式与 OpenClaw Node Protocol 的 ChatAttachment 一致：
        { "type": "image", "mimeType": "image/png", "fileName": "...", "content": "<base64>" }

    Args:
        file_path: 图片文件路径

    Returns:
        dict 或 None（文件不存在或非图片时）
    """
    path = Path(file_path).expanduser().resolve()
    if not path.is_file():
        print(f"{RED}✗ 文件不存在: {path}{RESET}")
        return None

    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type or not mime_type.startswith("image/"):
        print(f"{RED}✗ 不支持的文件类型: {mime_type or '未知'}（仅支持 image/*）{RESET}")
        return None

    try:
        raw = path.read_bytes()
        content = base64.b64encode(raw).decode("ascii")
    except Exception as e:
        print(f"{RED}✗ 读取文件失败: {e}{RESET}")
        return None

    return {
        "type": "image",
        "mimeType": mime_type,
        "fileName": path.name,
        "content": content,
    }


async def connect_to_gateway(host: str, port: int) -> ClientConnection:
    """建立与 OpenDesk 网关的 WebSocket 连接并完成握手。"""
    uri = f"ws://{host}:{port}"

    print(f"{DIM}正在连接 {uri} ...{RESET}")
    ws = await websockets.connect(uri)
    print(f"{GREEN}✓ WebSocket 已连接{RESET}")

    # ── 步骤 1: 接收挑战 ─────────────────────────────────────────────
    challenge_msg = await ws.recv()
    challenge = json.loads(challenge_msg)

    if (
        challenge.get("type") != "event"
        or challenge.get("event") != "connect.challenge"
    ):
        print(f"{RED}✗ 未收到 connect.challenge: {challenge_msg[:200]}{RESET}")
        await ws.close()
        sys.exit(1)

    nonce = challenge.get("payload", {}).get("nonce", "")
    print(f"{DIM}收到挑战 nonce={nonce[:16]}...{RESET}")

    # ── 步骤 2: 发送 connect 请求 ───────────────────────────────────
    client_id = f"py-example-{make_short_id()}"
    connect_id = make_id()

    connect_params = {
        "minProtocol": PROTOCOL_VERSION,
        "maxProtocol": PROTOCOL_VERSION,
        "client": {
            "id": client_id,
            "displayName": "Python Node Example",
            "version": "1.0.0",
            "platform": "python",
            "mode": "operator",
        },
    }

    await ws.send(json.dumps({
        "type": "req",
        "id": connect_id,
        "method": "connect",
        "params": connect_params,
    }))

    # ── 步骤 3: 接收 hello-ok ───────────────────────────────────────
    hello_msg = await ws.recv()
    hello = json.loads(hello_msg)

    if hello.get("type") != "res" or not hello.get("ok"):
        error = hello.get("error", {})
        print(
            f"{RED}✗ 握手失败: {error.get('code')} - {error.get('message')}{RESET}"
        )
        await ws.close()
        sys.exit(1)

    payload = hello.get("payload", {})
    protocol = payload.get("protocol", "?")
    server_version = payload.get("server", {}).get("version", "?")
    features = payload.get("features", {})
    methods = features.get("methods", [])

    print(f"{GREEN}✓ 握手完成 (协议 v{protocol}, 服务端 {server_version}){RESET}")
    print(f"{DIM}  可用方法: {len(methods)} 个{RESET}")

    return ws


async def send_message(
    ws: ClientConnection,
    session_key: str,
    message: str,
    show_thinking: bool = False,
    attachments: Optional[list] = None,
) -> Optional[str]:
    """发送消息并流式接收回复。

    支持通过 attachments 参数发送图片附件（与 OpenClaw Node Protocol 兼容）。

    Args:
        ws: WebSocket 连接
        session_key: 会话标识
        message: 文本消息
        show_thinking: 是否显示思考过程
        attachments: 附件列表，每项为 {type, mimeType, fileName, content} 字典

    Returns:
        最终完整回复文本，失败时返回 None。
    """
    run_id = make_id()
    req_id = make_id()

    params: dict = {
        "sessionKey": session_key,
        "message": message,
        "idempotencyKey": make_id(),
    }

    if attachments:
        params["attachments"] = attachments

    await ws.send(json.dumps({
        "type": "req",
        "id": req_id,
        "method": "chat.send",
        "params": params,
    }))

    # ── 等待 ACK ─────────────────────────────────────────────────────
    ack = None
    while True:
        raw = await ws.recv()
        frame = json.loads(raw)

        if frame.get("type") == "res" and frame.get("id") == req_id:
            ack = frame
            break
        # 忽略连接建立期间可能收到的 tick 事件
        if frame.get("type") == "event" and frame.get("event") == "tick":
            continue

    if not ack or not ack.get("ok"):
        error = ack.get("error", {}) if ack else {}
        print(
            f"\n{RED}✗ chat.send 失败: {error.get('code')} - {error.get('message')}{RESET}"
        )
        return None

    ack_payload = ack.get("payload", {})
    ack_run_id = ack_payload.get("runId", "?")

    # ── 流式接收 chat 事件 ──────────────────────────────────────────
    first_chunk = True
    _last_tool_key = ""  # 工具调用去重：避免逐 chunk 重复打印
    _text_total_len = 0  # 已输出文本总长度，用于计算增量

    while True:
        raw = await ws.recv()
        frame = json.loads(raw)

        if frame.get("type") != "event":
            continue

        event_type = frame.get("event")
        if event_type == "tick":
            continue

        if event_type != "chat":
            continue

        payload = frame.get("payload", {})
        state = payload.get("state")

        if state == "delta":
            # 文本输出 — part.text 是累积全文，只取增量部分
            msg = payload.get("message")
            if msg:
                content = msg.get("content", [])
                for part in content:
                    if part.get("type") == "text":
                        text = part.get("text", "")
                        delta = text[_text_total_len:]
                        _text_total_len = len(text)
                        if delta:
                            if first_chunk:
                                print()
                                first_chunk = False
                            print(delta, end="", flush=True)

            # 工具调用 — 只在状态变化时打印一次
            tool_calls = payload.get("toolCalls")
            if tool_calls:
                for tc in tool_calls:
                    name = tc.get("name", "unknown")
                    status = tc.get("status", "?")
                    key = f"{name}:{status}"
                    if key != _last_tool_key:
                        _last_tool_key = key
                        if first_chunk:
                            print()
                            first_chunk = False
                        print(f"\n{DIM}[工具: {name} ({status})]{RESET}", end="", flush=True)

            # 思考内容 — 默认隐藏，--verbose 开启时单行原地刷新
            thinking = payload.get("thinking")
            if thinking and show_thinking:
                if first_chunk:
                    print()
                    first_chunk = False
                print(f"\r{YELLOW}[思考]{RESET} {DIM}{thinking}\033[K{RESET}", end="", flush=True)

        elif state == "final":
            # 增量已在 delta 中输出，此处仅收尾
            msg = payload.get("message")
            final_text = ""
            if msg:
                for part in msg.get("content", []):
                    if part.get("type") == "text":
                        final_text = part.get("text", "")
            print()  # 换行
            print()  # 空行分隔
            return final_text

        elif state == "error":
            error_msg = payload.get("errorMessage", "未知错误")
            print(f"\n{RED}✗ 错误: {error_msg}{RESET}")
            return None


async def interactive_loop(host: str, port: int, show_thinking: bool = False) -> None:
    """交互式 REPL 主循环。"""
    print(f"{BOLD}{CYAN}╔══════════════════════════════════════════╗{RESET}")
    print(f"{BOLD}{CYAN}║       OpenDesk 节点协议 交互式客户端      ║{RESET}")
    print(f"{BOLD}{CYAN}╚══════════════════════════════════════════╝{RESET}")
    print()
    print(f"  网关: {YELLOW}{host}:{port}{RESET}")
    print(f"  命令: {DIM}/help /exit /new /verbose /image{RESET}")
    print()

    ws = await connect_to_gateway(host, port)
    session_key = f"node-example-{make_short_id()}"
    print(f"  会话: {YELLOW}{session_key}{RESET}")
    print()

    try:
        while True:
            try:
                user_input = input(f"{BOLD}You › {RESET}").strip()
            except (EOFError, KeyboardInterrupt):
                print(f"\n{DIM}退出.{RESET}")
                break

            if not user_input:
                continue

            # ── 内置命令 ─────────────────────────────────────────────
            if user_input == "/exit":
                print(f"{DIM}退出.{RESET}")
                break

            if user_input == "/help":
                print()
                print(f"  {BOLD}可用命令:{RESET}")
                print(f"  {YELLOW}/exit{RESET}     退出程序")
                print(f"  {YELLOW}/new{RESET}      开始新会话")
                print(f"  {YELLOW}/help{RESET}     显示帮助")
                print(f"  {YELLOW}/session{RESET}  显示当前会话标识")
                print(f"  {YELLOW}/verbose{RESET}  切换思考过程显示")
                print(f"  {YELLOW}/image <路径> [消息]{RESET}  发送图片及可选文本")
                print()
                continue

            if user_input == "/new":
                session_key = f"node-example-{make_short_id()}"
                print(f"  {GREEN}新会话: {session_key}{RESET}")
                print()
                continue

            if user_input == "/session":
                print(f"  {DIM}当前会话: {session_key}{RESET}")
                print()
                continue

            if user_input == "/verbose":
                show_thinking = not show_thinking
                state = "开启" if show_thinking else "关闭"
                print(f"  {DIM}思考过程显示: {state}{RESET}")
                print()
                continue

            # ── /image 命令：发送图片附件 ───────────────────────────────
            if user_input.startswith("/image "):
                parts = user_input[7:].strip().split(maxsplit=1)
                if not parts:
                    print(f"  {RED}用法: /image <文件路径> [可选消息]{RESET}")
                    print()
                    continue
                file_path = parts[0]
                text_msg = parts[1] if len(parts) > 1 else "请分析这张图片"
                attachment = encode_image_to_base64(file_path)
                if attachment is None:
                    continue
                print(f"  {DIM}发送图片: {attachment['fileName']} ({attachment['mimeType']}){RESET}")
                print(f"  {DIM}附带消息: {text_msg}{RESET}")
                await send_message(ws, session_key, text_msg, show_thinking, [attachment])
                continue

            # ── 发送消息并流式显示回复 ──────────────────────────────
            await send_message(ws, session_key, user_input, show_thinking)

    finally:
        await ws.close()
        print(f"{DIM}连接已关闭.{RESET}")


def parse_args() -> tuple[str, int, bool]:
    """解析命令行参数。"""
    args = sys.argv[1:]
    host = DEFAULT_HOST
    port = DEFAULT_PORT
    verbose = False

    i = 0
    while i < len(args):
        if args[i] == "--host" and i + 1 < len(args):
            host = args[i + 1]
            i += 2
        elif args[i] == "--port" and i + 1 < len(args):
            try:
                port = int(args[i + 1])
            except ValueError:
                print(f"{RED}无效端口号: {args[i+1]}{RESET}", file=sys.stderr)
                sys.exit(1)
            i += 2
        elif args[i] in ("-v", "--verbose"):
            verbose = True
            i += 1
        elif args[i] in ("-h", "--help"):
            print("用法: python3 node_example.py [--host HOST] [--port PORT] [-v]")
            print()
            print("选项:")
            print("  --host HOST    网关地址 (默认: localhost)")
            print("  --port PORT    网关端口 (默认: 18789)")
            print("  -v, --verbose  显示模型思考过程")
            print("  -h, --help     显示帮助")
            sys.exit(0)
        else:
            print(f"{RED}未知参数: {args[i]}{RESET}", file=sys.stderr)
            sys.exit(1)

    return host, port, verbose


def main() -> None:
    host, port, verbose = parse_args()

    try:
        asyncio.run(interactive_loop(host, port, show_thinking=verbose))
    except (ConnectionRefusedError, OSError) as e:
        print(
            f"\n{RED}✗ 无法连接 {host}:{port} — {e}{RESET}",
            file=sys.stderr,
        )
        print(
            f"{DIM}请确认 OpenDesk 网关已启动 (devicemgr 应用已启用){RESET}",
            file=sys.stderr,
        )
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{DIM}中断.{RESET}")
        sys.exit(0)


if __name__ == "__main__":
    main()
