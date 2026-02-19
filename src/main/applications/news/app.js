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

import { BaseApplication } from "../base";
import { logger } from "../../utils/logger.js";
import https from "https";


class NewsApplication extends BaseApplication {
    constructor() {
        super("news", "新闻聚合");
    }

    /**
     * Fetch top news via Hacker News Algolia API on the main process side to avoid renderer CORS issues.
     */
    async fetchTopNews() {
        try {
            logger.info('[news] fetchTopNews start');
            const url = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30';
            const data = await new Promise((resolve, reject) => {
                const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
                    const { statusCode } = res;
                    if (!statusCode || statusCode < 200 || statusCode >= 300) {
                        logger.error(`[news] fetchTopNews bad status ${statusCode}`);
                        reject(new Error(`http ${statusCode}`));
                        res.resume();
                        return;
                    }
                    let rawData = '';
                    res.on('data', (chunk) => rawData += chunk.toString('utf-8'));
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(rawData));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                req.on('error', reject);
                req.setTimeout(10000, () => {
                    req.destroy(new Error('request timeout'));
                });
            });
            const hits = data.hits ?? [];
            logger.info(`[news] fetchTopNews success, hits=${hits.length}`);
            return hits;
        } catch (error) {
            logger.error(`news fetchTopNews failed: ${error.message}`);
            throw error;
        }
    }
}

export { NewsApplication };
