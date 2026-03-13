# Agent Skill 测试用例生成指导（面向大模型）

本文档面向**大模型**：当用户指定一个 Agent Skill（例如提供技能路径或 SKILL.md 内容）时，请根据本指导为该技能生成一整套符合 OpenDesk 测试框架的测试用例与配置。

---

## 1. 文档用途

- **输入**：用户指定的 Agent Skill（目录或 SKILL.md + scripts/references 等描述）。
- **输出**：可放入该技能 `tests/` 目录的完整测试套件，包括：
  - `tests/TEST.md`（测试配置）
  - `tests/README.md`（可选，测试说明与使用方式）
  - `tests/cases/` 下的四类用例：`environment.test.js`、`basic.test.js`、`integration.test.js`、`stability.test.js`
  - 若需要：`tests/fixtures/` 下的测试数据或辅助脚本

生成后的文件应满足 [SKILL-TEST-FRAMEWORK.md](./SKILL-TEST-FRAMEWORK.md) 中的协议与目录约定，并能在 OpenDesk 中通过 `/skills test <skill-name>` 运行。

---

## 2. 测试框架要点摘要

- **技能目录**：标准 Agent Skill（SKILL.md、scripts/、references/、assets/）+ 可选 **tests/**。
- **tests 结构**：
  - **TEST.md**：YAML frontmatter 必填 `version: "1.0"`，可选 `timeout`、`requires`（node、os、tools、memory、disk）。
  - **cases/**：仅运行 `*.test.js` 或 `*.spec.js`（.js/.mjs/.cjs）；类型由文件名推断：
    - `environment` / `env` → 环境检测
    - `integration` / `e2e` → 集成测试
    - `stability` / `stress` → 稳定性测试
    - 其余 → functional（功能测试）
  - **fixtures/**：可选，供用例通过 `path.join(process.env.SKILL_DIR, 'tests', 'fixtures', ...)` 读取。
- **运行环境**：每个用例在 `cwd = 技能根目录` 下以 `node <用例文件>` 执行，并注入：
  - `SKILL_DIR`：技能根目录
  - `TEST_TYPE`：environment | functional | integration | stability
  - `NODE_ENV`：test
- **通过/失败**：`process.exit(0)` 为通过，非 0 为失败；建议失败前 `console.error('FAIL: ...')` 便于诊断。

---

## 3. 分析技能并确定测试内容

在生成用例前，请根据用户提供的技能信息做以下分析：

1. **SKILL.md**
   - frontmatter：`name`、`description`、是否包含 `fillipdesk` 等扩展。
   - 正文：提到的运行时（Python/Node/系统命令）、依赖库、参考文档（references）、脚本用途。
2. **scripts/**
   - 列出所有脚本（如 `.py`、`.js`、`.sh`）；区分必需与可选。
   - 每个脚本的用途、是否可无参或 `--help` 运行、是否依赖外部命令或库。
3. **references/** 与根目录 `.md`
   - 是否声明了外部依赖（如 Python 包、系统工具）、版本要求。
4. **运行环境**
   - 主要运行时：Node 仅 / Python 仅 / 双端 / 系统命令。
   - 必需与可选依赖：解释器版本、包名、系统工具（如 `pdftotext`、`qpdf`）。

根据以上分析，在四类测试中覆盖：

- **environment**：检测解释器、包管理器、必需库/工具、技能目录与必需文件/脚本是否存在。
- **basic（functional）**：SKILL.md 格式与必填字段、脚本语法或可执行性（如 `python -m py_compile`、`node --check`）、参考文档存在性。
- **integration**：真实调用脚本或库（如导入关键库、跑一小段示例、用 fixtures 跑一条端到端流程）。
- **stability**：边界与异常（空输入、大文件、错误路径、超时或并发等，视技能能力而定）。

---

## 4. 生成 TEST.md

- 必须包含 YAML frontmatter，且包含 `version: "1.0"`。
- 根据技能需求设置：
  - `timeout`：若技能有重操作（如大文件、网络），可设为 300–600。
  - `requires.node`：若用到 Node，写 `">=18.0.0"` 等。
  - `requires.os`：通常 `["win32", "darwin", "linux"]`。
  - `requires.tools`：如 `["python"]`、`["node"]`（若脚本需命令行 python/node）。
  - `requires.memory` / `requires.disk`：若技能说明中有要求则填写。
- frontmatter 后可用 Markdown 简要说明依赖与测试覆盖范围（供人阅读）。

---

## 5. 生成四类用例文件

### 5.1 environment.test.js

- 检查运行环境是否满足技能要求：
  - 解释器是否存在及版本（如 `python --version`、`node --version`）。
  - 包管理器（如 `pip --version`）。
  - 必需库是否可导入（如 Python：`python -c "import pypdf"`）；可选库可只报存在与否，不因缺失而退出非 0。
  - 技能目录结构：`SKILL.md`、`scripts/` 等是否存在；是否包含技能文档中声明的必需脚本。
  - 可选：系统工具（如 `pdftotext`、`qpdf`）是否在 PATH 中。
- 使用 `process.env.SKILL_DIR` 定位技能根目录；所有路径用 `path.join` 拼接。
- 任一**必需**项不满足则 `console.error('FAIL: ...')` 并 `process.exit(1)`；全部通过则 `process.exit(0)`。
- Windows 下执行外部命令时优先使用 `shell: false`，避免对复杂参数的引号/分号解析问题。

### 5.2 basic.test.js（功能测试）

- 验证 SKILL.md：存在、以 `---` 起止的 frontmatter、必填字段（如 `name`、`description`）存在。
- 验证 scripts：语法检查（如 Python：`python -m py_compile <script>`；Node：`node --check <script>`）；或无参/`--help` 运行不崩溃。
- 检查 references 或根目录说明中提到的文档/资源是否存在（可按需放宽为“存在即可”）。
- 失败时明确报错并 `process.exit(1)`；全部通过则 `process.exit(0)`。

### 5.3 integration.test.js

- 调用技能实际依赖的库或脚本，做最小可行验证：
  - 例如 Python 技能：`python -c "import pypdf; from pypdf import PdfReader; ..."` 完成一次读/写或简单转换。
  - 若有脚本接受输入：用 fixtures 或临时文件跑一条端到端（如：生成文件 → 调用脚本 → 检查输出）。
- 使用 `process.env.SKILL_DIR` 与临时目录（如 `fs.mkdtempSync`）避免污染技能目录；测试结束可删除临时文件。
- 任一关键步骤失败则 `console.error('FAIL: ...')` 并 `process.exit(1)`；全部通过则 `process.exit(0)`。

### 5.4 stability.test.js

- 根据技能能力选择可实施的项（不必全部）：
  - 大输入/大文件（如生成大 PDF、大文本）并验证能处理或优雅失败。
  - 空文件、错误路径、无效输入下的行为（期望报错而非崩溃）。
  - 并发：多次读同一文件或调用同一脚本，确认无异常。
  - 超时：若某操作可能很慢，可设较短 timeout 并期望被终止或返回错误。
- 使用临时目录与 `process.env.SKILL_DIR`；不修改技能自带的 scripts/references。
- 失败时 `console.error('FAIL: ...')` 并 `process.exit(1)`；通过则 `process.exit(0)`。

---

## 6. 输出格式与约定

- **文件位置**（相对技能根目录）：
  - `tests/TEST.md`
  - `tests/README.md`（可选）
  - `tests/cases/environment.test.js`
  - `tests/cases/basic.test.js`
  - `tests/cases/integration.test.js`
  - `tests/cases/stability.test.js`
  - `tests/fixtures/<文件名>`（仅当用例需要时）
- **命名**：用例必须带 `.test.` 或 `.spec.`，扩展名 `.js`（或 `.mjs`/`.cjs`），以便运行器发现。
- **兼容性**：脚本应能在 Node 18+、Windows/macOS/Linux 下运行；外部命令调用注意 Windows 下 `shell: false` 与路径分隔符。
- **可读性**：每个用例文件顶部可加简短注释说明该文件目的；用例内用 `console.log` 输出关键步骤，便于用户在 TUI 或命令行查看。

---

## 7. 示例参考（PDF 技能）

若用户提供的技能与“PDF 处理”类似，可参考以下思路（不必照搬）：

- **environment**：检测 `python`、`pip`；检测 `pypdf`、`pdfplumber`、`reportlab` 等必需库；检测 `scripts/` 下声明的必需脚本文件；可选检测 `pdftotext`、`qpdf`。
- **basic**：所有 `.py` 脚本 `python -m py_compile`；SKILL.md frontmatter 与 `name`/`description`；根目录 `reference.md`、`forms.md` 等是否存在。
- **integration**：`pypdf`/`pdfplumber`/`reportlab` 导入并执行一次读 PDF、提取文本、创建小 PDF；用 fixtures 或临时 PDF 调用一个填表/转换脚本并检查输出。
- **stability**：生成 50 页 PDF 并读取；空 PDF 或无效路径；多进程/多次读取同一文件；错误输入下脚本是否正常退出非 0。

实际生成时请**严格依据用户给出的技能内容**（SKILL.md、scripts 列表、文档说明）来列依赖、脚本名和集成步骤，避免臆造不存在的脚本或库。

---

## 8. 检查清单（生成后自检）

- [ ] **TEST.md** 含 `version: "1.0"` 和合理的 `timeout`、`requires`。
- [ ] 四个用例文件均在 **tests/cases/** 下，文件名包含 `.test.`，扩展名为 .js/.mjs/.cjs。
- [ ] 所有用例仅通过 `process.env.SKILL_DIR` 与技能目录交互，不写死绝对路径。
- [ ] 通过时 `process.exit(0)`，失败时 `console.error` 后 `process.exit(1)`。
- [ ] 若使用 fixtures，路径为 `path.join(process.env.SKILL_DIR, 'tests', 'fixtures', ...)`，且相应文件已在输出中提供。
- [ ] 外部命令在 Windows 下使用 `shell: false` 时参数为数组形式，避免复杂字符串被 shell 曲解。

按以上指导生成的测试套件可直接放入用户指定技能的 `tests/` 目录，并在 OpenDesk 中通过 `/skills test <skill-name>` 运行。
