import assert from 'node:assert/strict';
import test from 'node:test';
import { addElement, createBlankPptx, openPptx, savePptx } from '@bitclub.ai/opendesk-office/engine';

test('packaged Open Slides engine opens and saves a generated pptx offline', async () => {
    const opened = await openPptx(await createBlankPptx());
    assert.equal(opened.deck.slides.length, 1);
    addElement(opened.deck.slides[0], {
        kind: 'textbox',
        offset: { x: 914400, y: 914400, cx: 7315200, cy: 914400 },
        paragraphs: [{ runs: [{ text: 'OpenDesk Open Slides smoke test' }] }]
    });

    const saved = await savePptx(opened);
    const reopened = await openPptx(saved);
    assert.equal(reopened.deck.slides.length, 1);
    assert.match(JSON.stringify(reopened.deck.slides[0]), /OpenDesk Open Slides smoke test/);
});
