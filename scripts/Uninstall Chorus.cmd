@echo off
start "Uninstall Chorus" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-chorus.ps1"
