@echo off
rem Starts the board server (shipped inside the plugin) if it isn't running,
rem and opens the board in its own window. In a Claude chat, /board open does the same.
rem Optional: pass a board id, e.g.  "Start Board.cmd" nefx
setlocal
set "APPDIR=%~dp0mod\project-board\app"
powershell -NoProfile -Command "Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory '%APPDIR%' -WindowStyle Hidden"
ping -n 2 127.0.0.1 >nul
set "URL=http://localhost:4317/"
if not "%~1"=="" set "URL=http://localhost:4317/?project=%~1"
start "" msedge --app="%URL%"
endlocal
