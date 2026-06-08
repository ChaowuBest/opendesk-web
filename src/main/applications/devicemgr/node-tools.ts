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

import { z } from 'zod';
import { BaseTool, BaseToolset, ToolResult } from '../../aikernel/tool.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ExecutionHost } from '../../aikernel/security/harness.js';
import type { DeviceMgrApplication } from './app.js';
import type { NodeInvokeResult } from './common.js';
import {
    NODE_FILE_COMMANDS,
    NODE_SHELL_COMMAND,
    nodeSupportsCommand,
    nodeSupportsShell,
    type NodeShell
} from './execution.js';

type SelectedNodeHost = Extract<ExecutionHost, { type: 'node' }>;

function getSelectedNodeHost(taskState?: TaskState): SelectedNodeHost | null {
    const host = taskState?.harnessContext?.executionHost;
    return host?.type === 'node' ? host : null;
}

function parsePayload(result: NodeInvokeResult): unknown {
    if (typeof result.payloadJSON === 'string' && result.payloadJSON.trim()) {
        try {
            return JSON.parse(result.payloadJSON);
        } catch {
            return result.payloadJSON;
        }
    }
    return result.payload;
}

function payloadToText(payload: unknown): string {
    if (payload === undefined || payload === null) return '';
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload, null, 2);
}

function formatShellOutput(payload: unknown): string {
    if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>;
        const stdout = typeof obj.stdout === 'string' ? obj.stdout : '';
        const stderr = typeof obj.stderr === 'string' ? obj.stderr : '';
        const error = typeof obj.error === 'string' ? obj.error : '';
        const parts = [stdout, stderr, error].filter(Boolean);
        if (parts.length > 0) return parts.join('\n').trimEnd();
    }
    return payloadToText(payload).trimEnd();
}

abstract class NodeCommandTool<T extends z.ZodType> extends BaseTool<T> {
    protected app: DeviceMgrApplication;
    protected nodeCommand: string;

    constructor(app: DeviceMgrApplication, name: string, description: string, params: T, nodeCommand: string) {
        super(name, description, params);
        this.app = app;
        this.nodeCommand = nodeCommand;
    }

    isAvailable(taskState?: TaskState): boolean {
        const host = getSelectedNodeHost(taskState);
        if (!host || !nodeSupportsCommand(host.capabilities, this.nodeCommand)) return false;
        const gateway = this.app.getGateway();
        return Boolean(gateway?.isRunning() && gateway.getNodeRegistry().get(host.nodeId));
    }

    protected async invokeSelectedNode(
        taskState: TaskState | undefined,
        payload?: unknown,
        timeoutMs?: number
    ): Promise<unknown> {
        const host = getSelectedNodeHost(taskState);
        if (!host) {
            throw new Error('当前任务未选择 node，无法执行 node 工具');
        }
        if (!nodeSupportsCommand(host.capabilities, this.nodeCommand)) {
            throw new Error(`节点 ${host.nodeId} 不支持 ${this.nodeCommand}`);
        }

        const gateway = this.app.getGateway();
        if (!gateway?.isRunning()) {
            throw new Error('设备网关未启动，无法执行 node 工具');
        }
        const result = await gateway.getNodeRegistry().invoke({
            nodeId: host.nodeId,
            command: this.nodeCommand,
            params: payload,
            timeoutMs
        });
        if (!result.ok) {
            const code = result.error?.code ?? 'NODE_INVOKE_FAILED';
            const message = result.error?.message ?? 'node invoke failed';
            throw new Error(`${code}: ${message}`);
        }
        return parsePayload(result);
    }

    protected async invokeSelectedNodeText(
        taskState: TaskState | undefined,
        payload?: unknown,
        timeoutMs?: number
    ): Promise<string> {
        return payloadToText(await this.invokeSelectedNode(taskState, payload, timeoutMs));
    }
}

