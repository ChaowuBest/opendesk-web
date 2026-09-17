# 任务标题和正文搜索

## 产品边界

- 侧栏搜索框暂时只作为入口，保留外观；输入和结果展示在水平居中、顶部固定的浮层内完成。距窗口顶部 80px，窗口高度不超过 500px 时改为 48px；结果变化只向下伸展，超出可用高度时滚动结果区。
- 浮层宽度上限 560px；字号复用 `common.css` 的输入 `--fs-base`、列表 `--fs-md`、辅助文字 `--fs-sm`。圆角复用 Tailwind 的 `--radius-xl/lg/md`，间距遵循现有菜单的紧凑尺度，不新增全局设计 token。
- 本轮不增加搜索键盘快捷键。使用标准文本输入、点击选择、关闭按钮和遮罩关闭。
- 搜索标题、工作目录、用户可见的用户/助手文本（包含文本中的代码）。不索引工具输出、思考过程、附件内容及内部任务。目标补充消息使用既有可见文本投影。
- 按任务聚合。标题完全匹配、标题包含、工作目录、正文依次优先，同级按任务活动时间排序。正文结果保留消息 ID，点击后加载任务并定位、高亮消息。
- 正文片段优先展示首个命中词，前文最多占行宽的 30%，两侧上下文随可用宽度省略，窗口缩放无需重新查询。搜索词自身超过整行宽度时保留其开头高亮并省略尾部。
- 输入按不区分大小写的连续子串匹配，空白归一化；支持中文单字、双字、代码及字面标点，不解释 FTS 运算符。

## 结构与数据

`sidebar` → `TaskSearchDialog` → preload IPC → `TaskSearchService` → 独立 Worker → `TaskSearchIndex`。

索引位于应用配置目录的 `task-search-v1.sqlite`，仅是可重建缓存，原始任务 JSON 不变。

- `tasks`：标题、目录、活动时间和源文件指纹。
- `documents`：消息文本分块、消息 ID、任务 ID、原文和归一化文本。每块 4000 个 UTF-16 单元，重叠 200，覆盖允许的最长查询。
- `terms`：FTS5 倒排索引。应用层生成 1/2/3 字符编码词项，以统一覆盖中文短词和任意代码子串。只保存文档命中关系，不保存位置或分词副本。查询后用原文校验连续子串，避免 ngram 交集误报。
- 只在 SQLite 中聚合候选 ID；先选前 N 个任务，再读取其展示片段，避免排序携带全部正文。

复用现有 `better-sqlite3` 和 `node-sqlite3-wasm`，没有新增依赖。原生模块缺失/ABI 不兼容、Windows ARM64 和 OpenHarmony 使用 WASM。搜索 Worker 使用轻量 SQLite 适配，避免引入通用 storage 工厂所依赖的 Setting/日志/应用初始化链。FTS5 需要支持 contentless-delete；已声明的依赖版本提供该能力，初始化失败会明确返回搜索不可用。

## 同步和流畅性

- 启动时预热；后台读取任务清单，优先导入最近任务，逐任务事务提交并让出 Worker 执行机会。
- 文件通知触发增量检查，合并同一轮事件后检查变化任务及新增任务；任务清单变化或打开搜索浮层时触发完整指纹核对，补偿 CLI 修改、通知遗漏和中断。不使用定时扫描。
- 指纹未变不读取正文；任务文件变化后只替换发生变化的消息分块。删除、隐藏、回退通过差异同步移除旧索引。
- 文件 ID 必须与任务清单一致，读取前后检查文件状态，拒绝不一致快照。坏文件不保留过时正文；错误状态与空结果分开显示。
- 150 ms 输入防抖，输入法组词期间暂停查询。同一窗口排队请求合并，旧结果不能覆盖新输入。
- 浮层先显示同关键词缓存或标题结果，后台查询/索引未完成时展示分组 loading。Worker 缓存按索引版本失效，浮层缓存按索引通知和任务列表更新失效。
- 索引进度、内容或失败状态变化时由 Worker 经 IPC 主动通知浮层。浮层仅在打开期间订阅；关闭即退订。没有变化时不查询，不使用进度或结果轮询。正在查询时合并刷新请求，任务列表更新不能取消或推迟正文查询。首次展示 20 个任务，“显示更多”位于滚动列表末尾；点击一次后直接展开至 200 条上限。仍有更多匹配时，在列表底部提示“当前最多显示 200 条任务，建议输入更精确的内容”。按钮和提示随结果一起滚动。同一查询的索引更新保留展开状态，更换关键词恢复首批展示。
- 长历史消息定位逐批渲染并在批次间让出界面线程，关闭的任务视图不再继续定位。

- Worker 原始异常保留在内部诊断和请求错误中；无待处理请求的启动失败也记录日志，并通知浮层结束 loading，用户可显式重试。
- 搜索相关计时器只保留 150ms 一次性输入防抖及 15s 请求超时；事件合并、分批让出线程使用 setImmediate，不形成定时监听。

## 验证与限制

- Jest：`npm test -- --runInBand --runTestsByPath src/tests/ut/search/task-search.test.ts src/tests/ut/renderer/task-search-dialog.test.ts src/tests/ut/renderer/chat-navigation.test.ts`
- Worker 集成回归：`node --test src/tests/ut/node/search/task-search-worker.test.js`，真实 Worker、文件变化和 SQLite，验证主动通知及异常原因传递。
- Renderer 回归：`npm test -- --runInBand --selectProjects unit --testPathPatterns src/tests/ut/renderer`
- 片段浏览器回归（需安装 Chrome）：`OPENDESK_BROWSER_TESTS=1 PLAYWRIGHT_CHANNEL=chrome node --test src/tests/ut/node/renderer/task-search-snippet.test.js`；不指定 channel 时使用 Playwright 自带 Chromium。验证中文长前文、代码和字面 HTML、多次命中、超长搜索词及窗口缩放下的高亮可见性。
- 必须通过 `npm run build-cli`、`npm run build`、`npm run check:architecture`。
- 性能应分别记录首次索引耗时、磁盘占用、不同命中密度下的查询耗时和 UI 响应，不能用缓存命中替代首次查询测量。
- 首次索引期间结果可能不全，会明确显示进度；搜索速度不承诺所有数据量和硬件均在固定时间内完成。
- 消息定位仍依赖现有任务加载和历史渲染，超长任务可能需要更多时间；不引入新的历史存储/虚拟列表架构。
- 用户文案均接入中英文 locale。服务错误、数据库字段和图标字符属于内部诊断、协议或图形符号，不直接作为用户提示。

真实 Electron 验证使用独立临时配置及合成任务，不操作其他 worktree 中运行的应用或真实用户历史。
