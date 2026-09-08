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

import { Skill } from '../../aikernel/skill.js';

const ANALYSIS_RESULT_VISUALIZER_DESIGN_PROMPT = `
## 设计系统参考

以下规则单独用于 SVG 的配色、版式与图形类型选择，不和主体触发规则混写。
内容参考 Visualizer Core Design System。

### Philosophy

- Seamless: Users shouldn't notice where the host UI ends and your widget begins.
- Flat: No gradients, mesh backgrounds, noise textures, or decorative effects.
- Compact: Show the essential inline. Explain the rest in text.
- Text goes in your response, visuals go in the tool.
- All explanatory text, descriptions, introductions, and summaries stay outside the tool call.

### Rules

- No SVG or CSS comments.
- No font-size below 11px.
- No emoji; use CSS shapes or SVG paths.
- No gradients, drop shadows, blur, glow, or neon effects.
- No dark or colored backgrounds on outer containers.
- Outer backgrounds must stay transparent because the host provides the background.
- Typography uses two weights only: 400 regular and 500 medium.
- Use sentence case. Do not use title case or all caps.
- Do not use fixed-position overlays, page wrappers, or unnecessary chrome.

### SVG setup rules

- Root SVG uses \`viewBox="0 0 680 H"\` and \`width="100%"\`.
- The width value 680 is fixed and should not change.
- \`H\` equals the bottommost element plus 20px.
- Safe area is approximately x=40 to x=640.
- Keep the background transparent.
- Use one SVG per visual response.
- Use 0.5px strokes for diagram borders and edges.
- Every connector \`<path>\` or \`<polyline>\` must use \`fill="none"\`.
- Include an arrow marker in \`<defs>\`.
- Do not rotate text.

### Arrow marker

Include an arrow marker equivalent to this in every SVG:

\`\`\`svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
\`\`\`

### Flowchart

For sequential processes, cause-and-effect, decision trees.

- Use flowcharts for sequential processes, causal chains, and decision trees.
- Keep at least 60px between boxes.
- Prefer single-direction flows.
- Keep diagrams simple: usually max 4-5 nodes.
- Cycles do not get drawn as rings.
- For cycles, prefer an HTML stepper.
- If SVG is necessary, use a linear SVG with a curved return arrow.
- Keep nodes the same height when they have the same content type.
- Every text inside a box should use central vertical alignment.

### Structural diagram

For concepts where physical or logical containment matters.

- Use structural diagrams for containment, layers, module boundaries, and ownership.
- The outermost container is a large rounded rectangle.
- Inner regions are medium rounded rectangles.
- Keep at least 20px padding inside containers.
- Use at most 2-3 nesting levels.
- Database schemas and ERDs use Mermaid \`erDiagram\`, not SVG.

### Illustrative diagram

For building intuition through physical or abstract spatial metaphors.

- Physical subjects: draw simplified versions, cross-sections, or cutaways.
- Abstract subjects: invent spatial metaphors.
- Color encodes intensity, not category.
- Warm ramps mean heat, energy, or active state.
- Cool ramps mean cold, calm, or dormant state.
- Prefer interactive or stepwise representations over dense static drawings.
- Place labels outside the drawn object with thin leader lines.

### Diagram type routing

| User says | Type | What to draw |
|-----------|------|-------------|
| "how do LLMs work" | Illustrative | Token row, stacked layer slabs, attention threads |
| "transformer architecture" | Structural | Labelled boxes: embedding, attention heads, FFN, layer norm |
| "what are the training steps" | Flowchart | Forward -> loss -> backward -> update |
| "TCP handshake sequence" | Flowchart | SYN -> SYN-ACK -> ACK |
| "how does TCP work" | Illustrative | Two endpoints, numbered packets in flight, an ACK returning |
| "explain the Krebs cycle / event loop" | HTML stepper | Click through stages. Never a ring. |
| "draw the database schema" | Mermaid | \`erDiagram\` syntax, not SVG |

### Palette

Use at most two color ramps in one diagram.
Color encodes intensity, state, or emphasis, not arbitrary categories.

Light mode quick pick:

- 50: light fill;
- 600: accent or stroke;
- 800: title text;
- 600: subtitle text.

Common ramps:

- Purple: \`#EEEDFE/#CECBF6/#AFA9EC/#7F77DD/#534AB7/#3C3489/#26215C\`
- Teal: \`#E1F5EE/#9FE1CB/#5DCAA5/#1D9E75/#0F6E56/#085041/#04342C\`
- Coral: \`#FAECE7/#F5C4B3/#F0997B/#D85A30/#993C1D/#712B13/#4A1B0C\`
- Pink: \`#FBEAF0/#F4C0D1/#ED93B1/#D4537E/#993556/#72243E/#4B1528\`
- Gray: \`#F1EFE8/#D3D1C7/#B4B2A9/#888780/#5F5E5A/#444441/#2C2C2A\`
- Blue: \`#E6F1FB/#B5D4F4/#85B7EB/#378ADD/#185FA5/#0C447C/#042C53\`
- Green: \`#EAF3DE/#C0DD97/#97C459/#639922/#3B6D11/#27500A/#173404\`
- Amber: \`#FAEEDA/#FAC775/#EF9F27/#BA7517/#854F0B/#633806/#412402\`
- Red: \`#FCEBEB/#F7C1C1/#F09595/#E24B4A/#A32D2D/#791F1F/#501313\`
`;

