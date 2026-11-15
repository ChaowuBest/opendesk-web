# OpenDesk Web 模式

Web 模式让桌面版 OpenDesk 在服务器或容器中运行，并通过浏览器访问完整的图形界面。

## 原理

- Electron 主进程照常启动，所有 `ipcMain` 处理器保持不变；主窗口隐藏，只加载 `about:blank`。
- 同一端口提供 renderer 静态页面，并在每个 HTML 页面最前面注入 web preload（`dist/web/preload.js`）。web preload 与桌面 preload 是同一份源码（`src/renderer/preload.js`），只是把 `electron` 模块替换为 `src/renderer/web/electron-shim.ts`，`ipcRenderer` 改走 WebSocket。
- 每条浏览器连接在主进程里表现为一个 `event.sender` / `event.senderFrame`（`src/main/web/ipc-bridge.ts`），按 frame 订阅的任务流、终端输出等推送只发回对应的浏览器标签页；发往主窗口的广播则转发给所有连接。
- 原生对话框（`dialog.showOpenDialog` 等）和 `shell.openPath` / `openExternal` 会转交给触发该次 IPC 的浏览器，由网页对话框完成；浏览器中的文件通过上传落盘到服务端，再按路径交给 agent。
- `file://` 与应用自定义协议（`opendesk-app://`、`agentoffice://`）地址由 web preload 改写为同源 HTTP 代理地址。

## 启动

```bash
OPENDESK_WEB_PORT=8080 OPENDESK_WEB_TOKEN=<随机令牌> ./opendesk --no-sandbox
```

| 环境变量             | 说明                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `OPENDESK_WEB_PORT`  | 监听端口；设置后进入 web 模式                                                             |
| `OPENDESK_WEB_HOST`  | 监听地址，默认 `0.0.0.0`                                                                  |
| `OPENDESK_WEB_TOKEN` | 访问令牌。设置后首次访问 `/?token=<令牌>` 写入 Cookie，API 也可用 `Authorization: Bearer` |

未设置 `OPENDESK_WEB_TOKEN` 时服务不做认证，只应在已有上层认证（如反向代理）的环境中这样部署。

## 容器

```bash
docker build -f docker/web/Dockerfile -t opendesk-web .
docker run -d -p 8080:8080 -e OPENDESK_WEB_TOKEN=<令牌> -v opendesk-home:/home/opendesk opendesk-web
```

- 数据（设置、任务、默认工作区 `~/.opendesk/workspace`）都在 `/home/opendesk`，挂载卷即可持久化。
- 镜像以 uid 1000 的 `opendesk` 用户运行；入口脚本启动 Xvfb 供 Electron 使用，并以 `--no-sandbox` 启动（容器内通常没有 Chromium 沙箱所需的用户命名空间）。
- 存活探针：`GET /__opendesk/health`（免认证）。
- 首次访问会进入配置向导，在网页上填写模型服务即可。

## 限制

- 内置浏览器（`<webview>`）无法在普通网页中嵌入，web 模式下不可用。
- 通过 http（非 localhost）访问时浏览器不开放 Clipboard API，粘贴只能使用浏览器原生快捷键；部署在 HTTPS 后可恢复完整剪贴板能力。
- 全局快捷键、托盘、任务状态浮窗属于宿主桌面，web 模式下不启用。

## 生成式 UI

对话里的 `showUI` / `askUI` 组件在 web 模式下同样可用，详见 [generative-ui.md](./generative-ui.md)。
