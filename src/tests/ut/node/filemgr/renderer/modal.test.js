import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { showDeleteRootModal } from '../../../../../main/applications/filemgr/renderer/modal.js';
import { createRendererTranslator } from '../../../../../renderer/locale.ts';

test('remove scan path modal follows theme tokens and uses plain localized wording', async (t) => {
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    const originalDocument = globalThis.document;
    globalThis.document = document;
    t.after(() => {
        globalThis.document = originalDocument;
    });

    const resultPromise = showDeleteRootModal({
        rootName: '<classifier-test>',
        mountTarget: document.body,
        t: createRendererTranslator('zh-CN')
    });

    const overlay = document.querySelector('.od-confirm-modal-overlay');
    const styles = overlay?.querySelector('style')?.textContent ?? '';
    assert.ok(overlay);
    assert.match(styles, /background:\s*var\(--mc-card-bg/);
    assert.match(styles, /color:\s*var\(--mc-ink/);
    assert.match(styles, /border-top:\s*1px solid var\(--mc-line-soft/);
    assert.equal(document.querySelector('.od-confirm-modal-title')?.textContent, '移除扫描路径');
    assert.equal(
        document.querySelector('.od-confirm-modal-body')?.textContent,
        '要移除扫描路径「<classifier-test>」吗？移除后将不再扫描这个文件夹，相关的搜索数据会被清除，但不会删除任何文件。'
    );
    assert.equal(document.querySelector('[data-action="confirm"]')?.textContent, '移除');
    assert.equal(document.querySelector('[data-action="cancel"]')?.textContent, '取消');
    assert.equal(document.querySelector('.od-confirm-modal-body')?.querySelector('classifier-test'), null);

    document
        .querySelector('[data-action="cancel"]')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(await resultPromise, false);
});
