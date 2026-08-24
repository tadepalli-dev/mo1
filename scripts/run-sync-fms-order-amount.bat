@echo off
cd /d "%~dp0\.."
echo ---- %date% %time% ---- >> logs\sync-fms-order-amount.log
"C:\Program Files\nodejs\node.exe" scripts\sync-fms-order-amount.js >> logs\sync-fms-order-amount.log 2>&1
