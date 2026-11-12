# Registers a Windows Scheduled Task that runs the local LinkedIn sync
# every 4 hours. Read-only sync: it never writes to LinkedIn.
#
# WARNING: LinkedIn's User Agreement prohibits automated scraping; running
# this can risk your account. Use only on your own account, at your own risk.
#
# Setup (once):
#   1. node tools\sync-linkedin.js --login     (sign in once in the window)
#   2. powershell -ExecutionPolicy Bypass -File tools\register-sync-task.ps1
#
# Remove:
#   schtasks /delete /tn "zjacko LinkedIn sync" /f

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cmdPath = Join-Path $PSScriptRoot "sync-task.cmd"
$logDir = Join-Path $env:LOCALAPPDATA "zjacko-linkedin-sync"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$cmd = @"
@echo off
cd /d "$root"
node tools\sync-linkedin.js --push >> "%LOCALAPPDATA%\zjacko-linkedin-sync\task.log" 2>&1
"@
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII

$taskName = "zjacko LinkedIn sync"
$taskRun = '"' + $cmdPath + '"'
schtasks /create /f /tn $taskName /tr $taskRun /sc hourly /mo 4 /st 00:10

Write-Host ""
Write-Host "Registered '$taskName' - runs every 4 hours while you are signed in."
Write-Host "  Not pushed without git access; commits only when the data changed."
Write-Host "  Logs: $logDir\sync.log and task.log"
Write-Host "  First time: node tools\sync-linkedin.js --login"
Write-Host ""
Write-Host "If LinkedIn starts blocking headless sessions, edit $cmdPath and add --headed."
