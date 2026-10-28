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

import path from 'node:path';
import { z } from 'zod';
import {
    PRESENTATION_AUTOMATION_CORE_GUIDE,
    PRESENTATION_CAPABILITY_TOPICS,
    getPresentationAutomationCapabilities
} from '@bitclub.ai/opendesk-office/presentation-automation';
import { Skill } from '../../aikernel/skill.js';
import { BaseTool, BaseToolset } from '../../aikernel/tool.js';
import type { PermissionRequest } from '../../aikernel/security/permission.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type {
    PresentationProgramExecution,
    PresentationProgramInput,
    SlidesPresentationOpenResult
} from './provider.js';
import { t } from './locale/index.js';

export type PresentationProgramExecutor = (
    taskId: string,
    input: PresentationProgramInput
) => Promise<PresentationProgramExecution>;

export type SlidesPresentationOpener = (taskId: string, filePath: string) => Promise<SlidesPresentationOpenResult>;

const PresentationProgramSchema = z
    .object({
        program: z
            .string()
            .min(1)
            .max(200_000)
            .optional()
            .describe('首次创建时提交的完整 presentation/v1 generator 源码；工具会把它固化为同一任务的 main.mjs'),
        programPath: z
            .string()
            .min(1)
            .optional()
            .describe('后续修正时使用工具返回的 provenance.sourcePath；编辑同一 main.mjs 后从该路径重新运行'),
        startFrom: z
            .enum(['auto', 'current', 'blank'])
            .default('auto')
            .describe(
                '默认 auto：只复用当前或既有 PPT，不会隐式新建；新建必须显式指定 blank，已有文件应先 open_presentation'
            ),
        expectedRevision: z
            .string()
            .optional()
            .describe(
                '上次成功结果中的 revision.after；可传 presentation/v1:<sha256> 或纯 64 位 SHA-256，冲突时读取最新文档后更新'
            ),
        unsavedChanges: z
            .enum(['save', 'discard'])
            .optional()
            .describe(
                '仅在工具返回 UNSAVED_CHANGES 且用户明确决定后使用：save 保留并保存编辑器修改，discard 放弃修改并重载文件'
            ),
        outputPath: z
            .string()
            .optional()
            .describe('可选输出 PPTX 路径；通常省略，由 OpenDesk 在当前任务中持续复用同一目标文件'),
        expectedSlideCount: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .optional()
            .describe('按用户需求确定的最终页数；新建时提供，后续同一 generator 重跑自动复用，用于核对是否漏页或多页'),
        assets: z
            .record(z.string(), z.string())
            .optional()
            .describe(
                '可选图片资产映射：asset id 到文件路径。同一 programPath 重跑自动复用已归档素材；只传新增或替换的 id 即可，例如 { hero: "cover.png" }'
            )
    })
    .superRefine((value, context) => {
        if (value.program && value.startFrom === 'blank' && value.expectedSlideCount === undefined) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['expectedSlideCount'],
                message: t('error.expectedSlideCountRequired')
            });
        }
        if (Boolean(value.program) === Boolean(value.programPath)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'program 与 programPath 必须且只能提供一个'
            });
        }
    });

const OpenPresentationSchema = z.object({
    filePath: z.string().min(1).describe('任务工作区内或绝对路径的目标 .pptx 文件')
});

const PresentationCapabilitiesSchema = z.object({
    topics: z
        .array(z.enum(PRESENTATION_CAPABILITY_TOPICS))
        .min(1)
        .max(3)
        .optional()
        .describe('需要精确契约的 1-3 个主题；省略时仅返回全部主题的简短能力索引'),
    detail: z
        .enum(['summary', 'contract', 'examples'])
        .default('contract')
        .describe('summary 仅返回能力摘要；contract 返回字段、枚举与清除语义；examples 额外返回最小示例'),
    operation: z
        .enum(['read', 'add', 'update', 'layout', 'workflow'])
        .optional()
        .describe('可选操作过滤；例如修改图表时使用 update')
});