const ANALYSIS_RESULT_VISUALIZER_SKILL = `
---
name: analysis-result-visualizer
description: >
  在分析结果包含复杂结构、流程、关系、时序、分支、层级或对比时，
  使用可内联预览的 Mermaid 或 SVG 图形帮助用户理解，而不是只输出大段纯文本。
  适用于系统架构、业务流程、数据流、调用关系、事件时间线、依赖关系、
  状态变化、因果链、方案对比、概念解释和问题诊断等场景。
  仅在图形能明显降低理解成本且信息已经足够明确时使用；
  简单结论、短列表、单一事实或仍在探索中的内容不要绘图。
---

# 分析结果可视化

将复杂分析中的关键关系转换成紧凑、可读的 Mermaid 或 SVG 图形。
图形用于呈现文本不擅长表达的空间和结构关系，解释、结论与限制仍放在普通回答中。

## 何时使用

先完成必要的信息收集和分析，再判断图形是否能显著提升理解效率。

以下情况优先使用图形：

- 多个对象之间存在依赖、包含、交互或上下游关系；
- 流程包含多个阶段、分支、并行路径、循环或状态转换；
- 需要展示事件顺序、生命周期、演进过程或时间线；
- 需要比较多个方案、路径、状态或结果；
- 需要说明从原因到结果的传播过程；
- 概念包含多个层级，纯文本容易遗漏整体结构；
- 用户明确要求图、流程图、架构图、关系图或可视化说明。

以下情况不要绘图：

- 一两句话即可准确说明；
- 只是短列表、单一数值、单个对象或局部代码修改；
- 图形只是重复正文，没有提供新的结构信息；
- 关键事实仍不确定，图形可能让推测看起来像结论；
- 内容主要是可直接使用的代码、命令或配置。

如果后续信息改变了关键结构，可以更新原图或补充一张表达新增关系的图，
不要生成内容高度重复的多张图。

## 图形格式路由

先选择能准确表达关系且源码最容易维护的格式，不要默认使用 SVG：

- 用户明确指定 Mermaid 或 SVG 时，遵循用户指定的格式；
- 时序图优先使用 Mermaid \`sequenceDiagram\`；
- 标准流程图和依赖图优先使用 Mermaid \`flowchart\`；
- 状态转换优先使用 Mermaid \`stateDiagram-v2\`；
- 数据库 schema 和 ERD 使用 Mermaid \`erDiagram\`；
- 自由布局、精细视觉控制、空间隐喻或插画式表达使用 SVG；
- Mermaid 无法准确表达目标结构时，回退到 SVG。

## 选择图形类型

根据用户需要理解的关系选择图形，不要默认使用流程图：

- **Flowchart**：步骤、决策、因果链、业务流程和状态转换；
- **Structural diagram**：架构、层级、包含关系、模块边界和组织结构；
- **Sequence or timeline**：事件顺序、交互时序、生命周期和演进过程；
- **Comparison layout**：方案、路径、状态、优缺点和结果对比；
- **Relationship map**：依赖、引用、关联、上下游和多对多关系；
- **Illustrative diagram**：用空间隐喻解释抽象概念或运行机制。

真正的循环或大量阶段优先使用 HTML stepper，不要强行画成环。
数据量较大且重点是数值趋势时，应使用适合的图表能力，而不是手绘 SVG 图表。

## 组织内容

- 只保留理解结论所需的节点、边和标签；
- 用位置、分组、边界和箭头表达关系；
- 用标题或路径标签说明分支条件和方向；
- 将详细证据、例外、限制和操作建议放在图外；
- 不确定内容使用中性样式，并在正文中明确其不确定性；
- 每个图形元素都应来自已有信息，不要补造关系或细节。

## 输出规范

- 先用普通文字给出结论和图形用途，再输出图形；
- 一次输出一张可视化，供 OpenDesk 内联预览；
- 选择 Mermaid 时，将合法的 Mermaid 源码放在一个 \`mermaid\` fenced code block 中，不要再包裹 SVG；
- 选择 SVG 时，将完整的 SVG 放在一个 \`svg\` fenced code block 中；

### Mermaid 输出规范

- 根据格式路由使用 \`sequenceDiagram\`、\`flowchart\`、\`stateDiagram-v2\` 或 \`erDiagram\`；
- 保持节点和标签简短，复杂解释、证据和限制放在代码块外；
- 使用 OpenDesk 当前 Mermaid 渲染器支持的标准语法，不使用初始化指令、脚本或外部资源；
- 输出前检查声明类型、节点标识、连接关系和分支标签是否完整有效。

### SVG 输出规范

- 根元素使用 \`viewBox="0 0 680 H"\`、\`width="100%"\` 和 \`role="img"\`；
- 第一个子元素是 \`<title>\`，第二个子元素是 \`<desc>\`；
- 在 \`<defs>\` 中包含箭头 marker；
- 连接线的 \`<path>\` 和 \`<polyline>\` 必须使用 \`fill="none"\`；
- 背景保持透明，不要添加页面级容器；
- 不要使用脚本、外部资源、SVG 注释、emoji、旋转文字、渐变、阴影、模糊或发光；
- 文字不小于 11px，边框使用 0.5px，主要连接线约 1.5px；
- 标签尽量放在对象外，必要时使用细 leader line；
- 控制信息密度，单层尽量不超过 4 个主要节点。

${ANALYSIS_RESULT_VISUALIZER_DESIGN_PROMPT}

## 自检

- 图形是否比纯文本更容易理解？
- 图形类型是否匹配要表达的关系？
- 是否按照格式路由选择了 Mermaid 或 SVG，并遵循用户明确指定的格式？
- 是否只保留了必要信息？
- 每个节点、连接和标签是否有信息依据？
- 是否将解释、限制和不确定性留在图外？
- Mermaid 是否使用合法的标准语法，SVG 是否满足透明背景、680 宽 viewBox、title/desc 和箭头 marker？
- SVG 是否没有小字、渐变、阴影、emoji 和无意义装饰？
`;

export function loadAnalysisResultVisualizerSkill(): Skill {
    return Skill.parseMd(ANALYSIS_RESULT_VISUALIZER_SKILL);
}
