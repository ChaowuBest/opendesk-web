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

import { z } from 'zod';

/**
 * 笔记条目 Schema
 */
const NoteItemSchema = z.object({
    id: z.string(),
    title: z.string().default(''),
    tags: z.array(z.string()).default([]),
    createdAt: z.number(),
    updatedAt: z.number(),
    isPinned: z.boolean().default(false)
});

/**
 * 标签 Schema
 */
const NoteTagSchema = z.object({
    name: z.string(),
    color: z.string().default('#007AFF'),
    createdAt: z.number()
});

/**
 * 笔记存储结构 Schema（notes.json 的完整格式）
 */
const NotesStorageSchema = z.object({
    version: z.string().default('1.0'),
    notes: z.array(NoteItemSchema).default([]),
    tags: z.array(NoteTagSchema).default([]),
    last_updated: z.string().default('')
});

export { NoteItemSchema, NoteTagSchema, NotesStorageSchema };
