import assert from 'node:assert/strict';
import test from 'node:test';
import pptxgenModule from 'pptxgenjs';
import { openPptx, savePptx } from '@opendesk/genoffice-slides/engine';

test('vendored GenOffice engine opens and saves a generated pptx offline', async () => {
    const PptxGenJS = (pptxgenModule as unknown as { default: typeof pptxgenModule }).default;
    const presentation = new PptxGenJS();
    presentation.layout = 'LAYOUT_WIDE';
    presentation.addSlide().addText('OpenDesk GenOffice smoke test', {
        x: 1,
        y: 1,
        w: 8,
        h: 1,
        fontSize: 24
    });
    const generated = await presentation.write({ outputType: 'arraybuffer' });

    const opened = await openPptx(new Uint8Array(generated as ArrayBuffer));
    assert.equal(opened.deck.slides.length, 1);
    assert.match(JSON.stringify(opened.deck.slides[0]), /OpenDesk GenOffice smoke test/);

    const saved = await savePptx(opened);
    const reopened = await openPptx(saved);
    assert.equal(reopened.deck.slides.length, 1);
    assert.match(JSON.stringify(reopened.deck.slides[0]), /OpenDesk GenOffice smoke test/);
});
