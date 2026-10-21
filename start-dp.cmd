@echo off
chcp 936 >nul
pushd "%~dp0"
title 照片点评
echo 正在启动照片点评…
echo 默认只监听 127.0.0.1:8091，路径前缀 /dp。
echo 第一次打开网页会引导创建管理者账号并填写 API Key。
echo 关掉这个窗口即停止服务。
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 node.exe，请先安装 Node.js 并把它加进 PATH。
  pause
  popd
  exit /b 1
)
node server.js
pause
popd