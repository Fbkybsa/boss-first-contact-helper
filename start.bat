@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BOSS直聘投递追踪服务
echo ============================================
echo  投递追踪服务启动中...
echo  稍后浏览器会自动打开 http://127.0.0.1:8787
echo  关闭本窗口即停止服务
echo ============================================
rem 延迟2秒后自动打开管理页（等服务就绪）
start "" /min cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8787"
where python >nul 2>nul
if %errorlevel%==0 (
    python server\app.py
) else (
    py -3 server\app.py
)
echo.
echo 服务已停止。
pause
