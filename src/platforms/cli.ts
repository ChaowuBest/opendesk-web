import { AbstractPlatform } from './base';
import { BaseApplication } from '../main/applications/base';

import { MailboxApplication } from "../main/applications/mailbox/app.js";
import { FileMgrApplication } from "../main/applications/filemgr/app.js";
import { CalendarApplication } from "../main/applications/calendar/app.js";
import { SearchApplication } from "../main/applications/search/app.js";
import { NewsApplication } from "../main/applications/news/app.js";
import { TerminalApplication } from "../main/applications/terminal/app.js";


export class CliPlatform extends AbstractPlatform {
    getName(): string {
        return 'cli';
    }

    getApplicationClasses(): typeof BaseApplication[] {
        return [
            MailboxApplication,
            FileMgrApplication,
            CalendarApplication,
            SearchApplication,
            NewsApplication,
            TerminalApplication,
        ];
    }
}
