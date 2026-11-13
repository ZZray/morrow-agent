@echo off
rem Uninstall handwave node Windows service (run as Administrator)
cd /d %~dp0
handwave.exe node uninstall
if errorlevel 1 pause
