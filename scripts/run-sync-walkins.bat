@echo off
cd /d "%~dp0\.."
echo ---- %date% %time% ---- >> logs\sync-walkins.log
"C:\Program Files\nodejs\node.exe" scripts\sync-walkins.js >> logs\sync-walkins.log 2>&1
