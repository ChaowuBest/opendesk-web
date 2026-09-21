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

export const zhCn: Record<string, string> = {
    'credentials.oldPassword': '旧密码',
    'credentials.newPassword': '新密码',
    'credentials.showPasswords': '显示密码',
    'credentials.cancelUpdate': '取消',
    'credentials.close': '关闭',
    'credentials.title': '保存的密码',
    'credentials.accounts': '选择已保存的账号',
    'credentials.ok': '知道了',
    'credentials.saveQuestion': '是否保存密码？',
    'credentials.save': '保存',
    'credentials.updateQuestion': '更新密码',
    'credentials.update': '更新',
    'credentials.unavailable': '系统安全存储不可用，无法保存密码。',
    'credentials.failed': '无法读取或保存密码。请检查系统钥匙串；如需重置，可在浏览器设置中清除密码与自动填充数据。',

    'app.name': '浏览器',

    // ========== 应用事件描述 ==========
    'appEvent.navigate': '浏览器导航到指定URL',
    'appEvent.goBack': '浏览器后退',
    'appEvent.goForward': '浏览器前进',
    'appEvent.refresh': '浏览器刷新',
    'appEvent.executeScript': '在浏览器中执行JavaScript',

    // ========== 会话操作消息（app.ts） ==========
    'error.sessionNotInitialized': '浏览器会话未初始化',
    'message.cookiesCleared': '已清除 ${count} 个 Cookie',
    'message.storageCleared': '已清除 localStorage / IndexedDB / 缓存存储 / Service Workers',
    'message.cacheCleared': '已清除 HTTP 缓存',
    'message.allDataCleared': '已清除所有浏览数据',
    'message.autofillCleared': '已清除密码与自动填充数据',
    'error.certAlreadyImported': '该证书已导入',
    'error.certNotFound': '证书未找到',
    'message.certImported': '证书 "${name}" 已导入。请重启 OpenDesk 以使证书生效。',
    'message.certDeleted': '证书 "${name}" 已删除。请重启 OpenDesk 以使更改生效。',
    'common.unknown': '未知',

    // ========== 原生对话框 / TUI ==========
    'dialog.saveFile': '保存文件',
    'dialog.saveSnapshot': '保存 Snapshot',
    'tui.status.ready': '浏览器就绪',
    'cli.command.browser.description': '显示浏览器信息',
    'tui.info.title': '🌐 嵌入式浏览器',
    'tui.info.tabHint': '• 浏览器标签位于右侧栏 "浏览器" 选项',
    'tui.info.toolsHint': '• 使用 browser 系列工具进行自动化控制',

    // ========== CLI 渲染：共享标签 ==========
    'cli.label.url': '网址: ',
    'cli.label.target': '  目标: ',
    'cli.label.text': '  文本: ',
    'cli.label.file': '  文件: ',
    'cli.label.key': '  按键: ',
    'cli.label.value': '  值: ',
    'cli.label.script': '脚本: ',
    'cli.label.action': '  动作: ',
    'cli.label.args': '  参数: ',
    'cli.label.operation': '  操作: ',
    'cli.label.tabCount': '  标签页数: ',
    'cli.label.tab': '  标签页: ',
    'cli.label.time': '  时间: ',
    'cli.label.domain': '  域名: ',
    'cli.label.waitText': '  等待文本: ',
    'cli.label.waitGone': '  等待消失: ',
    'cli.label.title': '  标题: ',
    'cli.label.interactive': '  可交互元素: ',

    // ========== CLI 渲染：各工具 ==========
    'cli.newTab.cardTitle': '打开网页',
    'cli.newTab.inNewTab': '  新标签页打开',
    'cli.newTab.running': '⏳ 正在加载页面…',
    'cli.newTab.success': '✓ 页面已打开',
    'cli.snapshot.cardTitle': '页面快照',
    'cli.snapshot.refCount': '${count} 个',
    'cli.snapshot.diffMode': '- Mode: diff (仅展示变化部分)',
    'cli.explore.cardTitle': '展开节点',
    'cli.explore.success': '✓ 已展开',
    'cli.click.cardTitle': '点击元素',
    'cli.click.running': '⏳ 正在点击…',
    'cli.click.success': '✓ 已点击',
    'cli.type.cardTitle': '输入文本',
    'cli.type.running': '⏳ 正在输入…',
    'cli.type.success': '✓ 已输入',
    'cli.upload.cardTitle': '上传文件',
    'cli.upload.files': '${count} 个文件：${name}…',
    'cli.upload.running': '⏳ 正在上传…',
    'cli.upload.success': '✓ 已设置文件',
    'error.filePathRequired': '必须提供 filePath 或 filePaths',
    'cli.hover.cardTitle': '悬停',
    'cli.hover.success': '✓ 已悬停',
    'cli.press.cardTitle': '按键',
    'cli.press.success': '✓ 已按键',
    'cli.select.cardTitle': '选择选项',
    'cli.select.success': '✓ 已选择',
    'cli.scrollTo.cardTitle': '滚动到元素',
    'cli.scrollTo.done': '已滚动',
    'cli.goBack.cardTitle': '后退',
    'cli.goBack.success': '✓ 已后退',
    'cli.goBack.fail': '后退失败: ${error}',
    'cli.goForward.cardTitle': '前进',
    'cli.goForward.success': '✓ 已前进',
    'cli.goForward.fail': '前进失败: ${error}',
    'cli.reload.cardTitle': '刷新',
    'cli.reload.success': '✓ 已刷新',
    'cli.reload.fail': '刷新后页面加载失败: ${error}',
    'cli.execute.cardTitle': '执行脚本',
    'cli.execute.running': '⏳ 正在执行…',
    'cli.execute.success': '✓ 执行完成',
    'cli.trigger.cardTitle': '触发动作',
    'cli.trigger.running': '⏳ 正在触发…',
    'cli.trigger.success': '✓ 已触发',
    'cli.trigger.unavailableOnPage': '动作 ${action} 在当前页面不可用。可用动作：${available}',
    'cli.trigger.noHints': '动作 ${action} 在当前页面不可用：该页面没有任何 Action Hint',
    'cli.tabs.cardTitle': '标签页管理',
    'cli.screenshot.cardTitle': '页面截图',
    'cli.screenshot.running': '⏳ 正在截图…',
    'cli.screenshot.saved': '  ✓ 已保存: ',
    'cli.screenshot.badDataUri': '截图返回了非图片的 data URI: ${uri}',
    'cli.wait.cardTitle': '等待条件',
    'cli.wait.running': '⏳ 等待中…',
    'cli.wait.success': '✓ 条件满足',
    'cli.deleteHistory.cardTitle': '删除历史记录',
    'cli.deleteHistory.running': '⏳ 正在删除…',
    'cli.deleteHistory.deletedCount': '${count} 条记录',
    'cli.deleteHistory.success': '✓ 已删除',
    'cli.deleteHistory.unlimited': '不限',
    'error.deleteHistoryNoFilter': '至少需要指定一个筛选条件（startTime/endTime 或 domains）',
    'error.mainWindowUnavailable': '主窗口不可用，无法操作浏览器历史记录'

    // ========== Renderer：工具栏 / 菜单 ==========

    // ========== Renderer：清除数据消息 ==========

    // ========== Renderer：弹窗通用 ==========

    // ========== Renderer：清除数据确认 / 快照 ==========

    // ========== Renderer：历史面板 / 页面 ==========

    // ========== Renderer：收藏夹 ==========

    // ========== Renderer：下载 ==========

    // ========== Renderer：标签页 / 内部页 / 新标签页 ==========

    // ========== Renderer：设置页 ==========
};
