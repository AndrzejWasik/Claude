@echo off
setlocal
chcp 65001 >nul 2>nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Nie znaleziono Node.js.
  echo.
  echo   Zainstaluj wersje 20 lub nowsza z https://nodejs.org/en/download
  echo   a potem uruchom ten plik jeszcze raz.
  echo.
  pause
  exit /b 1
)

node "%~dp0setup.mjs" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
