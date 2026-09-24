@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装： https://nodejs.org
  pause
  exit /b 1
)
echo 正在启动内鬼模式服务...
echo 本机访问： http://localhost:3000
echo 局域网内其他人访问： http://你的内网IP:3000
echo 关闭这个窗口即停止服务。
echo.
node server.js
pause
