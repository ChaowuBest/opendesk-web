class AgentFilesView extends HTMLElement {
    constructor() {
        super();
        this.hidden = true;
        this.files = [];
        this.current_page = 1;
        this.page_size = 5;
        this.file_list_id = crypto.randomUUID();
    }

    connectedCallback() {
        this.render();
    }

    clearSearchResults() {
        this.files = [];
        this.current_page = 1;
        this.render();
    }

    /**
     * Start searching files by keyword
     * @param {string} query
     */
    startSearch(query) {
        // INSERT_YOUR_CODE
        Promise.all([
            window.fsAPI.searchFilesByKeyword(query),
            window.fsAPI.searchFilesByNameSimilarity(query)
        ]).then(([keywordFiles, similarityFiles]) => {
            // 合并两个结果，去重（假设 path 唯一）
            let files = [...keywordFiles, ...similarityFiles];
            this.setFiles(files);
        }).catch(error => {
            console.error('searching files failed', error);
            this.clearSearchResults();
        });
    }

    setFiles(files) {
        this.files = files;
        this.current_page = 1;
        if (this.files.length === 0) {
            this.hidden = true;
        } else {
            this.hidden = false;
            this.render();
        }
    }

    renderFileItem(file) {
        return `
        <div class="px-3 py-1 hover:bg-gray-50 transition grid grid-cols-12 gap-4 items-center">
            <div class="btn-open-file col-span-7 flex items-center gap-3 cursor-pointer" data-file_path="${file.path}">
                <i class="fas fa-file-pdf text-red-500 text-xl"></i>
                <span class="text-gray-800 font-medium truncate" style="display: inline-block; vertical-align: bottom;" title="${file.filename}">${file.filename}</span>
            </div>
            <div class="col-span-2 text-gray-600 text-sm hidden md:block">${new Date(file.modified).toLocaleDateString()}</div>
            <div class="col-span-2 text-gray-600 text-sm hidden md:block">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
            <div class="col-span-1 flex justify-end gap-2">
                <button
                    class="p-2 hover:bg-gray-100 rounded transition btn-add-file-to-session"
                    data-file_path="${file.path}"
                    title="添加到会话"
                >
                    <i class="fas fa-plus text-gray-600"></i>
                </button>
            </div>
        </div>
        `;
    }

    renderPagination() {
        let pages = [];
        let npages = Math.ceil(this.files.length / this.page_size);

        if (npages <= 1) return ''; // No need for pagination

        // 上一页
        if (this.current_page > 1) {
            pages.push(`<button data-page="${this.current_page - 1}" class="btn-page-goto px-3 py-1 border border-gray-300 rounded-xl hover:bg-gray-50 transition">上一页</button>`);
        }

        // page button factory
        const makeBtn = (i) => {
            let page_class = "px-3 py-1 border border-gray-300 rounded-full hover:bg-gray-50 transition";
            if (i === this.current_page) {
                page_class = "px-3 py-1 bg-[#C94C40] text-white rounded-full";
            }
            return `<button data-page="${i}" class="btn-page-goto ${page_class}">${i}</button>`;
        };

        // 计算显示哪些页
        // 总页数小于等于7时直接显示全部
        if (npages <= 7) {
            for (let i = 1; i <= npages; i++) {
                pages.push(makeBtn(i));
            }
        } else {
            // 1-2 always show
            for (let i = 1; i <= 2; i++) {
                pages.push(makeBtn(i));
            }

            // 需要省略号的位置
            let showLeftEllipsis = false, showRightEllipsis = false;
            // 当前页前后要显示
            let before = this.current_page - 1, after = this.current_page + 1;

            // 当前页为5及以后，显示省略号
            if (this.current_page > 4) {
                showLeftEllipsis = true;
            }
            // 当前页为倒数第4页及以前，显示省略号
            if (this.current_page < npages - 3) {
                showRightEllipsis = true;
            }

            // 左侧省略号
            if (showLeftEllipsis) {
                pages.push(`<span class="px-2 text-gray-400">...</span>`);
            }

            // 当前页前后显示
            let startMid = Math.max(3, before); // mid from 3 or当前页-1
            let endMid = Math.min(npages - 2, after); // mid 到倒数第2前后

            for (let i = startMid; i <= endMid; i++) {
                // 前2、后2已经显示过，跳过
                if (i <= 2 || i > npages - 2) continue;
                pages.push(makeBtn(i));
            }

            // 右侧省略号
            if (showRightEllipsis) {
                pages.push(`<span class="px-2 text-gray-400">...</span>`);
            }

            // npages-1, npages
            for (let i = npages - 1; i <= npages; i++) {
                if (i > 2 && i <= npages) {
                    pages.push(makeBtn(i));
                }
            }
        }

        // 下一页
        if (this.current_page < npages) {
            pages.push(`<button data-page="${this.current_page + 1}" class="btn-page-goto px-3 py-1 border border-gray-300 rounded-xl hover:bg-gray-50 transition">下一页</button>`);
        }

        return pages.join('');
    }

    render() {
        const current_files = this.files.slice((this.current_page - 1) * this.page_size, this.current_page * this.page_size);
        const file_items = current_files.map(file => this.renderFileItem(file)).join('');
        this.innerHTML = `
        <!-- 文件列表 -->
        <div class="mt-3 w-full bg-white text-sm rounded-2xl shadow-sm overflow-hidden">
            <!-- 列表头部 -->
            <div class="bg-gray-50 px-3 py-3 border-b border-gray-200 grid grid-cols-12 gap-4 font-medium text-gray-600">
                <div class="col-span-7">名称</div>
                <div class="col-span-2 hidden md:block">修改时间</div>
                <div class="col-span-2 hidden md:block">大小</div>
                <div class="col-span-1 text-left">操作</div>
            </div>
            <!-- 文件项 -->
            <div id='${this.file_list_id}' class="divide-y divide-gray-200">
                ${file_items}
            </div>
            <!-- 分页 -->
            <div class="mt-4 px-3 pb-3 flex justify-between items-center">
                <p class="text-gray-600">共 ${this.files.length} 个文件</p>
                <div class="flex gap-2">
                    ${this.renderPagination()}
                </div>
            </div>
        </div>
        `;

        this.querySelectorAll('.btn-page-goto').forEach(btn => {
            btn.addEventListener('click', (event) => {
                this.current_page = parseInt(event.currentTarget.dataset.page);
                this.render();
            });
        });
        this.querySelectorAll('.btn-open-file').forEach(btn => {
            btn.addEventListener('click', (event) => {
                const file_path = event.currentTarget.dataset.file_path;
                console.info('open file', file_path);
                window.fsAPI.openFile(file_path);
            });
        });
        this.querySelectorAll('.btn-add-file-to-session').forEach(btn => {
            btn.addEventListener('click', (event) => {
                const file_path = event.currentTarget.dataset.file_path;
                this.dispatchEvent(new CustomEvent('addFileToSession', { detail: { file_path } }));
            });
        });
    }
}

customElements.define('agent-files-view', AgentFilesView);