@echo off
chcp 65001 > nul
title Landsat 지수 분석 플랫폼 서버
cd /d "%~dp0"
echo.
echo  Landsat 지수 분석 플랫폼 서버를 시작합니다...
echo  브라우저 주소: http://localhost:8080
echo  종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요.
echo.
start "" http://localhost:8080
npx --yes http-server . -p 8080 -c-1
pause
