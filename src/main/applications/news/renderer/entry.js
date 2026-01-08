import { AgentOperableHTMLElement, RendererTool, RendererToolset, z } from '../../widget_utils.js';

class NewsEntryWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
        /** @type {Array<{title:string,url:string,source:string,points:number,author:string,created_at:string,objectID:string}>} */
        this.articles = [];
        this.selectedIndex = 0;
        this.loading = false;
        this.errorMessage = null;
    }

    connectedCallback() {
        this.render();
        this.fetchNews();
        this.setupEvents();
    }

    getAgentInstruct() {
        return '你是新闻助手，帮助用户快速浏览并总结最新热点新闻。';
    }

    getToolset() {
        const toolset = new RendererToolset('news');
        if (this.articles.length > 0) {
            const headlineTool = new RendererTool('getTopHeadlines', '获取当前新闻列表（前10条）');
            headlineTool.setExecutor(async () => {
                return this.articles.slice(0, 10).map((item, idx) => {
                    return `${idx + 1}. ${item.title}\n   链接: ${item.url}\n   来源: ${item.source}，作者: ${item.author || '未知'}，热度: ${item.points}`;
                }).join('\n');
            });
            toolset.addTool(headlineTool);

            if (this.selectedIndex !== null && this.articles[this.selectedIndex]) {
                const detailTool = new RendererTool('getSelectedArticle', '获取用户正在查看的新闻详情');
                detailTool.setExecutor(async () => {
                    const current = this.articles[this.selectedIndex];
                    return `标题: ${current.title}\n来源: ${current.source}\n作者: ${current.author || '未知'}\n热度: ${current.points}\n链接: ${current.url}`;
                });
                toolset.addTool(detailTool);
            }
        }
        return toolset;
    }

    setupEvents() {
        this.querySelector('#news-refresh-btn').addEventListener('click', () => this.fetchNews());
    }

    async fetchNews() {
        this.loading = true;
        this.errorMessage = null;
        this.updateStatus();
        let errorFlag = false;
        try {
            console.info('[news-ui] fetchNews start');
            const hits = await window.applicationAPI.sendMessageToApplication('fetchTopNews');
            console.info('[news-ui] fetchNews hits received', hits?.length);
            this.articles = hits.map(hit => ({
                title: hit.title || hit.story_title || 'Untitled',
                url: hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
                source: 'Hacker News',
                points: hit.points ?? 0,
                author: hit.author,
                created_at: hit.created_at,
                objectID: hit.objectID
            }));
            this.selectedIndex = 0;
        } catch (error) {
            console.error('加载新闻失败', error);
            this.errorMessage = error.message;
            errorFlag = true;
        } finally {
            this.loading = false;
            this.updateStatus();
            this.renderArticleList(errorFlag);
            this.renderArticleDetail(errorFlag);
        }
    }

    updateStatus() {
        const status = this.querySelector('#news-status');
        if (this.loading) {
            status.innerHTML = `<i class="fa-solid fa-rotate fa-spin mr-2"></i> 正在获取最新新闻...`;
            status.classList.remove('text-red-500');
            status.classList.add('text-gray-600');
        } else if (this.errorMessage) {
            status.innerHTML = `<i class="fa-solid fa-triangle-exclamation mr-2"></i> ${this.errorMessage}`;
            status.classList.remove('text-gray-600');
            status.classList.add('text-red-500');
        } else {
            const timeText = new Date().toLocaleTimeString();
            status.innerHTML = `<i class="fa-regular fa-clock mr-2"></i> 已更新：${timeText}`;
            status.classList.remove('text-red-500');
            status.classList.add('text-gray-500');
        }
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100">
            <header class="pl-6 pr-16 py-4 flex items-center justify-between border-b bg-white/80 backdrop-blur">
                <div>
                    <p class="text-xs uppercase tracking-wide text-gray-400">News now</p>
                    <h1 class="text-2xl font-semibold text-gray-800">即时新闻</h1>
                </div>
                <div class="flex items-center gap-3">
                    <button id="news-refresh-btn" class="px-4 py-2 rounded-full bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 shadow-sm transition">
                        <i class="fa-solid fa-rotate mr-2"></i>刷新
                    </button>
                    <span id="news-status" class="text-xs text-gray-500"></span>
                </div>
            </header>

            <div class="flex-1 grid grid-cols-12 gap-4 p-6 overflow-hidden">
                <div class="col-span-5 bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
                    <div class="px-4 py-3 border-b flex items-center justify-between">
                        <span class="text-sm font-semibold text-gray-700">新闻情报官</span>
                        <span class="text-xs text-gray-400">点击查看详情</span>
                    </div>
                    <div id="news-list" class="flex-1 overflow-y-auto divide-y"></div>
                </div>
                <div class="col-span-7 bg-white rounded-3xl shadow-sm border border-gray-100 p-6 overflow-y-auto" id="news-detail">
                </div>
            </div>
        </div>
        `;
    }

    renderArticleList(isError = false) {
        const list = this.querySelector('#news-list');
        if (!list) return;

        if (this.loading) {
            list.innerHTML = `<div class="p-6 text-center text-gray-500">加载中...</div>`;
            return;
        }

        if (isError) {
            list.innerHTML = `<div class="p-6 text-center text-red-500">加载失败，请重试</div>`;
            return;
        }

        if (this.articles.length === 0) {
            list.innerHTML = `<div class="p-6 text-center text-gray-500">暂无新闻数据</div>`;
            return;
        }

        list.innerHTML = this.articles.map((article, idx) => {
            const active = idx === this.selectedIndex;
            return `
            <div class="px-4 py-3 cursor-pointer transition ${active ? 'bg-blue-50 border-l-4 border-blue-500' : 'hover:bg-gray-50'}" data-index="${idx}">
                <div class="flex items-start justify-between">
                    <div class="flex-1">
                        <p class="text-sm font-semibold text-gray-800 line-clamp-2">${article.title}</p>
                        <p class="text-xs text-gray-500 mt-1">${article.source} · ${article.author || '未知'} · ${article.points} 分</p>
                    </div>
                    <span class="text-[10px] text-gray-400 ml-2">#${idx + 1}</span>
                </div>
            </div>
            `;
        }).join('');

        list.querySelectorAll('[data-index]').forEach(item => {
            item.addEventListener('click', () => {
                this.selectedIndex = Number(item.dataset.index);
                this.renderArticleList();
                this.renderArticleDetail();
            });
        });
    }

    renderArticleDetail(isError = false) {
        const detail = this.querySelector('#news-detail');
        if (!detail) return;

        if (this.loading) {
            detail.innerHTML = `<div class="h-full flex items-center justify-center text-gray-500">加载中...</div>`;
            return;
        }

        if (isError) {
            detail.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-red-500 gap-2">
                <i class="fa-solid fa-triangle-exclamation text-xl"></i>
                <span>加载失败，请点击刷新重试</span>
            </div>`;
            return;
        }

        if (!this.articles[this.selectedIndex]) {
            detail.innerHTML = `<div class="h-full flex items-center justify-center text-gray-500">选择一条新闻查看详情</div>`;
            return;
        }

        const article = this.articles[this.selectedIndex];
        const timeText = new Date(article.created_at).toLocaleString();

        detail.innerHTML = `
        <div class="flex flex-col gap-3">
            <div class="flex items-start gap-3">
                <div class="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center font-semibold">N</div>
                <div>
                    <p class="text-xs uppercase tracking-wide text-gray-400">${article.source}</p>
                    <h2 class="text-xl font-semibold text-gray-900 leading-snug">${article.title}</h2>
                </div>
            </div>
            <div class="text-sm text-gray-500 flex flex-wrap gap-3">
                <span><i class="fa-regular fa-user mr-1"></i>${article.author || '未知'}</span>
                <span><i class="fa-regular fa-clock mr-1"></i>${timeText}</span>
                <span><i class="fa-regular fa-star mr-1"></i>${article.points} points</span>
            </div>
            <div class="p-4 bg-gray-50 rounded-2xl text-gray-700 text-sm leading-relaxed">
                这是一条来自 Hacker News 的实时热点。可点击下方按钮在浏览器中查看原文。
            </div>
            <div class="flex items-center gap-3">
                <a class="px-4 py-2 rounded-full bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition" href="${article.url}" target="_blank" rel="noreferrer">
                    <i class="fa-solid fa-arrow-up-right-from-square mr-2"></i>打开原文
                </a>
                <button id="news-copy-link" class="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 transition">
                    复制链接
                </button>
            </div>
        </div>
        `;

        const copyBtn = detail.querySelector('#news-copy-link');
        copyBtn?.addEventListener('click', () => {
            navigator.clipboard?.writeText(article.url);
            copyBtn.innerHTML = '<i class="fa-solid fa-check mr-1"></i>已复制';
            setTimeout(() => {
                copyBtn.innerHTML = '复制链接';
            }, 1200);
        });
    }
}

customElements.define('news-entry-widget', NewsEntryWidget);
