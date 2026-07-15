@echo off
setlocal
cd /d "%~dp0"

if not exist "desktop\node_modules\electron\dist\electron.exe" (
  echo [Gauss Stream] Desktop dependencies are missing. Run:
  echo   cd desktop ^&^& npm install
  if not defined GAUSS_STREAM_NONINTERACTIVE pause
  exit /b 1
)

if not exist "rust\target\release\build-lod.exe" (
  echo [Gauss Stream] The Rust LOD processor is missing. Run after features are finalized:
  echo   cd rust ^&^& cargo build -p build-lod --release
  if not defined GAUSS_STREAM_NONINTERACTIVE pause
  exit /b 1
)

echo [Gauss Stream] Starting the source development build...
echo [Gauss Stream] Electron will read the current workspace files directly.
pushd desktop
call node_modules\.bin\electron.cmd . %*
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
  echo [Gauss Stream] Launch failed with exit code %EXIT_CODE%.
  if not defined GAUSS_STREAM_NONINTERACTIVE pause
)
exit /b %EXIT_CODE%
