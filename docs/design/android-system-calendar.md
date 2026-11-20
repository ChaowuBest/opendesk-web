# 系统日历与 CalendarKit

本文说明 Core 的系统日历合同、业务调用链和宿主接入边界。Android 的 CalendarProvider、Java 权限及环回传输实现位于独立的 OpenDesk-Android 壳仓，具体原生行为见壳仓 `docs/system-calendar.md`。具体版本的构建、测试和设备验收范围以壳仓对应交付报告为准；本文说明接口和生命周期，不代替真机验收。

## 分层与平台支持

所有平台的 `CalendarApplication.getWorkerClass()` 都返回同一个 `CalendarWorker`。本地日历、系统日历合并、默认目标、错误本地化和应用事件均在这一个业务 Worker 中处理。平台差异通过 `getPlatform().getNativeBridge().getCalendarKit()` 获取的 Kit 表达；业务层不按 Android 标记选择 Worker，也不解析平台事件 UID。

| 层次             | 职责                                                           | 代码位置                                           |
| ---------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| 公共原生合同     | CalendarKit、事件、日历、权限状态、变更监听                    | `src/platforms/bridges/common.ts`                  |
| NativeBridge     | 为当前进程提供稳定的 CalendarKit 实例                          | `src/platforms/bridges/*`                          |
| 日历业务         | 本地 NeDB、查询合并、读写路由、配置与应用事件                  | `src/main/applications/calendar/service/worker.js` |
| 应用入口         | 提供 GUI 配置/授权方法及 Skill 工具                            | `src/main/applications/calendar/app.js`            |
| Android 原生适配 | AndroidNativeBridge、AndroidCalendarKit、Java CalendarProvider | 独立 Android 壳仓                                  |
| GUI              | 展示日程与状态，通过 applicationAPI 调用应用业务               | `src/main/applications/calendar/renderer/entry.js` |

Android 宿主提供实际 CalendarKit。macOS、Windows、Linux、OpenHarmony 在本轮使用 `NaiveCalendarKit`，尚未实现各自的原生日历接入。它返回 `supported: false`，`ownsEvent()` 返回 false，监听返回空清理函数，原生日历读取、授权和写入方法明确拒绝。原有本地日历及桌面 Outlook 业务继续保留；Windows 的 Outlook COM 导入不是 CalendarKit 的系统日历实现。

`NaiveNativeBridge` 和 renderer 的 `NativeBridgeProxy` 都保存稳定的 NaiveCalendarKit 实例。renderer 不通过此入口代理真实系统日历，不新增直接的 CalendarKit GUI IPC。Kit 在平台实例完成安装后由业务实例获取，不在模块顶层缓存平台能力。

## 公共合同

公共类型在 `src/platforms/bridges/common.ts` 中定义，不反向依赖日历应用类型：

```ts
interface CalendarKit {
    getState(): Promise<CalendarKitState>;
    requestAccess(): Promise<void>;
    listEvents(startTime: number, endTime: number): Promise<CalendarEvent[]>;
    addEvent(calendarId: string, item: CalendarEventInput): Promise<CalendarEvent>;
    updateEvent(uid: string, updates: CalendarEventUpdates): Promise<CalendarEvent>;
    deleteEvent(uid: string): Promise<{ deleted: boolean; uid: string }>;
    ownsEvent(uid: string): boolean;
    onDidChange(listener: (change: CalendarKitChange) => void): () => void;
}
```

- `CalendarKitState` 包含 `supported`、`readGranted`、`writeGranted`、`calendars` 及可选 `revision`。`NativeCalendar` 包含字符串 id、名称、账户名、可写性和可选的可见/主日历属性。
- `CalendarEvent` 包含不透明的 `uid` 和独立的 `calendarId`，以及标题、地点、开始/结束时间、全天、取消、分类、可写和重复属性。时间使用 epoch 毫秒。
- `ownsEvent(uid)` 只判断该 Kit 是否拥有这种标识，不表示事件仍存在、当前授权有效或允许修改。实际操作必须重新检查权限、目标归属和冲突。
- `requestAccess()` 表示宿主受理授权 UI 请求，不等于用户已授予权限。完成后通过状态查询或变更通知确认结果。
- `onDidChange()` 返回幂等且只清理本监听者的 disposer。通知是重新查询的信号，不是事件数据，也不是持久化消息队列。

