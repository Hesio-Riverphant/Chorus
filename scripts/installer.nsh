; Chorus installs for the current user and never removes chat data.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall Chorus.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "/currentuser"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Uninstall Chorus.lnk"
!macroend
