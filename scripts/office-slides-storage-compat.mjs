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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SLIDES_SHA256 = 'd9a5b2a7ed455c913ec1490899e0d1ef45475dbf7e968e7153a3a7c2ce5ef242';

function replaceOnce(source, before, after) {
    if (source.split(before).length !== 2) throw new Error('Office 0.3.4 Slides storage patch mismatch');
    return source.replace(before, after);
}

export function transformOfficeSlidesStorage(source) {
    if (createHash('sha256').update(source).digest('hex') !== SLIDES_SHA256) {
        throw new Error('Office 0.3.4 Slides bundle changed; review the storage patch before building');
    }
    const atomicWriter = fileURLToPath(new URL('../src/main/office/atomicWorkingCopy.ts', import.meta.url));
    source =
        `import { persistOfficeWorkingCopyAtomically as persistOpenDeskSlidesWorkingCopy } from ${JSON.stringify(atomicWriter)};\n` +
        source;
    source = replaceOnce(
        source,
        'function configureSlidesRuntime(paths) {',
        `async function commitOpenDeskSlidesDocument(contents, localPath, opened, intent) {
  if (!runtime.documentStorage) throw new Error("Office document storage is not configured");
  await runtime.documentStorage.commit(
    { kind: "slides", editorId: contents.id, localPath, intent },
    () => persistOpenDeskSlidesWorkingCopy(localPath, (temporaryPath) => savePptxToFile(opened, temporaryPath))
  );
}
function configureSlidesRuntime(paths) {
  runtime.documentStorage = paths.documentStorage;`
    );
    source = replaceOnce(
        source,
        'rendererFilePath: options.rendererFilePath\n      });\n      registerSlidesIpc();',
        'rendererFilePath: options.rendererFilePath,\n        documentStorage: options.documentStorage\n      });\n      registerSlidesIpc();'
    );
    source = replaceOnce(
        source,
        `  if (!session.path) {
    const draftsDir = getDraftsDir();
    if (!existsSync5(draftsDir)) mkdirSync5(draftsDir, { recursive: true });
    session.path = pickDraftPath(draftsDir, tm("untitledDeck"));
    await pushRecent(session.path);
    slidesOpenedHook?.(contents, session.path);
  }
  await savePptxToFile(session.opened, session.path);`,
        `  const creating = !session.path;
  let targetPath = session.path;
  if (creating) {
    const draftsDir = getDraftsDir();
    if (!existsSync5(draftsDir)) mkdirSync5(draftsDir, { recursive: true });
    targetPath = pickDraftPath(draftsDir, tm("untitledDeck"));
  }
  await commitOpenDeskSlidesDocument(contents, targetPath, session.opened, creating ? "save-new" : "save");
  if (creating) {
    session.path = targetPath;
    await pushRecent(targetPath);
    slidesOpenedHook?.(contents, targetPath);
  }`
    );
    source = replaceOnce(
        source,
        'await savePptxToFile(session.opened, r.filePath);',
        'await commitOpenDeskSlidesDocument(e.sender, r.filePath, session.opened, "save-as");'
    );
    source = replaceOnce(
        source,
        '            renameSync2(temporaryPath, targetPath);',
        `            if (!runtime.documentStorage) throw new Error("Office document storage is not configured");
            await runtime.documentStorage.commit(
              { kind: "slides", editorId: contents.id, localPath: targetPath, bytes: result.bytes, intent: outputPath ? "save-as" : "save" },
              async () => { renameSync2(temporaryPath, targetPath); }
            );`
    );
    source = replaceOnce(
        source,
        '        pushHistory(session);\n        session.opened = opened;',
        `        if (sessions.get(contents.id) !== session || presentationRevision(session.opened) !== revisionAtStart) {
          return { apiVersion: PRESENTATION_AUTOMATION_API_VERSION, ok: false, error: { code: "REVISION_CONFLICT", message: "The presentation changed while storage was committing" }, revision: { expected: revisionAtStart } };
        }
        pushHistory(session);
        session.opened = opened;`
    );
    for (const channel of ['slides:save', 'slides:save-as']) {
        const start = source.indexOf(`ipcMain3.handle("${channel}",`);
        const end = source.indexOf('\n  ipcMain3.', start);
        if (start < 0 || end < 0) throw new Error(`Missing Office Slides save handler: ${channel}`);
        const handler = replaceOnce(
            source.slice(start, end),
            'return { ok: false, error: String(err) };',
            'if (err?.code === "canceled") return { ok: false };\n      return { ok: false, error: String(err) };'
        );
        source = source.slice(0, start) + handler + source.slice(end);
    }
    return source;
}

export function createOfficeSlidesStoragePlugin() {
    const slidesMainPath = require.resolve('@bitclub.ai/opendesk-office/main');
    const version = JSON.parse(
        readFileSync(path.join(path.dirname(slidesMainPath), '..', 'package.json'), 'utf8')
    ).version;
    if (version !== '0.3.4') throw new Error(`Unsupported Office storage package version: ${version}`);
    return {
        name: 'opendesk-office:slides-storage-compat',
        enforce: 'pre',
        transform(source, id) {
            if (id.split('?', 1)[0] !== slidesMainPath) return null;
            return { code: transformOfficeSlidesStorage(source), map: null };
        }
    };
}
