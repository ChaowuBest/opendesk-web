# Telemetry 架构

本文说明 OpenDesk 当前遥测系统的代码结构、初始化流程、插桩模型、数据路由和协议扩展方式。
文档描述的是当前实现，同时单独标注尚未统一的调用链，避免将目标架构与现状混淆。

## 设计目标

OpenDesk 的遥测层遵循以下原则：

- AI Kernel 只依赖协议无关的插桩接口，不直接判断 Langfuse 或 OpenTelemetry 是否启用。
- 全进程只创建一个 OpenTelemetry `NodeTracerProvider`，由不同的 Span Processor 负责协议导出。
- Langfuse 和通用 OpenTelemetry 数据通过 Span 类型过滤隔离，避免同一份数据进入错误的后端。
- 业务语义插桩与底层技术操作插桩分开，分别表达 Agent 执行过程和组件内部执行过程。
- 协议的配置解析、实现注册、资源刷新和关闭由各协议自己的 `init.ts` 管理。
- 未启用遥测或没有安装插桩实现时，业务逻辑仍可正常执行。

## 目录结构

```text
src/main/telemetry/
├── index.ts                         # 顶层生命周期：初始化、重载、关闭
├── protocol.ts                      # 协议接口及协议插桩装配
├── agent-execution.ts               # Agent 业务语义插桩接口与注册表
├── operation.ts                     # 通用技术操作及其注册表
├── local-telemetry.ts               # 独立的本地 Token 用量统计
├── langfuse/
│   ├── init.ts                      # Langfuse 初始化、Processor 和生命周期
│   ├── config.ts                    # Langfuse 运行配置解析
│   ├── agent-execution.ts           # Langfuse Agent 插桩实现
│   ├── observations.ts              # Langfuse observation 生命周期
│   └── task-format.ts               # Langfuse 输入、输出和工具数据格式化
└── opentelemetry/
    ├── init.ts                      # 全局 Provider、OTLP Exporter 和 Processor
    ├── agent-execution.ts           # OpenTelemetry Agent 插桩实现
    ├── operation.ts                 # OpenTelemetry 技术操作插桩实现
    ├── tracing.ts                   # tracer 和 withSpan 基础能力
    └── startup-tracer.ts            # 启动阶段 tracer
```

公共文件只定义协议中立的模型。Langfuse SDK 相关代码位于 `langfuse/`，OpenTelemetry SDK
相关代码位于 `opentelemetry/`。

## 整体架构

```text
                              ┌──────────────────────────┐
                              │       Telemetry 配置      │
                              │ Langfuse / OpenTelemetry │
                              └────────────┬─────────────┘
                                           │
                                    initTelemetry()
                                           │
                  ┌────────────────────────┴───────────────────────┐
                  │                                                │
          Langfuse init                                  OpenTelemetry init
          ├─ Agent 插桩                                  ├─ Agent 插桩
          └─ 每端点一个 LangfuseSpanProcessor             ├─ Operation 插桩
                                                         └─ 全局唯一 Provider
                  │                                                │
                  └────────────────────────┬───────────────────────┘
                                           │
                    ┌──────────────────────┴─────────────────────┐
                    │                                            │
          AgentExecution Registry                    TelemetryOperation Registry
          ├─ task.turn                               ├─ llm.ask / streamComplete
          ├─ 正常对话模型请求                         ├─ adapter / HTTP
          └─ tool                                    └─ retry / 底层执行
                    │                                            │
                    └──────────────────────┬─────────────────────┘
                                           │
                                NodeTracerProvider
                                           │
                         ┌─────────────────┴──────────────────┐
                         │                                    │
              Langfuse Observation                    普通 OTel Span
                         │                                    │
             LangfuseSpanProcessor(s)              OTLP BatchSpanProcessor(s)
                         │                                    │
                 Langfuse Endpoints                     OTLP Endpoints

本地 Token 用量：
onUsage ──> 本地 usage event 文件 + Task usage_summary

当前缺口：
任务命名 / 终止判断 ──> LLM.ask ──> OTel Operation
                               └──> 未进入 Agent 模型 Hook，
                                    不产生 Langfuse LLM.__call
```

## 初始化与生命周期

`initTelemetry()` 是统一入口，按以下顺序初始化：

