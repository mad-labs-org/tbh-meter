; electron-builder NSIS custom-uninstall hook.
; On uninstall, ask whether to also delete the user's meter folder
; (%USERPROFILE%\<productName> — runs.jsonl, meter_live.txt, logs/). The app
; resolves this folder via app.getPath("home") + the variant name, which equals
; NSIS $PROFILE\${PRODUCT_NAME} for a per-user install (tbh-meter, or tbh-meter-rc
; for the side-by-side RC build — both match defaultMeterDir() in settings.ts).
; ${PRODUCT_NAME} is electron-builder's verbatim productName. Default = KEEP the
; data (No), incl. silent uninstalls (/SD IDNO).
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Also delete your saved runs and logs?$\n$\n$PROFILE\${PRODUCT_NAME}$\n$\nYes = delete them.    No = keep them." \
    /SD IDNO IDNO keepMeterData
    RMDir /r "$PROFILE\${PRODUCT_NAME}"
  keepMeterData:
!macroend
