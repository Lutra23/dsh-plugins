[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$DistDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $DistDir)) {
    Write-Error "dist 目录不存在：$DistDir（先跑 npm run pack）"
    exit 1
}

$packs = @(Get-ChildItem -Path $DistDir -Recurse -Filter *.tgz | Sort-Object FullName)
if ($packs.Count -eq 0) { Write-Error 'dist 下没有 tgz'; exit 1 }

Write-Host ("找到 {0} 个包：" -f $packs.Count)
foreach ($p in $packs) { Write-Host ("  - {0}" -f $p.Name) }

$dsh = Get-Command dsh -ErrorAction SilentlyContinue

if (-not $Apply) {
    Write-Host ''
    Write-Host '预览模式（未改动任何文件）。确认后加 -Apply 执行：'
    Write-Host ("  pwsh -File scripts/install.ps1 -ProfileName {0} -Apply" -f $ProfileName)
    if ($dsh) { Write-Host ("检测到 dsh CLI：{0}" -f $dsh.Source) }
    else { Write-Host '未检测到 dsh CLI，-Apply 时会打印手动注册步骤。' }
    exit 0
}

if ($dsh) {
    foreach ($p in $packs) {
        Write-Host ("安装 {0} ..." -f $p.Name)
        & dsh plugin --profile $ProfileName add $p.FullName
        if ($LASTEXITCODE -ne 0) { Write-Warning ("dsh plugin add 失败：{0}" -f $p.Name) }
    }
    Write-Host '完成。重启 DSH 后生效。'
    exit 0
}

$pluginsDir = Join-Path $DshHome 'plugins'
$profileDir = Join-Path $DshHome ('profiles/' + $ProfileName)
Write-Host '未检测到 dsh CLI，手动注册步骤：'
Write-Host ("1) 解压到 {0}" -f $pluginsDir)
foreach ($p in $packs) {
    Write-Host ("   tar -xzf `"{0}`" -C `"{1}`"" -f $p.FullName, $pluginsDir)
}
Write-Host ("2) 编辑 {0}" -f (Join-Path $profileDir 'package.json'))
Write-Host '   dependencies 加 "<包名>": "file:<tgz 绝对路径>"'
Write-Host '   dsh.profile.bundles 追加包名'
Write-Host ("3) cd {0} && pnpm install" -f $profileDir)
Write-Host '4) 重启 DSH'
