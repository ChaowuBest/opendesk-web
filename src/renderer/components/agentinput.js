class AgentInput extends HTMLElement {

    constructor() {
        super();
        this.attachedFilePaths = [];
    }

    connectedCallback() {
        this.render();
    }

    disconnectedCallback() {

    }

    attachFilePath(filePath) {
        this.attachedFilePaths.push(filePath);
        this.render();
    }

    removeFilePath(filePath) {
        this.attachedFilePaths = this.attachedFilePaths.filter(p => p !== filePath);
        this.render();
    }

    render() {
        let fileItems = this.attachedFilePaths.map(filePath => {
            let fileName = filePath.split('/').pop();
            return `
            <div class="px-3 py-1 bg-blue-50 text-blue-700 hover:text-gray-600 hover:bg-blue-20 rounded-full border border-blue-100 transition-all shadow-sm text-xs cursor-pointer">
                <i class="fas fa-paperclip"></i>
                <span class="max-w-[120px] truncate">${fileName}</span>
                <button data-file_path="${filePath}" class="agent-input-remove-file-btn hover:text-red-500 leading-none">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            `;
        }).join('');

        this.innerHTML = `
        <div id="agent-input-container" class="w-full p-1.5 rounded-[28px] bg-white/40 border border-gray/60 shadow-[0_10px_40px_-15px_rgba(0,0,0,0.08)]">
            <div class="bg-white rounded-[22px] p-1 shadow-sm border border-gray-100/40">
                <!-- 主要输入区域 -->
                <div class="p-3">
                    <textarea
                        id="agent-input-textarea"
                        placeholder="在这里输入消息，按 Ctrl+Enter 发送"
                        class="w-full h-15 resize-none border-none outline-none placeholder-gray-400 text-gray-700"
                    ></textarea>
                </div>

                <!-- 工具栏 -->
                <div class="flex items-center justify-between px-2 py-1 border-t border-gray-100">
                    <!-- 左侧工具按钮 -->
                    <div class="flex items-center space-x-3">
                        <!-- 附件 -->
                        <div id="agent-input-attached-file-list" class="flex items-center gap-1">
                            ${fileItems}
                        </div>
                    </div>

                    <!-- 右侧按钮 -->
                    <div class="flex items-center space-x-2">
                        <!-- 发送按钮 -->
                        <button id="agent-input-submit-btn" class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-full transition-colors">
                            <i class="fas fa-arrow-up text-lg"></i>
                    </div>
                </div>
            </div>
        </div>
        `

        this.setUpEventListeners();
    }

    setUpEventListeners() {
        const container = this.querySelector('#agent-input-container')
        const textarea = this.querySelector('#agent-input-textarea')
        const submitBtn = this.querySelector('#agent-input-submit-btn')
        const removeFileBtns = this.querySelectorAll('.agent-input-remove-file-btn')

        // 提交消息的函数
        const handleSubmit = () => {
            const message = textarea.value.trim()
            if (message === '') {
                return;
            }

            const submitEvent = new CustomEvent('submit', {
                detail: {
                    message: message,
                    attachedFilePaths: this.attachedFilePaths
                },
                bubbles: true
            });
            this.dispatchEvent(submitEvent);
            textarea.value = '';
        }

        submitBtn.addEventListener('click', handleSubmit)

        removeFileBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.removeFilePath(btn.dataset.file_path);
            });
        });

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        })

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const files = e.dataTransfer.files;
            for (const file of files) {
                console.info('attach dropped file', file, window.fsAPI.getFilePath(file));
                /* electron前端无法获取文件完整路径，需要通过fsAPI.getFilePath获取 */
                this.attachFilePath(window.fsAPI.getFilePath(file));
            }
        })

        // Ctrl+Enter 快捷键
        textarea.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
            }
        })

        textarea.addEventListener('input', (e) => {
            this.dispatchEvent(new CustomEvent('contentChanged', {
                detail: {
                    value: e.target.value
                },
                bubbles: true
            }));
        })
    }
}

