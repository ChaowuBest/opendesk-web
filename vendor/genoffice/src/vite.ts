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

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const harfbuzzDist = path.dirname(require.resolve('harfbuzzjs'));
const harfbuzzWasmModuleId = '@opendesk/genoffice-slides/harfbuzz-wasm?asset';

export const genOfficeSlidesMainBuildPlugin = {
    name: 'genoffice-slides:build-main',
    async buildStart(): Promise<void> {
        await Promise.all([
            build({
                entryPoints: [path.join(packageRoot, 'src', 'main.ts')],
                outfile: path.join(packageRoot, 'dist', 'main.js'),
                bundle: true,
                format: 'esm',
                platform: 'node',
                target: 'node22',
                sourcemap: false,
                legalComments: 'none',
                external: ['electron', '@genspark/cli'],
                plugins: [
                    {
                        name: 'genoffice-slides:resolve-harfbuzz',
                        setup(esbuild): void {
                            esbuild.onResolve({ filter: /harfbuzz\.js$/ }, () => ({
                                path: path.join(harfbuzzDist, 'harfbuzz.js')
                            }));
                            esbuild.onResolve({ filter: /harfbuzz\.wasm\?asset$/ }, () => ({
                                path: harfbuzzWasmModuleId,
                                external: true
                            }));
                        }
                    }
                ]
            }),
            build({
                entryPoints: [require.resolve('@genspark/cli')],
                outfile: path.join(packageRoot, 'dist', 'genspark-cli.cjs'),
                bundle: true,
                format: 'cjs',
                platform: 'node',
                target: 'node22',
                sourcemap: false,
                legalComments: 'none',
                banner: {
                    js: "const __import_meta_url__ = require('node:url').pathToFileURL(__filename).href;"
                },
                define: {
                    'import.meta.url': '__import_meta_url__'
                }
            })
        ]);
    }
};

export const genOfficeSlidesEntries = {
    preload: path.join(packageRoot, 'src', 'preload.ts')
};

export function createGenOfficeSlidesViteAliases(): Record<string, string> {
    return {
        '@opendesk-slides/main': path.join(packageRoot, 'dist', 'main.js'),
        '@opendesk-slides/preload': path.join(packageRoot, 'src', 'preload.ts'),
        '@opendesk-slides/renderer': path.join(packageRoot, 'src', 'renderer.ts'),
        [harfbuzzWasmModuleId]: `${path.join(
            harfbuzzDist,
            'harfbuzz.wasm'
        )}?asset`,
        '../../../../node_modules/harfbuzzjs/dist/harfbuzz.js': path.join(
            harfbuzzDist,
            'harfbuzz.js'
        ),
        '../../../../node_modules/harfbuzzjs/dist/harfbuzz.wasm?asset': `${path.join(
            harfbuzzDist,
            'harfbuzz.wasm'
        )}?asset`
    };
}