1. 通过 `TelemetrySchema` 解析 `Setting` 中的遥测配置。
2. 调用 `initLangfuse()`。为每个已启用且密钥完整的端点创建一个 `LangfuseSpanProcessor`，并创建
   一份共享的 Langfuse Agent 插桩。
3. 调用 `initOpenTelemetry()`，将 Langfuse 的 Processor 集合作为一个协议集成传入。
4. `initOpenTelemetry()` 创建唯一的 `NodeTracerProvider`、上下文管理器和所有 Span Processor。
5. 将 Provider 绑定给 Langfuse tracing SDK。
6. 将每个协议提供的插桩实现安装到两个公共注册表。

即使只启用 Langfuse，也由 `initOpenTelemetry()` 创建共享 Provider。Langfuse 本身不维护第二个
Provider。

应用退出时，`shutdownTelemetry()` 会先清空公共注册表，再按初始化的相反顺序关闭协议资源。
配置变更时，`reloadTelemetry()` 先完整关闭旧实例，再使用新配置重新初始化，避免旧 Processor
继续持有连接或缓存。

CLI、GUI 和 OpenCode Server 模式都必须在 AI Kernel 开始工作前完成 `initTelemetry()`，否则
早期创建的任务和模型调用会使用 no-op tracer，无法在初始化后补报。

## 两类公共插桩

### AgentExecutionInstrumentation

`AgentExecutionInstrumentationRegistry` 描述 Agent 执行过程中的业务语义：

| 接口                 | 语义                       | 当前调用位置                  |
| -------------------- | -------------------------- | ----------------------------- |
| `aroundTaskTurn`     | 一个任务轮次的完整生命周期 | `TaskState.processTaskTurn()` |
| `aroundModelRequest` | 正常对话中的一次模型请求   | `task/completion.ts`          |
| `recordToolCall`     | 一次工具调用及其结果       | Task 工具执行流程             |

注册表使用 middleware 链组合多个协议实现。当前顺序为 Langfuse、OpenTelemetry，任一协议未启用
时不会进入相应实现。模型 Hook 还支持逐层合并 HTTP Header，用于向下游传播 trace 和 observation
上下文。

入口附加的外部上下文通过 `submitUserMessage` 参数显式传给对应的 `processTaskTurn`，Task 不暂存
“下一轮”遥测状态。这样每份请求上下文与具体 turn 一一对应，并发或连续提交不会相互覆盖。

### TelemetryOperation

`TelemetryOperationRegistry` 描述组件内部的技术操作。业务组件只创建操作名称、属性和生命周期，
不直接创建特定协议的 Span。

目前主要包括：

- `llm.ask`
- `llm.complete`
- `llm.streamComplete`
- Adapter 调用
- HTTP 请求
- 重试和底层执行阶段

当前只有 `OpenTelemetryOperationInstrumentation` 实现了这一接口，因此通用 Operation 会产生
OTel Span，但不会自动产生 Langfuse generation。

`TelemetryOperation` 可以在执行期间追加属性或标记错误。协议实现通过 `attach()` 订阅变化，
因此调用方不需要持有原生 OTel Span。

### Hook 执行边界

`aikernel/hooks.ts` 只负责业务 Hook 的注册、排序和执行，不依赖 Telemetry。用于观测 Hook 耗时的
`hook.*` 技术 Operation 位于 `TaskState` 实际调用 Hook 的位置，而不是由 Hook 注册表转发。

工具 Observation 同样在 `TaskState.processToolCall()` 的执行收尾阶段记录。此时工具状态、结果以及
`afterToolCall` 的后处理均已完成，同时成功、拒绝、校验失败和执行异常都能被覆盖。

## 单 Provider 与数据隔离

共享 Provider 同时安装以下 Processor：

- 每个已启用 OTLP Endpoint 对应一个 `BatchSpanProcessor`。
- 每个已启用的 Langfuse Endpoint 对应一个 `LangfuseSpanProcessor`。

Processor 外层使用过滤器隔离数据：

```text
Langfuse SDK 创建的 Span
  └── isLangfuseSpan(span) = true
      └── 只进入 LangfuseSpanProcessor

普通 OpenTelemetry Span
  └── isLangfuseSpan(span) = false
      └── 只进入 OTLP BatchSpanProcessor
```

