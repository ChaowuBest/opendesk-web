import { BaseWorker } from "../../base.js";
import { spawnSync } from 'child_process';


const POWERSHELL_CMD_GET_OUTLOOK_CALENDAR_ITEMS = `
$outlook = New-Object -ComObject Outlook.Application;
$ns = $outlook.GetNamespace("MAPI");
$calendar = $ns.GetDefaultFolder(9);
$items = $calendar.Items
$items.Sort("[Start]")
$items.IncludeRecurrences = $true

$startRange = (Get-Date).AddDays(-90).ToString("yyyy-MM-dd HH:mm")
$endRange = (Get-Date).AddDays(30).ToString("yyyy-MM-dd HH:mm")
$filter = "[Start] >= '$startRange' AND [End] <= '$endRange'"
$items = $items.Restrict($filter)

$objects = $items | ForEach-Object {
    $attendees = @()
    foreach ($recipient in $_.Recipients) {
        $attendees += $recipient.Name
    }
    [PSCustomObject]@{
        Subject   = $_.Subject
        StartTime = $_.Start.ToString("yyyy-MM-dd HH:mm:ss")
        EndTime   = $_.End.ToString("yyyy-MM-dd HH:mm:ss")
        Location  = if ($_.Location) { $_.Location } else { "" }
        Attendees = $attendees
        Organizer = if ($_.Organizer) { $_.Organizer.Name } else { "" }
    }
}

$jsonOutput = $objects | ConvertTo-Json -Depth 2
Write-Output $jsonOutput
`

class SynchronizationWorker extends BaseWorker {

    constructor() {
        super();
    }

    async getOutlookCalendarItems() {
        console.info('synchronizing outlook');
        const cmd = POWERSHELL_CMD_GET_OUTLOOK_CALENDAR_ITEMS;
        const result = spawnSync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-Command', cmd]);
        console.info(result.stdout.toString());
        return result;
    }

    async startService() {

    }

    async stopService() {

    }
}

(new SynchronizationWorker()).initialize();