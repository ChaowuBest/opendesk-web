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

const supportedFileExtensions = [
    'pdf',
    'docx',
    'doc',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
]

class AgentInput extends HTMLElement {

    constructor() {
        super();
        this.attachedFilePaths = [];
        this.isDisabled = false;
        this.showStopButton = false;
        this.onStopCallback = null;
    }

    connectedCallback() {
        this.render();
    }

    disconnectedCallback() {

    }

    attachFilePath(filePath) {
        const extname = filePath.split('.').pop();
        if (!supportedFileExtensions.includes(extname)) {
            window.notificationAPI.sendNotification('error', '文件管理', '不支持的文件类型', `当前还不支持在对话中使用${extname} 文件`);
            return;
        }
        this.attachedFilePaths.push(filePath);
        this.render();
    }

    removeFilePath(filePath) {
        this.attachedFilePaths = this.attachedFilePaths.filter(p => p !== filePath);
        this.render();
    }

    clearAttachedFilePaths() {
        this.attachedFilePaths = [];
        this.render();
    }

    setDisabled(disabled) {
        this.isDisabled = disabled;
        this.updateInputState();
    }

    setStopMode(showStop, onStopCallback = null) {
        this.showStopButton = showStop;
        this.onStopCallback = onStopCallback;
        this.updateInputState();
    }

    updateInputState() {
        const textarea = this.querySelector('#agent-input-textarea');
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        const stopBtn = this.querySelector('#agent-input-stop-btn');

        if (textarea) {
            if (this.isDisabled) {
                textarea.disabled = true;
                textarea.classList.add('opacity-50', 'cursor-not-allowed');
                textarea.placeholder = '正在生成回复，请稍候...';
            } else {
                textarea.disabled = false;
                textarea.classList.remove('opacity-50', 'cursor-not-allowed');
                textarea.placeholder = '在这里输入消息，按 Ctrl+Enter 发送';
            }
        }

        if (submitBtn) {
            if (this.showStopButton) {
                submitBtn.classList.add('hidden');
            } else {
                submitBtn.classList.remove('hidden');
            }
        }

        if (stopBtn) {
            if (this.showStopButton) {
                stopBtn.classList.remove('hidden');
            } else {
                stopBtn.classList.add('hidden');
            }
        }
    }

    render() {
        let fileItems = this.attachedFilePaths.map(filePath => {
            let fileName = filePath.split('/').pop();
            return `
            <div class="px-3 py-1 bg-blue-50 text-blue-700 hover:text-gray-600 hover:bg-blue-20 rounded-full border border-blue-100 transition-all shadow-sm text-xs cursor-pointer flex items-center">
                <i class="fas fa-paperclip mr-1"></i>
                <span class="max-w-[120px] truncate whitespace-nowrap overflow-hidden" style="display:inline-block;">${fileName}</span>
                <button data-file_path="${filePath}" class="agent-input-remove-file-btn hover:text-red-500 leading-none">
                    <i class="fas fa-times ml-1"></i>
                </button>
            </div>
            `;
        }).join('');

        if (this.attachedFilePaths.length === 0) {
            fileItems = `
            <div class="flex items-center justify-center text-sm text-gray-400 py-2">
                <i class="fas fa-file-upload m-2"></i>
                <span>你可以将文件拖拽到这里~</span>
            </div>
            `;
        }

        this.innerHTML = `
        <div id="agent-input-container" class="w-full p-1.5 rounded-[28px] bg-white/40 border border-gray-300/60 shadow-[0_10px_40px_-15px_rgba(0,0,0,0.08)]">
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
                <div class="flex items-start justify-between p-2 border-t border-gray-100">
                    <!-- 左侧工具按钮 -->
                    <div class="flex items-center space-x-3">
                        <!-- 附件 -->
                        <div
                            id="agent-input-attached-file-list"
                            class="flex flex-wrap items-center gap-1 w-full"
                            style="row-gap: 0.3rem; overflow-x: auto;"
                        >
                            ${fileItems}
                        </div>
                    </div>

                    <!-- 右侧按钮 -->
                    <div class="flex items-center space-x-2 mt-1">
                        <!-- 发送按钮 -->
                        <button id="agent-input-submit-btn" class="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-full transition-colors">
                            <i class="fas fa-arrow-up text-lg"></i>
                        </button>
                        <!-- 停止按钮 -->
                        <button id="agent-input-stop-btn" class="p-1.5 bg-red-500 hover:bg-red-600 text-white rounded-full px-4 transition-colors text-sm hidden">
                            <i class="fas fa-stop"></i>
                            <span class="ml-1">停止任务</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
        `

        this.setUpEventListeners();
        this.updateInputState();
    }

