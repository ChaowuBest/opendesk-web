import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const outfile = 'dist/cli/opendesk';

/**
 * 注入 shebang，复制到别处可用 ./opendesk 或 node --input-type=module opendesk
 * 为了保持对OpenHarmony HiShell的兼容性，这里使用 #!/bin/env node 而不是 #!/usr/bin/env node
 * 未来当HiShell支持 #!/usr/bin/env node 时，这里就可以改掉了
 */
const SHEBANG = '#!/bin/env node\n';

const requireShimPlugin: esbuild.Plugin = {
    name: 'require-shim',
    setup(build) {
        build.onEnd((result) => {
            if (result.errors.length > 0) return;
            let text: string;
            try {
                text = readFileSync(outfile, 'utf8');
            } catch {
                return;
            }
            // 1. 将 esbuild 注入的“动态 require 抛错”改为 Node 的 createRequire（变量名可能是 x、x3 等）
            if (text.includes('Dynamic require')) {
                const shim = `
                import { createRequire } from 'node:module';
                const __createRequire = createRequire(import.meta.url);
                `;
                const replaced = text.replace(
                    /if \(typeof require !== "undefined"\) return require\.apply\(this, arguments\);\s*throw Error\('Dynamic require of "' \+ (\w+) \+ '" is not supported'\);/,
                    'return __createRequire($1);'
                );
                if (replaced !== text) {
                    text = replaced.startsWith('import { createRequire }') ? replaced : shim + replaced;
                }
            }
            // 2. 无扩展名时无 package.json 仍按 ESM 执行：注入 shebang，复制到别处可用 ./opendesk 或 node --input-type=module opendesk
            if (!text.startsWith('#!')) {
                text = SHEBANG + text;
            }
            writeFileSync(outfile, text, 'utf8');
        });
    },
};

const config: esbuild.BuildOptions = {
    entryPoints: ['src/main/cli.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    external: ['node-screenshots', 'vectra', 'number-to-alphabet'],
    plugins: [requireShimPlugin],
};

async function build() {
    await esbuild.build(config);
}

build().catch((error) => {
    console.error('Failed to build CLI: ', error.message);
    process.exit(1);
});
