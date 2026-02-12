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

import path from "path";
import fs from "fs";
import { BaseWorker } from "../base";
import type { Slides } from "./common";
import { logger } from "../../utils/logger";


export default class PPTWorker extends BaseWorker {
    constructor(appDataDirectory: string) {
        super('ppt', appDataDirectory);
    }

    async initialize() {
        super.initialize();
    }

    /**
     * 从 appDataDirectory/data/<uid> 读取 manifest.json，返回幻灯片定义
     */
    async getSlides(uid: string): Promise<Slides | null> {
        const dataDir = path.join(this.appDataDirectory, 'data', uid);
        const manifestPath = path.join(dataDir, 'manifest.json');

        const data = await fs.promises.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(data);
        const slides: Slides = {
            uid: uid,
            name: manifest.name,
            abstract: manifest.abstract,
            pages: [],
            images: {},
        };

        for (var i = 0;; i ++) {
            const pagePath = path.join(dataDir, `${i}.html`);
            if (fs.existsSync(pagePath)) {
                const pageContent = fs.readFileSync(pagePath, 'utf-8');
                slides.pages.push(pageContent);
            } else {
                break;
            }
        }

        const imagesDir = path.join(dataDir, 'images');
        if (fs.existsSync(imagesDir)) {
            const images = await fs.promises.readdir(imagesDir);
            for (const image of images) {
                slides.images[image] = path.join(dataDir, 'images', image);
            }
        }

        logger.info(`slides for ${uid} loaded with ${slides.pages.length} pages and ${Object.keys(slides.images).length} images`);
        return slides;
    }
}