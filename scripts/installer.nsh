; Current-user installation. Both uninstall entrances use the same scoped plan.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall Chorus.lnk" "$INSTDIR\Uninstall Chorus.cmd"
!macroend

!macro customUnInit
  ; Never permit electron-builder's independent recursive data-delete path.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Use Uninstall Chorus in the app folder to review the exact app and shared data scope."
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customRemoveFiles
  ; Override RMDir /r entirely: unknown files and links stop before deletion.
  SetOutPath $TEMP
  ClearErrors
  ${If} ${isUpdated}
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-chorus.ps1" -InstalledRemove -Update' $R0
  ${Else}
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-chorus.ps1" -InstalledRemove' $R0
  ${EndIf}
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Unable to launch the scoped Chorus uninstaller."
  ${EndIf}
  ${If} $R0 != 0
    SetErrorLevel $R0
    Abort "Removal cancelled or failed validation. No recursive fallback is allowed."
  ${EndIf}
  Delete "$SMPROGRAMS\Uninstall Chorus.lnk"
!macroend
