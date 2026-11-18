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

/**
 * extract.js — 文件内容提取，所有格式统一处理
 * 从文件中提取原始文本，不支持或解析失败返回 null。
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import yauzl from 'yauzl';
import { DOMParser } from '@xmldom/xmldom';
import * as XLSX from 'xlsx';
import WordExtractor from 'word-extractor';
import { readOfd } from '@sharp9/ofdjs';
import {
    initDOMParser as initOfdDOMParser,
    parseXml,
    getChild,
    getTextContent,
    getAllChildren,
    getTagName
} from '@sharp9/ofdjs/xml-parser';
import { logger as staticLogger } from '../../../utils/logger.js';

function getLogger() {
    return staticLogger;
}

export const RAW_TEXT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
export const RAW_CONTAINER_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

const PLAIN_TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'tsx']);
const RTF_EXTS = new Set(['rtf']);
const OFFICE_PARSER_EXTS = new Set(['docx', 'odt', 'odp', 'ods']);
const WORD_EXTRACTOR_EXTS = new Set(['doc']);
const SPREADSHEET_EXTS = new Set(['xls', 'xlsx']);
const CONTAINER_EXTS = new Set(['pdf', 'doc', 'docx', 'pptx', 'xls', 'xlsx', 'odt', 'odp', 'ods', 'ofd']);

export const EXTRACT_TEXT_SUPPORTED_EXTENSIONS = Object.freeze([
    ...new Set([
        ...PLAIN_TEXT_EXTS,
        ...RTF_EXTS,
        ...OFFICE_PARSER_EXTS,
        ...WORD_EXTRACTOR_EXTS,
        ...SPREADSHEET_EXTS,
        ...CONTAINER_EXTS
    ])
]);

export function isExtractTextSupported(filePath) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return EXTRACT_TEXT_SUPPORTED_EXTENSIONS.includes(ext);
}

function getMaxFileSizeForExt(ext) {
    if (PLAIN_TEXT_EXTS.has(ext) || RTF_EXTS.has(ext)) return RAW_TEXT_MAX_FILE_SIZE;
    if (CONTAINER_EXTS.has(ext)) return RAW_CONTAINER_MAX_FILE_SIZE;
    return RAW_TEXT_MAX_FILE_SIZE;
}

function isRtfContent(buffer) {
    if (buffer.length < 5) return false;
    const head = buffer.subarray(0, 5);
    return (
        head[0] === 0x7b &&
        head[1] === 0x5c &&
        (head[2] === 0x72 || head[2] === 0x52) &&
        (head[3] === 0x74 || head[3] === 0x54) &&
        (head[4] === 0x66 || head[4] === 0x46)
    );
}

function extractRtfPlainText(rtfContent) {
    let text = rtfContent;
    let previous = '';
    while (previous !== text) {
        previous = text;
        text = text.replace(/\{\\\*[^}]*\}/g, '');
    }

    text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) => {
        const code = parseInt(hex, 16);
        if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
            return String.fromCharCode(code);
        }
        return '';
    });

    text = text.replace(/\\\{/g, '\uE000');
    text = text.replace(/\\\}/g, '\uE001');
    text = text.replace(/\\\\/g, '\uE002');
    text = text.replace(/\\par\b/g, '\n');
    text = text.replace(/\\pard\b/g, '\n');
    text = text.replace(/\\tab\b/g, '\t');
    text = text.replace(/\\line\b/g, '\n');
    text = text.replace(/\\[a-zA-Z]+[-\d]*\s?/g, '');
    text = text.replace(/\uE000/g, '{');
    text = text.replace(/\uE001/g, '}');
    text = text.replace(/\uE002/g, '\\');
    text = text.replace(/[{}]/g, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text
        .split('\n')
        .map((line) => line.trim())
        .join('\n');
    return text.replace(/^\n+/, '').replace(/\n+$/, '').trim();
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
            // 每张 slide 的解析结果都先落到 failures，等 zipfile 'end' 时统一判定。
            // 不要在这里创建会 reject 的 Promise：zipfile 'end' 之前没有人消费这些拒绝，
            // 单张 slide 解析失败（如畸形 XML 触发 xmldom ParseError）会冒泡成进程级
            // unhandledRejection，OpenDesk 会把它当作不可恢复错误直接退出。
            const pending = [];
            const failures = [];

            zipfile.readEntry();
            zipfile.on('error', reject);

            zipfile.on('entry', (entry) => {
                const m = entry.fileName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
                if (m) {
                    const slideNum = parseInt(m[1], 10);
                    const p = new Promise((res) => {
                        zipfile.openReadStream(entry, (streamErr, stream) => {
                            if (streamErr) {
                                failures.push(streamErr);
                                return res();
                            }
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
                                } catch (parseErr) {
                                    failures.push(parseErr);
                                }
                                res();
                            });
                            stream.on('error', (streamError) => {
                                failures.push(streamError);
                                res();
                            });
                        });
                    });
                    pending.push(p);
                }
                zipfile.readEntry();
            });

            zipfile.on('end', () => {
                Promise.all(pending)
                    .then(() => {
                        if (failures.length > 0) return reject(failures[0]);
                        const slideNums = [...slideMap.keys()].sort((a, b) => a - b);
                        resolve(slideNums.map((n) => slideMap.get(n)).join('\n\n===\n\n'));
                    })
                    .catch(reject);
            });
        });
    });
}

/** 校验 XML entry 时允许的最大解压字节数，避免 zip bomb 把校验拖死 */
const ZIP_VALIDATE_MAX_INFLATE_BYTES = 512 * 1024 * 1024;

