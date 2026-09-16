import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('renderer tools do not bundle main-process utilities', async () => {
    const entryPoint = fileURLToPath(new URL('../../../main/applications/widget_utils.ts', import.meta.url));
    const result = await build({
        entryPoints: [entryPoint],
        bundle: true,
        platform: 'browser',
        packages: 'external',
        write: false,
        metafile: true
    });
    const inputs = Object.keys(result.metafile!.inputs).map((path) => path.replaceAll('\\', '/'));

    expect(inputs).not.toContain('src/main/aikernel/messages.ts');
    expect(inputs).not.toContain('src/main/utils/logger.ts');
    expect(inputs).not.toContain('src/main/utils/setting.ts');
});
