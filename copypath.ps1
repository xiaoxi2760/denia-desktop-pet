# Copy this project to a pure ASCII folder, as a path test.
# Pure ASCII on purpose: the .cmd wrapper is parsed by cmd.exe
# byte by byte using OEM codepage 936.
# The source path is taken from $PSScriptRoot, so no Chinese
# path literal ever appears in any file - that is what keeps
# this safe. PowerShell handles the Unicode path natively.
$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSCommandPath
$dst = 'D:\denia'

Write-Host '============================================'
Write-Host '  Path test: copy the pet to an ASCII path'
Write-Host "  Source : $src"
Write-Host "  Target : $dst"
Write-Host '============================================'
Write-Host ''

if (-not (Test-Path -LiteralPath $src)) { throw "source not found: $src" }

if (Test-Path -LiteralPath $dst) {
    Write-Host 'Target already exists, merging into it.'
} else {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

Write-Host 'Copying about 460 MB, please wait...'
Write-Host ''

Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force

$exe = Join-Path $dst 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "copy finished but electron.exe is missing at: $exe"
}

$runner = Join-Path $dst 'RUN.cmd'
$body = @"
@echo off
cd /d "$dst"
echo Running from $dst
echo ------------------------------------
"node_modules\electron\dist\electron.exe" .
echo.
echo exit code : %ERRORLEVEL%
pause
"@
Set-Content -LiteralPath $runner -Value $body -Encoding ASCII

Write-Host ''
Write-Host 'Copy finished and verified (electron.exe is present).'
Write-Host ''
Write-Host '--------------------------------------------------------'
Write-Host '  Now double-click:'
Write-Host ''
Write-Host ('     ' + $runner)
Write-Host ''
Write-Host '  Then compare the exit code:'
Write-Host ''
Write-Host '     0                ASCII path fixed it, the Chinese'
Write-Host '                      folder name was the whole problem.'
Write-Host ''
Write-Host '     -2147483645      Still crashing, so the path is not'
Write-Host '                      the cause. Next suspects: an antivirus'
Write-Host '                      or endpoint agent injecting into'
Write-Host '                      electron.exe.'
Write-Host '--------------------------------------------------------'
Write-Host ''

$answer = Read-Host 'Press Enter to close'
