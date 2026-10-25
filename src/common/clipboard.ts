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

interface ClipboardDataLike {
    getData?(format: string): string;
}

const POWERPOINT_CLIPBOARD_HTML_PATTERN =
    /urn:schemas-microsoft-com:office:powerpoint|PowerPoint\.Slide|Microsoft PowerPoint/i;

export function hasPowerPointClipboardText(clipboardData: ClipboardDataLike | null | undefined): boolean {
    const plainText = clipboardData?.getData?.('text/plain')?.trim();
    if (!plainText) return false;
    // plainText 非空即说明 clipboardData 存在，这里沿用可选链保持与上面的取参一致
    const html = clipboardData?.getData?.('text/html') || '';
    return POWERPOINT_CLIPBOARD_HTML_PATTERN.test(html);
}
