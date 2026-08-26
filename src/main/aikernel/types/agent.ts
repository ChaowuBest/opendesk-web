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

/**
 * 外部贡献的 Agent 声明（纯数据结构，供 plugin-sdk 与宿主共享）。
 *
 * 一个 Agent 声明对应插件目录中的一个 agent 子目录（包含 agents.md），
 * 宿主会基于该声明构建运行时 Agent 实例，其完整 agentId 为
 * `<所属插件 id>:<name>`，因此不同插件可以定义同名 agent。
 */
export interface AgentDefinition {
    /** agent 名称，在所属插件内唯一 */
    name: string;
    /** 使用场景描述，指示主 Agent 何时应调度此 Agent */
    whenToUse: string;
    /**
     * agents.md 正文，作为该 Agent 的 system prompt 指令体（必需且非空）
     */
    body: string;
    /** 是否可被主 Agent 作为子任务执行者调度，缺省为 true */
    dispatchable?: boolean;
}

/**
 * 从插件目录装载的外部 agent 定义：在基础声明之上保留安装位置。
 *
 * location 不是插件作者的声明内容，而是目录装载的产物，因此只出现在
 * 该子类型上；运行时据此在 system prompt 中声明 agent 的实际安装目录。
 */
export interface ExternalAgentDefinition extends AgentDefinition {
    /** agent 实际安装目录；prompt 组装时用于声明该路径 */
    location: string;
}