const PRESENTATION_GENERATION_GUIDE = `
## 新建演示文稿工作流

- “完整 generator”指一份持续维护的完整源码，而不是要求第一次执行就成功。首次用 \`program\` + \`startFrom: 'blank'\` 提交完整源码；工具会返回 \`provenance.sourcePath\`，继续按 generator 生成时，编辑该同一个 \`main.mjs\`，再用 \`programPath\` + \`startFrom: 'blank'\` 重跑。
- 创建阶段可以根据结构化错误反复修正和重跑，但源码始终包含设计常量、helper、数据和全部页面。不要第一次用 generator，随后把剩余页面或修复拆成多个 \`current\`/update 事务；这会丢失全局设计契约。
- 当前 PPT 仍与上次 generator 产物一致时，允许修改同一 generator 并从 \`blank\` 重跑，包括整体配色、字号和布局调整。直接修改既有文稿、保留用户手动编辑时使用 \`current\` 增量修改；失败重试继续修正同一 generator。
- \`blank\` 已含一张空白页，应从 \`deck.slide(0)\` 开始构建。基础入口是 \`const slide = deck.slide(0)\` 与 \`slide.add({ kind: 'text', ... })\`；不要猜测 \`addText\`、\`addShape\`、\`addElement\` 等不存在的方法。
- 完整程序应先用一组简短常量固化设计契约：背景体系、主/强调/中性色、字体层级、页面边距与网格、核心组件以及图表/表格规范。这是一致性约束，不要强制所有页面使用同一背景；如果封面、正文和结尾使用不同明暗，应让它们成为有意图的章节体系。常规 16:9 汇报可参考封面 30–40pt、页标题 26–32pt、正文 16–20pt、图表标签与表格 12–16pt；除页脚/注释外避免低于 12pt，并把核心字号控制在约 4 档。
- 在同一程序中定义并复用如 \`addPageChrome\`、\`addCard\`、\`addSectionSlide\`、\`addChartCard\` 和 \`addTableCard\` 的 helper，并将展示数据与布局逻辑分开。相同的页眉、页脚、卡片和章节样式不应逐页重新手写。通用卡片 helper 默认使用 \`rect\`；若设计明确需要圆角，将选定的固定 pt 值作为全局设计常量，并统一通过 \`cornerRadiusPt\` 传入，不使用百分比作为设计尺寸。
- 主题与组件样式应来自集中常量或主题引用。\`deck.setTheme\` 不会覆盖元素上的显式颜色；使用显式颜色时，必须通过同一组生成常量统一管理，不要在各页散落无关色值。
- 整体事务失败时，使用工具返回的 \`recovery\`、精确错误行列、不支持字段或 validation 修改同一源文件。不要复制整段源码到下一次工具参数，也不要用临时探测页替代契约查询。
- 新建时根据用户需求确定最终页数并传入 \`expectedSlideCount\`，同一 generator 重跑会复用。目录必须与实际页面一一对应；示例目录也不能引用不存在的页或章节。
- \`ok: true\` 只表示该程序成功提交，不等于成品通过。先读取 \`acceptance\` 和 \`contentReview\`：只有 \`acceptance.passed: true\` 才通过自动验收；目录越界、目录标题与目标页不符、页数与计划不一致都必须修改同一 generator 后重跑。结合 \`contentReview.slides\` 核对用户要求的章节、数据和示例内容；自动检查不证明事实正确或全稿视觉通过。再读取结构排版结果 \`validation.summary\`：\`qualityPassed: false\` 表示仍有高风险结构或文字覆盖问题，应按已排序在前的 high severity 条目修正同一 generator；medium/low 仅作针对性判断，不要机械清零所有提示。切换到增量编辑或向用户宣布完成前，还应核对计划页数与实际页数、关键章节/数据是否完整及原生图表/表格等元素 kind 是否正确；最小探针、占位页或部分页面绝不能作为初稿验收通过。
- 如果当前会话具有可读取渲染图像的视觉能力，可软性建议渲染全稿缩略图并做一次集中视觉修正；找不到现成的渲染入口时停止探测，不为验收反复寻找 PDF 转换器或安装 Office；没有视觉能力时不得因此阻塞任务，应使用结构化 validation、目标 inspect 和最终 deck 级检查完成可验证的收尾。
`;

