@echo off
rem Install handwave node as Windows service (run as Administrator)
cd /d %~dp0
handwave.exe node install %*
if errorlevel 1 pause
