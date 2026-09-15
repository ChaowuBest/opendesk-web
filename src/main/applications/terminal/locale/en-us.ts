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
    'pwsh.timeout': 'Execution timeout in milliseconds; defaults to 30000 (30 seconds)',
    'checkShellStatus.name': 'Check Shell Status',
    'status.description':
        'Check the current status, exit code and output of a background process started by executeBash, executePwsh or executeZsh. Use kill to terminate it. Returns immediately without waiting for the process to finish.',
    'shell.sandboxTag': 'Sandbox',
    'sandbox.description':
        'Run the selected powershell in the Windows dynamic sandbox. Use host paths such as C:\\foo or D:\\work in command arguments and the working directory; startup maps them automatically and file approvals show the original host paths. Absolute paths inside script files are not rewritten: use relative paths or build mapped paths from $env:SBX_ROOT (for example, Join-Path $env:SBX_ROOT C/foo). Do not hardcode the sandbox drive letter.',
    'sandbox.executableMissing':
        'Dynamic sandbox is enabled, but sandbox.exe was not found. Rebuild the Windows version.',
    'sandbox.endpointFailed': 'Could not obtain a port for the dynamic sandbox authorization endpoint.',
    'sandbox.loopbackSetupFailed':
        'Could not initialize local network access for the sandbox. Allow the Windows administrator confirmation and retry. OpenDesk continues to run without administrator privileges after setup.'
};