const PRESENTATION_AUTOMATION_SKILL = `
---
name: automate-presentation
description: 当用户要求创建、生成、打开、读取或编辑 PPT/PPTX、PowerPoint、幻灯片或演示文稿时优先加载；使用原生 presentation/v1 能力，不要默认改用 Python 或手工 OOXML，除非用户明确要求脚本或已同意能力不足时的降级
---

${PRESENTATION_AUTOMATION_CORE_GUIDE}

${PRESENTATION_GENERATION_GUIDE}

## OpenDesk execution contract

- 这是 PPT/PPTX、PowerPoint 和演示文稿任务的首选能力。不要沿用历史任务中的 Python、zipfile 或手工 OOXML；只有用户明确要求脚本，或查询精确能力后确认原生契约不足并得到用户同意，才允许降级。
- 直接工具共有三个：\`get_presentation_capabilities\` 按主题读取精确契约，\`open_presentation\` 打开或切换已有文件，\`run_presentation_program\` 读取、创建和修改。不要通过旧的 CallSkillTool 包装调用。
- 不需要为能力索引中的每个领域都查询契约。首次使用某个能力且字段不确定时，为相关 1-3 个主题调用 \`get_presentation_capabilities\`；创建元素时优先请求 \`detail: 'examples'\`。精确入口、字段归属、枚举、清除语义和示例以工具返回为准，不要读取或再次包装之前保存的 tool-result 文件。
- 只读查看或检查已有文件时，直接调用 \`open_presentation\`，不要为此创建副本。首次修改已有 PPT 时，除非用户明确要求直接修改或覆盖原文件，否则先用可用的文件复制能力创建一个字节级一致、名称不冲突的工作副本，再调用 \`open_presentation\` 打开该副本并进行修改；不要通过读取为文本、重新生成或重新导出 PPT 来代替文件复制。用户指定另存名称或路径时遵从其选择；无法安全复制或无法判断目标文件时，先询问用户。
- 同一任务后续的修改继续使用已打开的工作副本和该任务返回的同一目标路径，不要再次复制，也不要切回原文件。\`open_presentation\` 本身只打开文件，不会隐式复制。编辑默认使用 \`startFrom: 'auto'\`，新建必须显式使用 \`blank\`；返回 \`not_opened\` 时保持当前文件并停止自动重试。
- 新建和重跑遵循上述同一 generator 源文件工作流；成品可继续维护 generator，也可使用带 \`revision.after\` 的增量事务。遇到 \`GENERATOR_OUTPUT_CHANGED\`，说明 PPT 与上次生成结果不同，可能含用户手动修改或其他程序更改；不得直接用旧 generator 覆盖。先读取当前文稿，再编写基于 \`startFrom: 'current'\` 的修改程序，使用返回的当前版本作为 \`expectedRevision\`；保留用户修改，只更新本轮目标。不要把完整 generator 原样切到 current 执行，以免重复添加页面或元素。\`UNSAVED_CHANGES\` 必须询问用户选择 save 或 discard。
- 用户提供选中元素 id 时直接从编辑器给出的稳定 \`e_*\` 引用开始；顶层元素与任意层级的组内元素使用同一套身份。未分组复合组件使用 \`neighborhood()\`。图片文件通过工具参数 \`assets\` 声明。
- 原生图表、表格、分组或布局失败时不得默默改成手绘替代物。先依据结构化错误和对应主题契约修正；确认能力不足时说明缺口并请求用户决定是否降级。
- 成功修改后检查本次目标一次，全部修改完成后做一次 deck 级检查。不要创建临时探测页，也不要重复无变化的 inspect。
- 工具结果即使 \`ok: false\` 也是正常传输；根据错误行列、支持字段、validation 和 revision 修正，不得绕过事务保护。不要安装字体、清理 Office 缓存或修改用户配置。
`;

function resolveWorkspacePath(value: string | undefined, taskState?: TaskState): string | undefined {
    if (!value) return undefined;
    return path.resolve(taskState?.getWorkspace() || process.cwd(), value);
}

