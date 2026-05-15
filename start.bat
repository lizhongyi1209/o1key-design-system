@echo off
chcp 65001 >nul 2>&1
echo ========================================
echo o1key ai generator - Starting
echo ========================================
echo.

REM Check if portable Python exists
if not exist "app\python\python.exe" (
    echo ERROR: Python runtime not found!
    echo Please ensure the app\python folder is complete.
    echo.
    pause
    exit /b 1
)

REM Start server in background
echo Starting server...
start /B "" app\python\python.exe app\server.py

REM Poll until server is ready, then open browser immediately
echo Waiting for server to be ready...
:waitloop
powershell -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 8080); $c.Close(); exit 0 } catch { exit 1 }" 2>nul
if %errorlevel% equ 0 goto openbrowser
timeout /t 1 /nobreak >nul
goto waitloop

:openbrowser
echo Server ready, opening browser...
start "" "http://localhost:8080/home.html"

echo.
echo Visit: http://localhost:8080/home.html
echo.
echo Press Ctrl+C to stop
echo ========================================
echo.

pause
