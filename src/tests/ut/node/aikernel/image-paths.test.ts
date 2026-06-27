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

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { extractImagePaths, imageToDataUri } from '../../../../main/aikernel/messages.js';

test('image path extraction covers common image extensions', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'opendesk-image-paths-'));
    try {
        const extensions = [
            'png',
            'jpg',
            'jpeg',
            'jfif',
            'gif',
            'webp',
            'bmp',
            'svg',
            'avif',
            'tif',
            'tiff',
            'ico',
            'heic',
            'heif'
        ];
        const filePaths: string[] = [];
        for (const extension of extensions) {
            const filePath = path.join(tmpDir, `sample.${extension}`);
            await writeFile(filePath, extension === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg"></svg>' : '');
            filePaths.push(filePath);
        }

        const text = filePaths.map((filePath) => `"${filePath}"`).join('\n');
        assert.deepEqual(extractImagePaths(text).sort(), filePaths.sort());

        assert.match(imageToDataUri(path.join(tmpDir, 'sample.svg')), /^data:image\/svg\+xml;base64,/);
        assert.match(imageToDataUri(path.join(tmpDir, 'sample.avif')), /^data:image\/avif;base64,/);
        assert.match(imageToDataUri(path.join(tmpDir, 'sample.tiff')), /^data:image\/tiff;base64,/);
        assert.match(imageToDataUri(path.join(tmpDir, 'sample.ico')), /^data:image\/x-icon;base64,/);
        assert.match(imageToDataUri(path.join(tmpDir, 'sample.heic')), /^data:image\/heic;base64,/);
        assert.match(imageToDataUri(path.join(tmpDir, 'sample.heif')), /^data:image\/heif;base64,/);
    } finally {
        await rm(tmpDir, { recursive: true, force: true });
    }
});
