@echo off
REM ===========================================================
REM  Instalador Windows del Cerebro "Mi Boveda".
REM  - Verifica Node 22
REM  - Instala dependencias npm
REM  - Prepara .env (normaliza a LF para que Node lo lea bien)
REM  - Crea el script de inicio y lo agrega al Inicio de Windows
REM
REM  Uso:  double-clic o:  install_windows.bat
REM ===========================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
set CODE_DIR=%CD%
set PORT=8787

echo.
echo  === Cerebro Mi Boveda - Instalador Windows ===
echo  Directorio: %CODE_DIR%
echo  Puerto:     %PORT%
echo.

REM ---- 1) Node >= 22 ----
where node >nul 2>nul
if errorlevel 1 (
  echo  Node no encontrado. Descargalo de https://nodejs.org (v22 LTS)
  echo  y reinstala este instalador cuando tengas Node.
  echo  Abriendo la pagina de descarga...
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -v') do set NODE_MAJOR=%%v
set NODE_MAJOR=%NODE_MAJOR:~1%
if %NODE_MAJOR% LSS 22 (
  echo  Necesitas Node 22 o superior. Tienes: %NODE_MAJOR%
  echo  Descargalo de https://nodejs.org (v22 LTS)
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
echo  Node encontrado: %NODE_MAJOR%
echo.

REM ---- 2) Dependencias npm ----
echo  Instalando dependencias npm...
call npm install --omit=dev
if errorlevel 1 (
  echo  ERROR: no se pudo instalar dependencias.
  pause
  exit /b 1
)

REM ---- 3) .env ----
if not exist ".env" (
  copy ".env.example" ".env" >nul 2>nul
)
if not exist ".env" type nul > ".env"
REM Normalizar saltos de .env a LF (Node >=22 lee mejor con LF).
powershell -NoProfile -Command "(Get-Content -Raw '.env') -replace \"`r`n\",\"`n\" | Set-Content -NoNewline '.env'"
if not exist ".env" type nul > ".env"

REM ---- 4) Script de inicio ----
(
echo @echo off
echo cd /d "%CODE_DIR%"
echo set PORT=%PORT%
echo node --env-file-if-exists=.env src\index.js
echo pause
) > "iniciar_cerebro.bat"

REM ---- 5) Agregar al Inicio de Windows (opcional) ----
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SHORTCUT="%STARTUP_DIR%\Cerebro Mi Boveda.lnk"
powershell -NoProfile -Command "$w=(New-Object -ComObject WScript.Shell);$s=$w.CreateShortcut(%SHORTCUT%);$s.TargetPath='%CODE_DIR%\iniciar_cerebro.bat';$s.WorkingDirectory='%CODE_DIR%';$s.Save()" >nul 2>nul

echo.
echo  === Instalacion completada ===
echo  Panel (admin):  http://localhost:%PORT%/
echo  API:            http://localhost:%PORT%/api/v1
echo.
echo  Para arrancar ahora:  doble clic en  iniciar_cerebro.bat
echo  (tambien queda accesible desde el menu Inicio de Windows).
echo  Para desinstalar:   doble clic en  desinstalar_windows.bat
echo.
pause
endlocal