class RunPresentationProgramTool extends BaseTool<typeof PresentationProgramSchema> {
    constructor(executeProgram: PresentationProgramExecutor) {
        super(
            'run_presentation_program',
            '创建、生成、读取或编辑 PPT/PPTX 的首选工具；首次提交完整 program，后续编辑返回的同一 main.mjs 并用 programPath 重跑',
            PresentationProgramSchema,
            undefined,
            { 'zh-CN': '运行演示文稿程序', 'en-US': 'Run Presentation Program' }
        );
        this.serialExecution = true;
        this.setExecutor(async (args, taskState) => {
            const taskId = taskState?.task_id;
            if (!taskId) throw new Error(t('error.taskContextRequired'));
            const result = await executeProgram(taskId, {
                ...args,
                ...(args.programPath ? { programPath: resolveWorkspacePath(args.programPath, taskState) } : {}),
                ...(args.outputPath ? { outputPath: resolveWorkspacePath(args.outputPath, taskState) } : {}),
                ...(args.assets
                    ? {
                          assets: Object.fromEntries(
                              Object.entries(args.assets).map(([id, assetPath]) => [
                                  id,
                                  resolveWorkspacePath(assetPath, taskState)!
                              ])
                          )
                      }
                    : {}),
                workspace: taskState.getWorkspace(),
                suggestedName: taskState.task_name || 'presentation'
            });
            const serialized = JSON.stringify(result, null, 2);
            return serialized;
        });
    }

    getDeclaredPermissions(
        args: z.output<typeof PresentationProgramSchema>,
        taskState?: TaskState
    ): PermissionRequest[] {
        const outputPath = resolveWorkspacePath(args.outputPath, taskState);
        const programPath = resolveWorkspacePath(args.programPath, taskState);
        return [
            ...(programPath
                ? [{ resourceType: 'file' as const, action: 'read' as const, resourcePath: programPath }]
                : []),
            ...(outputPath
                ? [
                      { resourceType: 'file' as const, action: 'read' as const, resourcePath: outputPath },
                      { resourceType: 'file' as const, action: 'write' as const, resourcePath: outputPath }
                  ]
                : []),
            ...Object.values(args.assets ?? {}).map((assetPath) => ({
                resourceType: 'file' as const,
                action: 'read' as const,
                resourcePath: resolveWorkspacePath(assetPath, taskState)!
            }))
        ];
    }
}

class OpenPresentationTool extends BaseTool<typeof OpenPresentationSchema> {
    constructor(openPresentation: SlidesPresentationOpener) {
        super(
            'open_presentation',
            '打开或编辑已有 PPT/PPTX、PowerPoint 和演示文稿时使用：在当前任务中安全打开或切换明确文件，并等待编辑器就绪',
            OpenPresentationSchema,
            undefined,
            { 'zh-CN': '打开演示文稿', 'en-US': 'Open Presentation' }
        );
        this.serialExecution = true;
        this.setExecutor(async ({ filePath }, taskState) => {
            const taskId = taskState?.task_id;
            if (!taskId) throw new Error(t('error.taskContextRequired'));
            const resolvedPath = resolveWorkspacePath(filePath, taskState)!;
            return JSON.stringify(await openPresentation(taskId, resolvedPath), null, 2);
        });
    }

    getDeclaredPermissions(args: z.output<typeof OpenPresentationSchema>, taskState?: TaskState): PermissionRequest[] {
        return [
            {
                resourceType: 'file',
                action: 'read',
                resourcePath: resolveWorkspacePath(args.filePath, taskState)!
            }
        ];
    }
}

class GetPresentationCapabilitiesTool extends BaseTool<typeof PresentationCapabilitiesSchema> {
    constructor() {
        super(
            'get_presentation_capabilities',
            '按主题读取 presentation/v1 的精确字段、枚举、清除语义和最小示例；只读且不需要打开 PPT',
            PresentationCapabilitiesSchema,
            undefined,
            { 'zh-CN': '演示文稿能力', 'en-US': 'Presentation Capabilities' }
        );
        this.setExecutor(async (args) => JSON.stringify(getPresentationAutomationCapabilities(args), null, 2));
    }
}

export function buildSlidesSkill(): Skill {
    return Skill.parseMd(PRESENTATION_AUTOMATION_SKILL);
}

export function createSlidesToolset(
    executeProgram: PresentationProgramExecutor,
    openPresentation: SlidesPresentationOpener
): BaseToolset {
    const toolset = new BaseToolset('presentation-automation');
    toolset.addTools(
        new GetPresentationCapabilitiesTool(),
        new OpenPresentationTool(openPresentation),
        new RunPresentationProgramTool(executeProgram)
    );
    return toolset;
}
