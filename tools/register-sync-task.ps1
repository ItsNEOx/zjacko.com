# Registers a Windows Scheduled Task that runs the local LinkedIn sync
# every 4 hours. Read-only sync: it never writes to LinkedIn.
#
# The task runs unelevated (RunLevel Limited), in your own session, with the
# repo as its working directory, and through a hidden VBS launcher so no
# console window flashes. It never runs as SYSTEM or as an administrator.
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
$vbsPath = Join-Path $PSScriptRoot "sync-task.vbs"
$logDir = Join-Path $env:LOCALAPPDATA "zjacko-linkedin-sync"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Console wrapper: pins the repo as the working directory, then runs the sync.
$cmd = @"
@echo off
cd /d "$root"
node tools\sync-linkedin.js --push >> "%LOCALAPPDATA%\zjacko-linkedin-sync\task.log" 2>&1
"@
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII

# Hidden launcher: window style 0 means cmd.exe never shows a console.
$vbs = @"
' Hidden launcher for the zjacko LinkedIn sync (machine-specific).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$root"
sh.Run Chr(34) & "$cmdPath" & Chr(34), 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ASCII

$taskName = "zjacko LinkedIn sync"

# Keep the existing 00:10 / 04:10 / ... cadence.
$start = (Get-Date).Date.AddMinutes(10)
if ($start -le (Get-Date)) { $start = $start.AddDays(1) }

$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\System32\wscript.exe" `
  -Argument ('"{0}" //B //Nologo' -f $vbsPath) `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -Once -At $start `
  -RepetitionInterval (New-TimeSpan -Hours 4)

# Interactive + Limited: your session, your normal (non-admin) token.
$principal = New-ScheduledTaskPrincipal `
  -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Write-Host ""
Write-Host "Registered '$taskName' - runs every 4 hours while you are signed in."
Write-Host "  Runs unelevated (no admin/SYSTEM token), working dir: $root"
Write-Host "  Starts hidden through $vbsPath - no console window."
Write-Host "  Task writes stay in $logDir and the repo; nothing else."
Write-Host "  Commits only when the data changed; pushes to origin/main."
Write-Host "  First time: node tools\sync-linkedin.js --login"
Write-Host ""
Write-Host "If LinkedIn starts blocking headless sessions, edit $cmdPath and add --headed."
