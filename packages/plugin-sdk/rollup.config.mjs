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

import { builtinModules } from 'node:module';
import typescript from '@rollup/plugin-typescript';
import { dts } from 'rollup-plugin-dts';

const input = {
    index: 'src/index.ts',
    package: 'src/package.ts',
    cli: 'src/cli.ts'
};
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const external = (id) => id === 'zod' || builtins.has(id);

export default [
    {
        input,
        external,
        plugins: [
            typescript({
                tsconfig: './tsconfig.json',
                declaration: false,
                declarationMap: false
            })
        ],
        output: {
            dir: 'dist',
            format: 'es',
            sourcemap: true,
            entryFileNames: '[name].js'
        }
    },
    {
        input,
        external,
        plugins: [dts({ tsconfig: './tsconfig.json' })],
        output: {
            dir: 'dist',
            format: 'es',
            entryFileNames: '[name].d.ts'
        }
    }
];