/**
 * officeparser 各格式真正会打开的 xml entry（见 officeParser.js 的 extractFiles 过滤规则）：
 * docx 只读 word/document[\d]*.xml 与 footnotes / endnotes，odt/odp/ods 只读 content.xml
 * 与 Object \d+/content.xml。校验范围必须与之对齐——校验了它不会读的 entry（docx 的
 * [Content_Types].xml、styles.xml 等），会把"无关 entry 损坏但正文完好"的文件误判成解析失败。
 */
const DOCX_XML_ENTRY_PATTERNS = [
    /^word\/document\d*\.xml$/i,
    /^word\/footnotes\d*\.xml$/i,
    /^word\/endnotes\d*\.xml$/i
];
const ODF_XML_ENTRY_PATTERNS = [/^content\.xml$/i, /^Object \d+\/content\.xml$/i];

/**
 * 取某扩展名对应的 officeparser XML entry 匹配规则
 * @param {string} ext
 * @returns {RegExp[]}
 */
function getOfficeParserXmlEntryPatterns(ext) {
    return ext === 'docx' ? DOCX_XML_ENTRY_PATTERNS : ODF_XML_ENTRY_PATTERNS;
}

/**
 * 逐个解压 officeparser 会读取的 xml entry，确认数据流完整。
 * officeparser 内部对 yauzl 的 read stream 没有挂 error 监听（officeParser.js 的 extractFiles：
 * readStream.pipe(concat(...))），entry 数据损坏时 zlib 错误会变成无人监听的 'error' 事件，
 * 升级为进程级 uncaughtException，OpenDesk 会当作不可恢复错误退出。
 * 所以交给 officeparser 之前先用同样的方式把这些 entry 读一遍：
 * 任何损坏都退化成"这个文件解析不出文本"，而不是让进程崩掉。
 * @param {string} filePath
 * @param {string} ext
 * @returns {Promise<boolean>}
 */
function isXmlEntryReadable(filePath, ext) {
    const patterns = getOfficeParserXmlEntryPatterns(ext);
    return new Promise((resolve) => {
        yauzl.open(filePath, { lazyEntries: true }, (openError, zipfile) => {
            if (openError) return resolve(false);

            let settled = false;
            let inflatedBytes = 0;
            const finish = (readable) => {
                if (settled) return;
                settled = true;
                try {
                    zipfile.close();
                } catch {
                    /* 关闭失败不影响校验结论 */
                }
                resolve(readable);
            };

            zipfile.on('error', () => finish(false));
            zipfile.on('end', () => finish(true));
            zipfile.on('entry', (entry) => {
                if (settled) return;
                if (!patterns.some((pattern) => pattern.test(entry.fileName))) return zipfile.readEntry();
                zipfile.openReadStream(entry, (streamError, stream) => {
                    if (streamError) return finish(false);
                    stream.on('error', () => finish(false));
                    stream.on('data', (chunk) => {
                        if (settled) return;
                        inflatedBytes += chunk.length;
                        if (inflatedBytes > ZIP_VALIDATE_MAX_INFLATE_BYTES) finish(false);
                    });
                    stream.on('end', () => {
                        if (!settled) zipfile.readEntry();
                    });
                });
            });

            zipfile.readEntry();
        });
    });
}

