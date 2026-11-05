@echo off
chcp 65001 >nul
cd /d "%~dp0"
title CamApp
start "" "http://localhost:8080"
node server.js
pause
