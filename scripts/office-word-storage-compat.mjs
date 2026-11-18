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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const OFFICE_VERSION = '0.3.4';
const WORD_MAIN_SHA256 = '16cf9e142c7971fd9f3e39b18ed48597f804b4c5344b4046cdc92ab672310dbf';

function replaceExactly(source, before, after, expectedCount) {
    const count = source.split(before).length - 1;
    if (count !== expectedCount) {
        throw new Error(
            `Office ${OFFICE_VERSION} Word storage patch mismatch: expected ${expectedCount}, got ${count}`
        );
    }
    return source.split(before).join(after);
}

/** Versioned package compatibility patch; transforms build input without changing node_modules. */
export function transformOfficeWordStorage(source) {
    if (createHash('sha256').update(source).digest('hex') !== WORD_MAIN_SHA256) {
        throw new Error(`Office ${OFFICE_VERSION} Word bundle changed; review the storage patch before building`);
    }
    source = replaceExactly(
        source,
        'function configureDocsRuntime(config) {',
        `async function commitOpenDeskWordDocument(event, localPath, bytes, intent) {
  if (!runtime.documentStorage) throw new Error("Office document storage is not configured");
  await runtime.documentStorage.commit(
    { kind: "word", editorId: event.sender.id, localPath, bytes, intent },
    () => atomicWriteFile(localPath, bytes)
  );
}
function configureDocsRuntime(config) {`,
        1
    );
    source = replaceExactly(
        source,
        'rendererFile: options.rendererFilePath\n      });\n      registerDocsIpc();',
        'rendererFile: options.rendererFilePath,\n        documentStorage: options.documentStorage\n      });\n      registerDocsIpc();',
        1
    );
    source = replaceExactly(
        source,
        'await atomicWriteFile(filePath, bytes);',
        'await commitOpenDeskWordDocument(event, filePath, bytes, "save");',
        2
    );
    // The second matching write is the first save of a new document.
    source = replaceExactly(
        source,
        'await commitOpenDeskWordDocument(event, filePath, bytes, "save");\n      if (tornDownWcIds.has(event.sender.id)) {\n        await unlink2(filePath)',
        'await commitOpenDeskWordDocument(event, filePath, bytes, "save-new");\n      if (tornDownWcIds.has(event.sender.id)) {\n        await unlink2(filePath)',
        1
    );
    source = replaceExactly(
        source,
        'await atomicWriteFile(result.filePath, bytes);',
        'await commitOpenDeskWordDocument(event, result.filePath, bytes, "save-as");',
        1
    );
    for (const channel of ['docs:save', 'docs:save-as', 'docs:save-new']) {
        const start = source.indexOf(`"${channel}"`);
        const end = source.indexOf('\n  ipcMain.', start);
        if (start < 0 || end < 0) throw new Error(`Missing Office Word save handler: ${channel}`);
        const handler = replaceExactly(
            source.slice(start, end),
            'return { ok: false, error: String(err) };',
            'if (err?.code === "canceled") return { ok: false };\n        return { ok: false, error: String(err) };',
            1
        );
        source = source.slice(0, start) + handler + source.slice(end);
    }
    return source;
}

export function createOfficeWordStoragePlugin() {
    const wordMainPath = require.resolve('@bitclub.ai/opendesk-office/word-main');
    const packagePath = path.join(path.dirname(wordMainPath), '..', 'package.json');
    const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
    if (version !== OFFICE_VERSION) throw new Error(`Unsupported Office storage package version: ${version}`);
    return {
        name: 'opendesk-office:word-storage-compat',
        enforce: 'pre',
        transform(source, id) {
            if (id.split('?', 1)[0] !== wordMainPath) return null;
            return { code: transformOfficeWordStorage(source), map: null };
        }
    };
}
