@echo off
chcp 65001 >nul 2>&1

REM Check if portable Python exists
if not exist "app\python\python.exe" (
    echo ERROR: Python runtime not found!
    echo Please ensure the app\python folder is complete.
    echo.
    pause
    exit /b 1
)

REM Find next available port starting from 8080
set PORT=8080
:findport
powershell -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" 2>nul
if %errorlevel% equ 0 (
    set /a PORT+=1
    goto findport
)

REM Set port-specific output directory
set OUTDIR=%~dp0output\%PORT%

echo ========================================
echo o1key ai generator - Port %PORT%
echo ========================================
echo.
echo Starting server on port %PORT%...
echo History dir: %OUTDIR%
echo.

REM Start server in background with port-specific output dir
start /B "" app\python\python.exe server.py %PORT% %OUTDIR%

REM Poll until server is ready, then open browser immediately
echo Waiting for server...
:waitloop
powershell -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" 2>nul
if %errorlevel% equ 0 goto openbrowser
timeout /t 1 /nobreak >nul
goto waitloop

:openbrowser
echo Server ready, opening browser...
start "" "http://localhost:%PORT%/home.html"

echo.
echo Instance on port %PORT% is running.
echo Visit: http://localhost:%PORT%/home.html
echo Close this window or press Ctrl+C to stop.
echo ========================================
echo.

pause
