#!/usr/bin/env python3
"""dynobox ask 端点的可控 stub，用于复现上游阻塞/慢响应场景。

用法：
    python3 stub_endpoint.py <port> <mode> [logfile]
mode:
    allow         立即 allow
    deny          立即 deny
    hang          收到请求后不响应（模拟 UI 未确认）直到客户端超时
    delay:<ms>    延迟 <ms> 后 allow
    slow:<ms>     每个响应 +<ms> 延迟（记录并发数）
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
MODE = sys.argv[2] if len(sys.argv) > 2 else "allow"
LOG = sys.argv[3] if len(sys.argv) > 3 else "/tmp/stub_endpoint.log"

_lock = threading.Lock()
_count = 0
_inflight = 0


def log(msg):
    with _lock:
        with open(LOG, "a") as f:
            f.write(f"{time.time():.3f} {msg}\n")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        global _count, _inflight
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace")
        with _lock:
            _count += 1
            _inflight += 1
            cur_inflight = _inflight
            cnt = _count
        log(f"REQ#{cnt} inflight={cur_inflight} {body[:200]}")

        if MODE == "hang":
            # 客户端超时前不返回；收到 0 字节也继续等
            while True:
                time.sleep(1)
        if MODE.startswith("delay:"):
            time.sleep(int(MODE.split(":", 1)[1]) / 1000.0)
        elif MODE.startswith("slow:"):
            time.sleep(int(MODE.split(":", 1)[1]) / 1000.0)

        decision = "deny" if MODE == "deny" else "allow"
        payload = json.dumps({"decision": decision}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()
        with _lock:
            _inflight -= 1
        log(f"DONE#{cnt} inflight={_inflight}")

    def do_GET(self):
        with _lock:
            body = json.dumps({"count": _count, "inflight": _inflight, "mode": MODE}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    open(LOG, "a").close()
    log(f"START port={PORT} mode={MODE} pid={os.getpid()}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
