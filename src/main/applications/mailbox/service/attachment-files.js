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

import fs from 'fs';
import path from 'path';

function requirePath(value, message) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(message);
    }
    return path.resolve(value);
}

function getSafeAttachmentFilename(filename) {
    if (typeof filename !== 'string') {
        throw new Error('Invalid attachment filename');
    }
    const basename = path.basename(filename.trim());
    return basename && basename !== '.' && basename !== '..' ? basename : 'attachment';
}

export async function saveAttachmentFile(sourcePath, destinationPath) {
    const source = requirePath(sourcePath, 'Invalid attachment source path');
    const destination = requirePath(destinationPath, 'Invalid attachment destination path');
    const samePath =
        process.platform === 'win32'
            ? source.toLocaleLowerCase() === destination.toLocaleLowerCase()
            : source === destination;
    if (samePath) return destination;

    await fs.promises.copyFile(source, destination);
    return destination;
}

export async function saveAllAttachmentFiles(attachments, destinationDirectory) {
    if (!Array.isArray(attachments)) {
        throw new Error('Invalid attachment list');
    }

    const directory = requirePath(destinationDirectory, 'Invalid attachment destination directory');
    const directoryStat = await fs.promises.stat(directory);
    if (!directoryStat.isDirectory()) {
        throw new Error('Attachment destination is not a directory');
    }

    const savedPaths = [];
    for (const attachment of attachments) {
        if (!attachment || typeof attachment.path !== 'string') {
            throw new Error('Invalid attachment');
        }

        const source = requirePath(attachment.path, 'Invalid attachment source path');
        const filename = getSafeAttachmentFilename(attachment.filename);
        const extension = path.extname(filename);
        const stem = path.basename(filename, extension);
        let suffix = 1;

        while (true) {
            const suffixText = suffix === 1 ? '' : ` (${suffix})`;
            const destination = path.join(directory, `${stem}${suffixText}${extension}`);
            try {
                await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
                savedPaths.push(destination);
                break;
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                suffix += 1;
            }
        }
    }
    return savedPaths;
}
