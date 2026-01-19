import { z } from 'zod';


var defaultExcludePatterns = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.idea/**",
    "**/.vscode/**",
    "**/.pytest_cache/**",
    "**/.mypy_cache/**",
    "**/.hvigor/**",
    "**/site-packages/**",
]

function getHomeDirectory() {
    return process.env.HOME || process.env.USERPROFILE || "";
}

if (process.platform === 'darwin') {
    defaultExcludePatterns.push(`${getHomeDirectory()}/Library/**`);
    defaultExcludePatterns.push("**/.DS_Store/**");
}

if (process.platform === 'win32') {
    let home = getHomeDirectory();
    home = home.replace(/\\/g, '/');
    defaultExcludePatterns.push(`${home}/AppData/**`);
    defaultExcludePatterns.push("C:/Windows/**");
    defaultExcludePatterns.push("C:/Temp/**");
}

export const FSEntrySchema = z.object({
    root: z.string().default(getHomeDirectory()),
    include_patterns: z.array(z.string()).default([
        "**/*.{txt,md}",
        "**/*.{pdf,doc,docx,ppt,pptx,xls,xlsx,csv}",
        "**/*.{json,yaml,yml,xml,html,css,js}",
    ]),
    exclude_patterns: z.array(z.string()).default(defaultExcludePatterns),
})
