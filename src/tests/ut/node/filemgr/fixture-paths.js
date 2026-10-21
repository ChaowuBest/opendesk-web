// Match scanner file IDs and I/O arguments, never source roots, state keys or root_refs.
export function scanPath(filePath, platform = process.platform) {
    return platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath;
}
