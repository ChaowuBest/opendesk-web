import fs from 'fs';

export default fs.readFileSync(
    new URL('../../../main/applications/agentoffice/renderer/style.css', import.meta.url),
    'utf8'
);
