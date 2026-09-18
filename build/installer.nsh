; AugenPause – NSIS additions (included via nsis.include in electron-builder.yml)
;
; "Beim Anmelden starten" writes a value into HKCU\...\Run (Electron
; app.setLoginItemSettings). Without cleanup Windows would keep a broken
; autostart entry after uninstalling. The value name is the AppUserModelID
; (appId when the app sets it, Electron's default otherwise) – all candidates are
; removed; DeleteRegValue is a no-op for values that do not exist.
; Skipped on updates (the old uninstaller runs with --updated), so autostart
; survives installing a newer version.

!macro augenpauseRemoveAutostartValue NAME
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${NAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${NAME}"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro augenpauseRemoveAutostartValue "com.augenpause.app"
    !insertmacro augenpauseRemoveAutostartValue "electron.app.AugenPause"
    !insertmacro augenpauseRemoveAutostartValue "AugenPause"
  ${endIf}
!macroend
