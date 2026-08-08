import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBlankDocx, parseDocx, saveDocx } from '@bitclub.ai/opendesk-office/word-engine';

test('packaged Open Docs engine creates, saves and reopens a docx offline', async () => {
    const document = await parseDocx(await buildBlankDocx());
    const saved = await saveDocx(
        document,
        document.blocks
            .filter((block) => !block.hidden && block.docxIndex !== null)
            .map((block) => ({ kind: 'original', docxIndex: block.docxIndex! }))
    );
    const reopened = await parseDocx(saved);

    assert.equal(reopened.blocks.length, document.blocks.length);
});
