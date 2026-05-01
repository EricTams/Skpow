@echo off
setlocal

cd /d "%~dp0"

echo Starting SkPow local dev server...
start "SkPow Vite Dev Server" cmd /k "npm run dev -- --host 127.0.0.1 --port 5173 --strictPort"

echo Opening http://127.0.0.1:5173/ ...
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5173/"
