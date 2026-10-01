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
    'pwsh.cwd.sandbox': '沙箱内工作目录，使用宿主真实路径（C:...）；默认任务工作区',
    'pwsh.timeout': '命令执行超时时间（毫秒），默认 30000（30 秒）',
    'checkShellStatus.name': '检查Shell状态',
    'status.description':
        '查看 executeBash、executePwsh 或 executeZsh 启动的后台进程当前的执行状态、返回码和输出内容。可通过 kill 参数终止进程。省略 waitMs 或设为 0 时立即返回；若下一步依赖该进程完成，请按预计剩余时间传入正数 waitMs 进行有限等待（范围 0-${max} 毫秒），进程完成时会提前返回。',
    'status.waitMs':
        '可选的有限等待时间（毫秒），范围 0-${max}，默认 0（立即查询）。仅在确实需要即时状态、且查询后可继续其他独立工作时使用 0；确实需要很快再次观察进度时可用 1000-5000；下一步依赖完成结果时优先使用 10000-30000。进程完成时会提前返回，无需等满 waitMs。避免对同一运行中 PID 连续使用 0。',
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
        '- 命令、workingDirectory 以及 PowerShell、Python、Node.js 脚本中的绝对路径直接使用宿主盘符路径（C:X 或 C:/X）；策略与授权按根相对约定 /C/... 映射。',
    'prompt.sandbox.cwd': '- 沙箱工作目录与任务工作空间一致（宿主真实路径，例如 C:/foo）；相对路径从该目录解析。',
    'prompt.sandbox.trash': '- 删除一律送入 Windows 回收站（与 Linux/OHOS 沙箱一致，不区分实例内新建）。',
    'sandbox.description':
        '在 Windows 动态沙箱中执行选定的 powershell 或 Git Bash。子进程直接使用宿主真实路径（C:X 或 C:/X）；策略与授权按根相对约定 /C/... 映射到宿主 C:/...；相对路径从任务工作区（宿主真实路径）解析。文件访问审批仍显示原始宿主路径。',
    'sandbox.pathErrorHint':
        '沙箱路径提示：检测到访问拒绝错误。宿主盘符路径（C:\\foo）在沙箱内直接可用；请检查路径拼写与任务权限规则，或对目标路径发起授权。',
    'sandbox.pipeErrorHint':
        '沙箱命名管道：沙箱内进程以普通用户身份运行，命名管道创建与连接均可用（tsx / npx / IPC 类工具可正常工作）。',
    'sandbox.cwdUnsupported': '沙箱工作目录必须是可映射的 Windows 盘符绝对路径：${path}',
    'sandbox.executableMissing': '动态沙箱已启用，但未找到 sandbox.exe。请重新构建 Windows 版本。',
    'sandbox.endpointFailed': '动态沙箱授权端点未能获取端口。',
    // Linux 动态沙箱（dynobox-linux）
    'sandbox.executableMissing.linux': '动态沙箱已启用，但未找到 dynobox-linux。请重新构建 Linux 版本。',
    'sandbox.cwdMissing.linux': '动态沙箱需要任务工作目录作为受控路径。',
    'sandbox.cwdUnsupported.linux': '沙箱工作目录不存在或不可用：${path}',
    // OpenHarmony 动态沙箱（LD_PRELOAD 版 dynobox-linux）
    'sandbox.executableMissing.ohos': '动态沙箱已启用，但未找到 OpenHarmony 版 dynobox。请重新构建 OpenHarmony 版本。',
    'sandbox.trashDirUnavailable': '无法创建回收站目录 ${path}，请检查家目录写入权限或关闭回收站选项。',
    'prompt.mode.sandbox.linux': '- 当前运行模式：Linux 动态沙箱',
    'prompt.sandbox.linux.transparent':
        '- 沙箱内根文件系统布局与宿主完全一致（/home、/tmp、/var 等均可访问），读写操作经权限检查。',
    'prompt.sandbox.linux.workspace':
        '- 工作区可写；工作区外的写入需要审批（或按规则拒绝）。系统目录（/usr /lib /etc 等）只读。',
    'prompt.sandbox.linux.system':
        '- 系统目录（/usr /lib /bin /etc 等）从宿主只读挂载：Python、Node.js 等运行时依赖原生可用且不可修改。',
    'prompt.sandbox.linux.tmp': '- /tmp 透传宿主目录：沙箱内写入的文件跨命令/跨沙箱实例持久，关闭不丢失。',
    'sandbox.description.linux':
        '在 Linux 动态沙箱中执行选定的 shell。根文件系统布局与宿主一致，读写经权限检查；工作区写放行、其余写询问或拒绝；删除可选送回收站（XDG Trash）。文件访问审批显示原始宿主路径。',
    // darwin 动态沙箱（dynobox-darwin.dylib，DYLD interposing）
    'sandbox.executableMissing.darwin': '动态沙箱已启用，但未找到 dynobox-darwin.dylib。请重新构建 macOS 版本。',
    'sandbox.cwdMissing.darwin': '动态沙箱需要任务工作目录作为受控路径。',
    'sandbox.cwdUnsupported.darwin': '沙箱工作目录不存在或不可用：${path}',
    'prompt.sandbox.darwin.trash':
        '- 任务开始前已存在的文件被删除时会送入 macOS 废纸篓；沙箱运行期间创建的文件在同一沙箱实例内删除时直接清除，不进废纸篓。'
};