因此，共享 Provider 的目的是统一上下文传播和资源管理，并不表示一条 Span 会同时发送给所有
后端。Langfuse observation 不会进入普通 OTLP Endpoint，普通技术 Span也不会进入 Langfuse。

当只启用 Langfuse、未配置 OTLP Endpoint 时，普通 OTel 技术 Span仍可被创建，但没有接受它的
Processor，最终不会导出。这正是当前辅助 `LLM.ask` 在 Langfuse 中不可见的原因之一。

## 正常对话的数据结构

### Langfuse

正常对话经过 `aroundTaskTurn()` 和 `aroundModelRequest()`，大致形成以下 observation 树：

```text
task.turn
└── session.llm.ai.streamText
    └── session.llm.ai.streamText.doStream
        ├── LLM.__call             generation
        └── <tool name>            tool
```

- `task.turn` 保存任务输入、最终输出、工作区、模型、Provider 和执行结果。
- `streamText` 与 `doStream` 表达 AI SDK 流式调用层次。
- `LLM.__call` 保存模型输入、输出、模型名称和 Token 用量。
- 工具 observation 保存工具名、参数、结果、状态和调用 ID。
- observation 输入和输出受 `max_payload_chars` 限制，超出部分会截断。
- 活跃的 task turn 上下文按 `taskId` 保存在 Telemetry 层，业务代码不持有 Langfuse SDK 对象。

当任务实际模型 Provider 为 `myagent` 时，`recordGenerations` 为 `false`，OpenDesk 不创建自己的
`LLM.__call`，避免与 myagent/OpenCode 下游生成的模型 observation 重复。`task.turn` 和工具
observation 仍会记录。

### OpenTelemetry

OpenTelemetry Agent 插桩当前创建 `task.turn` 业务 Span；模型、Adapter、HTTP 和重试等细节由
Operation 插桩创建。典型结构为：

```text
task.turn
└── llm.streamComplete
    ├── adapter
    ├── llm.http_request
    └── retry / execution stage
```

实际父子层次取决于调用时的活跃 OTel Context。`withSpan()` 负责设置活跃上下文、记录异常状态并
结束 Span。

## 调用时序

### 正常对话

```text
TaskState
  └─> aroundTaskTurn
      ├─> Langfuse：开始 task.turn
      └─> OpenTelemetry：开始 task.turn
          └─> completion.ts
              └─> aroundModelRequest
                  ├─> Langfuse：开始 streamText / doStream
                  └─> LLM.streamComplete
                      └─> Operation Registry：记录 llm.streamComplete
                          └─> Adapter 执行模型请求

模型返回后：
Langfuse 创建 LLM.__call
  └─> 结束 streamText / doStream
      └─> 结束 task.turn
```

### 任务命名和终止判断

任务命名和对话终止判断直接调用 `LLM.ask()`：

```text
任务命名 / 终止判断
  └─> LLM.ask
      └─> Operation Registry
          └─> OpenTelemetry：记录 llm.ask
              └─> Adapter.completeText

该调用没有经过 aroundModelRequest，因此不会创建 Langfuse LLM.__call。
```

任务命名还采用异步并发方式启动，可能早于当前 `task.turn` observation 建立。终止判断通常位于
`task.turn` 生命周期内，但由于调用的是 `LLM.ask()`，仍然只进入 Operation 插桩。

## 配置

配置文件中的结构如下：

```yaml
telemetry:
    opentelemetry:
        endpoints:
            - name: local-collector
              url: http://localhost:4318/v1/traces
              protocol: opentelemetry
              enabled: true
    langfuse:
        endpoints:
            - name: langfuse-cloud
              protocol: langfuse
              enabled: true
              base_url: https://cloud.langfuse.com
              public_key: pk-lf-...
              secret_key: sk-lf-...
              export_mode: batched
              flush_at: 50
              flush_interval_seconds: 5
        environment: development
        max_payload_chars: 20000
```

Langfuse 可以同时启用多个配置文件端点。

当 `LANGFUSE_ENABLED=true` 且环境变量中的公钥、私钥完整时，环境变量会创建一个独立端点，
与配置文件中各自启用的端点同时生效。`LANGFUSE_ENABLED=false` 只禁用环境变量端点，不会关闭
配置文件端点。相同 `base_url + public_key` 的端点只初始化一次。