const NodeShellSchema = z.object({
    command: z.string().min(1, '命令不能为空').describe('要在当前选中 node 上执行的 shell 命令'),
    shell: z
        .enum(['auto', 'bash', 'zsh', 'powershell', 'cmd', 'sh'])
        .optional()
        .default('auto')
        .describe('node 上要使用的 shell。auto 使用 node 声明的默认 shell'),
    description: z.string().optional().describe('对该命令意图的简短描述，用于界面展示'),
    workingDirectory: z
        .string()
        .optional()
        .describe('node 上的执行目录。未指定时使用 node 自己的默认目录；相对路径由 node 端解析'),
    timeout: z.number().int().positive().optional().default(30000).describe('命令执行超时时间（毫秒），默认 30000ms')
});

export class ExecuteNodeShellTool extends NodeCommandTool<typeof NodeShellSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'executeNodeShell',
            '在当前选中的 node 上执行 shell 命令。该工具只访问 node 端环境；OpenDesk 本机 shell 请使用 executeBash/executePowerShell/executeZsh。',
            NodeShellSchema,
            NODE_SHELL_COMMAND
        );
        this.setUniversalExecutor(this.run.bind(this));
    }

    async run(args: z.output<typeof NodeShellSchema>, result: ToolResult, taskState?: TaskState): Promise<void> {
        const host = getSelectedNodeHost(taskState);
        if (!host) {
            throw new Error('当前任务未选择 node，无法执行 node shell 工具');
        }
        const shell = args.shell ?? 'auto';
        if (shell !== 'auto' && !nodeSupportsShell(host.capabilities, shell as Exclude<NodeShell, 'auto'>)) {
            throw new Error(`节点 ${host.nodeId} 不支持 ${shell} shell`);
        }
        const payload = await this.invokeSelectedNode(
            taskState,
            {
                command: args.command,
                shell,
                cwd: args.workingDirectory,
                timeoutMs: args.timeout
            },
            args.timeout
        );
        result.updateResult(formatShellOutput(payload));
    }
}

const NodeReadFileSchema = z.object({
    path: z.string().min(1).describe('node 上要读取的文件路径，支持 node 默认目录下的相对路径或绝对路径'),
    offset: z.number().int().min(1).optional().describe('起始行号，默认 1'),
    limit: z.number().int().min(1).optional().describe('读取行数，未指定则读取到文件末尾')
});

export class ReadNodeFileTool extends NodeCommandTool<typeof NodeReadFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'readNodeFile',
            '读取当前选中 node 本地文件系统中的文本文件。该工具不读取 OpenDesk 本机文件。',
            NodeReadFileSchema,
            NODE_FILE_COMMANDS.readText
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeReadFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, {
            path: args.path,
            file_path: args.path,
            offset: args.offset,
            limit: args.limit
        });
    }
}

const NodeWriteFileSchema = z.object({
    path: z.string().min(1).describe('node 上要写入的文件路径，支持 node 默认目录下的相对路径或绝对路径'),
    content: z.string().describe('要写入的文本内容'),
    mode: z.enum(['overwrite', 'append']).optional().default('overwrite').describe('写入模式，默认覆盖，append 为追加')
});

export class WriteNodeFileTool extends NodeCommandTool<typeof NodeWriteFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'writeNodeFile',
            '将文本写入当前选中 node 的本地文件系统。该工具不写入 OpenDesk 本机文件。',
            NodeWriteFileSchema,
            NODE_FILE_COMMANDS.writeText
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeWriteFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, {
            path: args.path,
            content: args.content,
            mode: args.mode
        });
    }
}

const NodeEditFileSchema = z.object({
    filePath: z.string().min(1).describe('node 上要修改或创建的文件路径'),
    oldString: z.string().describe('要替换的原始文本。使用空字符串可创建新文件'),
    newString: z.string().describe('替换后的新文本。当创建新文件时，此参数将成为文件内容'),
    expectedReplacements: z.number().int().min(1).optional().describe('预期替换次数，默认 1')
});

