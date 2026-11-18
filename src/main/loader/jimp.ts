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

import { createResourceLoader, type ResourceLoader } from './base.js';

/** jimp 的 Jimp 构造器。全量解码器在 bundle 内约 2.6MB。 */
export type JimpConstructor = (typeof import('jimp'))['Jimp'];

export const jimpLoader: ResourceLoader<JimpConstructor> = createResourceLoader(
    'image-processing',
    async () => (await import('jimp')).Jimp
);
