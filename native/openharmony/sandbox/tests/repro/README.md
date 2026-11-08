# repro/ — devecocli 卡死复现资产

复现「沙箱内命令无输出卡死」这一历史问题（根因见 README 附录 A.3 最后一行）。

## 复现步骤

```bash
cd native/openharmony/sandbox
make all                      # 构建 build/dynobox + build/libdynobox.so

# 1) 起一个"永不响应"的上游决策端点（模拟 UI 未确认）
setsid python3 tests/stub_endpoint.py 18083 hang tests/work/stub_repro.log </dev/null >/dev/null 2>&1 &
sleep 1 && curl -s http://127.0.0.1:18083/        # {"count":0,"inflight":0,...}

# 2) 用 OpenDesk 标准模式的兜底策略（/** write = ask, timeout 330s）跑 devecocli
cd <任意 HarmonyOS 工程目录>
/path/to/sandbox/build/dynobox run \
    --policy /path/to/sandbox/tests/repro/stdmode.toml \
    --log /path/to/sandbox/tests/work/sbx_repro.log \
    -- /path/to/devecocli signature generate
```

## 修复前的现象

```
Executing signature generate command       # 到这里之后再无任何输出
Start generating p12
```

进程一直挂到 `timeout_ms` 耗尽，`tests/work/stub_repro.log` 里能看到真正的卡点：

```
REQ#1 inflight=1 {"path":"/dev/tty","access":"write","token":"stub"}
```

即 node 启动时的 `open("/dev/tty", O_WRONLY)` 被兜底写规则送去 ask 了。

## 修复后

同一命令 6 秒左右完成（`Signature generation completed successfully.`），
stub 计数不再增长，`exec 3>/dev/tty` 直接落到内核（`ENXIO`，而不是被 deny 的 `EACCES`）。

## 备注

`stub_endpoint.py` 的 `mode` 可选 `allow` / `deny` / `hang` / `delay:<ms>` / `slow:<ms>`，
`GET /` 可读当前请求计数与并发数，便于做 ask 并发/超时类实验。
