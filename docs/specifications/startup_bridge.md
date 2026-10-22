# 开机自启动 bridge 边界

自启动属于操作系统状态，不写入 OpenDesk 的共享配置。设置页通过
`NativeBridgeProxy.getStartupKit()` 使用两个能力：

| 方法                                                | 职责                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `delegateSetting(enabled?: boolean): Promise<void>` | 委托系统设置。`toggle` 模式传入目标布尔值；`system-settings` 模式不传参数，打开系统管理页面。完成调用不代表系统已开启自启动。 |
| `getState(): Promise<StartupState>`                 | 查询系统实际状态，同时返回该平台的交互能力。                                                                                  |

`StartupState` 的 `enabled` 为 `true`、`false` 或 `null`（未知）。`supported` 表示该实例是否支持状态查询；
`mode` 为 `toggle` 或 `system-settings`。查询异常返回 `reason: 'unavailable'` 和未知状态，
不会将异常当作关闭；HM 仍可打开系统设置。开发/调试限制返回 `reason: 'development'`；
不支持的系统返回 `reason: 'unsupported'`。HM 的状态查询不可用时，仍允许委托打开系统设置，
两项能力不互相代替；调试实例禁止委托操作。

调用链：

```text
settingpanel → NativeBridgeProxy → window.native.call → native:call
             → NativeBridge.getStartupKit() → 平台 StartupKit → 操作系统
```

- `bridges/common.ts` 定义契约、缺省实现和实例限制/查询失败的公共处理。
- `bridges/main.ts` 选择平台，分发 `startupKit:delegateSetting` 和 `startupKit:getState`。
- `bridges/renderer.ts` 代理这两个操作；preload 复用现有 `native:call`，不增加设置专用 IPC。
- `bridges/darwin/startup.ts` 使用 Electron 登录项 API，读取系统审批结果。
- `bridges/win32/startup.ts` 使用 Electron 登录项 API，查询和设置使用同一可执行文件路径及参数，读取启动审批结果。
- `bridges/harmonyos/startup.ts` 使用壳工程的 ArkTS 查询/设置入口，保留请求 ID、响应校验和超时限制。
- `bridges/linux/startup.ts` 管理当前用户的 OpenDesk XDG autostart 文件。

设置页只依据 bridge 返回的 `mode` 显示开关或系统设置入口，不判断操作系统，不导入原生实现。
状态查询只在以下时机发生：首次进入或重新进入通用设置、开关委托完成后，以及通过按钮前往系统设置后返回且通用设置实际可见时。
打开其他设置标签、普通切回应用、设置区域重绘均不额外查询。同一次系统设置往返的焦点/可见性事件只消费一次；
查询进行中再次进入通用设置时，等待旧请求结束后补一次新查询，不并发请求。离开通用设置会丢弃旧查询的显示结果。
打开系统设置不会本地置为开启；状态查询与委托设置仍是两个独立的 bridge 操作。

HM 的一次状态查询会先在壳内发起一次系统 API 调用，并立即返回请求 ID。Node 侧先立即用这个 ID
读取壳内保存的结果；若为 `pending`，依次等待 50ms、100ms、200ms，之后每次等待 500ms 再读取。
得到完成结果后立即结束，最多等待 5 秒，最后一次等待按剩余时间截断。持续未完成时，含首次立即读取共约 13 次结果读取。
这段轮询只读取该请求的结果，不会重新调用系统状态查询 API，也不是后台定时刷新。
异步结果须仍属于当前页面且未被新操作取代，避免旧查询覆盖新状态。

平台工厂负责安装实例限制。macOS、Windows、Linux 需要正式打包；HM HAP 的目录资源可能让
Electron 报告未打包，因此只检查调试标记，不使用 `app.isPackaged` 阻断已安装 HAP。
宿主通过 `registerNativeBridge({ debug })` 传递实例上下文，不在设置业务 IPC 中处理平台差异。

单元和桥接回归不能替代安装后的系统授权检查及重新登录/重启验收。
HM 壳协议及构建依赖见 [OpenHarmony 平台说明](../platforms/openharmony.md#7-hm-pc-开机自启动)。
