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
    'pwsh.cwd.sandbox': '沙箱内工作目录，使用 /C/... 形式；默认映射到任务工作区',
    'pwsh.timeout': '命令执行超时时间（毫秒），默认 30000（30 秒）',
    'checkShellStatus.name': '检查Shell状态',
    'status.description':
        '查看 executeBash、executePwsh 或 executeZsh 启动的后台进程当前的执行状态、返回码和输出内容。可通过 kill 参数终止进程。此工具立即返回，不等待进程结束。',
    'shell.sandboxTag': '沙箱',
    'prompt.title': '# 终端执行环境',
    'prompt.active': '- 当前终端：${shell} (`${path}`)',
    'prompt.shell.powershell': 'PowerShell',
    'prompt.shell.bash': 'Bash',
    'prompt.shell.zsh': 'Zsh',
    'prompt.mode.host': '- 当前运行模式：直接在宿主系统执行',
    'prompt.mode.sandbox': '- 当前运行模式：Windows 动态沙箱',
    'prompt.sandbox.rootPaths':
        '- 使用稳定的根相对路径映射：/C/... 表示宿主 C:/...，/D/... 表示宿主 D:/...，其他盘符以此类推。',
    'prompt.sandbox.absolutePaths':
        '- 命令、workingDirectory 以及 PowerShell、Python、Node.js 脚本中的绝对路径必须使用 /<盘符>/... 形式；不要使用宿主盘符路径或动态沙箱盘符。',
    'prompt.sandbox.cwd':
        '- 沙箱工作目录与任务工作空间一致，例如工作空间 C:/foo 会映射为 /C/foo；相对路径从该目录解析。',
    'prompt.sandbox.trash': '- 沙箱内直接删除的文件会送入 Windows 回收站。',
    'sandbox.description':
        '在 Windows 动态沙箱中执行选定的 powershell。使用稳定的根相对路径：/C/... 表示宿主 C:/...，/D/... 表示宿主 D:/...。命令、workingDirectory 和脚本中的绝对路径必须使用 /<盘符>/...；相对路径从映射后的任务工作空间解析。文件访问审批仍显示原始宿主路径。',
    'sandbox.pathErrorHint':
        '沙箱路径提示：检测到 Windows 盘符绝对路径和访问拒绝错误。如果路径指向宿主文件，请改用沙箱根相对路径，例如 C:\\foo 改为 /C/foo，D:\\bar 改为 /D/bar。',
    'sandbox.cwdUnsupported': '沙箱工作目录必须是可映射的 Windows 盘符绝对路径：${path}',
    'sandbox.executableMissing': '动态沙箱已启用，但未找到 sandbox.exe。请重新构建 Windows 版本。',
    'sandbox.endpointFailed': '动态沙箱授权端点未能获取端口。',
    'sandbox.loopbackSetupFailed':
        '未能完成沙箱本地网络初始化。请允许 Windows 管理员确认后重试；初始化完成后，OpenDesk 仍以普通权限运行。'
};
