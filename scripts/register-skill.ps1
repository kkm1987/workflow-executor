param(
    [ValidateSet('codex', 'claude')]
    [string[]]$Client = @('codex', 'claude')
)

$ErrorActionPreference = 'Stop'
$executorRoot = Split-Path -Parent $PSScriptRoot
$skillSource = Join-Path $executorRoot 'skills/workflow-executor'
$profileRoot = [Environment]::GetFolderPath('UserProfile')
if (-not $profileRoot) { throw 'ユーザーのホームディレクトリを取得できません' }
if (-not (Test-Path -LiteralPath (Join-Path $skillSource 'SKILL.md'))) { throw '登録するskillがありません' }

$registrations = foreach ($name in ($Client | Select-Object -Unique)) {
    $folder = if ($name -eq 'codex') { '.agents/skills' } else { '.claude/skills' }
    $destination = Join-Path (Join-Path $profileRoot $folder) 'workflow-executor'
    if (Test-Path -LiteralPath $destination) {
        $existing = Get-Item -LiteralPath $destination
        if ($existing.LinkType -ne 'Junction' -or $existing.Target -ne $skillSource) {
            throw "既存のskillは上書きしません: $destination"
        }
    }
    [PSCustomObject]@{ Client = $name; Destination = $destination }
}

foreach ($registration in $registrations) {
    if (-not (Test-Path -LiteralPath $registration.Destination)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $registration.Destination) -Force | Out-Null
        New-Item -ItemType Junction -Path $registration.Destination -Target $skillSource | Out-Null
    }
    $registration
}
