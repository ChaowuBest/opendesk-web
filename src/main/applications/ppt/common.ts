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

/** 幻灯片定义：与 data/<id>/manifest.json 结构一致；pages 为每页的原始 HTML 字符串 */
export interface Slides {
    uid: string;
    name: string;
    abstract: string;
    /** 每页的完整 HTML 内容，用于 Shadow DOM 展示 */
    pages: string[];
    images: Record<string, string>;
}
