@echo off
rem ai-handwave hub launcher (ASCII only)
cd /d %~dp0
if exist hub.conf goto run
echo [first run] setup hub:
set /p TOK=Root token, controls console/CLI/downloads (or run: handwave.exe token): 
>hub.conf echo token=%TOK%
set /p NTOK=Node enrollment token (Enter=skip; nodes-only token, safe to embed in distributed exe): 
if not "%NTOK%"=="" >>hub.conf echo node_token=%NTOK%
set /p UP=Upstream AI base URL (Enter=skip; or edit upstreams.conf for multi-upstream): 
if "%UP%"=="" goto run
>>hub.conf echo upstream=%UP%
set /p UPK=Upstream API key: 
>>hub.conf echo upkey=%UPK%
:run
handwave.exe hub
pause