    setUpEventListeners() {
        const container = this.querySelector('#agent-input-container')
        const textarea = this.querySelector('#agent-input-textarea')
        const submitBtn = this.querySelector('#agent-input-submit-btn')
        const stopBtn = this.querySelector('#agent-input-stop-btn')
        const removeFileBtns = this.querySelectorAll('.agent-input-remove-file-btn')

        // 提交消息的函数
        const handleSubmit = () => {
            // 如果输入框被禁用，不允许提交
            if (this.isDisabled) {
                return;
            }

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
            this.clearAttachedFilePaths();
        }

        submitBtn.addEventListener('click', handleSubmit)

        // 停止按钮事件
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                if (this.onStopCallback) {
                    this.onStopCallback();
                }
            });
        }

        removeFileBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.removeFilePath(btn.dataset.file_path);
            });
        });

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        })

        container.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const files = e.dataTransfer.files;
            for (const file of files) {
                const filePath = window.fsAPI.getFilePath(file);
                /* electron前端无法获取文件完整路径，需要通过fsAPI.getFilePath获取 */

                // 检查路径类型
                const pathType = await window.fsAPI.getPathType(filePath);

                if (pathType === 'directory') {
                    // 如果是目录，直接插入到textarea当前光标位置
                    const cursorPos = textarea.selectionStart;
                    const textBefore = textarea.value.substring(0, cursorPos);
                    const textAfter = textarea.value.substring(cursorPos);
                    textarea.value = textBefore + filePath + textAfter;
                    // 设置光标位置到插入文本的末尾
                    const newCursorPos = cursorPos + filePath.length;
                    textarea.setSelectionRange(newCursorPos, newCursorPos);
                    // 触发input事件以通知内容变化
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (pathType === 'file') {
                    // 如果是文件，按原有逻辑attachFilepath
                    this.attachFilePath(filePath);
                }
                // 如果pathType为null（路径不存在），则不执行任何操作
            }
        })

        // Ctrl+Enter 快捷键
        textarea.addEventListener('keydown', (e) => {
            // 如果输入框被禁用，阻止所有输入
            if (this.isDisabled) {
                e.preventDefault();
                return;
            }

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

    /**
     * 这个组件用于显示嵌入在应用之中的悬浮AI输入框
     */

    constructor() {
        super();
        /**
         * 当前任务状态
         * @type {string}
         */
        this.taskStatus = 'waiting';
        /**
         * 停止任务的回调函数
         * @type {function | null}
         */
        this.onStopCallback = null;
    }

    /**
     * 设置任务状态
     * @param {string} status 任务状态 ('running', 'waiting', 'stopped' 等)
     * @param {function | null} onStopCallback 停止任务的回调函数
     */
    setTaskStatus(status, onStopCallback = null) {
        this.taskStatus = status;
        this.onStopCallback = onStopCallback;
        this.updateDisplay();
    }

    /**
     * 更新显示状态（停止图标或渐变背景）
     */
    updateDisplay() {
        const gradientContainer = this.querySelector('#gradient-container');
        const stopButton = this.querySelector('#stop-task-button');
        const textarea = this.querySelector('#application-agent-input-textarea');

        if (!gradientContainer || !stopButton) {
            return;
        }

        if (this.taskStatus === 'running') {
            // 显示停止图标，隐藏渐变背景
            gradientContainer.classList.add('hidden');
            stopButton.classList.remove('hidden');
            // 禁用输入框
            if (textarea) {
                textarea.disabled = true;
                textarea.classList.add('opacity-50', 'cursor-not-allowed');
            }
        } else {
            // 显示渐变背景，隐藏停止图标
            gradientContainer.classList.remove('hidden');
            stopButton.classList.add('hidden');
            // 启用输入框
            if (textarea) {
                textarea.disabled = false;
                textarea.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
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
                <div id="input-container" class="transition-liquid relative flex items-center bg-white/[0.18] backdrop-blur-md border border-white/20 shadow-2xl overflow-hidden
                            w-14 h-14 rounded-full px-2">

                    <!-- 内部液态背景 (Siri 核心) - 任务非运行状态时显示 -->
                    <!-- 即使展开了，这个圆形发光体也可以作为图标保留在左侧 -->
                    <div id="gradient-container" class="flex-shrink-0 w-10 h-10 relative overflow-hidden rounded-full flex items-center justify-center">
                        <div class="absolute inset-0 animate-siri opacity-80"></div>
                    </div>

                    <!-- 停止按钮 - 任务运行状态时显示 -->
                    <button id="stop-task-button" class="flex-shrink-0 w-10 h-10 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-colors shadow-lg hidden">
                        <i class="fas fa-stop text-sm"></i>
                    </button>

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
        const stopButton = this.querySelector('#stop-task-button');

        // 停止按钮点击事件
        if (stopButton) {
            stopButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onStopCallback) {
                    this.onStopCallback();
                }
            });
        }

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
            const focusEvent = new CustomEvent('focus', {
                bubbles: true
            });
            this.dispatchEvent(focusEvent);
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

        textarea.addEventListener('keydown', (event) => {
            // 如果正在输入法组字过程中，直接返回，不执行提交逻辑
            if (event.isComposing || event.keyCode === 229) {
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                const submitEvent = new CustomEvent('submit', {
                    detail: {
                        message: textarea.value,
                        attachedFilePaths: []
                    },
                    bubbles: true
                });
                this.dispatchEvent(submitEvent);
                textarea.value = '';
            }
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

        // 初始化显示状态
        this.updateDisplay();
    }

}


customElements.define('agent-input', AgentInput);
customElements.define('application-agent-input', ApplicationAgentInput);