function extractSpreadsheetText(buffer) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheets = [];
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const lines = sheetToRowNumberedLines(sheet);
        if (lines.length === 0) continue;
        const text = lines.join('\n');
        sheets.push(workbook.SheetNames.length > 1 ? `[${sheetName}]\n${text}` : text);
    }
    return sheets.join('\n\n');
}

function sheetToRowNumberedLines(sheet) {
    if (!sheet['!ref']) return [];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const lines = [];
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex++) {
        const values = [];
        let hasValue = false;
        for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex++) {
            const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
            const value = cell ? XLSX.utils.format_cell(cell) : '';
            if (value !== '') {
                hasValue = true;
            }
            values.push(String(value ?? ''));
        }
        if (hasValue) {
            lines.push([String(rowIndex + 1), ...values].join('\t'));
        }
    }
    return lines;
}

/** 确保 @sharp9/ofdjs 在 Node.js 中的 DOMParser 已初始化 */
let _ofdDompReady = false;
async function ensureOfdDomp() {
    if (!_ofdDompReady) {
        await initOfdDOMParser();
        _ofdDompReady = true;
    }
}

/**
 * pdfjs-dist 包内资源目录（cmaps / standard_fonts）的文件系统路径缓存。
 * null 表示尚未解析过，{} 内缺失的 key 表示该资源在当前环境不可用。
 */
let _pdfJsResourceDirs;

/**
 * 解析 pdfjs-dist 包内资源子目录（cmaps / standard_fonts）为文件系统路径（带尾部分隔符）。
 * 解析失败（pdfjs-dist 不在依赖树中）返回 null，调用方会把 null 原样传给 pdf.js，
 * 即退回 pdf.js 默认行为（不加载外部 CMap / 标准字体数据）。
 *
 * 必须返回纯文件系统路径而非 file:// URL：当 PDF 的 CID 字体依赖预定义 CMap
 * （如土耳其语等拉丁扩展文本常见的 /UniGB-UCS2-H）时，pdf.js 需要读取对应的
 * .bcmap 数据。pdf.js 在 Node/Electron 下由 NodeBinaryDataFactory 负责加载这类
 * 资源，实现是 fs/promises.readFile，不接受 file:// 字符串；而 unpdf 的
 * getDocumentProxy 默认在 Node 下恰恰把 cMapUrl / standardFontDataUrl 生成为
 * file:// URL——读取失败会让字体翻译失败，整页文本提取为空。
 *
 * 版本约定：这里只提供「资源数据」，加载它们的是 unpdf 内置的 pdf.js（当前
 * apiVersion 6.1.200），与声明的 pdfjs-dist 版本并不相同。cmaps 与 standard_fonts
 * 是跨版本稳定的静态数据，已由单测覆盖其文件集合；升级 pdfjs-dist 或 unpdf 时
 * 需重新确认引擎要求的资源文件仍被覆盖。
 * @param {'cmaps' | 'standard_fonts'} kind
 * @returns {string | null}
 */
export function getPdfJsResourceDir(kind) {
    if (_pdfJsResourceDirs === undefined) {
        _pdfJsResourceDirs = {};
        try {
            const pkgDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
            for (const dir of ['cmaps', 'standard_fonts']) {
                const full = path.join(pkgDir, dir) + path.sep;
                if (fs.existsSync(full)) {
                    // pdf.js 校验资源 url 必须以 "/" 结尾，Windows 的 path.sep 不满足，
                    // 统一改成正斜杠（fs.readFile 在 Windows 上接受正斜杠路径）
                    _pdfJsResourceDirs[dir] = full.replaceAll(path.sep, '/');
                }
            }
        } catch {
            // pdfjs-dist 无法解析（未安装或打包时被裁剪），退回 pdf.js 默认
            // （不加载外部 CMap / 标准字体数据）
        }
    }
    return _pdfJsResourceDirs[kind] ?? null;
}

