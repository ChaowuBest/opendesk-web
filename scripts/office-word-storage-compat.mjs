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

const OFFICE_VERSION = '0.3.9';
const WORD_MAIN_SHA256 = '1b52650d1b41747fffe170230ef8190869222ed92eba29be496b5ce88eb658f5';

function replaceExactly(source, before, after, expectedCount) {
    const count = source.split(before).length - 1;
    if (count !== expectedCount) {
        throw new Error(
            `Office ${OFFICE_VERSION} Word storage patch mismatch: expected ${expectedCount}, got ${count}`
        );
    }
    return source.split(before).join(after);
}

/**
 * Versioned package compatibility patch; transforms build input without changing node_modules.
 *
 * 0.3.9 bundles the host as readable-but-renamed ESM (`HR` stores the runtime config in the
 * module variable `mp`, the atomic writer is `Bt`, invoke events are `i` inside the arrow
 * handlers). Anchors below are exact-minified-text and verified unique for the pinned SHA;
 * any upstream rebuild changes them and the SHA gate above fails first.
 */
export function transformOfficeWordStorage(source) {
    if (createHash('sha256').update(source).digest('hex') !== WORD_MAIN_SHA256) {
        throw new Error(`Office ${OFFICE_VERSION} Word bundle changed; review the storage patch before building`);
    }
    // Commit helper next to the runtime-config setter (`mp` holds the host config once
    // `HR` runs inside the factory's register()).
    source = replaceExactly(
        source,
        'function HR(e){mp=e,pp=null}',
        `async function commitOpenDeskWordDocument(event, localPath, bytes, intent) {
  if (!mp.documentStorage) throw new Error("Office document storage is not configured");
  await mp.documentStorage.commit(
    { kind: "word", editorId: event.sender.id, localPath, bytes, intent },
    () => Bt(localPath, bytes)
  );
}
function HR(e){mp=e,pp=null}`,
        1
    );
    // Factory config literal: forward the shell-provided storage port into the runtime config.
    source = replaceExactly(
        source,
        'HR({preloadPath:e.preloadPath,rendererUrl:e.rendererDevUrl,rendererFile:e.rendererFilePath})',
        'HR({preloadPath:e.preloadPath,rendererUrl:e.rendererDevUrl,rendererFile:e.rendererFilePath,documentStorage:e.documentStorage})',
        1
    );
    // docs:save — write stays inside the per-sender write serializer (`KR.track`).
    source = replaceExactly(
        source,
        'async()=>{await Bt(s,d),Ye.has(i.sender.id)||await Ta(i.sender.id,s,Li(d))}',
        'async()=>{await commitOpenDeskWordDocument(i,s,d,"save"),Ye.has(i.sender.id)||await Ta(i.sender.id,s,Li(d))}',
        1
    );
    // docs:save-as — dialog pick result `l`.
    source = replaceExactly(
        source,
        'await Bt(l.filePath,f)',
        'await commitOpenDeskWordDocument(i,l.filePath,f,"save-as")',
        1
    );
    // docs:save-new — draft path `A`; the trailing recovery cleanup disambiguates it from
    // the docs:save-to writer (`await Bt(s,f)`), which stays a plain local write.
    source = replaceExactly(
        source,
        'await Bt(A,d),Ye.has(i.sender.id))return await Mu(A)',
        'await commitOpenDeskWordDocument(i,A,d,"save-new"),Ye.has(i.sender.id))return await Mu(A)',
        1
    );
    // Provider-committed writes can reject with `code: "canceled"` (shell picker UI);
    // keep that silent like an in-package dialog cancel instead of surfacing an error.
    for (const [catchVar, nextChannel] of [
        ['l', 'docs:write-recovery'],
        ['c', 'docs:save-new'],
        ['A', 'docs:create-document']
    ]) {
        const before = `}catch(${catchVar}){return{ok:!1,error:String(${catchVar})}}}),oe.handle("${nextChannel}"`;
        const after = `}catch(${catchVar}){if(${catchVar}?.code==="canceled")return{ok:!1};return{ok:!1,error:String(${catchVar})}}}),oe.handle("${nextChannel}"`;
        source = replaceExactly(source, before, after, 1);
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
