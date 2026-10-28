param(
    [string]$DshHome = '',
    [string]$ProfileName = 'desktop',
    [string]$VcpHome = '',
    [switch]$SkipDependencyInstall,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$bundleRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$packageName = '@local/dsh-vcp-bridge'

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) {
        $env:DSH_HOME
    } else {
        Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
    }
}
$DshHome = [IO.Path]::GetFullPath($DshHome)
$profileRoot = Join-Path $DshHome (Join-Path 'profiles' $ProfileName)
$profilePackagePath = Join-Path $profileRoot 'package.json'
$profilePatchPath = Join-Path $profileRoot 'cordis.patch.yml'

if (-not (Test-Path -LiteralPath $profilePackagePath -PathType Leaf)) {
    throw "DSH profile package.json not found: $profilePackagePath"
}
if (-not (Test-Path -LiteralPath $profilePatchPath -PathType Leaf)) {
    throw "DSH profile patch not found: $profilePatchPath"
}

if (-not $VcpHome) {
    $VcpHome = if ($env:VCP_HOME) {
        $env:VCP_HOME
    } else {
        [IO.Path]::GetFullPath((Join-Path $bundleRoot '..\..'))
    }
}
$VcpHome = [IO.Path]::GetFullPath($VcpHome)
foreach ($required in @('agent_map.json', 'Agent', 'Plugin\DSHAgentSync', 'Plugin\DSHBridge')) {
    if (-not (Test-Path -LiteralPath (Join-Path $VcpHome $required))) {
        throw "VCP_HOME is incomplete; missing: $(Join-Path $VcpHome $required)"
    }
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
$packageBackup = "$profilePackagePath.bak-vcp-omni-$timestamp"
$patchBackup = "$profilePatchPath.bak-vcp-omni-$timestamp"
Copy-Item -LiteralPath $profilePackagePath -Destination $packageBackup
Copy-Item -LiteralPath $profilePatchPath -Destination $patchBackup

function Get-InstalledPackageManifest([string]$PackageName) {
    $segments = @($PackageName -split '/')
    $manifestPath = Join-Path `
        (Join-Path (Join-Path $profileRoot 'node_modules') $segments[0]) `
        (($segments | Select-Object -Skip 1) -join [IO.Path]::DirectorySeparatorChar)
    if ($segments.Count -gt 1) {
        $manifestPath = Join-Path $manifestPath 'package.json'
    } else {
        $manifestPath = Join-Path (Join-Path $profileRoot 'node_modules') $PackageName
        $manifestPath = Join-Path $manifestPath 'package.json'
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-InstalledPackageVersion([string]$PackageName) {
    $manifest = Get-InstalledPackageManifest $PackageName
    if ($null -eq $manifest) {
        return ''
    }
    return [string]$manifest.version
}

$hostManifest = Get-InstalledPackageManifest '@deepseek-ai/dsh-brand'
$hostVersion = if ($null -eq $hostManifest) { '' } else { [string]$hostManifest.version }
$cordisVersion = Get-InstalledPackageVersion '@deepseek-ai/cordis'
if (-not $cordisVersion -and $null -ne $hostManifest) {
    $cordisPeer = [string]$hostManifest.peerDependencies.'@deepseek-ai/cordis'
    if ($cordisPeer -match '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)') {
        $cordisVersion = $Matches[1]
    }
}
$projectForgeVersion = Get-InstalledPackageVersion 'dsh-project-forge'
$forgeContextVersion = Get-InstalledPackageVersion '@dsh-external/dsh-forge-context'

$profilePackage = Get-Content -LiteralPath $profilePackagePath -Raw | ConvertFrom-Json
if (-not $profilePackage.dependencies) {
    $profilePackage | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$linkTarget = 'link:' + ($bundleRoot -replace '\\', '/')
$profilePackage.dependencies | Add-Member `
    -NotePropertyName $packageName `
    -NotePropertyValue $linkTarget `
    -Force

if (-not $profilePackage.dsh) {
    $profilePackage | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{})
}
if (-not $profilePackage.dsh.profile) {
    $profilePackage.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $profilePackage.dsh.profile.PSObject.Properties['bundles']) {
    $profilePackage.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}
$bundles = @($profilePackage.dsh.profile.bundles)
if ($bundles -notcontains $packageName) {
    $bundles += $packageName
}
$profilePackage.dsh.profile.bundles = $bundles

$packageJson = $profilePackage | ConvertTo-Json -Depth 30

$patchText = [IO.File]::ReadAllText($profilePatchPath)
$beginMarker = '# BEGIN DSH/VCP BRIDGE PRESETS'
$endMarker = '# END DSH/VCP BRIDGE PRESETS'
$legacyPattern = "(?s)\r?\n?$([regex]::Escape($beginMarker)).*?$([regex]::Escape($endMarker))\r?\n?"
$omniBeginMarker = '# BEGIN DSH/VCP OMNI PROFILE'
$omniEndMarker = '# END DSH/VCP OMNI PROFILE'
$omniPattern = "(?s)\r?\n?$([regex]::Escape($omniBeginMarker)).*?$([regex]::Escape($omniEndMarker))\r?\n?"
$modelProviderBeginMarker = '# BEGIN DSH/VCP MODEL PROVIDER'
$modelProviderEndMarker = '# END DSH/VCP MODEL PROVIDER'
$modelProviderPattern = "(?s)\r?\n?$([regex]::Escape($modelProviderBeginMarker)).*?$([regex]::Escape($modelProviderEndMarker))\r?\n?"
function Extract-TopLevelEntry([string]$Text, [string]$EntryId) {
    $lines = $Text -split "\r?\n"
    $start = -1
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^-\s+id:\s*['""]?$([regex]::Escape($EntryId))['""]?\s*$") {
            $start = $index
            break
        }
    }
    if ($start -lt 0) {
        return ''
    }
    $end = $lines.Count
    for ($index = $start + 1; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^-\s+' -or $lines[$index] -match '^#\s+(BEGIN|END)\s+DSH/VCP') {
            $end = $index
            break
        }
    }
    return (($lines[$start..($end - 1)]) -join [Environment]::NewLine).TrimEnd()
}

function Remove-TopLevelEntry([string]$Text, [string]$EntryId) {
    $lines = $Text -split "\r?\n"
    $output = [Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -notmatch "^-\s+id:\s*['""]?$([regex]::Escape($EntryId))['""]?\s*$") {
            $output.Add($lines[$index])
            continue
        }
        for ($index = $index + 1; $index -lt $lines.Count; $index++) {
            if ($lines[$index] -match '^-\s+' -or $lines[$index] -match '^#\s+(BEGIN|END)\s+DSH/VCP') {
                $index -= 1
                break
            }
        }
    }
    return ($output -join [Environment]::NewLine).TrimEnd()
}

$hasLegacyModelProviderMarker = [regex]::IsMatch(
    $patchText,
    $modelProviderPattern
)
$preservedProviderEntry = if ($hasLegacyModelProviderMarker) {
    ''
} else {
    Extract-TopLevelEntry $patchText 'llm-pi-ai'
}
$withoutLegacy = [regex]::Replace($patchText, $legacyPattern, '')
$withoutLegacy = [regex]::Replace($withoutLegacy, $omniPattern, '').TrimEnd()
$withoutLegacy = [regex]::Replace(
    $withoutLegacy,
    $modelProviderPattern,
    ''
).TrimEnd()
$withoutLegacy = Remove-TopLevelEntry $withoutLegacy 'llm-pi-ai'
$yamlVcpHome = $VcpHome.Replace("'", "''")
$yamlHostVersion = $hostVersion.Replace("'", "''")
$yamlCordisVersion = $cordisVersion.Replace("'", "''")
$yamlProjectForgeVersion = $projectForgeVersion.Replace("'", "''")
$yamlForgeContextVersion = $forgeContextVersion.Replace("'", "''")
$profileBlock = @(
    $omniBeginMarker
    '- id: vcp-agent-sync'
    "  name: '$packageName'"
    '  config:'
    "    hostVersion: '$yamlHostVersion'"
    "    cordisVersion: '$yamlCordisVersion'"
    "    projectForgeVersion: '$yamlProjectForgeVersion'"
    "    forgeContextVersion: '$yamlForgeContextVersion'"
    '    enableProjectForge: true'
    '    enableForgeContext: true'
    "    vcpHome: '$yamlVcpHome'"
    '    snapshotUrl: http://127.0.0.1:6005/api/plugins/DSHAgentSync/snapshot'
    '    apiKeyEnv: VCPTOOLBOX_API_KEY'
    '    snapshotTimeoutMs: 5000'
    '    presetPrefix: vcp-agent'
    '    genericCompatId: vcp-compat'
    '    genericDualId: vcp-dual-stack'
    '    genericOmniId: vcp-omni'
    '    genericDeepId: vcp-deep-work'
    '    omniIdentityName: DSH主控'
    '    memoryReadFolders: DSH工程档案,公共'
    '    memoryWriteFolders: DSH工程档案'
    '    memoryToolsEnabled: true'
    '    memoryOwner: native'
    '    passiveRecallBoundaries: ""'
    '    passiveRecallFolders: ""'
    '    passiveRecallRoots: dailynote'
    '    passiveRecallLimit: 4'
    '    passiveRecallCandidateLimit: 12'
    '    passiveRecallBudgetChars: 4000'
    '    passiveRecallMinScore: 0.18'
    '    passiveRecallCooldownMs: 30000'
    '    passiveRecallFailureThreshold: 3'
    '    passiveRecallCircuitCooldownMs: 60000'
    '    memoryRerankMode: lexical'
    '    rerankUrl: ""'
    '    rerankModel: ""'
    '    rerankApiKeyEnv: ""'
    '    rerankTimeoutMs: 15000'
    '    intuitionCardPrefix: 直觉卡'
    '    deferStartupSync: true'
    '    watch: true'
    '    pollIntervalMs: 15000'
    $omniEndMarker
    ''
) -join [Environment]::NewLine
$mergedPatch = $withoutLegacy + [Environment]::NewLine + [Environment]::NewLine + $profileBlock
if ($preservedProviderEntry) {
    $mergedPatch += [Environment]::NewLine + $preservedProviderEntry + [Environment]::NewLine
}

[IO.File]::WriteAllText(
    $profilePackagePath,
    $packageJson + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
    $profilePatchPath,
    $mergedPatch,
    [Text.UTF8Encoding]::new($false)
)

$installResult = $null
if (-not $SkipDependencyInstall) {
    $pnpm = Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $pnpm) {
        throw 'pnpm.cmd was not found on PATH. Install dependencies with the DSH plugin manager, or rerun with -SkipDependencyInstall.'
    }
    Push-Location $profileRoot
    try {
        $pnpmArgs = @('install', $(if ($Offline) { '--offline' } else { '--prefer-offline' }))
        & $pnpm.Source @pnpmArgs
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed with exit code $LASTEXITCODE."
        }
        $installResult = if ($Offline) { 'installed-offline' } else { 'installed-prefer-offline' }
    } finally {
        Pop-Location
    }
}

[pscustomobject]@{
    Status = 'installed'
    DshHome = $DshHome
    Profile = $profileName
    VcpHome = $VcpHome
    PackageName = $packageName
    DependencyLink = $linkTarget
    PackageBackup = $packageBackup
    PatchBackup = $patchBackup
    DependencyInstall = $installResult
    ModelProvider = 'official-llm-pi-ai-custom-provider'
    OptionalIntegrations = [pscustomobject]@{
        HostVersion = $hostVersion
        CordisVersion = $cordisVersion
        ProjectForgeVersion = $projectForgeVersion
        ForgeContextVersion = $forgeContextVersion
    }
    RestartRequired = $true
}