export class EditNodeFileTool extends NodeCommandTool<typeof NodeEditFileSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'editNodeFile',
            '在当前选中 node 的文件中执行精确文本替换，也可用空 oldString 创建 node 上的新文件。',
            NodeEditFileSchema,
            NODE_FILE_COMMANDS.editText
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeEditFileSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
    }
}

const NodeSearchReplaceSchema = z.object({
    filePath: z.string().min(1).describe('node 上要执行搜索替换的文件路径'),
    oldString: z.string().describe('要搜索的字符串'),
    newString: z.string().describe('替换 oldString 的新字符串')
});

export class SearchReplaceNodeFileTool extends NodeCommandTool<typeof NodeSearchReplaceSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'searchReplaceNodeFile',
            '在当前选中 node 的指定文件中执行一次搜索替换操作。',
            NodeSearchReplaceSchema,
            NODE_FILE_COMMANDS.searchReplace
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeSearchReplaceSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
    }
}

const NodeGlobSchema = z.object({
    pattern: z.string().min(1).describe('node 上的 glob 模式，如 **/*.ts、src/**/*.js、*.md'),
    path: z.string().optional().describe('node 上的搜索根目录，默认使用 node 默认目录'),
    ignore: z.array(z.string()).optional().describe('额外忽略模式，是否生效取决于 node 实现'),
    caseSensitive: z.boolean().optional().default(false).describe('是否区分大小写，是否生效取决于 node 实现'),
    maxResults: z.number().int().min(1).max(1000).optional().default(200).describe('最大返回结果数，默认 200')
});

export class GlobNodeFilesTool extends NodeCommandTool<typeof NodeGlobSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'globNodeFiles',
            '在当前选中 node 的文件系统中使用 glob 模式搜索文件。',
            NodeGlobSchema,
            NODE_FILE_COMMANDS.glob
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeGlobSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
    }
}

const NodeGrepSchema = z.object({
    pattern: z.string().min(1).describe('node 上要搜索的文本或正则表达式'),
    path: z.string().optional().describe('node 上的搜索根目录，默认使用 node 默认目录'),
    filePattern: z.string().optional().default('**/*').describe('要搜索的文件 glob 模式，默认 **/*'),
    ignoreCase: z.boolean().optional().default(true).describe('是否忽略大小写，默认 true'),
    maxResults: z.number().int().min(1).max(1000).optional().default(50).describe('最大匹配数，默认 50'),
    contextLines: z.number().int().min(0).max(10).optional().default(0).describe('上下文行数，是否生效取决于 node 实现')
});

export class GrepNodeFilesTool extends NodeCommandTool<typeof NodeGrepSchema> {
    constructor(app: DeviceMgrApplication) {
        super(
            app,
            'grepNodeFiles',
            '在当前选中 node 的文件内容中搜索文本或正则表达式。',
            NodeGrepSchema,
            NODE_FILE_COMMANDS.grep
        );
        this.setExecutor(this.run.bind(this));
    }

    private async run(args: z.output<typeof NodeGrepSchema>, taskState?: TaskState): Promise<string> {
        return await this.invokeSelectedNodeText(taskState, args);
    }
}

export function createNodeExecutionToolset(app: DeviceMgrApplication): BaseToolset {
    const toolset = new BaseToolset('devicemgr-node');
    toolset.addTool(new ExecuteNodeShellTool(app));
    toolset.addTool(new ReadNodeFileTool(app));
    toolset.addTool(new WriteNodeFileTool(app));
    toolset.addTool(new EditNodeFileTool(app));
    toolset.addTool(new SearchReplaceNodeFileTool(app));
    toolset.addTool(new GlobNodeFilesTool(app));
    toolset.addTool(new GrepNodeFilesTool(app));
    return toolset;
}
