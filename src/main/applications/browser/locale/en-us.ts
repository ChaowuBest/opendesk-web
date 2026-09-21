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

export const enUs: Record<string, string> = {
    'credentials.oldPassword': 'Old password',
    'credentials.newPassword': 'New password',
    'credentials.showPasswords': 'Show passwords',
    'credentials.cancelUpdate': 'Cancel',
    'credentials.close': 'Close',
    'credentials.title': 'Saved passwords',
    'credentials.accounts': 'Choose a saved account',
    'credentials.ok': 'OK',
    'credentials.saveQuestion': 'Save password?',
    'credentials.save': 'Save',
    'credentials.updateQuestion': 'Update password',
    'credentials.update': 'Update',
    'credentials.unavailable': 'Secure system storage is unavailable. Passwords cannot be saved.',
    'credentials.failed':
        'Unable to read or save passwords. Check your system keychain, or reset saved passwords and autofill data in browser settings.',

    'app.name': 'Browser',

    // ========== 应用事件描述 ==========
    'appEvent.navigate': 'Browser navigated to a URL',
    'appEvent.goBack': 'Browser went back',
    'appEvent.goForward': 'Browser went forward',
    'appEvent.refresh': 'Browser reloaded',
    'appEvent.executeScript': 'JavaScript executed in the browser',

    // ========== 会话操作消息（app.ts） ==========
    'error.sessionNotInitialized': 'Browser session not initialized',
    'message.cookiesCleared': 'Cleared ${count} cookies',
    'message.storageCleared': 'Cleared localStorage / IndexedDB / cache storage / service workers',
    'message.cacheCleared': 'Cleared HTTP cache',
    'message.allDataCleared': 'Cleared all browsing data',
    'message.autofillCleared': 'Cleared passwords and autofill data',
    'error.certAlreadyImported': 'Certificate already imported',
    'error.certNotFound': 'Certificate not found',
    'message.certImported': 'Certificate "${name}" imported. Restart OpenDesk to apply it.',
    'message.certDeleted': 'Certificate "${name}" deleted. Restart OpenDesk to apply the change.',
    'common.unknown': 'Unknown',

    // ========== 原生对话框 / TUI ==========
    'dialog.saveFile': 'Save File',
    'dialog.saveSnapshot': 'Save Snapshot',
    'tui.status.ready': 'Browser ready',
    'cli.command.browser.description': 'Show browser info',
    'tui.info.title': '🌐 Embedded Browser',
    'tui.info.tabHint': '• The browser tab is under "Browser" in the right sidebar',
    'tui.info.toolsHint': '• Use the browser tools for automation',

    // ========== CLI 渲染：共享标签 ==========
    'cli.label.url': 'URL: ',
    'cli.label.target': '  Target: ',
    'cli.label.text': '  Text: ',
    'cli.label.file': '  Files: ',
    'cli.label.key': '  Key: ',
    'cli.label.value': '  Values: ',
    'cli.label.script': 'Script: ',
    'cli.label.action': '  Action: ',
    'cli.label.args': '  Args: ',
    'cli.label.operation': '  Operation: ',
    'cli.label.tabCount': '  Tab count: ',
    'cli.label.tab': '  Tab: ',
    'cli.label.time': '  Time: ',
    'cli.label.domain': '  Domains: ',
    'cli.label.waitText': '  Wait for text: ',
    'cli.label.waitGone': '  Wait until gone: ',
    'cli.label.title': '  Title: ',
    'cli.label.interactive': '  Interactive elements: ',

    // ========== CLI 渲染：各工具 ==========
    'cli.newTab.cardTitle': 'Open URL',
    'cli.newTab.inNewTab': '  Opened in a new tab',
    'cli.newTab.running': '⏳ Loading page...',
    'cli.newTab.success': '✓ Page opened',
    'cli.snapshot.cardTitle': 'Page Snapshot',
    'cli.snapshot.refCount': '${count} refs',
    'cli.snapshot.diffMode': '- Mode: diff (changes only)',
    'cli.explore.cardTitle': 'Expand Node',
    'cli.explore.success': '✓ Expanded',
    'cli.click.cardTitle': 'Click Element',
    'cli.click.running': '⏳ Clicking...',
    'cli.click.success': '✓ Clicked',
    'cli.type.cardTitle': 'Type Text',
    'cli.type.running': '⏳ Typing...',
    'cli.type.success': '✓ Typed',
    'cli.upload.cardTitle': 'Upload Files',
    'cli.upload.files': '${count} files: ${name}...',
    'cli.upload.running': '⏳ Uploading...',
    'cli.upload.success': '✓ Files set',
    'error.filePathRequired': 'Either filePath or filePaths is required',
    'cli.hover.cardTitle': 'Hover',
    'cli.hover.success': '✓ Hovered',
    'cli.press.cardTitle': 'Press Key',
    'cli.press.success': '✓ Key pressed',
    'cli.select.cardTitle': 'Select Option',
    'cli.select.success': '✓ Selected',
    'cli.scrollTo.cardTitle': 'Scroll to Element',
    'cli.scrollTo.done': 'Scrolled',
    'cli.goBack.cardTitle': 'Go Back',
    'cli.goBack.success': '✓ Went back',
    'cli.goBack.fail': 'Go back failed: ${error}',
    'cli.goForward.cardTitle': 'Go Forward',
    'cli.goForward.success': '✓ Went forward',
    'cli.goForward.fail': 'Go forward failed: ${error}',
    'cli.reload.cardTitle': 'Reload',
    'cli.reload.success': '✓ Reloaded',
    'cli.reload.fail': 'Page failed to load after reload: ${error}',
    'cli.execute.cardTitle': 'Execute Script',
    'cli.execute.running': '⏳ Executing...',
    'cli.execute.success': '✓ Done',
    'cli.trigger.cardTitle': 'Trigger Action',
    'cli.trigger.running': '⏳ Triggering...',
    'cli.trigger.success': '✓ Triggered',
    'cli.trigger.unavailableOnPage': 'Action ${action} is not available on this page. Available actions: ${available}',
    'cli.trigger.noHints': 'Action ${action} is not available on this page: no Action Hints registered',
    'cli.tabs.cardTitle': 'Manage Tabs',
    'cli.screenshot.cardTitle': 'Screenshot',
    'cli.screenshot.running': '⏳ Capturing...',
    'cli.screenshot.saved': '  ✓ Saved: ',
    'cli.screenshot.badDataUri': 'Screenshot returned a non-image data URI: ${uri}',
    'cli.wait.cardTitle': 'Wait for Condition',
    'cli.wait.running': '⏳ Waiting...',
    'cli.wait.success': '✓ Condition met',
    'cli.deleteHistory.cardTitle': 'Delete History',
    'cli.deleteHistory.running': '⏳ Deleting...',
    'cli.deleteHistory.deletedCount': '${count} entries',
    'cli.deleteHistory.success': '✓ Deleted',
    'cli.deleteHistory.unlimited': 'Any',
    'error.deleteHistoryNoFilter': 'At least one filter is required (startTime/endTime or domains)',
    'error.mainWindowUnavailable': 'Main window unavailable; cannot manage browser history'

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
