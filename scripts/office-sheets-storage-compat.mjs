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
const SHEETS_SHA256 = '20e3414a3db5732e5ab93b142cf5e5fcaefe160d31cf61dc4315705932c597c3';

function replaceOnce(source, before, after) {
    if (source.split(before).length !== 2) throw new Error('Office 0.3.4 Sheets storage patch mismatch');
    return source.replace(before, after);
}

export function transformOfficeSheetsStorage(source) {
    if (createHash('sha256').update(source).digest('hex') !== SHEETS_SHA256) {
        throw new Error('Office 0.3.4 Sheets bundle changed; review the storage patch before building');
    }
    source = replaceOnce(
        source,
        'function configureSheetsRuntime(config3) {',
        `async function commitOpenDeskSheetsBytes(event, localPath, bytes, intent) {
  if (!runtime.documentStorage) throw new Error("Office document storage is not configured");
  await runtime.documentStorage.commit(
    { kind: "sheets", editorId: event.sender.id, localPath, bytes, intent },
    () => atomicWriteFile(localPath, bytes)
  );
}
function configureSheetsRuntime(config3) {`
    );
    source = replaceOnce(
        source,
        'rendererFile: options.rendererFilePath\n      });\n      if (options.ironCalcWasmPath)',
        'rendererFile: options.rendererFilePath,\n        documentStorage: options.documentStorage\n      });\n      if (options.ironCalcWasmPath)'
    );
    source = replaceOnce(
        source,
        `    const mutation = await writeWorkbookTo(client, session, request, targetPath);
    if (csvInPlace && session.csvSourcePath !== void 0 && request.csvContent !== void 0) {
      const savedSha = await sha256File(session.path).catch(() => void 0);
      if (savedSha !== void 0 && entry.sessions.has(request.sessionId)) {
        entry.sessions.set(request.sessionId, { ...session, sha256: savedSha });
      }
      await writeFile5(
        session.csvSourcePath,
        Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(request.csvContent, "utf8")])
      );
    }`,
        `    let mutation;
    const stagedWorkbookPath = csvInPlace ? targetPath + ".opendesk-save-" + randomBytes(8).toString("hex") + ".xlsx" : targetPath;
    if (!runtime.documentStorage) throw new Error("Office document storage is not configured");
    try {
    await runtime.documentStorage.commit(
      { kind: "sheets", editorId: event.sender.id, localPath: csvInPlace ? session.csvSourcePath : targetPath, intent: request.mode === "save-as" || session.suggestSaveAs !== void 0 ? "save-as" : "save" },
      async () => {
        if (entry.sessions.get(request.sessionId) !== session) throw new Error("Unknown workbook session.");
        mutation = await writeWorkbookTo(client, session, request, stagedWorkbookPath);
        if (entry.sessions.get(request.sessionId) !== session) throw new Error("Unknown workbook session.");
        if (csvInPlace && session.csvSourcePath !== void 0 && request.csvContent !== void 0) {
          await atomicWriteFile(session.csvSourcePath,
            Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(request.csvContent, "utf8")])
          );
        }
      }
    );
    if (entry.sessions.get(request.sessionId) !== session) throw new Error("Unknown workbook session.");
    if (csvInPlace) await rename2(stagedWorkbookPath, targetPath);
    } catch (error) {
      if (error?.code === "canceled") return { canceled: true };
      throw error;
    } finally {
      if (csvInPlace) await unlink(stagedWorkbookPath).catch(() => {});
    }`
    );
    source = replaceOnce(
        source,
        `          await atomicWriteFile(
            filePath,
            Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(request.content, "utf8")])
          );`,
        `          await commitOpenDeskSheetsBytes(
            event, filePath,
            Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(request.content, "utf8")]), "save-new"
          );`
    );
    source = replaceOnce(
        source,
        '          await atomicWriteFile(filePath, buffer);',
        '          await commitOpenDeskSheetsBytes(event, filePath, buffer, "save-new");'
    );
    source = replaceOnce(
        source,
        '    await atomicWriteFile(targetPath, csvBytes);',
        `    try {
      await commitOpenDeskSheetsBytes(event, targetPath, csvBytes, "save-as");
    } catch (error) {
      if (error?.code === "canceled") return { canceled: true };
      throw error;
    }`
    );
    const createStart = source.indexOf('    IPC_CHANNELS.createDocument,');
    const createEnd = source.indexOf('  ipcMain.handle(IPC_CHANNELS.csvSaveConfirm,', createStart);
    if (createStart < 0 || createEnd < 0) throw new Error('Missing Office Sheets create handler');
    const createHandler = replaceOnce(
        source.slice(createStart, createEnd),
        '        return { ok: false, error: err instanceof Error ? err.message : String(err) };',
        '        if (err?.code === "canceled") return { ok: false };\n        return { ok: false, error: err instanceof Error ? err.message : String(err) };'
    );
    return source.slice(0, createStart) + createHandler + source.slice(createEnd);
}

export function createOfficeSheetsStoragePlugin() {
    const sheetsMainPath = require.resolve('@bitclub.ai/opendesk-office/sheets-main');
    const version = JSON.parse(
        readFileSync(path.join(path.dirname(sheetsMainPath), '..', 'package.json'), 'utf8')
    ).version;
    if (version !== '0.3.4') throw new Error(`Unsupported Office storage package version: ${version}`);
    return {
        name: 'opendesk-office:sheets-storage-compat',
        enforce: 'pre',
        transform(source, id) {
            if (id.split('?', 1)[0] !== sheetsMainPath) return null;
            return { code: transformOfficeSheetsStorage(source), map: null };
        }
    };
}
