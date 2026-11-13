# EvidenceCard repeated evidence V2 设计

## 背景

EvidenceCard 用于减少 Coding 任务中的重复读取、重复搜索和无效证据消耗。此前的 OpenDesk 适配为大量工具建立了 target、证据类型和阶段语义，并让所有工具进入 ledger。这个实现虽然解决了类型化工具参数无法识别的问题，但带来了新的扩展性成本：

- EvidenceCard 需要理解 GUI、浏览器、MCP、设备、任务、知识库等所有工具。
- 新增或修改业务工具时，往往还要同步修改 EvidenceCard 解析器。
- EvidenceCard 的收益主要来自高 token 的 Coding 读取和搜索，记录其他工具没有明确收益。

因此 V2 将 EvidenceCard 从“通用工具语义解析器”收缩为“Coding 读取证据白名单”。

## 目标

- 只记录本地文件读取、文件搜索以及明确的 Shell 读取或搜索。
- 未命中白名单的工具不解析，也不写入 ledger、token、phase、target 或重复索引。
- 新增工具默认忽略，不要求同步扩展 EvidenceCard。
- 只有成功的白名单调用写入重复索引。
- 保留类型化参数和 CallSkillTool 包装器内参数的必要解析能力。

## 非目标

本次不修改：

- 证据债务算法。
- 预算、token 估算和工具结果压缩。
- EvidenceCard ledger 和运行时提示的数据结构。
- 文件修改后的证据失效机制。
- GUI、浏览器、MCP、设备、工作流、知识库等工具的通用语义分类。

## 白名单

### 文件读取和搜索

只识别 filemgr 中以下工具：

| 工具           | 类别 | phase    | evidence kind        |
| -------------- | ---- | -------- | -------------------- |
| readFile       | 读取 | inspect  | 按范围和文件类型确定 |
| extractText    | 读取 | inspect  | full_file            |
| globFiles      | 搜索 | localize | repo_map             |
| grepFiles      | 搜索 | localize | symbol_signature     |
| semanticSearch | 搜索 | localize | search_result        |

文件编辑、写入、补丁、图片读取和其他 filemgr 工具均忽略。

### Shell 读取和搜索

只检查以下终端工具：

- terminal-executeBash
- terminal-executeZsh
- terminal-executePowerShell

命令还必须明确以只读或搜索命令开头。

搜索命令包括：

- rg、ripgrep、grep、find、findstr、fd
- ls、dir、Get-ChildItem、Select-String
- git ls-files、git grep

读取命令包括：

- Get-Content、cat、nl、type、head、tail
- 仅只读模式的 sed
- git show、git log、git blame

以下情况即使包含上述命令也忽略：

- 测试、构建和普通执行命令。
- git diff、git status 等状态性命令。
- 输出重定向。
- &&、||、;、命令替换等复合执行。
- tee、xargs、文件修改命令或将输出交给 Shell/解释器执行。

Shell 判断采用保守白名单。无法明确确认只读时直接忽略。

### Skill 包装器

对 skill-manager-CallSkillTool 只做一层最小解包：

1. 读取内部 toolName。
2. 只有内部工具名属于文件或 Shell 白名单时，才解析内层参数（arguments 字段，历史记录兼容旧名 toolArgs）。
3. 继续应用与直接调用相同的参数校验和 Shell 命令校验。
4. 其他 Skill 工具直接忽略。

EvidenceCard 不解析 Skill 的业务语义，也不为 GUI 等内部工具生成 target。

## 记录逻辑

    semantics = resolveAllowlistedEvidence(toolCall)

    if semantics is absent:
        return

    successful = toolCall.status == success
    previousTargetCount = successful ? state.target_counts[target] ?? 0 : 0
    repeated = successful AND previousTargetCount > 0

    if successful:
        state.target_counts[target] = previousTargetCount + 1

    append ledger entry

失败的白名单调用仍进入 ledger，并标记为错误证据，但不会写入重复索引。因此失败后使用相同参数重试，首次成功调用不会被判定为 repeated。

## 扩展规则

新增业务工具默认不进入 EvidenceCard，不需要修改 EvidenceCard。

只有同时满足以下条件时，才考虑扩展白名单：

- 工具主要服务于 Coding 证据定位或读取。
- 工具结果通常消耗较多上下文 token。
- 相同 target 在任务期间具有足够稳定的含义。
- 重复调用可以安全地提示复用先前证据。

扩展时只增加该工具的白名单识别和 target 生成，不增加通用工具语义解析。

## 测试范围

- 文件完整读取、分段读取和各类文件搜索能够生成稳定 target。
- 文件修改、图片读取和参数不完整的文件工具被忽略。
- Bash、Zsh、PowerShell 中明确的读取或搜索被记录。
- 测试、构建、状态观察、重定向、复合或可能修改状态的 Shell 命令被忽略。
- Skill 包装的文件或 Shell 白名单工具能够解析，其他 Skill 工具被忽略。
- GUI、浏览器、Todo、用户交互和未知工具不写入任何 EvidenceCard 状态。
- 连续成功读取相同 target 时，第二次才判定为 repeated。
- 失败读取不污染重复索引。
