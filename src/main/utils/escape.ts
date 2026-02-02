export function escapeHtml(content: string) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return content.replace(/[&<>"']/g, function (m) { return map[m]; });
}