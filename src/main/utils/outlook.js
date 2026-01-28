import { spawnSync } from 'child_process';
import { z } from 'zod';


const POWERSHELL_CMD_GET_OUTLOOK_CALENDAR_ITEMS = (daysBefore, daysAfter) => `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$outlook = New-Object -ComObject Outlook.Application;
$ns = $outlook.GetNamespace("MAPI");
$calendar = $ns.GetDefaultFolder(9);
$items = $calendar.Items
$items.Sort("[Start]")
$items.IncludeRecurrences = $true

$startRange = (Get-Date).AddDays(${daysBefore}).ToString("yyyy-MM-dd HH:mm")
$endRange = (Get-Date).AddDays(${daysAfter}).ToString("yyyy-MM-dd HH:mm")
$filter = "[Start] >= '$startRange' AND [End] <= '$endRange'"
$items = $items.Restrict($filter)

$objects = $items | ForEach-Object {
    $attendees = @()
    foreach ($recipient in $_.Recipients) {
        $attendees += $recipient.Name
    }
    [PSCustomObject]@{
        entryID   = $_.EntryID
        subject   = $_.Subject
        startTime = $_.Start.ToString("yyyy-MM-dd HH:mm:ss")
        endTime   = $_.End.ToString("yyyy-MM-dd HH:mm:ss")
        location  = if ($_.Location) { $_.Location } else { "" }
        attendees = $attendees
        organizer = if ($_.Organizer) { $_.Organizer.Name } else { "" }
        isAllDay  = $_.IsAllDay
        isPrivate = $_.IsPrivate
        isMeeting = $_.IsMeeting
        isCancelled = $_.IsCancelled
        isRecurring = $_.IsRecurring
    }
}

$jsonOutput = $objects | ConvertTo-Json -Depth 2
Write-Output $jsonOutput
`

const OutlookCalendarItemSchema = z.object({
    entryID: z.string(),
    subject: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    location: z.string(),
    attendees: z.array(z.string()),
    organizer: z.string(),
    isAllDay: z.boolean(),
    isPrivate: z.boolean(),
    isMeeting: z.boolean(),
    isCancelled: z.boolean(),
    isRecurring: z.boolean(),
});

export class OutlookUtils {

    /**
     * @param {number} daysBefore
     * @param {number} daysAfter
     * @returns {Promise<z.output<OutlookCalendarItemSchema>[]>}
     */
    static async getOutlookCalendarItems(daysBefore, daysAfter) {
        const cmd = POWERSHELL_CMD_GET_OUTLOOK_CALENDAR_ITEMS(daysBefore, daysAfter);
        const result = spawnSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', cmd]);
        if (result.status !== 0) {
            throw new Error(`failed to synchronize outlook: ${result.stderr.toString()}`);
        }
        const output = result.stdout.toString().trim();
        if (!output) {
            return [];
        } else {
            const jsonOutput = JSON.parse(output);
            return jsonOutput;
        }
    }

}