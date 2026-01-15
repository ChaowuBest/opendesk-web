import { BaseWorker } from "../../base.js";
import { spawnSync } from 'child_process';


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
        EntryID   = $_.EntryID
        Subject   = $_.Subject
        StartTime = $_.Start.ToString("yyyy-MM-dd HH:mm:ss")
        EndTime     = $_.End.ToString("yyyy-MM-dd HH:mm:ss")
        Location    = if ($_.Location) { $_.Location } else { "" }
        Attendees   = $attendees
        Organizer   = if ($_.Organizer) { $_.Organizer.Name } else { "" }
        IsAllDay    = $_.IsAllDay
        IsPrivate   = $_.IsPrivate
        IsMeeting   = $_.IsMeeting
        IsCancelled = $_.IsCancelled
        IsRecurring = $_.IsRecurring
    }
}

$jsonOutput = $objects | ConvertTo-Json -Depth 2
Write-Output $jsonOutput
`

class SynchronizationWorker extends BaseWorker {

    constructor() {
        super();
    }

    async getOutlookCalendarItems(daysBefore, daysAfter) {
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

    async startService() {

    }

    async stopService() {

    }
}

(new SynchronizationWorker()).initialize();