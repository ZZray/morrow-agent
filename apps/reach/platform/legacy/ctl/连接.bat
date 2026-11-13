@echo off
rem ai-handwave ctl (operator machine) launcher (ASCII only)
cd /d %~dp0
if exist ctl.conf goto pair
echo [first run] setup hub:
set /p HUB=Hub address, host or host:port (e.g. hub.example.com): 
>ctl.conf echo hub=%HUB%
set /p TOK=Hub access token (root token): 
>>ctl.conf echo token=%TOK%
:pair
handwave.exe pair
pause
