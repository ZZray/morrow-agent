@echo off
rem handwave node — one-shot helper (program mode, no service)
rem Double-click: connect hub and wait for allow/pair on the workbench.
cd /d %~dp0
if exist node.conf (
  handwave.exe node
) else (
  echo Tip: create node.conf with hub=... and token=... if not using defaults.
  handwave.exe node
)
pause