/**
 * 从 OFD 文件中逐页提取 TextObject 的文本内容。
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function extractOfdTextFromFile(filePath) {
    await ensureOfdDomp();
    const buffer = await fs.promises.readFile(filePath);
    const ofd = await readOfd(new Uint8Array(buffer));

    const docRoot = ofd.node.docBody.docRoot;
    const dir = docRoot.includes('/') ? docRoot.substring(0, docRoot.lastIndexOf('/')) : '';
    const pages = ofd.document.pages.page;
    const pageTexts = [];

    for (const pageInfo of pages) {
        if (!pageInfo.baseLoc) continue;
        const pagePath = dir ? `${dir}/${pageInfo.baseLoc}` : pageInfo.baseLoc;
        let pageXml;
        try {
            pageXml = await ofd.readFile(pagePath);
        } catch {
            continue;
        }

        const doc = parseXml(pageXml);
        const root = doc.documentElement;

        const texts = [];
        /**
         * @param {Element} parent
         */
        function collectTexts(parent) {
            const children = getAllChildren(parent);
            for (const child of children) {
                const tag = getTagName(child);
                if (tag === 'TextObject') {
                    const textCodeEl = getChild(child, 'TextCode');
                    if (textCodeEl) {
                        const value = getTextContent(textCodeEl);
                        if (value && value.trim()) {
                            texts.push(value.trim());
                        }
                    }
                } else if (tag === 'PageBlock') {
                    collectTexts(child);
                }
            }
        }

        const contentEl = getChild(root, 'Content');
        if (contentEl) {
            const layerEl = getChild(contentEl, 'Layer');
            if (layerEl) {
                collectTexts(layerEl);
            }
        }

        if (texts.length > 0) {
            pageTexts.push(texts.join('\n'));
        }
    }

    return pageTexts.join('\n\n');
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

        if (RTF_EXTS.has(ext)) {
            return extractRtfPlainText(await fs.promises.readFile(filePath, 'utf-8'));
        }

        if (OFFICE_PARSER_EXTS.has(ext)) {
            if (!(await isXmlEntryReadable(filePath, ext))) {
                (await getLogger()).warn(
                    `[parser] damaged xml entry in ${filePath}; skipped officeparser to avoid an uncaught stream error`
                );
                return null;
            }
            const { parseOfficeAsync } = await import('officeparser');
            return await parseOfficeAsync(filePath);
        }

        if (WORD_EXTRACTOR_EXTS.has(ext)) {
            const buffer = await fs.promises.readFile(filePath);
            if (isRtfContent(buffer)) {
                return extractRtfPlainText(buffer.toString('utf-8'));
            }
            const extractor = new WordExtractor();
            const document = await extractor.extract(filePath);
            return document.getBody();
        }

        if (SPREADSHEET_EXTS.has(ext)) {
            const buffer = await fs.promises.readFile(filePath);
            return extractSpreadsheetText(buffer);
        }

        if (ext === 'pptx') {
            const buffer = await fs.promises.readFile(filePath);
            return await extractPptxSlides(buffer);
        }

        if (ext === 'pdf') {
            const { extractText: pdfExtract, getDocumentProxy } = await import('unpdf');
            const buffer = await fs.promises.readFile(filePath);
            // 显式给出文件系统路径，让 pdf.js 的 NodeBinaryDataFactory 经 fs 加载预定义
            // CMap 与标准字体数据（.bcmap / .pfb）：unpdf 在 Node 下默认生成的
            // file:// URL 无法被 fs 读取。
            // useWorkerFetch 在 Node 下本就默认关闭（数据工厂为 Node 实现时），显式写出
            // 只为不依赖引擎默认值。
            // 资源目录解析不到时传 null，即退回 pdf.js 默认（不加载外部 CMap/标准字体）。
            // 代理生命周期归调用方管理，提取结束后必须销毁 loadingTask。
            const pdf = await getDocumentProxy(new Uint8Array(buffer), {
                useWorkerFetch: false,
                cMapUrl: getPdfJsResourceDir('cmaps'),
                cMapPacked: true,
                standardFontDataUrl: getPdfJsResourceDir('standard_fonts')
            });
            try {
                const { text } = await pdfExtract(pdf);
                return text.join('\n\n');
            } finally {
                await pdf.loadingTask.destroy();
            }
        }

        if (ext === 'ofd') {
            return await extractOfdTextFromFile(filePath);
        }

        return null;
    } catch (err) {
        (await getLogger()).warn(`[parser] failed to parse ${filePath}: ${err.message}`);
        return null;
    }
}
