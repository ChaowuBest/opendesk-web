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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '../..');
const sourceDirectory = path.join(projectRoot, 'resources', 'windows-update-service');
const compiler = process.env.CSC_PATH || 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function argument(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    if (!process.argv[index + 1]) throw new Error(`Missing value for --${name}`);
    return process.argv[index + 1];
}

function run(executable, args) {
    const result = spawnSync(executable, args, { cwd: projectRoot, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exit(result.status ?? 1);
}

const outputDirectory = path.resolve(argument('output-dir', path.join(projectRoot, 'out', 'windows-update-service')));
const testOnly = process.argv.includes('--test-only');
fs.mkdirSync(outputDirectory, { recursive: true });

const commonSources = ['OpenDeskUpdateService.cs', 'UpdateProtocol.cs', 'UpdateSecurity.cs', 'UpdateEngine.cs'].map(
    (name) => path.join(sourceDirectory, name)
);
const references = [
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Runtime.Serialization.dll',
    '/reference:System.Security.dll',
    '/reference:System.ServiceProcess.dll'
];

if (testOnly) {
    const testExecutable = path.join(outputDirectory, 'OpenDeskUpdateService.Tests.exe');
    run(compiler, [
        '/nologo',
        '/target:exe',
        '/optimize+',
        '/platform:x64',
        '/main:OpenDesk.UpdateService.UpdateServiceTests',
        `/out:${testExecutable}`,
        ...references,
        ...commonSources,
        path.join(sourceDirectory, 'OpenDeskUpdateService.Tests.cs')
    ]);
    run(testExecutable, []);
} else {
    const serviceExecutable = path.join(outputDirectory, 'OpenDeskUpdateService.exe');
    run(compiler, [
        '/nologo',
        '/target:exe',
        '/optimize+',
        '/platform:x64',
        '/main:OpenDesk.UpdateService.Program',
        `/out:${serviceExecutable}`,
        ...references,
        ...commonSources
    ]);
    process.stdout.write(`${serviceExecutable}\n`);
}
