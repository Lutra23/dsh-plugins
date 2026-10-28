param(
    [string]$ProfilePatch = (Join-Path $env:USERPROFILE '.dsh/profiles/desktop/cordis.patch.yml'),
    [string]$BridgePatch = (Join-Path $PSScriptRoot 'cordis.patch.yml')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProfilePatch -PathType Leaf)) {
    throw "DSH profile patch not found: $ProfilePatch"
}
if (-not (Test-Path -LiteralPath $BridgePatch -PathType Leaf)) {
    throw "Bridge patch not found: $BridgePatch"
}

$beginMarker = '# BEGIN DSH/VCP BRIDGE PRESETS'
$endMarker = '# END DSH/VCP BRIDGE PRESETS'
$profileText = [IO.File]::ReadAllText($ProfilePatch)
$bridgeText = [IO.File]::ReadAllText($BridgePatch).Trim()

$withoutPrevious = [regex]::Replace(
    $profileText,
    "(?s)\r?\n?$([regex]::Escape($beginMarker)).*?$([regex]::Escape($endMarker))\r?\n?",
    ''
).TrimEnd()

$merged = @(
    $withoutPrevious
    ''
    $beginMarker
    $bridgeText
    $endMarker
    ''
) -join [Environment]::NewLine

$backupPath = "$ProfilePatch.bak-vcp-bridge-$(Get-Date -Format 'yyyyMMdd-HHmmssfff')"
Copy-Item -LiteralPath $ProfilePatch -Destination $backupPath
[IO.File]::WriteAllText($ProfilePatch, $merged, [Text.UTF8Encoding]::new($false))

[pscustomobject]@{
    ProfilePatch = $ProfilePatch
    Backup = $backupPath
    BridgePatch = $BridgePatch
    Status = 'installed'
} | Format-List
