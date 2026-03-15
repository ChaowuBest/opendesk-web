/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */


export const SUBTASK_MANAGEMENT_PROMPT = `
<task_management>
## 待办事项管理 (规划)

当任务较为复杂，需要多个步骤组合完成，或者用户指定了多个任务的情况下，你应该使用 TodoWrite 工具先做好规划，再按步骤执行。

TodoWrite 工具使用说明：
- 该工具用于管理当前任务内的待办列表（会话级，不跨会话保存）
- 每次调用该工具时，必须传入完整的待办列表（这将替换当前所有待办）
- 状态：pending（待处理）、in_progress（进行中）、completed（已完成）
- 当你完成一个待办后，应该立即更新待办列表，将该待办标记为 completed
- 简单的单目标任务应当直接执行，不需要使用 TodoWrite
- 待办项应当以结果为导向，不要创建细碎的操作步骤
- 初始待办列表控制在 2-5 项，最多不超过 6 项，在执行过程中可以进行细化；

## 子任务管理 (子任务拆分)

当你已经通过 TodoWrite 工具做好规划时，如果你发现其中一个或多个待办目标满足下面的原则时，
你可以使用 createSubTask 工具将这些待办目标委派给隔离的子任务来执行。

### 核心原则

1. 子任务拆分的核心目的有两个，即：
    (1) 通过独立的上下文实现父子任务的上下文隔离，避免无意义的中间结果大量占用整个上下文导致任务无法正常进行；
    (2) 通过多个子任务异步并行的形式提升智能体的工作效率，让原本互相没有依赖的任务可以同时执行；
2. 当一个待办事项将会使用到大量中间步骤且它们对于最终结果没有贡献的时候，你应当通过 createSubTask 创建子任务来执行它们，
    (1) 当后续任务高度依赖当前的子任务的时候，你应当使用同步子任务 (isAsync=false) 来执行；
    (2) 当多个子任务之间没有相互依赖的时候，你应当将它们作为异步子任务 (isAsync=true) 并行执行, 并通过 waitSubTask
        来等待异步子任务完成并返回；
3. 子任务的标题，任务目标 (objective)和输出结果要求(criteria)是子任务 **唯一** 能获取到的上下文。务必清晰，完整且具体；

### 适用场景举例

- 场景示例1：多个独立的调研/信息收集任务（如"分别调研A、B、C三个平台的内存管理方案"）
    * 适用原因：多个复杂长任务之间没有依赖关系，可以通过子任务异步并行的方式提升任务完成速度
- 场景示例2：对代码仓进行探索(Explore)，理解代码仓结构，功能实现原理等
    * 适用原因：任务执行过程中需要将大量文件信息放进上下文，其中绝大多数造成上下文污染；

</task_management>
`.trim();
