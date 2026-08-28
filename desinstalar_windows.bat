@echo off
REM ===========================================================
REM  Desinstalador Windows del Cerebro "Mi Boveda".
REM  - Detiene el servidor
REM  - Quita el acceso directo del Inicio de Windows
REM  - (opcional) borra la carpeta de datos
REM
REM  Uso:  doble-clic en:  desinstalar_windows.bat
REM ===========================================================
setlocal
cd /d "%~dp0"
set CODE_DIR=%CD%
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo.
echo  === Desinstalando Cerebro Mi Boveda ===
echo.

REM ---- detener proceso del servidor ----
taskkill /f /im node.exe >nul 2>nul
echo  Procesos de node detenidos (si habia alguno).

REM ---- quitar acceso directo del Inicio ----
del "%STARTUP_DIR%\Cerebro Mi Boveda.lnk" >nul 2>nul
echo  Acceso directo del Inicio eliminado.

echo.
echo  Datos del Cerebro (base de datos, nodos, ordenes) en:
echo    %CODE_DIR%\data
echo.
choice /C SN /M "Borrar la carpeta de datos (S=borrar, N=conservar)"
if errorlevel 2 goto keep
rmdir /s /q "%CODE_DIR%\data"
echo  Datos borrados.
goto done
:keep
echo  Datos conservados.
:done
echo.
echo  === Desinstalacion completada ===
echo  La carpeta del programa queda en: %CODE_DIR%
echo  Si quieres borrarla del todo, eliminame manualmente.
pause
endlocal
