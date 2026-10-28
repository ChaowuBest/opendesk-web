import assert from 'node:assert/strict';
import test from 'node:test';
import { runPresentationProgram } from '@bitclub.ai/opendesk-office/presentation-automation';
import { reviewPresentationContent } from '../../../../main/office/presentationContentReview.js';

async function deckWithContents(page: number, title = 'Actual chapter') {
    const result = await runPresentationProgram({
        startFrom: 'blank',
        program: `
        deck.setSize({ width: 960, height: 540 });
        const toc = deck.slide(0);
        toc.add({kind:'text', text:'目 录', box:{x:40,y:40,w:400,h:50}});
        toc.add({kind:'text', text:'Actual chapter', box:{x:60,y:150,w:400,h:40}});
        toc.add({kind:'text', text:'${page}', box:{x:820,y:150,w:60,h:40}});
        deck.addSlide({}).add({kind:'text', text:${JSON.stringify(title)}, box:{x:40,y:40,w:400,h:50}});
    `
    });
    assert.equal(result.ok, true);
    return result.bytes!;
}

test('rejects a contents page pointing beyond the actual deck even when layout passes', async () => {
    const review = await reviewPresentationContent(await deckWithContents(7), 2);
    assert.equal(review.passed, false);
    assert.ok(review.findings.some((f) => f.code === 'CONTENTS_PAGE_OUT_OF_RANGE'));
});

test('checks declared page count and contents titles against the destination slide', async () => {
    const review = await reviewPresentationContent(await deckWithContents(2, 'Different chapter'), 5);
    assert.equal(review.passed, false);
    assert.ok(review.findings.some((f) => f.code === 'SLIDE_COUNT_MISMATCH'));
    assert.ok(review.findings.some((f) => f.code === 'CONTENTS_TITLE_MISMATCH'));
});

test('accepts consistent contents and returns actual text for final content review', async () => {
    const review = await reviewPresentationContent(await deckWithContents(2), 2);
    assert.equal(review.passed, true);
    assert.equal(review.slides.length, 2);
    assert.ok(review.slides[1]!.texts.includes('Actual chapter'));
});

test('does not treat ordinary numeric data as contents page references', async () => {
    const result = await runPresentationProgram({
        startFrom: 'blank',
        program: `
        deck.slide(0).add({kind:'text',text:'Revenue',box:{x:40,y:40,w:400,h:50}});
        deck.slide(0).add({kind:'text',text:'Customers',box:{x:40,y:150,w:400,h:40}});
        deck.slide(0).add({kind:'text',text:'999',box:{x:820,y:150,w:60,h:40}});
    `
    });
    assert.equal(result.ok, true);
    assert.equal((await reviewPresentationContent(result.bytes!, 1)).passed, true);
});
