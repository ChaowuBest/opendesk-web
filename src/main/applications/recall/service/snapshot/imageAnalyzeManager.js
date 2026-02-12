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

import dhashPkg from 'dhash';
const { dHash } = dhashPkg;
import { ssim } from 'ssim.js';
import { logger } from '../../../../utils/logger.js';
import fs from 'fs';
import sharp from 'sharp';
import { Setting } from '../../../../utils/setting.js';
import { UserMessage } from '../../../../agents/messages';
import { LLM } from '../../../../agents/llm.js';

// 关键帧检测阈值常量
const KEYFRAME_DETECTION = {
    DHASH_THRESHOLD: 5,           // dHash差异阈值
    SSIM_THRESHOLD: 0.8,          // SSIM相似度阈值
    MIN_INTERVAL_MS: 10000        // 最小间隔时间(毫秒)
};

/**
 * 计算两个dHash之间的汉明距离
 */
function calculateHammingDistance(hash1, hash2) {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) {
        return Infinity;
    }

    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
        if (hash1[i] !== hash2[i]) {
            distance++;
        }
    }
    return distance;
}

/**
 * 计算图像的dHash值
 */
async function calculateDHash(imageBuffer) {
    try {
        // 使用sharp将图像转换为8位灰度图并调整为9x8大小
        const grayBuffer = await sharp(imageBuffer)
            .resize(9, 8, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer();

        // 计算dHash：比较每行相邻像素的亮度差异
        let hash = '';
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const currentIndex = y * 9 + x;
                const nextIndex = y * 9 + x + 1;

                const currentPixel = grayBuffer[currentIndex];
                const nextPixel = grayBuffer[nextIndex];

                hash += currentPixel < nextPixel ? '1' : '0';
            }
        }

        return hash;
    } catch (error) {
        logger.error(`Failed to calculate dHash: ${error.message}`);
        return null;
    }
}

/**
 * 使用SSIM算法计算两张图片的相似度
 * ssim.js 需要 RGBA 格式的数据
 */
async function calculateSSIM(imagePath1, imagePath2) {
    try {
        // 将图像转换为 RGBA 格式（ssim.js 需要4通道数据）
        const img1Buffer = await sharp(imagePath1)
            .resize(256, 256, { fit: 'fill' })
            .ensureAlpha()  // 确保有 alpha 通道
            .raw()
            .toBuffer();

        const img2Buffer = await sharp(imagePath2)
            .resize(256, 256, { fit: 'fill' })
            .ensureAlpha()
            .raw()
            .toBuffer();

        // 转换为 Uint8ClampedArray 格式
        const img1Data = new Uint8ClampedArray(img1Buffer);
        const img2Data = new Uint8ClampedArray(img2Buffer);

        const ssimValue = ssim(
            { data: img1Data, width: 256, height: 256 },
            { data: img2Data, width: 256, height: 256 }
        );

        return ssimValue.mssim;
    } catch (error) {
        logger.error(`Failed to calculate SSIM: ${error.message}`);
        return 0;
    }
}

/**
 * 图像比较结果
 * @typedef {Object} ImageComparisonResult
 * @property {boolean} isSimilar - 是否相似
 * @property {number} hammingDistance - 汉明距离
 * @property {number} [ssimValue] - SSIM值（如果进行了SSIM比较）
 */

/**
 * 图像分析工具类（无状态）
 * 提供图像相似性计算的纯函数能力：dHash、汉明距离、SSIM
 * 不持有任何状态，所有判定结果通过参数传入和返回值传出
 */
class ImageAnalyzeManager {
    /**
     * 计算图像的dHash值
     * @param {Buffer} imageBuffer - 图像缓冲区
     * @returns {Promise<string|null>} 64位二进制字符串
     */
    static async calculateImageHash(imageBuffer) {
        return await calculateDHash(imageBuffer);
    }

    /**
     * 计算两个dHash之间的汉明距离
     * @param {string} hash1 - 第一个hash
     * @param {string} hash2 - 第二个hash
     * @returns {number} 汉明距离（0-64），Infinity表示无效
     */
    static calculateHammingDistance(hash1, hash2) {
        return calculateHammingDistance(hash1, hash2);
    }

    /**
     * 计算两张图片的SSIM相似度
     * @param {string} imagePath1 - 第一张图片路径
     * @param {string} imagePath2 - 第二张图片路径
     * @returns {Promise<number>} SSIM值（0-1）
     */
    static async calculateSSIM(imagePath1, imagePath2) {
        return await calculateSSIM(imagePath1, imagePath2);
    }

