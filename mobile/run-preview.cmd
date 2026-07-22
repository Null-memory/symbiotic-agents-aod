@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\index.html" (
  call npx expo export --platform web
  if errorlevel 1 exit /b 1
)

if "%AOD_BACKEND_URL%"=="" set "AOD_BACKEND_URL=http://127.0.0.1:4830"
if "%AOD_PREVIEW_HOST%"=="" set "AOD_PREVIEW_HOST=127.0.0.1"
if "%AOD_PREVIEW_PORT%"=="" set "AOD_PREVIEW_PORT=4173"

echo Android emulator URL: http://10.0.2.2:%AOD_PREVIEW_PORT%
echo AOD address on the login screen: http://10.0.2.2:%AOD_PREVIEW_PORT%
echo.
node preview-server.mjs

