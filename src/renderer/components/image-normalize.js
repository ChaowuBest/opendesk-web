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
 * 用户消息图片的 MIME 归一化（粘贴/拖拽进入 AgentInput 的唯一汇聚点）：
 * 非 png/jpeg 的图片统一经 canvas 转成 PNG 再进入消息，保证主进程图片外置
 * （jimp 不解码 webp/avif 等）与 artifacts 原图落盘对任意剪贴板/文件来源都可用。
 * 转换失败（解码失败等）时原样返回，不阻塞图片附件。
 */

const NATIVE_DECODABLE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

/** data URL 前缀：`data:<mime>;base64,` */
const DATA_URL_MIME_PATTERN = /^data:([^;,]+)[;,]/i;

/** @param {string} dataUrl @returns {boolean} */
export function isNativeDecodableImageDataUrl(dataUrl) {
    const match = DATA_URL_MIME_PATTERN.exec(dataUrl);
    return match !== null && NATIVE_DECODABLE_MIME_TYPES.has(match[1].toLowerCase());
}

/** @param {string} dataUrl @returns {Promise<string>} */
export async function normalizeImageDataUrlToPng(dataUrl) {
    if (isNativeDecodableImageDataUrl(dataUrl)) {
        return dataUrl;
    }
    try {
        const image = new Image();
        const loaded = new Promise((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('image decode failed'));
        });
        image.src = dataUrl;
        await loaded;
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
            throw new Error('image has no pixels');
        }
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('canvas 2d context unavailable');
        }
        context.drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
    } catch {
        // 解码失败（浏览器不支持的编码 / 损坏数据）：保持原样，由主进程按不可外置降级
        return dataUrl;
    }
}
