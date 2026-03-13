# Agent Skill 测试框架：设计说明与使用说明

本文档描述 OpenDesk 在**官方 Agent Skill 协议**基础上的**自测试扩展**：目录约定、配置格式、测试类型与执行方式，以及如何编写与运行测试。

---

## 1. 与官方 Skill 协议的关系

- **技能本体**遵循 [Agent Skills 行业标准](https://agentskills.io/specification)（如 `SKILL.md`、`scripts/`、`references/`、`assets/`）。
- **测试能力**为 OpenDesk 扩展：在技能根目录下增加 **`tests/`** 目录，不改变技能被发现与调用的方式；未提供 `tests/` 的技能仍按标准协议工作。

因此：  
**技能目录 = 标准 Skill 结构 + 可选的 `tests/` 自测套件。**

---

## 2. 测试目录结构（扩展约定）

```
skill-name/
├── SKILL.md              # 技能定义（必需，标准协议）
├── scripts/              # 可执行脚本（可选，标准协议）
├── references/           # 参考文档（可选，标准协议）
├── assets/               # 资源文件（可选，标准协议）
└── tests/                # 【扩展】测试目录
    ├── TEST.md           # 测试配置文件（YAML frontmatter + 说明）
    ├── README.md         # 可选：测试套件说明、运行方式、故障排除
    ├── cases/            # 测试用例目录
    │   ├── environment.test.js
    │   ├── basic.test.js
    │   ├── integration.test.js
    │   └── stability.test.js
    └── fixtures/         # 可选：测试数据、脚本、示例文件
        ├── sample_fields.json
        └── create_test_pdf.js
```

- **TEST.md**：必选；用于声明测试框架版本、超时、环境依赖等。
- **cases/**：必选；存放 `*.test.js` / `*.spec.js`（支持 `.js`、`.mjs`、`.cjs`）。
- **fixtures/**：可选；供用例通过 `process.env.SKILL_DIR` 定位并读取。

---

## 3. TEST.md 配置格式

### 3.1 YAML Frontmatter 示例

```yaml
---
version: "1.0"
minOpenDeskVersion: "0.1.0"
timeout: 300
requires:
  node: ">=18.0.0"
  os: ["win32", "darwin", "linux"]
  tools: ["python"]
  memory: "2GB"
  disk: "500MB"
---
```

### 3.2 配置字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| version | string | 是 | - | 测试框架版本，当前为 `"1.0"` |
| minOpenDeskVersion | string | 否 | - | 最低 OpenDesk 版本要求 |
| timeout | number | 否 | 300 | 单个测试用例超时时间（秒） |
| requires.node | string | 否 | - | Node.js 版本要求，如 `">=18.0.0"` |
| requires.os | string[] | 否 | - | 支持的操作系统：`win32` / `darwin` / `linux` |
| requires.tools | string[] | 否 | - | 需要的外部工具（如 `python`、`git`） |
| requires.memory | string | 否 | - | 最低内存要求，如 `"2GB"` |
| requires.disk | string | 否 | - | 最低磁盘空间要求，如 `"500MB"` |

Frontmatter 之后可写 Markdown 说明（依赖说明、测试覆盖范围等），执行器仅解析 frontmatter。

---

## 4. 测试类型与用例发现

框架将 **cases/** 下符合命名规则的文件识别为测试用例，并按**类型**排序执行。

### 4.1 类型与命名规则

| 类型 | 说明 | 文件名约定（含关键字即可） |
|------|------|----------------------------|
| environment | 环境检测：运行时环境、依赖、目录与文件完整性 | `environment`、`env` |
| functional | 功能测试：SKILL.md 格式、脚本可执行性、基础能力 | 默认（未匹配其他类型时） |
| integration | 集成测试：脚本与库的联合使用、端到端流程 | `integration`、`e2e` |
| stability | 稳定性：边界条件、并发、异常与资源 | `stability`、`stress` |

- 支持的文件名示例：`environment.test.js`、`basic.test.js`、`integration.test.js`、`stability.test.js`。
- 类型推断规则：文件名包含上述关键字即归入对应类型；否则归为 `functional`。
- 执行顺序固定为：**environment → functional → integration → stability**。

### 4.2 测试执行环境变量

运行每个用例时，运行器会注入：

| 变量 | 说明 |
|------|------|
| SKILL_DIR | 技能根目录的绝对路径 |
| TEST_TYPE | 当前用例类型：`environment` / `functional` / `integration` / `stability` |
| NODE_ENV | 固定为 `test` |

用例内通过 `process.env.SKILL_DIR` 访问技能目录；fixtures 路径一般为  
`path.join(process.env.SKILL_DIR, 'tests', 'fixtures', '...')`。

### 4.3 退出码约定

- **0**：测试通过。
- **非 0**：测试失败；运行器会收集 stdout/stderr 并标记该用例为失败。

---

## 5. 测试用例编写规范

### 5.1 基本要求

- 可执行入口为单个脚本（由 Node 以 `node <用例文件>` 方式运行）。
- 通过 `process.exit(0)` 表示通过，`process.exit(1)`（或其它非 0）表示失败。
- 可用 `console.log` / `console.error` 输出信息，运行器会捕获并展示。

### 5.2 推荐结构

- 使用 `require` 或 `import` 使用 Node 内置模块（`path`、`fs`、`child_process` 等）或第三方断言库。
- 异步逻辑用 `async/await` 或 Promise，在全部检查完成后再 `process.exit(0)` 或 `process.exit(1)`。
- 失败时建议先 `console.error('FAIL: ...')` 再 `process.exit(1)`，便于运行器解析失败原因。

### 5.3 使用 fixtures

```javascript
const path = require('path');
const fs = require('fs');
const skillDir = process.env.SKILL_DIR;
const fixturePath = path.join(skillDir, 'tests', 'fixtures', 'sample.json');
const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
```

### 5.4 自定义断言

可使用任意 Node 断言库，例如：

```javascript
const assert = require('assert');
assert.strictEqual(actual, expected);
// 或
const { expect } = require('chai');
expect(result).to.be.true;
```

---

## 6. 运行方式

### 6.1 OpenDesk TUI 内

- 打开技能测试界面：`/skills test`
- 直接运行指定技能：`/skills test <skill-name>`（例如 `/skills test pdf`）

在 TUI 中可查看环境检查结果、各用例通过/失败、耗时及输出摘要。

### 6.2 命令行（手动）

在具备 Node 环境且技能已部署到应用数据目录的前提下，可单独执行某个用例：

```bash
# Windows 需确保 PATH 已包含 Python 等依赖
set SKILL_DIR=C:\Users\...\AppData\Roaming\opendesk\apps\skills\resources\pdf
set TEST_TYPE=environment
set NODE_ENV=test
node "%SKILL_DIR%\tests\cases\environment.test.js"
```

成功则进程退出码为 0，失败为非 0。

### 6.3 执行流程概览

1. 解析技能目录下 **tests/TEST.md** 的 frontmatter，得到超时与 `requires`。
2. 根据 **requires** 做环境预检：Node 版本、OS、外部工具等（用于报告，不阻止执行）。
3. 扫描 **tests/cases/** 下 `*.test.js` / `*.spec.js`（.js/.mjs/.cjs），按类型排序。
4. 依次以 `node <用例文件>` 运行，注入 `SKILL_DIR`、`TEST_TYPE`、`NODE_ENV`，并应用 **timeout**。
5. 根据退出码和输出汇总结果；超时或子进程异常记为失败/错误。

---

## 7. 实现要点（与 skillmgr 一致）

- **配置**：仅解析 **TEST.md** 的 YAML frontmatter（第一组 `---...---`）。
- **发现**：仅识别 **cases/** 下扩展名为 `.js`/`.mjs`/`.cjs` 且文件名包含 `.test.` 或 `.spec.` 的文件。
- **类型**：由文件名关键字推断（environment / integration / stability），其余为 functional。
- **执行**：使用 `process.execPath` 直接运行用例文件，`cwd` 为技能根目录，并设置 `SKILL_DIR`、`TEST_TYPE`、`NODE_ENV`；Windows 下会合并用户与系统 PATH 以改善 Python 等工具的可用性。
- **超时**：由 **TEST.md** 的 `timeout` 控制，超时则终止子进程并标记失败。

---

## 8. 参考示例

- **技能示例**：`%APPDATA%/opendesk/apps/skills/resources/pdf`（含完整 `tests/` 与 `fixtures/`）。
- **协议与示例代码**：项目内 `skill-test-protocol.md`、`skill-test-example.js`（若存在）及本目录 **README.md** 中的 Skill 结构说明。

---

## 9. 故障排除

- **Python/脚本找不到**：在 Windows 下确保 PATH 包含 Python；运行器会尝试合并系统与用户 PATH，若仍失败请检查终端与 OpenDesk 使用的环境是否一致。
- **测试超时**：在 **TEST.md** 中适当增大 `timeout`（单位：秒）。
- **用例未发现**：确认文件在 **tests/cases/** 下，且文件名为 `*.test.js` 或 `*.spec.js`，扩展名为 `.js`/`.mjs`/`.cjs`。
- **环境预检不通过**：根据 TUI 或报告中的 `requires` 检查 Node 版本、OS、`requires.tools` 中的命令是否可用。

---

## 10. 版本与扩展性

- 当前测试框架版本：**1.0**。
- 后续可能扩展：覆盖率、Mock、快照测试、并行执行、CI 集成等；新能力将在文档与 **TEST.md** 的 `version` 中体现。
