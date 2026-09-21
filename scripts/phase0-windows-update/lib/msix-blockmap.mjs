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

import { parseStringPromise } from 'xml2js';

export const MSIX_BLOCK_SIZE = 64 * 1024;

function requireNonNegativeInteger(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return number;
}

function roundPercent(value) {
    return Math.round(value * 100) / 100;
}

export async function parseBlockMapXml(xml) {
    const parsed = await parseStringPromise(xml);
    const blockMap = parsed.BlockMap;
    if (!blockMap || !Array.isArray(blockMap.File)) {
        throw new Error('Invalid MSIX block map: missing BlockMap/File');
    }

    const files = blockMap.File.map((file) => {
        const name = file.$?.Name;
        if (!name) {
            throw new Error('Invalid MSIX block map: file name is missing');
        }
        const size = requireNonNegativeInteger(file.$?.Size, `File ${name} size`);
        const blocks = (file.Block ?? []).map((block, index) => {
            const hash = block.$?.Hash;
            if (!hash) {
                throw new Error(`Invalid MSIX block map: block hash is missing for ${name}`);
            }
            const remainingBytes = Math.max(0, size - index * MSIX_BLOCK_SIZE);
            return {
                hash,
                payloadBytes: Math.min(MSIX_BLOCK_SIZE, remainingBytes),
                compressedBytes:
                    block.$?.Size === undefined
                        ? Math.min(MSIX_BLOCK_SIZE, remainingBytes)
                        : requireNonNegativeInteger(block.$.Size, `Block ${index} compressed size for ${name}`)
            };
        });

        return {
            name,
            normalizedName: name.toLowerCase(),
            size,
            blocks
        };
    });

    return {
        hashMethod: blockMap.$?.HashMethod,
        files
    };
}

export function compareBlockMaps(baseline, candidate) {
    const baselineByName = new Map(baseline.files.map((file) => [file.normalizedName, file]));
    let candidatePayloadBytes = 0;
    let reusedPayloadBytes = 0;
    let candidateCompressedBlockBytes = 0;
    let reusedCompressedBlockBytes = 0;
    let candidateBlockCount = 0;
    let reusedBlockCount = 0;
    const changedFiles = [];

    for (const candidateFile of candidate.files) {
        const baselineFile = baselineByName.get(candidateFile.normalizedName);
        let fileChangedBytes = 0;
        let fileReusedBytes = 0;

        for (const [index, candidateBlock] of candidateFile.blocks.entries()) {
            const baselineBlock = baselineFile?.blocks[index];
            const reused = baselineBlock?.hash === candidateBlock.hash;
            candidateBlockCount += 1;
            candidatePayloadBytes += candidateBlock.payloadBytes;
            candidateCompressedBlockBytes += candidateBlock.compressedBytes;
            if (reused) {
                reusedBlockCount += 1;
                reusedPayloadBytes += candidateBlock.payloadBytes;
                reusedCompressedBlockBytes += candidateBlock.compressedBytes;
                fileReusedBytes += candidateBlock.payloadBytes;
            } else {
                fileChangedBytes += candidateBlock.payloadBytes;
            }
        }

        if (fileChangedBytes > 0 || !baselineFile) {
            changedFiles.push({
                name: candidateFile.name,
                size: candidateFile.size,
                reusedPayloadBytes: fileReusedBytes,
                changedPayloadBytes: fileChangedBytes,
                isNewFile: baselineFile === undefined
            });
        }
    }

    const changedPayloadBytes = candidatePayloadBytes - reusedPayloadBytes;
    const changedBlockCount = candidateBlockCount - reusedBlockCount;
    changedFiles.sort((left, right) => right.changedPayloadBytes - left.changedPayloadBytes);

    return {
        baselineFileCount: baseline.files.length,
        candidateFileCount: candidate.files.length,
        candidateBlockCount,
        reusedBlockCount,
        changedBlockCount,
        candidatePayloadBytes,
        reusedPayloadBytes,
        changedPayloadBytes,
        estimatedPayloadReusePercent:
            candidatePayloadBytes === 0 ? 100 : roundPercent((reusedPayloadBytes / candidatePayloadBytes) * 100),
        candidateCompressedBlockBytes,
        reusedCompressedBlockBytes,
        estimatedCompressedBlockReusePercent:
            candidateCompressedBlockBytes === 0
                ? 100
                : roundPercent((reusedCompressedBlockBytes / candidateCompressedBlockBytes) * 100),
        changedFiles
    };
}
