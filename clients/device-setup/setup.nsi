Unicode true
!include x64.nsh
!include FileFunc.nsh

!define Folder "$PROGRAMFILES64\Nomina Device Setup\${PackageId}"
!define Registry "Software\Microsoft\Windows\CurrentVersion\Uninstall\NominaDevice-${PackageId}"
!define Helper '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$INSTDIR\device.ps1"'

Name "Nomina device setup"
OutFile "NominaDeviceSetup.exe"
RequestExecutionLevel admin
SetDateSave off
InstallDir "${Folder}"
LicenseData review.txt
LicenseText "Review the network settings and root fingerprint before installation."
Page license
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section
  StrCpy $INSTDIR "${Folder}"
  SetRegView 64
  ${DisableX64FSRedirection}
  SetOutPath "$INSTDIR"
  File device.ps1
  SetOutPath "$INSTDIR\${Revision}"
  File root.cer
  File package.json
  File /nonfatal icon-*.ico
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${Registry}" DisplayName "Nomina device setup (${PackageId})"
  WriteRegStr HKLM "${Registry}" UninstallString '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${Registry}" ModifyPath '"$INSTDIR\uninstall.exe" /Repair'
  ExecWait '${Helper} Install ${Revision}' $0
  StrCmp $0 0 done
  MessageBox MB_ICONSTOP "Setup needs attention. See $INSTDIR\status.txt and rerun setup."
  SetErrorLevel 1
  Abort
done:
SectionEnd

Function un.onInit
  StrCpy $INSTDIR "${Folder}"
  ${GetParameters} $0
  StrCmp $0 "/Repair" 0 done
  ${DisableX64FSRedirection}
  FileOpen $1 "$INSTDIR\status.txt" r
  FileRead $1 $2
  FileClose $1
  MessageBox MB_YESNO "$2$\r$\nRepair this device setup?" IDNO cancel
  ExecWait '${Helper} Install' $0
  StrCmp $0 0 repaired
  MessageBox MB_ICONSTOP "Repair needs attention. See $INSTDIR\status.txt."
  SetErrorLevel 1
  Quit
repaired:
  MessageBox MB_OK "Device setup repaired."
cancel:
  Quit
done:
FunctionEnd

Section "Uninstall"
  SetRegView 64
  ${DisableX64FSRedirection}
  ExecWait '${Helper} Remove' $0
  StrCmp $0 0 cleanup
  MessageBox MB_ICONSTOP "Cleanup needs attention. See $INSTDIR\status.txt before retrying."
  SetErrorLevel 1
  Abort
cleanup:
  DeleteRegKey HKLM "${Registry}"
  IfFileExists "$INSTDIR\preserved.txt" 0 +2
  MessageBox MB_OK "Externally edited items were preserved. See $INSTDIR\preserved.txt."
  Delete "$INSTDIR\device.ps1"
  Delete "$INSTDIR\state.json"
  Delete "$INSTDIR\status.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
