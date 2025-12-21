class MailBoxEntryWidget extends HTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <div class="flex h-full">
            <!-- 左侧栏：融合了导航和列表 (Width: 400px) -->
            <aside class="w-[350px] bg-white border-r flex flex-col flex-shrink-0">

                <!-- 顶部操作区 -->
                <div class="p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h1 class="text-xl font-bold tracking-tight px-1">收件箱</h1>
                        <button class="p-2 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all">
                            <i class="fas fa-plus px-1"></i>
                        </button>
                    </div>

                    <!-- 搜索框 -->
                    <div class="relative rounded-2xl">
                        <i class="fas fa-search absolute left-3 top-3 text-gray-400"></i>
                        <input type="text" placeholder="搜索邮件..." class="w-full bg-gray-100 border-none rounded-xl pl-10 pr-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                    </div>

                    <!-- 导航标签 (水平排列) -->
                    <div class="flex gap-2 overflow-x-auto pb-1 text-xs no-scrollbar">
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-900 text-white rounded-lg">全部</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">未读</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">收藏</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">草稿</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">已发送</button>
                    </div>
                </div>

                <!-- 邮件列表区 -->
                <div class="flex-1 overflow-y-auto border-t">

                    <!-- 邮件项：选中态 -->
                    <div class="group p-4 border-b bg-indigo-50/50 cursor-pointer relative border-l-4 border-l-indigo-600">
                        <div class="flex justify-between items-start mb-1">
                            <span class="font-bold text-gray-900">Apple News</span>
                            <span class="text-xs text-indigo-600 font-semibold">12:30 PM</span>
                        </div>
                        <p class="text-indigo-900 font-semibold truncate mb-1 text-[13px]">iPhone 15 Pro 系列现已开启预约</p>
                        <p class="text-gray-500 line-clamp-2 text-xs leading-relaxed">首款采用航空级钛金属设计的手机，带来前所未有的强大性能与极致轻盈的握持感...</p>
                    </div>

                    <!-- 邮件项：常规态 -->
                    <div class="group p-4 border-b hover:bg-gray-50 cursor-pointer transition-colors border-l-4 border-l-transparent">
                        <div class="flex justify-between items-start mb-1">
                            <span class="font-bold text-gray-800">Dribbble</span>
                            <span class="text-xs text-gray-400">10:45 AM</span>
                        </div>
                        <p class="text-gray-900 font-medium truncate mb-1 text-[13px]">你关注的设计师有了新动态</p>
                        <p class="text-gray-500 line-clamp-2 text-xs leading-relaxed">Zeno Lion 刚刚发布了 "Fintech App UI Kit"，快来查看并获取灵感...</p>
                    </div>

                    <!-- 更多列表项 -->
                    <div class="group p-4 border-b hover:bg-gray-50 cursor-pointer transition-colors border-l-4 border-l-transparent">
                        <div class="flex justify-between items-start mb-1">
                            <span class="font-bold text-gray-800">Zoom</span>
                            <span class="text-xs text-gray-400">昨天</span>
                        </div>
                        <p class="text-gray-900 font-medium truncate mb-1 text-[13px]">会议纪要：Q4 产品规划讨论</p>
                        <p class="text-gray-500 line-clamp-2 text-xs leading-relaxed">这是本周一会议的详细录音和自动生成的纪要，请在周五下班前确认任务...</p>
                    </div>

                    <!-- 占位项 -->
                    <div class="group p-4 border-b hover:bg-gray-50 cursor-pointer transition-colors border-l-4 border-l-transparent">
                        <div class="flex justify-between items-start mb-1">
                            <span class="font-bold text-gray-800">Slack</span>
                            <span class="text-xs text-gray-400">2天前</span>
                        </div>
                        <p class="text-gray-900 font-medium truncate mb-1 text-[13px]">登录提醒：新设备登录</p>
                        <p class="text-gray-500 line-clamp-2 text-xs leading-relaxed">您的账号在上海的 Chrome 浏览器上登录，如果不是您本人...</p>
                    </div>
                </div>

                <!-- 底部个人信息与导航 -->
                <div class="p-4 bg-gray-50 border-t flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <img class="w-8 h-8 rounded-full border border-gray-200" src="https://ui-avatars.com/api/?name=Alex+Zhang&background=6366f1&color=fff" alt="">
                        <span class="font-semibold text-xs">Alex Zhang</span>
                    </div>
                    <div class="flex gap-3 text-gray-400">
                        <button class="hover:text-indigo-600 transition-colors"><i class="fas fa-cog"></i></button>
                        <button class="hover:text-indigo-600 transition-colors"><i class="fas fa-question-circle"></i></button>
                    </div>
                </div>
            </aside>

            <!-- 右侧栏：邮件内容 (Responsive Flex-1) -->
            <main class="flex-1 bg-white flex flex-col">

                <!-- 内容区顶部操作 -->
                <header class="h-16 pl-8 pr-16 border-b flex items-center justify-between">
                    <div class="flex items-center gap-6">
                        <button class="text-gray-500 hover:text-indigo-600"><i class="fas fa-reply"></i></button>
                        <button class="text-gray-500 hover:text-indigo-600"><i class="fas fa-reply-all"></i></button>
                        <button class="text-gray-500 hover:text-indigo-600"><i class="fas fa-share text-sm"></i></button>
                        <span class="h-4 w-px bg-gray-200 mx-2"></span>
                        <button class="text-gray-500 hover:text-red-500"><i class="far fa-trash-alt"></i></button>
                        <button class="text-gray-500 hover:text-amber-500"><i class="far fa-star"></i></button>
                    </div>
                    <div class="flex items-center gap-4">
                        <span class="text-xs text-gray-400">1 / 1,240</span>
                        <div class="flex border rounded-lg overflow-hidden">
                            <button class="px-3 py-1.5 hover:bg-gray-50 border-r"><i class="fas fa-chevron-left text-xs"></i></button>
                            <button class="px-3 py-1.5 hover:bg-gray-50"><i class="fas fa-chevron-right text-xs"></i></button>
                        </div>
                    </div>
                </header>

                <!-- 邮件阅读区 -->
                <div class="flex-1 overflow-y-auto px-12 py-10 bg-white">
                    <div class="max-w-3xl mx-auto">
                        <!-- 邮件头部 -->
                        <div class="mb-10">
                            <h2 class="text-2xl font-extrabold text-gray-900 mb-6 leading-tight">iPhone 15 Pro 系列现已开启预约</h2>
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-4">
                                    <div class="w-12 h-12 rounded-full bg-gray-900 flex items-center justify-center text-white">
                                        <i class="fab fa-apple text-2xl"></i>
                                    </div>
                                    <div>
                                        <h4 class="font-bold text-gray-900">Apple News</h4>
                                        <p class="text-xs text-gray-500">发送至: alex_design@icloud.com</p>
                                    </div>
                                </div>
                                <div class="text-right">
                                    <p class="text-sm font-medium text-gray-900">2023年9月22日</p>
                                    <p class="text-xs text-gray-400">12:30 (10小时前)</p>
                                </div>
                            </div>
                        </div>

                        <!-- 邮件主体 -->
                        <div class="prose prose-indigo max-w-none">
                            <p class="text-lg text-gray-700 leading-relaxed mb-6">
                                Alex，期待已久的时刻终于到来。
                            </p>
                            <p class="text-gray-600 leading-relaxed mb-6">
                                iPhone 15 Pro 由<b>航空级钛金属</b>打造，这是我们迄今为止最轻盈、最强韧的 Pro 机型。搭载全新的 A17 Pro 芯片，开启移动游戏和专业工作流的新篇章。
                            </p>

                            <!-- 装饰性Banner图片 -->
                            <div class="my-10 h-64 bg-gradient-to-br from-gray-900 to-indigo-900 rounded-2xl flex items-center justify-center text-white">
                                <div class="text-center">
                                    <p class="text-xs tracking-[0.2em] uppercase mb-2 opacity-70">New Performance</p>
                                    <h3 class="text-4xl font-bold">A17 Pro Chip</h3>
                                </div>
                            </div>

                            <p class="text-gray-600 mb-6 font-medium">主要亮点包括：</p>
                            <ul class="space-y-3 text-gray-600 mb-8">
                                <li class="flex items-start gap-2">
                                    <i class="fas fa-check-circle text-indigo-500 mt-1"></i>
                                    <span>操作按钮 (Action Button) - 你的个性化快捷键</span>
                                </li>
                                <li class="flex items-start gap-2">
                                    <i class="fas fa-check-circle text-indigo-500 mt-1"></i>
                                    <span>USB-C 接口 - 最高支持 10Gbps 传输速度</span>
                                </li>
                                <li class="flex items-start gap-2">
                                    <i class="fas fa-check-circle text-indigo-500 mt-1"></i>
                                    <span>5 倍光学变焦 - iPhone 史上最长的光学变焦距离</span>
                                </li>
                            </ul>

                            <div class="flex gap-4">
                                <button class="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 italic font-mono">
                                    Pre-order Now
                                </button>
                                <button class="border border-gray-200 text-gray-700 px-8 py-3 rounded-xl font-bold hover:bg-gray-50 transition-all">
                                    Learn More
                                </button>
                            </div>
                        </div>

                        <div class="mt-16 pt-8 border-t text-xs text-gray-400 text-center">
                            如果您不想再收到此类邮件，请点击 <a href="#" class="underline">取消订阅</a>。
                            <br>© 2023 Apple Inc. 保留所有权利。
                        </div>
                    </div>
                </div>
            </main>
        </div>
        `
    }
}

customElements.define('mailbox-entry-widget', MailBoxEntryWidget);