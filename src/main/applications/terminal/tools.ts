import { exec } from "child_process";
import { BaseTool } from "../../agents/tool";
import { ToolCall } from "../../agents/messages";
import { z } from 'zod';
import { promisify } from 'util';
import fs from 'fs';
import iconv from 'iconv-lite';


function renderTerminalToolCall(cmdName: string, toolcall: ToolCall): string | undefined {
    return `
    <!-- 终端主容器 -->
    <div class="terminal-window w-full max-w-4xl rounded-xl overflow-hidden border border-gray-300 flex flex-col my-2 font-mono">
        <!-- macOS 顶部标题栏 (浅色渐变) -->
        <div class="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-gray-100 to-gray-200 border-b border-gray-300">
            <div class="text-[12px] font-medium text-gray-600 flex items-center gap-2">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                FillipDesk Agent -- ${cmdName} Terminal
            </div>
            <div class="w-12"></div>
        </div>

        <!-- 终端内容区域 -->
        <div class="p-3 text-xs xs:text-base leading-relaxed overflow-y-none custom-scrollbar text-gray-800">

            <!-- 执行脚本 -->
            <div class="mb-2 flex items-start">
                <span class="text-blue-500 font-bold mr-2">❯</span>
                <div>
                    <span class="text-blue-600">/home</span>
                    <span class="text-gray-800 ml-1">${toolcall.args_object?.command}</span>
                </div>
            </div>

            <!-- 过程记录 -->
            <div class="space-y-1 mb-4 border-l-2 border-gray-200 pl-4 ml-1">
                ${toolcall.result === undefined
                    ? `<div class="flex items-center gap-2 text-gray-400 animate-pulse h-7">
                            <svg class="w-5 h-5 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                            <span>命令执行中，请稍候…</span>
                        </div>`
                    : `<pre>${toolcall.result}</pre>`}
            </div>
        </div>
    </div>
    `
}

const ExecuteCmdArgsSchema = z.object({
    command: z.string().describe('要执行的CMD命令'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用系统默认目录')
});

export class ExecuteCmdTool extends BaseTool<typeof ExecuteCmdArgsSchema> {
    constructor() {
        super(
            'executeCmd',
            '在 Windows 下执行 cmd 命令。可以执行任何有效的 Windows CMD 命令，如 dir、cd、type、echo 等',
            ExecuteCmdArgsSchema
        );

        this.executor = this.executeCommand;
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('CMD', toolcall);
    }

    /**
     * Execute a command in cmd
     */
    async executeCommand(args: z.output<typeof ExecuteCmdArgsSchema>): Promise<string> {
        let command: string = args.command;
        let workingDirectory: string | undefined = args.workingDirectory;

        const execAsync = promisify(exec);
        try {
            const options: any = {
                encoding: 'buffer',
                maxBuffer: 10 * 1024 * 1024, // 10MB
            };

            if (workingDirectory && fs.existsSync(workingDirectory)) {
                options.cwd = workingDirectory;
            }

            const { stdout, stderr } = await execAsync(`cmd /c ${command}`, options);
            const out = iconv.decode(stdout, 'cp936');
            const err = iconv.decode(stderr, 'cp936');

            let result = '';
            if (out) { result += `标准输出流：\n${out}\n`; }
            if (err) { result += `标准错误流：\n${err}\n`; }
            if (!out && !err) { result = '命令执行成功'; }

            const output = result.trim() || '命令执行完成。';
            return output;
        } catch (error: any) {
            return `执行命令时出错: ${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`;
        }
    }
}

const ExecuteBashArgsSchema = z.object({
    command: z.string().describe('要执行的BASH命令'),
    workingDirectory: z.string().optional().describe('执行命令的工作目录，如果不指定则使用系统默认目录')
});

export class ExecuteBashTool extends BaseTool<typeof ExecuteBashArgsSchema> {
    constructor() {
        super(
            'executeBash',
            '在 Linux/macOS 下执行 bash 命令。可以执行任何有效的 Linux/macOS BASH 命令，如 ls、cd、cat、echo 等',
            ExecuteBashArgsSchema
        );

        this.executor = this.executeCommand;
    }

    executeCommand(args: z.output<typeof ExecuteBashArgsSchema>): Promise<string> {
        let command: string = args.command;
        let workingDirectory: string | undefined = args.workingDirectory;

        // MacOS/Linux 下执行命令
        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const fs = require('fs');
            const path = require('path');

            // 校验命令
            if (!command || typeof command !== 'string') {
                return resolve('请输入要执行的 bash 命令。');
            }

            // 设置工作目录
            let cwd: string | undefined = undefined;
            if (workingDirectory && typeof workingDirectory === 'string' && fs.existsSync(workingDirectory)) {
                cwd = workingDirectory;
            }

            // 开启进程
            const bash = spawn('/bin/bash', ['-c', command], { cwd });

            let stdout = '';
            let stderr = '';

            bash.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            bash.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            bash.on('close', (code: number) => {
                let result = '';
                if (stdout) { result += `标准输出流：\n${stdout}\n`; }
                if (stderr) { result += `标准错误流：\n${stderr}\n`; }
                if (!stdout && !stderr) { result = `进程退出，代码 ${code}`; }
                const output = result.trim() || '命令执行完成。';
                resolve(output);
            });

            bash.on('error', (err: Error) => {
                resolve(`执行命令时出错: ${err.message}`);
            });
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderTerminalToolCall('BASH', toolcall);
    }
}

const readFileSchema = z.object({
    path: z.string().describe('要读取的文件路径')
});

export class ReadFileTool extends BaseTool<typeof readFileSchema> {
    constructor() {
        super(
            'readFile',
            '读取文件原始文本内容, 可用来读取文本、代码、配置文件等文本格式数据',
            readFileSchema
        );

        this.executor = this.executeCommand;
    }

    executeCommand(args: z.output<typeof readFileSchema>): Promise<string> {
        return new Promise((resolve, reject) => {
            fs.readFile(args.path, 'utf8', (err, data) => {
                if (err) {
                    reject(err);
                }
                resolve(data);
            });
        });
    }
}

const writeFileSchema = z.object({
    path: z.string().describe('要写入的文件路径'),
    content: z.string().describe('要写入的文件内容')
});

export class WriteFileTool extends BaseTool<typeof writeFileSchema> {
    constructor() {
        super(
            'writeFile',
            '将文件内容写入执行的路径',
            writeFileSchema
        );

        this.executor = this.executeCommand;
    }

    executeCommand(args: z.output<typeof writeFileSchema>): Promise<string> {
        return new Promise((resolve, reject) => {
            fs.writeFile(args.path, args.content, 'utf8', (err) => {
                if (err) {
                    reject(err);
                }
                resolve('文件写入成功');
            });
        });
    }
}