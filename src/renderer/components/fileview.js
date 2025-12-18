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
        <div class="px-2 py-1 hover:bg-gray-50 transition grid grid-cols-12 gap-4 items-center">
            <div class="btn-open-file col-span-7 flex items-center gap-3 cursor-pointer" data-file_path="${file.path}">
                <i class="fas fa-file-pdf text-red-500 text-xl"></i>
                <span class="text-gray-800 font-medium">${file.filename}</span>
            </div>
            <div class="col-span-2 text-gray-600 text-sm hidden md:block">${new Date(file.modified).toLocaleDateString()}</div>
            <div class="col-span-2 text-gray-600 text-sm hidden md:block">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
            <div class="col-span-1 flex justify-end gap-2">
                <button class="p-2 hover:bg-gray-100 rounded transition" title="AI阅读">
                    <i class="fas fa-download text-gray-600"></i>
                </button>
                <button class="p-2 hover:bg-gray-100 rounded transition" title="更多">
                    <i class="fas fa-ellipsis-v text-gray-600"></i>
                </button>
            </div>
        </div>
        `;
    }

    renderPagination() {
        let pages = [];
        let npages = Math.ceil(this.files.length / this.page_size);
        if (this.current_page > 1) {
            pages.push(`<button data-page="${this.current_page - 1}" class="btn-page-goto px-3 py-1 border border-gray-300 rounded-xl hover:bg-gray-50 transition">上一页</button>`);
        }
        for (let i = 1; i <= npages; i++) {
            let page_class = "px-3 py-1 border border-gray-300 rounded-full hover:bg-gray-50 transition";
            if (i === this.current_page) {
                page_class = "px-3 py-1 bg-blue-600 text-white rounded-full";
            }
            pages.push(`<button data-page="${i}" class="btn-page-goto ${page_class}">${i}</button>`);
        }
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
        <div class="mt-3 w-full bg-white rounded-xl shadow-sm overflow-hidden">
            <!-- 列表头部 -->
            <div class="bg-gray-50 px-3 py-3 border-b border-gray-200 grid grid-cols-12 gap-4 text-sm font-medium text-gray-600">
                <div class="col-span-7">名称</div>
                <div class="col-span-2 hidden md:block">修改时间</div>
                <div class="col-span-2 hidden md:block">大小</div>
                <div class="col-span-1 text-right">操作</div>
            </div>
            <!-- 文件项 -->
            <div id='${this.file_list_id}' class="divide-y divide-gray-200">
                ${file_items}
            </div>
            <!-- 分页 -->
            <div class="mt-4 px-3 pb-3 flex justify-between items-center">
                <p class="text-sm text-gray-600">共 ${this.files.length} 个文件</p>
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
    }
}

customElements.define('agent-files-view', AgentFilesView);