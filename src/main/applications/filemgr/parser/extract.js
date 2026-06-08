/**
 * extract.js — 文件内容提取，所有格式统一处理
 * 从文件中提取原始文本，不支持或解析失败返回 null。
 */

import fs from 'fs';
import path from 'path';
import yauzl from 'yauzl';
import { DOMParser } from '@xmldom/xmldom';
import * as XLSX from 'xlsx';
import { logger as staticLogger } from '../../../utils/logger.js';

function getLogger() {
    return staticLogger;
}

export const RAW_TEXT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const RAW_CONTAINER_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const PLAIN_TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'tsx']);
const OFFICE_EXTS = new Set(['docx']);
const CONTAINER_EXTS = new Set(['pdf', 'docx', 'pptx', 'xlsx']);

function getMaxFileSizeForExt(ext) {
    if (PLAIN_TEXT_EXTS.has(ext)) return RAW_TEXT_MAX_FILE_SIZE;
    if (CONTAINER_EXTS.has(ext)) return RAW_CONTAINER_MAX_FILE_SIZE;
    return RAW_TEXT_MAX_FILE_SIZE;
}

/**
 * 用 yauzl 打开 ZIP Buffer，按 slide 编号升序提取每张 slide 的 <a:t> 文本，
 * slide 间以 \n\n===\n\n 拼接。
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
function extractPptxSlides(buffer) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);

            const slideMap = new Map();
            const pending = [];

            zipfile.readEntry();
            zipfile.on('error', reject);

            zipfile.on('entry', (entry) => {
                const m = entry.fileName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
                if (m) {
                    const slideNum = parseInt(m[1], 10);
                    const p = new Promise((res, rej) => {
                        zipfile.openReadStream(entry, (streamErr, stream) => {
                            if (streamErr) return rej(streamErr);
                            const chunks = [];
                            stream.on('data', (c) => chunks.push(c));
                            stream.on('end', () => {
                                const xml = Buffer.concat(chunks).toString('utf-8');
                                try {
                                    const doc = new DOMParser().parseFromString(xml, 'text/xml');
                                    const nodes = doc.getElementsByTagNameNS(
                                        'http://schemas.openxmlformats.org/drawingml/2006/main',
                                        't'
                                    );
                                    const texts = [];
                                    for (let i = 0; i < nodes.length; i++) {
                                        const t = nodes[i].textContent;
                                        if (t && t.trim()) texts.push(t.trim());
                                    }
                                    slideMap.set(slideNum, texts.join('\n\n'));
                                    res();
                                } catch (parseErr) {
                                    rej(parseErr);
                                }
                            });
                            stream.on('error', rej);
                        });
                    });
                    pending.push(p);
                }
                zipfile.readEntry();
            });

            zipfile.on('end', () => {
                Promise.all(pending)
                    .then(() => {
                        const slideNums = [...slideMap.keys()].sort((a, b) => a - b);
                        resolve(slideNums.map((n) => slideMap.get(n)).join('\n\n===\n\n'));
                    })
                    .catch(reject);
            });
        });
    });
}

/**
 * 从文件中提取原始文本
 * @param {string} filePath
 * @returns {Promise<string | null>}
 *   不支持的格式或解析失败返回 null；
 *   合法文件解析为空内容时返回 ''（空字符串）
 */
export async function extractText(filePath) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    try {
        const stat = await fs.promises.stat(filePath);
        const maxFileSize = getMaxFileSizeForExt(ext);
        if (stat.size > maxFileSize) {
            (await getLogger()).warn(
                `[parser] skipping content for ${filePath}: file size ${stat.size} exceeds ${maxFileSize}; ` +
                    'filename-only embedding will still be used'
            );
            return null;
        }
    } catch (err) {
        (await getLogger()).warn(`[parser] cannot stat ${filePath}: ${err.message}`);
        return null;
    }

    try {
        if (PLAIN_TEXT_EXTS.has(ext)) {
            return await fs.promises.readFile(filePath, 'utf-8');
        }

        if (OFFICE_EXTS.has(ext)) {
            const { parseOfficeAsync } = await import('officeparser');
            return await parseOfficeAsync(filePath);
        }

        if (ext === 'xlsx') {
            const buffer = await fs.promises.readFile(filePath);
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) return '';
            const sheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
            if (!rows || rows.length === 0) return '';
            return rows.map((row) => row.join('\t')).join('\n');
        }

        if (ext === 'pptx') {
            const buffer = await fs.promises.readFile(filePath);
            return await extractPptxSlides(buffer);
        }

        if (ext === 'pdf') {
            const { extractText: pdfExtract } = await import('unpdf');
            const buffer = await fs.promises.readFile(filePath);
            const { text } = await pdfExtract(new Uint8Array(buffer));
            return text.join('\n\n');
        }

        return null;
    } catch (err) {
        (await getLogger()).warn(`[parser] failed to parse ${filePath}: ${err.message}`);
        return null;
    }
}