系统返回的 UID 原样保留。Worker 将 `CalendarEvent.calendarId` 映射为业务项的 `sourceCalendarId`，添加 `source: 'system'`；本地项保持本地结构。源身份判断由 Kit 完成，Core 不从字符串前缀或分隔符推导日历 ID。

## 读取、写入与错误

GUI 的 `applicationAPI.call()`、Skill 的 `CalendarApplication.callWorker()` 和 TUI 的日历查询都进入同一个 CalendarWorker：

```text
共用日历 GUI / Calendar Skill / TUI
→ ApplicationRegistry.callWorker('calendar', 方法, 参数)
→ CalendarWorker
  → 本地 NeDB
  → 当前 NativeBridge 的 CalendarKit
→ 合并业务日程或返回明确错误
```

本地日程仍写 `apps/calendar/calendar.db`。已启用且获读权限时，查询合并本地与系统日程；系统行不复制到 NeDB。修改、删除先通过 `ownsEvent(uid)` 决定交给 Kit 还是本地数据库。新建仅由配置的默认目标决定：空 ID 写本地，非空 ID 写指定系统日历；系统目标写失败不回退为本地成功。

未支持、未授权或关闭系统读取时，本地日历仍可初始化和查询。已经发起的原生查询失败、非法响应或写失败必须返回错误，不将其替换为成功的空数组。Skill 检查应用响应状态，错误进入工具失败状态。Worker/Registry 保留结构化错误码，GUI 在错误码缺失的路径也将已知消息转为本地化说明。

系统日历的重复、可写和账户属性由 Kit 返回并在写入时重新检查。业务展示元数据不能代替平台校验，`ownsEvent()` 也不能证明数据版本未变。

## 配置和 GUI

配置位于 `applications.calendar.dataSources.systemCalendar`：

```json
{
    "enabled": true,
    "defaultCalendarId": ""
}
```

`enabled` 默认 true；`defaultCalendarId` 默认空字符串，保留新日程写本地的行为。迁移不重置设备上已选择的目标。日历应用提供三个共用主进程方法：

| 方法                                  | 行为                                                               |
| ------------------------------------- | ------------------------------------------------------------------ |
| `getCalendarIntegrationState()`       | 返回 Kit 状态与当前应用配置合并后的平面对象                        |
| `requestCalendarAccess()`             | 通过业务 Worker 请求 Kit 授权，然后返回当前状态                    |
| `configureCalendarIntegration(patch)` | 只更新日历应用的系统日历配置，保留 Outlook 等其他字段并同步 Worker |

GUI 通过 `applicationAPI.callMainWorld()` 使用这些方法。它不直接取得 Kit，不根据操作系统名称判断支持程度。`supported: false` 时不显示集成条。用户显式点击授权按钮后才请求授权；“显示系统日历”和“新日程保存到”只保存应用配置，不代替系统权限。

默认目标包含本地及系统日历，只读目标不可选；已选目标暂不可用时明确显示不可用，不伪装成本地默认。重复系统日程和只读系统日历条目禁用编辑、删除及拖动。查询失败保留已有日程，并显示友好错误。

GUI 在应用事件及 focus、visibilitychange、pageshow 后重查状态与日程。状态、日程查询分别使用请求序号和组件生命周期检查，防止旧月份结果或旧错误覆盖当前查询。标题、地点、日历名称及事件属性进入 HTML 模板时均作为纯文本转义。

## 变更通知与生命周期

业务 Worker 订阅本实例当前 Kit 的 `onDidChange`，将变化合并为声明过的 `calendarItemsChanged` 应用事件。该事件经 Registry 同时通知 GUI、应用事件监听者及 `todomgr.handleApplicationEvent`。GUI 随后按当前范围查询，todomgr 按已配置的应用事件触发器处理。

```text
原生 Provider / 权限与恢复变化
→ 宿主 CalendarKit.onDidChange
→ CalendarWorker
→ emitEvent('calendarItemsChanged')
→ ApplicationRegistry
→ GUI 订阅者 / 应用监听者 / todomgr
```

