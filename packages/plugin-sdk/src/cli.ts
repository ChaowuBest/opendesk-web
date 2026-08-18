#!/usr/bin/env node
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

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { validateOpenDeskPluginPackage } from './package.js';

export interface PluginCliOutput {
    log(message: string): void;
    error(message: string): void;
}

export function runPluginCli(args: string[], output: PluginCliOutput = console): number {
    const [command, directory] = args;
    if (command !== 'validate' || !directory) {
        output.error('Usage: opendesk-plugin-sdk validate <plugin-dir>');
        return 1;
    }
    const result = validateOpenDeskPluginPackage(path.resolve(directory));
    output.log(JSON.stringify(result, null, 2));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
    try {
        process.exitCode = runPluginCli(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