    /**
     * 比较两个图像是否相似（纯判定函数）
     * 使用分层策略：先dHash快速过滤，再SSIM精确比较
     *
     * @param {string} hash1 - 第一个图像的dHash
     * @param {string} path1 - 第一个图像的路径
     * @param {string} hash2 - 第二个图像的dHash
     * @param {string} path2 - 第二个图像的路径
     * @param {Object} [thresholds] - 阈值配置
     * @param {number} [thresholds.dhashThreshold=5] - dHash汉明距离阈值
     * @param {number} [thresholds.ssimThreshold=0.8] - SSIM相似度阈值
     * @returns {Promise<ImageComparisonResult>} 比较结果
     */
    static async compareImages(hash1, path1, hash2, path2, thresholds = {}) {
        const dhashThreshold = thresholds.dhashThreshold ?? KEYFRAME_DETECTION.DHASH_THRESHOLD;
        const ssimThreshold = thresholds.ssimThreshold ?? KEYFRAME_DETECTION.SSIM_THRESHOLD;

        // 第一层：dHash快速比较
        const hammingDistance = calculateHammingDistance(hash1, hash2);
        if (hammingDistance > dhashThreshold) {
            return {
                isSimilar: false,
                hammingDistance,
                ssimValue: undefined
            };
        }

        // 第二层：SSIM精确比较
        if (!fs.existsSync(path1) || !fs.existsSync(path2)) {
            return {
                isSimilar: false,
                hammingDistance,
                ssimValue: undefined
            };
        }

        const ssimValue = await calculateSSIM(path1, path2);
        const isSimilar = ssimValue >= ssimThreshold;

        return {
            isSimilar,
            hammingDistance,
            ssimValue
        };
    }

    /**
     * 获取统计信息（占位方法，已废弃）
     * @deprecated 状态管理已移至业务层
     */
    static getStats() {
        return {
            message: 'ImageAnalyzeManager is now stateless. Statistics should be managed by the business layer.',
            totalImages: 0,
            keyframes: 0,
            duplicateRate: 0,
            memoryUsage: { hashDatabase: 0, keyframeHashes: 0 }
        };
    }

    /**
     * 批量生成图片记忆（summary）
     * @param {Array<{snapshotId: string, imageUrl: string}>} snapshots - 快照列表
     * @returns {Promise<Array<{snapshotId: string, summary: string}>>}
     */
    static async batchGenerateMemories(snapshots) {
        if (!snapshots || snapshots.length === 0) {
            return [];
        }

        try {
            const model = Setting.getInstance().getDefaultVisionModelInstance();

            const prompt = `你是一个屏幕记录助手。请为每张截图生成一句话记忆描述。

    要求：
    1. 每张图片独立分析，不要参考其他图片
    2. 忽略无效信息（人物头像、空白画面、未共享内容等）
    3. 如果是有意义的内容，简洁描述用户在做什么或看到了什么
    4. 如果是无效内容，返回空字符串

    返回JSON格式：
    {
    "memories": [
        {"index": 0, "summary": "一句话描述"},
        {"index": 1, "summary": ""}
    ]
    }

    请按照快照顺序返回，index 从 0 开始。`;

            const message = new UserMessage().appendText(prompt);

            // 添加所有图片
            for (const snapshot of snapshots) {
                message.appendImageURL(snapshot.imageUrl);
            }

            const response = await LLM.askForObject(message, model);
            logger.info(`Vision model response for memory generation: ${JSON.stringify(response)}`);
            if (!response.memories || !Array.isArray(response.memories)) {
                throw new Error('Invalid response format from vision model');
            }

            // 映射回 snapshotId
            const results = [];
            for (let i = 0; i < snapshots.length; i++) {
                const memory = response.memories.find(m => m.index === i);
                results.push({
                    snapshotId: snapshots[i].snapshotId,
                    summary: memory ? (memory.summary || '') : ''
                });
            }

            return results;
        } catch (error) {
            logger.error(`Failed to generate memories: ${error.message}`);
            throw error;
        }
    }

    /**
     * 生成单张图片记忆
     * @param {string} snapshotId - 快照ID
     * @param {string} imageUrl - 图片URL（base64或文件路径）
     * @returns {Promise<string>}
     */
    static async generateMemory(snapshotId, imageUrl) {
        const results = await ImageAnalyzeManager.batchGenerateMemories([
            { snapshotId, imageUrl }
        ]);
        return results[0]?.summary || '';
    }
}

export { ImageAnalyzeManager, KEYFRAME_DETECTION };