Worker 拥有 Kit 的精确订阅 disposer、变更合并定时器、Outlook 同步定时器及本地提醒定时器；退出或重建时必须配对清理。Kit 在每个进程/Worker 中独立构造，函数对象不通过 Worker IPC 传送。

Android 主桥收到 Java 变化后，先发布本进程的 Kit 变化，再通过壳私有消息 `{ type: '__opendesk_android_calendar_changed', change: { revision? } }` 转发到全局 Worker 的 Kit。该消息不带 `bundleName`。Core 通用 Worker 请求分发器忽略没有应用 bundleName 的消息，不承担 Android 通知协议。AndroidKit 在首个订阅时安装自己的 parentPort 监听，在最后一个订阅释放时移除；重复初始化不能累计监听或业务定时器。

Java 的 Application context 单例和 ContentObserver 是另一个生命周期边界：有读取权限时注册，权限撤销时注销，Activity 重建不会创建额外的观察者。释放某个 Node Kit 监听者不等于销毁 Java 单例；Java 侧的具体约束由壳文档说明。

通知不直接伪造 renderer 事件，不承诺重放后端退出期间的每次变化。恢复后的状态和范围查询仍读取真实 Provider。正常状态查询不能持续制造变化通知，Kit 变化也不表示 GUI 已完成刷新。

## 数据所有权与限制

| 数据/能力              | 所有者与边界                                                     |
| ---------------------- | ---------------------------------------------------------------- |
| 本地日程、分类、提醒   | 原 NeDB 和 CalendarWorker 的本地业务                             |
| 系统日程和账户         | 操作系统 CalendarProvider；只在读取时合并，不写本地镜像          |
| 权限和系统日历可写等级 | Kit 和原生系统实时校验；配置不能授予权限                         |
| 账户同步、系统提醒     | 操作系统及账户组件；本轮不创建账户、Reminders 或参与人记录       |
| Outlook 导入           | 保留桌面业务；Android 不执行 Outlook COM，即使导入的配置开启该项 |

全天日期在界面按本地日历日处理，结束时间为排他的下一个午夜。新建使用本地 `new Date(y, m, d + 1)`；编辑多日全天保留原日历天数，改标题不缩短事件，改日期也不以固定 24 小时推算跨 DST 的结束时间。

Android Kit 支持普通与全天事件的查询、添加、修改和删除；重复事件读取但不编辑系列或单次例外。系统事件不承载 OpenDesk 分类，系统表单仅提供“未分类”，发送空 type；非空分类明确报错。本地分类功能保留。

本轮没有实现参会者、会议邀请响应、附件、重复规则编辑、系统提醒配置和独立的事件时区选择 UI。共用 GUI 仍主要按开始日期组织格子，没有展开多日事件在每个日期格的可视铺排。其他操作系统没有因增加公共合同而自动具备系统日历功能。

## 为另一宿主实现 CalendarKit

新宿主在自己的 NativeBridge 中提供稳定的 CalendarKit，按公共事件合同返回独立 calendarId，并在 ownsEvent 中识别自身 UID。实现六个状态/授权/读写方法以及变化订阅，负责本机权限、日历写权限、日期转换、取消/重复规则、身份冲突和错误语义。

能力必须在业务 Worker 初始化前装到该进程的原生桥；主进程与 Worker 各自获得实例，并由宿主完成它们之间的变化转发。订阅须有精确、幂等的生命周期清理。通用 CalendarWorker、GUI、Skill 和应用事件合同可直接复用，不需要为平台另建日历应用或在 Core 中解析平台 UID。

实现和验收完成前返回 NaiveCalendarKit。renderer 继续保持业务应用 API，不为新宿主直接暴露 CalendarKit 的读写和监听。

## 验证范围

回归范围包括公共 Kit 与 renderer 稳定 Naive 占位、原生 dispatcher、共用 Worker、日历 RPC 和 Outlook 边界，以及重复初始化、数据库或 Kit 等待期间 finalize、旧 Kit 等待期间重建、换桥清理旧变更定时器。GUI 回归还应覆盖配置、通知、XSS、查询交错和全天 DST 行为。

具体版本的构建、测试和设备验收范围以壳仓对应交付报告为准；本文说明接口和生命周期，不代替真机验收。报告应记录对应源码与产物、真实 CalendarProvider CRUD、外部应用变化、权限撤销及未覆盖边界。
