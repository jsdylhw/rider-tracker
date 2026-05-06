@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"

echo.
echo ========================================
echo Rider Tracker Windows 一键启动
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 没有找到 Node.js。
    echo 请先安装 Node.js 24 或更高版本：
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "usebackq delims=" %%v in (`node -p "process.versions.node.split('.')[0]" 2^>nul`) do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
    echo [错误] 无法读取 Node.js 版本。
    echo.
    pause
    exit /b 1
)

if %NODE_MAJOR% LSS 24 (
    echo [错误] 当前 Node.js 版本过低。
    node -v
    echo 本项目需要 Node.js 24 或更高版本。
    echo.
    pause
    exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [错误] 没有找到 npm。
    echo 请重新安装 Node.js 24 或更高版本，并勾选 npm。
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo 第一次启动，正在安装依赖...
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败。请检查网络后重新双击本文件。
        echo.
        pause
        exit /b 1
    )
)

echo.
echo 正在启动 Rider Tracker...
echo 浏览器稍后会自动打开：http://127.0.0.1:8787
echo.
echo 关闭服务：回到这个窗口，按 Ctrl + C。
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8787"
call npm.cmd start

echo.
echo Rider Tracker 已停止。
pause
