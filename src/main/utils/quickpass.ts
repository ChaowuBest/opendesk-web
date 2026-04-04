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

import { createHash } from 'crypto';
import { Setting } from './setting.js';

const QUICKPASS_PREFIX = '[[Opendesk';
const QUICKPASS_SUFFIX = ']]';
const QUICKPASS_SEPARATOR = ' -- ';
const CHECKSUM_LENGTH = 8;

interface QuickPassResult {
    name: string;
    payload: string;
}

interface ImportConfigResult {
    name: string;
    hasApplications: boolean;
}

interface ConfigData {
    applications?: Record<string, unknown>;
    [key: string]: unknown;
}

class QuickPassHelper {
    /**
     * 将原始 payload 编码为带校验和的 base64 字符串。
     * 格式: base64(payload) + base64(sha256(payload)[0:4])
     * 校验和取 SHA-256 前 4 字节的 base64（固定 8 字符，无 padding），
     * 附加在 payload base64 末尾，用于完整性验证。
     * @param payload
     * @returns
     */
    static encodePayload(payload: string): string {
        const payloadBase64 = Buffer.from(payload, 'utf-8').toString('base64');
        const hash = createHash('sha256').update(payloadBase64, 'utf-8').digest();
        const checksum = hash.subarray(0, 6).toString('base64').replace(/=+$/, '');
        return payloadBase64 + checksum;
    }

    /**
     * 解码带校验和的 base64 字符串，验证完整性后返回原始 payload。
     * @param encoded
     * @returns
     * @throws {Error} 校验和不匹配时抛出
     */
    static decodePayload(encoded: string): string {
        if (encoded.length <= CHECKSUM_LENGTH) {
            throw new Error('口令数据太短，无法解析');
        }
        const payloadBase64 = encoded.slice(0, -CHECKSUM_LENGTH);
        const checksum = encoded.slice(-CHECKSUM_LENGTH);
        const hash = createHash('sha256').update(payloadBase64, 'utf-8').digest();
        const expectedChecksum = hash.subarray(0, 6).toString('base64').replace(/=+$/, '');
        if (checksum !== expectedChecksum) {
            throw new Error('口令校验失败，数据可能已被修改或复制不完整');
        }
        return Buffer.from(payloadBase64, 'base64').toString('utf-8');
    }

    /**
     * 导出口令：将名称和 payload 组合成口令字符串
     * @param name - 口令名称（仅用于展示）
     * @param payload - 口令内容
     * @returns
     */
    static exportQuickPass(name: string, payload: string): string {
        const encoded = QuickPassHelper.encodePayload(payload);
        return `${QUICKPASS_PREFIX} ${name}${QUICKPASS_SEPARATOR}${encoded}${QUICKPASS_SUFFIX}`;
    }

    /**
     * 解析口令字符串，返回名称和原始内容
     * @param quickpass
     * @returns
     * @throws {Error} 格式不合法或校验失败时抛出
     */
    static parseQuickPass(quickpass: string): QuickPassResult {
        const trimmed = quickpass.trim();
        if (!trimmed.startsWith(QUICKPASS_PREFIX)) {
            throw new Error('口令格式错误：缺少起始标记 [[Opendesk');
        }
        if (!trimmed.endsWith(QUICKPASS_SUFFIX)) {
            throw new Error('口令格式错误：缺少结束标记 ]]');
        }

        const inner = trimmed.slice(QUICKPASS_PREFIX.length, -QUICKPASS_SUFFIX.length);
        const separatorIndex = inner.indexOf(QUICKPASS_SEPARATOR);
        if (separatorIndex === -1) {
            throw new Error('口令格式错误：缺少分隔符 --');
        }

        const name = inner.slice(0, separatorIndex).trim();
        const encoded = inner.slice(separatorIndex + QUICKPASS_SEPARATOR.length).replace(/\s+/g, '');

        if (!encoded) {
            throw new Error('口令格式错误：payload 为空');
        }

        const payload = QuickPassHelper.decodePayload(encoded);
        return { name, payload };
    }

    /**
     * 检测一段文本是否是合法的口令
     * @param text
     * @returns
     */
    static isQuickPass(text: string): boolean {
        const trimmed = text.trim();
        if (!trimmed.startsWith(QUICKPASS_PREFIX) || !trimmed.endsWith(QUICKPASS_SUFFIX)) {
            return false;
        }
        try {
            QuickPassHelper.parseQuickPass(trimmed);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 导出基础设置口令（不含 applications 字段）
     * @returns
     */
    static exportBaseConfig(): string {
        const setting = Setting.getInstance();
        const data = { ...setting.getData() } as ConfigData;
        delete data.applications;
        const payload = JSON.stringify(data);
        return QuickPassHelper.exportQuickPass('基础设置口令', payload);
    }

    /**
     * 导出全部设置口令（含 applications 字段）
     * @returns
     */
    static exportAllConfig(): string {
        const setting = Setting.getInstance();
        const data = setting.getData();
        const payload = JSON.stringify(data);
        return QuickPassHelper.exportQuickPass('全部设置口令', payload);
    }

    /**
     * 从口令中导入设置
     * @param quickpass - 口令字符串
     * @returns
     * @throws {Error} 格式不合法、校验失败或数据无法解析时抛出
     */
    static importConfig(quickpass: string): ImportConfigResult {
        const { name, payload } = QuickPassHelper.parseQuickPass(quickpass);

        let configData: ConfigData;
        try {
            configData = JSON.parse(payload);
        } catch {
            throw new Error('口令内容不是有效的 JSON 格式');
        }

        const setting = Setting.getInstance();
        const currentData = setting.getData() as ConfigData;
        const hasApplications = configData.applications !== undefined;

        if (!hasApplications) {
            configData.applications = currentData.applications;
        }

        setting.setData(configData);

        return { name, hasApplications };
    }
}

export { QuickPassHelper };
