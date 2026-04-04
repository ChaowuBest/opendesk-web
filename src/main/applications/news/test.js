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

import https from 'https';

async function fetchTopNews() {
    const url = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=5';

    const data = await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
            const { statusCode } = res;

            if (!statusCode || statusCode < 200 || statusCode >= 300) {
                reject(new Error(`HTTP status ${statusCode}`));
                res.resume();
                return;
            }

            let rawData = '';
            res.on('data', (chunk) => (rawData += chunk));
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

    return data.hits ?? [];
}

(async () => {
    try {
        const news = await fetchTopNews();

        console.log('是否成功获取数据:', Array.isArray(news));
        console.log('新闻条数:', news.length);
        console.log('第一条新闻示例:');
        console.log({
            title: news[0]?.title,
            url: news[0]?.url,
            author: news[0]?.author,
            points: news[0]?.points
        });
    } catch (err) {
        console.error('获取失败:', err.message);
    }
})();
