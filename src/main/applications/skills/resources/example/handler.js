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
 * 示例技能执行器（Anthropic Agent Skills + FillipDesk 扩展）
 * 主进程通过 SkillRegistry 动态 import 并调用 execute(input, args)
 * @param {string} input - 可选任务/输入摘要（来自 tool 参数 input）
 * @param {object} args - 已解析的完整参数（含 input_schema 中定义的 action、message 等）
 * @returns {Promise<string>} 返回给模型的文本结果
 */
export async function execute(input, args) {
  const action = args?.action ?? (input?.toLowerCase().includes('时间') || input?.toLowerCase().includes('time') ? 'time' : 'echo');
  const message = args?.message ?? input ?? '';

  if (action === 'time') {
    const now = new Date();
    return `[示例技能] 当前本地时间: ${now.toLocaleString('zh-CN')}`;
  }
  if (action === 'echo') {
    return `[示例技能] 已回显: ${message}`;
  }
  return `[示例技能] 未知 action: ${action}。支持 action: echo, time。`;
}