class ApplicationAgentInput extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <style>
        /* Siri 风格的多色液态旋转背景 */
        @keyframes siri-rotate {
            0% { transform: rotate(0deg) scale(1); }
            50% { transform: rotate(180deg) scale(1.2); }
            100% { transform: rotate(360deg) scale(1); }
        }
        .animate-siri {
            background: conic-gradient(from 0deg, #3b82f6, #8b5cf6, #ec4899, #3b82f6);
            filter: blur(8px);
            animation: siri-rotate 4s linear infinite;
        }
        /* 贝塞尔曲线让展开更有弹性感 */
        .transition-liquid {
            transition: all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        /* 展开状态样式 */
        #input-container.expanded,
        .group:hover #input-container {
            width: 450px;
        }
        #input-content.expanded,
        .group:hover #input-content {
            opacity: 1;
        }
        </style>

        <div class="flex-none p-3 flex justify-center items-center">
            <!-- 交互容器：group 负责监听悬停 -->
            <div class="group relative flex items-center justify-center">

                <!-- 外部动态光晕 (只在圆框状态下明显) -->
                <div class="absolute inset-0 bg-blue-500/30 blur-2xl rounded-full opacity-0 group-hover:opacity-0 transition-opacity duration-1500"></div>

                <!-- 对话框/圆框主体 -->

                <!-- 初始：w-14 (圆) -> 悬停或焦点：w-[450px] (长条) -->
                <div id="input-container" class="transition-liquid relative flex items-center bg-white/[0.18] backdrop-blur-2xl border border-white/20 shadow-2xl overflow-hidden
                            w-14 h-14 rounded-full px-2">

                    <!-- 内部液态背景 (Siri 核心) -->
                    <!-- 即使展开了，这个圆形发光体也可以作为图标保留在左侧 -->
                    <div class="flex-shrink-0 w-10 h-10 relative overflow-hidden rounded-full flex items-center justify-center">
                        <div class="absolute inset-0 animate-siri opacity-80"></div>
                    </div>

                    <!-- 展开后的内容：输入框和按钮 -->
                    <!-- 使用 expanded 状态和 hover 控制透明度和显示 -->
                    <div id="input-content" class="flex flex-1 items-center opacity-0 transition-opacity duration-500 delay-100 pl-3">
                        <input
                            id="application-agent-input-textarea"
                            type="text"
                            placeholder="告诉我你想做什么..."
                            class="w-full bg-transparent border-none p-2 rounded-full focus:ring-0 text-black placeholder-black/50 text-sm"
                        />

                        <!-- 快捷按钮 -->
                        <div class="flex items-center gap-2 pr-1">
                            <button class="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-black/70 transition-colors">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                                </svg>
                            </button>
                        </div>
                    </div>

                </div>

            </div>
        </div>
        `

        const textarea = this.querySelector('#application-agent-input-textarea');
        const container = this.querySelector('#input-container');
        const content = this.querySelector('#input-content');
        const group = container.closest('.group');

        // 跟踪hover和focus状态
        let isHovered = false;
        let isFocused = false;

        // 更新展开状态的函数
        const updateExpandedState = () => {
            if (isFocused || isHovered) {
                container.classList.add('expanded');
                content.classList.add('expanded');
            } else {
                container.classList.remove('expanded');
                content.classList.remove('expanded');
            }
        };

        // 焦点时展开
        textarea.addEventListener('focus', () => {
            isFocused = true;
            updateExpandedState();
        });

        // 失去焦点时检查状态
        textarea.addEventListener('blur', () => {
            isFocused = false;
            // 延迟检查，以便能够检测到hover状态
            setTimeout(() => {
                updateExpandedState();
            }, 0);
        });

        // 处理鼠标进入和离开时的状态
        group.addEventListener('mouseenter', () => {
            isHovered = true;
            updateExpandedState();
        });

        group.addEventListener('mouseleave', () => {
            isHovered = false;
            updateExpandedState();
        });
    }

}


customElements.define('agent-input', AgentInput);
customElements.define('application-agent-input', ApplicationAgentInput);