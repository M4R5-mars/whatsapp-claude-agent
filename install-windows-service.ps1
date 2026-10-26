# WhatsApp agent: start automatically with Windows.
# Run this script ONCE, in PowerShell opened as Administrator:
#   powershell -ExecutionPolicy Bypass -File .\install-windows-service.ps1
# To remove:  Unregister-ScheduledTask -TaskName "WhatsApp AI Agent" -Confirm:$false

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "WhatsApp AI Agent"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js not found. Install Node.js (LTS) from https://nodejs.org and run this script again."
}
if (-not (Test-Path (Join-Path $dir ".env"))) {
  Write-Error "No .env file in this folder. Copy .env.example to .env and fill it in first."
}

$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$dir\start-windows.bat`"" -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

try {
  $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:3000/health" -TimeoutSec 5
  Write-Host "OK: the agent is running and will start automatically with Windows. ($($r.Content))"
} catch {
  Write-Warning "The task was created, but the agent isn't responding yet. Check logs\agent.log in this folder."
}