| 环境变量                       | 含义                                            |
| ------------------------------ | ----------------------------------------------- |
| `LANGFUSE_ENABLED`             | 是否启用环境变量端点                            |
| `LANGFUSE_BASE_URL`            | 环境变量端点的 Langfuse 服务地址                |
| `LANGFUSE_PUBLIC_KEY`          | 环境变量端点的项目公钥                          |
| `LANGFUSE_SECRET_KEY`          | 环境变量端点的项目私钥                          |
| `LANGFUSE_TRACING_ENVIRONMENT` | tracing 环境名称，优先于 `LANGFUSE_ENVIRONMENT` |
| `LANGFUSE_ENVIRONMENT`         | 环境名称                                        |
| `LANGFUSE_EXPORT_MODE`         | 环境变量端点使用 `immediate` 或 `batched`       |
| `LANGFUSE_MAX_PAYLOAD_CHARS`   | 单个字符串字段的最大字符数                      |
| `LANGFUSE_FLUSH_AT`            | 环境变量端点批量发送前累计的 Span 数量          |
| `LANGFUSE_FLUSH_INTERVAL`      | 环境变量端点批量发送最长等待时间                |

`environment` 和 `max_payload_chars` 是所有 Langfuse 端点共享的观测属性；对应环境变量可覆盖
这两个公共值。环境变量不改变模型 Provider 的选择。模型 Provider 是否为 `myagent` 只影响
OpenDesk 是否记录自己的 Langfuse generation。

## 本地用量统计

`local-telemetry.ts` 不属于远程 tracing 协议，也不经过共享 Provider。它通过模型请求的
`onUsage` 回调：

- 更新任务自身的 `usage_summary`；
- 将标准化后的 Token 用量追加到本地按日期组织的 event 文件；
- 提供按任务和时间聚合本地用量的基础数据。

本地用量统计与 Langfuse、OTLP 可以同时工作，任何一方未启用都不影响本地统计。

## 新增协议

新增遥测协议时，应按以下边界实现：

1. 在独立目录中创建协议的 `init.ts`，负责配置解析、SDK 对象创建、刷新和关闭。
2. 根据协议需要实现 `AgentExecutionInstrumentation`、`OperationInstrumentation` 或两者。
3. 从 `init.ts` 返回 `TelemetryProtocol`，不要在 AI Kernel 中直接注册协议实现。
4. 在 `telemetry/index.ts` 中按协议完成初始化和装配。
5. 如果协议复用全局 OTel Provider，应提供自己的 Span Processor 和明确的 Span 接受条件。
6. 如果协议需要向下游传播 Header，应通过 `aroundModelRequest()` 的 `next(headers)` 返回追加项。
7. 禁止在公共文件中引入协议 SDK 类型，公共上下文只使用 TypeScript 基础类型和 `unknown`。

如果新协议需要观察所有模型调用，当前仅实现 `AgentExecutionInstrumentation` 还不够，因为任务
命名、终止判断等辅助请求尚未经过 Agent 模型 Hook。应先扩展统一的协议中立模型调用上下文，
再由各协议决定如何映射为 generation 或 Span。

## 当前限制与后续方向

当前架构仍有以下已知限制：

1. `aroundModelRequest()` 只覆盖正常对话的 `completion.ts` 调用。
2. `LLM.ask()`、`LLM.complete()` 与 `LLM.streamComplete()` 尚未共享统一的模型请求 Hook。
3. 任务命名和终止判断不会产生 Langfuse `LLM.__call`。
4. 任务命名异步启动时可能尚未建立 `task.turn` 上下文。
5. OpenTelemetry 的 `aroundModelRequest()` 当前不创建额外 Span，主要依赖 Operation 插桩。
6. Langfuse 当前没有实现通用 `OperationInstrumentation`。

后续重构宜将模型调用插桩下沉到统一 LLM 边界，并在请求上下文中显式携带：

- `taskId` 和 `turnId`；
- 调用用途，例如 `conversation`、`task.generate_name`、`task.termination_check`；
- 模型和 Provider；
- 输入、输出和 usage 获取方式；
- 外部 trace context；
- 是否允许当前进程记录 generation。

完成后，正常对话和辅助模型请求可以使用同一个协议中立 Hook，同时继续由 Langfuse 和
OpenTelemetry 各自决定数据名称、层次和导出方式。
