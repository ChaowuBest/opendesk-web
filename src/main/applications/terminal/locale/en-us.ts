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

export const enUs: Record<string, string> = {
    'app.name': 'Terminal',
    'output.truncated': 'Output too large; display truncated',
    'output.artifactSaved': 'Complete output saved to',
    'pwsh.description':
        'Execute commands using the selected powershell. Commands that exceed the timeout continue in the background; use checkShellStatus to inspect them.',
    'pwsh.command.empty': 'Command cannot be empty',
    'pwsh.command': 'The powershell command to execute',
    'pwsh.intent': 'A short description of the command intent for display, such as "Check powershell version"',
    'pwsh.cwd': 'Working directory; defaults to the task workspace',
    'pwsh.cwd.sandbox': 'Sandbox working directory in /C/... form; defaults to the mapped task workspace',
    'pwsh.timeout': 'Execution timeout in milliseconds; defaults to 30000 (30 seconds)',
    'checkShellStatus.name': 'Check Shell Status',
    'status.description':
        'Check the current status, exit code and output of a background process started by executeBash, executePwsh or executeZsh. Use kill to terminate it. Returns immediately without waiting for the process to finish.',
    'shell.sandboxTag': 'Sandbox',
    'prompt.title': '# Terminal execution environment',
    'prompt.active': '- Active terminal: ${shell} (`${path}`)',
    'prompt.shell.powershell': 'PowerShell',
    'prompt.shell.bash': 'Bash',
    'prompt.shell.zsh': 'Zsh',
    'prompt.mode.host': '- Execution mode: directly on the host system',
    'prompt.mode.sandbox': '- Execution mode: Windows dynamic sandbox',
    'prompt.mode.sandbox.linux': '- Execution mode: Linux dynamic sandbox',
    'prompt.sandbox.rootPaths':
        '- Use stable root-relative paths: /C/... maps to host C:/..., /D/... maps to host D:/..., and so on.',
    'prompt.sandbox.absolutePaths':
        '- Absolute paths in commands, workingDirectory, and PowerShell, Python, or Node.js scripts must use /<drive>/... form; do not use host drive paths or the dynamic sandbox drive letter.',
    'prompt.sandbox.cwd':
        '- The sandbox working directory matches the task workspace; for example, workspace C:/foo maps to /C/foo, and relative paths resolve from there.',
    'prompt.sandbox.trash':
        '- Files that existed before this task started are moved to the Windows Recycle Bin when deleted; files created during a sandbox run are removed permanently when deleted within the same sandbox instance.',
    'sandbox.description':
        'Run the selected powershell in the Windows dynamic sandbox. Use stable root-relative paths: /C/... maps to host C:/..., and /D/... maps to host D:/.... Absolute paths in commands, workingDirectory, and scripts must use /<drive>/... form; relative paths resolve from the mapped task workspace. File approvals still show original host paths.',
    'sandbox.pathErrorHint':
        'Sandbox path hint: a Windows drive path was reported with an access-denied error. If the path refers to a host file, use the sandbox root-relative path instead, for example C:\\foo -> /C/foo or D:\\bar -> /D/bar.',
    'sandbox.pipeErrorHint':
        'Sandbox pipe hint: AppContainer processes inside the sandbox cannot create named pipes. Tools that rely on named-pipe IPC fail here; for example run tsx via node --import tsx instead of npx tsx, or use an equivalent command that does not need pipes.',
    'sandbox.cwdUnsupported':
        'The sandbox working directory must be an absolute Windows drive path that can be mapped: ${path}',
    'sandbox.executableMissing':
        'Dynamic sandbox is enabled, but sandbox.exe was not found. Rebuild the Windows version.',
    'sandbox.endpointFailed': 'Could not obtain a port for the dynamic sandbox authorization endpoint.',
    'prompt.sandbox.linux.transparent':
        '- The sandbox root filesystem mirrors the host layout (/home, /tmp, /var, etc. are all visible); reads and writes go through permission checks.',
    'prompt.sandbox.linux.workspace':
        '- The workspace is writable; writes outside the workspace require approval (or are denied by rules). System dirs (/usr /lib /etc etc.) are read-only.',
    'prompt.sandbox.linux.tmp':
        '- /tmp maps to the host directory: files written in the sandbox persist across commands and sandbox instances.',
    'sandbox.executableMissing.linux':
        'Dynamic sandbox enabled but dynobox-linux was not found. Rebuild the Linux package.',
    'sandbox.cwdMissing.linux': 'Dynamic sandbox requires a task workspace as the controlled path.',
    'sandbox.cwdUnsupported.linux': 'Sandbox working directory is missing or unusable: ${path}',
    'sandbox.description.linux':
        'Run the selected shell in the Linux dynamic sandbox. The root filesystem mirrors the host layout and reads/writes go through permission checks; workspace writes are allowed while other writes prompt or are denied; deletions can optionally go to the trash (XDG Trash). File approvals show original host paths.',
    'sandbox.loopbackSetupFailed':
        'Could not initialize local network access for the sandbox. Allow the Windows administrator confirmation and retry. OpenDesk continues to run without administrator privileges after setup.'
};
