@echo off
REM WhatsApp agent: starts the server and restarts it if it stops.
REM Logs are written to logs\agent.log
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
echo [%date% %time%] Starting the agent >> logs\agent.log
node server.js >> logs\agent.log 2>&1
echo [%date% %time%] The agent stopped. Restarting in 10 seconds >> logs\agent.log
ping -n 11 127.0.0.1 > nul
goto loop
