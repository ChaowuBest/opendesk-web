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

import path from 'path';

export const SUPPORTED_ATTACHMENT_FILE_EXTENSIONS = [
    'doc',
    'docx',
    'xls',
    'xlsx',
    'csv',
    'pptx',
    'odt',
    'odp',
    'ods',
    'pdf',
    'ofd',
    'rtf',
    'txt',
    'log',
    'json'
] as const;

export const KNOWN_UNSUPPORTED_ATTACHMENT_FILE_EXTENSIONS = ['ppt', 'md', 'html'] as const;

export type AttachmentFileSupport = {
    supportedExtensions: string[];
    knownUnsupportedExtensions: string[];
};

export type UnsupportedAttachmentFile = {
    filePath: string;
    extension: string;
};

export class UnsupportedAttachmentFileTypeError extends Error {
    unsupportedFiles: UnsupportedAttachmentFile[];
    supportedExtensions: string[];

    constructor(
        unsupportedFiles: UnsupportedAttachmentFile[],
        supportedExtensions = getAttachmentFileSupport().supportedExtensions
    ) {
        const unsupportedDisplay = unsupportedFiles
            .map((file) => (file.extension ? `.${file.extension}` : '<no extension>'))
            .join(', ');
        const supportedDisplay = supportedExtensions.map((extension) => `.${extension}`).join(', ');
        super(`Unsupported attachment file type: ${unsupportedDisplay}. Supported file types: ${supportedDisplay}.`);
        this.name = 'UnsupportedAttachmentFileTypeError';
        this.unsupportedFiles = unsupportedFiles;
        this.supportedExtensions = supportedExtensions;
    }
}

export function getAttachmentFileSupport(): AttachmentFileSupport {
    return {
        supportedExtensions: [...SUPPORTED_ATTACHMENT_FILE_EXTENSIONS],
        knownUnsupportedExtensions: [...KNOWN_UNSUPPORTED_ATTACHMENT_FILE_EXTENSIONS]
    };
}

export function normalizeAttachmentFileExtension(filePathOrExtension: string): string {
    const value = String(filePathOrExtension || '')
        .trim()
        .toLowerCase();
    if (!value) {
        return '';
    }
    if (!value.includes('/') && !value.includes('\\') && value.startsWith('.')) {
        return value.slice(1);
    }
    const extname = path.extname(value);
    if (extname) {
        return extname.slice(1);
    }
    if (!value.includes('/') && !value.includes('\\') && !value.includes('.')) {
        return value;
    }
    return '';
}

export function isAttachmentFileExtensionSupported(extension: string): boolean {
    const normalized = normalizeAttachmentFileExtension(extension);
    return SUPPORTED_ATTACHMENT_FILE_EXTENSIONS.includes(
        normalized as (typeof SUPPORTED_ATTACHMENT_FILE_EXTENSIONS)[number]
    );
}

export function isAttachmentFilePathSupported(filePath: string): boolean {
    return isAttachmentFileExtensionSupported(path.extname(filePath));
}

export function findUnsupportedAttachmentFiles(filePaths: string[]): UnsupportedAttachmentFile[] {
    return filePaths
        .map((filePath) => ({
            filePath,
            extension: normalizeAttachmentFileExtension(path.extname(filePath))
        }))
        .filter((file) => !isAttachmentFileExtensionSupported(file.extension));
}

export function assertAttachmentFilePathsSupported(filePaths: string[]): void {
    const unsupportedFiles = findUnsupportedAttachmentFiles(filePaths);
    if (unsupportedFiles.length > 0) {
        throw new UnsupportedAttachmentFileTypeError(unsupportedFiles);
    }
}
