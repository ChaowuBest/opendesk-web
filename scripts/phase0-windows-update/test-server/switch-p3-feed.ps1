# Copyright (c) 2026 The OpenDesk Team
# OpenDesk is licensed under Mulan PSL v2.
# You can use this software according to the terms and conditions of the Mulan PSL v2.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('0.3.7', '0.3.8')]
    [string]$Version
)

$newsDirectory = Join-Path $PSScriptRoot 'news'
$source = Join-Path $newsDirectory "index-$Version.html"
$destination = Join-Path $newsDirectory 'index.html'
Copy-Item -LiteralPath $source -Destination $destination -Force
Write-Host "OpenDesk P3 test feed now publishes $Version"
