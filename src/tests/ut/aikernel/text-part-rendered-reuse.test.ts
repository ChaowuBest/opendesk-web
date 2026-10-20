import { afterEach, describe, expect, jest, test } from '@jest/globals';
import path from 'path';
import { marked, TextMessagePart } from '../../../main/aikernel/messages.js';
import { runWithRenderWorkspace, setRenderWorkspace } from '../../../main/utils/marked-file-link.js';

const PILL_TEXT = '[setting.ts](src/main/utils/setting.ts)';

/** 模拟任务 JSON 落盘 → 恢复：不可枚举的内存字段被剥掉，可枚举字段保留 */
function revive(part: TextMessagePart): TextMessagePart {
    return TextMessagePart.assign(JSON.parse(JSON.stringify(part)));
}

describe('TextMessagePart rendered reuse across persistence', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        setRenderWorkspace(null);
    });

    test('reuses the persisted rendering when the workspace is unchanged', async () => {
        await runWithRenderWorkspace('/ws-a', async () => {
            const part = new TextMessagePart(PILL_TEXT);
            const first = await part.render();

            const restored = revive(part);
            const parseSpy = jest.spyOn(marked, 'parse');

            const second = await restored.render();

            expect(second).toBe(first);
            expect(parseSpy).not.toHaveBeenCalled();
        });
    });

    test('re-renders when the restored part is rendered under a different workspace', async () => {
        let restored: TextMessagePart;
        let firstHtml: string;
        await runWithRenderWorkspace('/ws-a', async () => {
            const part = new TextMessagePart(PILL_TEXT);
            firstHtml = await part.render();
            restored = revive(part);
        });

        await runWithRenderWorkspace('/ws-b', async () => {
            const parseSpy = jest.spyOn(marked, 'parse');
            const second = await restored!.render();

            expect(parseSpy).toHaveBeenCalledTimes(1);
            expect(second).not.toBe(firstHtml);
            // 新 workspace 下的 pill 路径必须反映新 workspace
            expect(second).toContain(pathResolve('/ws-b', 'src/main/utils/setting.ts'));
        });
    });

    test('legacy persisted data without the workspace marker re-renders', async () => {
        const restored = TextMessagePart.assign({
            type: 'text',
            text: PILL_TEXT,
            rendered: '<p>stale-from-old-version</p>'
        });
        const parseSpy = jest.spyOn(marked, 'parse');

        await runWithRenderWorkspace('/ws-a', async () => {
            const result = await restored.render();
            expect(parseSpy).toHaveBeenCalledTimes(1);
            expect(result).not.toBe('<p>stale-from-old-version</p>');
        });
    });

    test('streaming append invalidates both rendered and the workspace marker', async () => {
        const part = new TextMessagePart('a');
        await runWithRenderWorkspace('/ws-a', async () => {
            await part.render();
        });

        part.text += 'b';
        part.invalidateRender();

        expect(part.rendered).toBeUndefined();
        expect((part as any).renderedWorkspace).toBeUndefined();

        const parseSpy = jest.spyOn(marked, 'parse');
        await runWithRenderWorkspace('/ws-a', async () => {
            await part.render();
        });
        expect(parseSpy).toHaveBeenCalledTimes(1);
    });

    test('the workspace marker survives repeated persistence round-trips', async () => {
        await runWithRenderWorkspace('/ws-a', async () => {
            const part = new TextMessagePart(PILL_TEXT);
            await part.render();
            let restored = revive(part);
            restored = revive(restored);

            const parseSpy = jest.spyOn(marked, 'parse');
            await restored.render();
            expect(parseSpy).not.toHaveBeenCalled();
        });
    });
});

function pathResolve(workspace: string, relative: string): string {
    return path.resolve(workspace, relative);
}
