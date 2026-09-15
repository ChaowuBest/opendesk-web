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

export const zhCn: Record<string, string> = {
    'app.name': '终端',
    'output.truncated': '输出过大，已截断显示',
    'output.artifactSaved': '完整输出已保存至',
    'pwsh.description':
        '使用选定的 powershell 执行命令。超过超时时间的命令会转入后台，可通过 checkShellStatus 查看执行状态。',
    'pwsh.command.empty': '命令不能为空',
    'pwsh.command': '要执行的 powershell 命令',
    'pwsh.intent': '对命令意图的简短描述，用于在界面中展示，例如“检查 powershell 版本”',
    'pwsh.cwd': '执行命令的工作目录，默认使用任务工作区',
    'pwsh.timeout': '命令执行超时时间（毫秒），默认 30000（30 秒）',
    'checkShellStatus.name': '检查Shell状态',
    'status.description':
        '查看 executeBash、executePwsh 或 executeZsh 启动的后台进程当前的执行状态、返回码和输出内容。可通过 kill 参数终止进程。此工具立即返回，不等待进程结束。',
    'shell.sandboxTag': '沙箱',
    'sandbox.description':
        '在 Windows 动态沙箱中执行选定的 powershell。命令参数和工作目录使用宿主路径，如 C:\\foo 或 D:\\work；启动时自动映射，文件访问审批显示原始宿主路径。脚本文件内的绝对路径不会自动改写，可使用相对路径或通过 $env:SBX_ROOT 拼接映射路径（如 Join-Path $env:SBX_ROOT C/foo），不要硬编码沙箱盘符。',
    'sandbox.executableMissing': '动态沙箱已启用，但未找到 sandbox.exe。请重新构建 Windows 版本。',
    'sandbox.endpointFailed': '动态沙箱授权端点未能获取端口。',
    'sandbox.loopbackSetupFailed':
        '未能完成沙箱本地网络初始化。请允许 Windows 管理员确认后重试；初始化完成后，OpenDesk 仍以普通权限运行。'
};
