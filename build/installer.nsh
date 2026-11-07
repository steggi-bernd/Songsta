; Songsta's installer in Songsta's own look: dark, one page with one big white button. Pressed,
; logo and name stay where they are and a thin white bar takes the button's place. Then the app
; opens with its first-start pages. An update (the app's own, silent or not) skips the first page.

; The hook below replaces the template's own, which brings these along otherwise.
!include "getProcessInfo.nsh"
Var pid

!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!include WinMessages.nsh
!include nsDialogs.nsh

!define SONGSTA_BG "121212"
!define SONGSTA_TEXT "FFFFFF"
!define SONGSTA_DIM "B3B3B3"
!define /ifndef SS_BITMAP 0x0E
!define /ifndef STM_SETIMAGE 0x172
!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR 0x2001

Var songstaPathLabel
Var songstaFontTitle
Var songstaFontLine
Var songstaFontButton
Var songstaFontSmall
Var songstaWindowX
Var songstaWindowY
Var songstaWindowW
Var songstaWindowH
Var songstaBarLogo
Var songstaBarTitle

!macro songstaHide parent id
  GetDlgItem $0 ${parent} ${id}
  ShowWindow $0 ${SW_HIDE}
!macroend

; The installer's frame out of the way: its buttons, lines and headline, in the dark.
!macro songstaDarkFrame
  !insertmacro songstaHide $HWNDPARENT 1
  !insertmacro songstaHide $HWNDPARENT 2
  !insertmacro songstaHide $HWNDPARENT 3
  !insertmacro songstaHide $HWNDPARENT 1028
  !insertmacro songstaHide $HWNDPARENT 1256
  !insertmacro songstaHide $HWNDPARENT 1034
  !insertmacro songstaHide $HWNDPARENT 1035
  !insertmacro songstaHide $HWNDPARENT 1036
  !insertmacro songstaHide $HWNDPARENT 1037
  !insertmacro songstaHide $HWNDPARENT 1038
  !insertmacro songstaHide $HWNDPARENT 1039
  SetCtlColors $HWNDPARENT "${SONGSTA_TEXT}" "${SONGSTA_BG}"
  ; Windows draws the title bar: dark as well, where it can.
  System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)"
!macroend

Function songstaAssets
  InitPluginsDir
  File "/oname=$PLUGINSDIR\songsta-logo.bmp" "${BUILD_RESOURCES_DIR}\installer-logo.bmp"
  CreateFont $songstaFontTitle "Segoe UI Semibold" 28 600
  CreateFont $songstaFontLine "Segoe UI" 10 400
  CreateFont $songstaFontButton "Segoe UI Semibold" 11 600
  CreateFont $songstaFontSmall "Segoe UI" 8 400
FunctionEnd

; The page takes the whole window. Leaves its size in $3 and $4.
Function songstaFill
  Exch $1
  System::Call "*(i, i, i, i) p.r2"
  System::Call "user32::GetClientRect(p $HWNDPARENT, p r2)"
  System::Call "*$2(i, i, i .r3, i .r4)"
  System::Free $2
  System::Call "user32::SetWindowPos(p r1, p 0, i 0, i 0, i r3, i r4, i 0x14)"
  Pop $1
FunctionEnd

; The logo in a control, as big as 40 units are on this screen and properly scaled down. Wants the page in $5.
Function songstaSetLogo
  Exch $0
  System::Call "*(i 0, i 0, i 40, i 40) p.r2"
  System::Call "user32::MapDialogRect(p r5, p r2)"
  System::Call "*$2(i, i, i .r9, i)"
  System::Free $2
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\songsta-logo.bmp", i 0, i 0, i 0, i 0x10) p.r1'
  System::Call 'user32::GetDC(p 0) p.r2'
  System::Call 'gdi32::CreateCompatibleDC(p r2) p.r3'
  System::Call 'gdi32::CreateCompatibleDC(p r2) p.r4'
  System::Call 'gdi32::CreateCompatibleBitmap(p r2, i r9, i r9) p.r6'
  System::Call 'gdi32::SelectObject(p r3, p r1)'
  System::Call 'gdi32::SelectObject(p r4, p r6)'
  System::Call 'gdi32::SetStretchBltMode(p r4, i 4)'
  System::Call 'gdi32::SetBrushOrgEx(p r4, i 0, i 0, p 0)'
  System::Call 'gdi32::StretchBlt(p r4, i 0, i 0, i r9, i r9, p r3, i 0, i 0, i 192, i 192, i 0xCC0020)'
  System::Call 'gdi32::DeleteDC(p r3)'
  System::Call 'gdi32::DeleteDC(p r4)'
  System::Call 'user32::ReleaseDC(p 0, p r2)'
  System::Call 'gdi32::DeleteObject(p r1)'
  SendMessage $0 ${STM_SETIMAGE} 0 $6
  Pop $0
FunctionEnd

; Round ends, like every button in the app.
Function songstaRound
  Exch $1
  System::Call "*(i, i, i, i) p.r2"
  System::Call "user32::GetClientRect(p r1, p r2)"
  System::Call "*$2(i, i, i .r3, i .r4)"
  System::Free $2
  System::Call "gdi32::CreateRoundRectRgn(i 0, i 0, i r3, i r4, i r4, i r4) p.r2"
  System::Call "user32::SetWindowRgn(p r1, p r2, i 1)"
  Pop $1
FunctionEnd

; Whatever folder is chosen, the app gets one of its own in there.
Function songstaFixPath
  StrLen $0 "${APP_FILENAME}"
  IntOp $0 0 - $0
  StrCpy $1 $INSTDIR "" $0
  ${If} $1 != "${APP_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${EndIf}
FunctionEnd

Function songstaInstallPressed
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function songstaCancelPressed
  Pop $0
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd

Function songstaChangePressed
  Pop $0
  nsDialogs::SelectFolderDialog "$(songstaWhere)" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    StrCpy $INSTDIR $0
    Call songstaFixPath
    SendMessage $songstaPathLabel ${WM_SETTEXT} 0 "STR:$INSTDIR"
  ${EndIf}
FunctionEnd

Function songstaPage
  Call songstaSkipIfUpdated
  Call songstaAssets
  nsDialogs::Create 1044
  Pop $5
  ${If} $5 == error
    Abort
  ${EndIf}
  !insertmacro songstaDarkFrame
  Push $5
  Call songstaFill
  SetCtlColors $5 "${SONGSTA_TEXT}" "${SONGSTA_BG}"

  nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_BITMAP} 0 8% 10% 40u 40u ""
  Pop $0
  Push $0
  Call songstaSetLogo

  ${NSD_CreateLabel} 8% 32% 84% 36u "Songsta"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $songstaFontTitle 1
  SetCtlColors $0 "${SONGSTA_TEXT}" "${SONGSTA_BG}"

  ${NSD_CreateLabel} 8% 47% 84% 22u "$(songstaLine)"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $songstaFontLine 1
  SetCtlColors $0 "${SONGSTA_DIM}" "${SONGSTA_BG}"

  nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE} 0 8% 63% 104u 24u "$(songstaInstall)"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $songstaFontButton 1
  SetCtlColors $0 "000000" "FFFFFF"
  ${NSD_OnClick} $0 songstaInstallPressed
  Push $0
  Call songstaRound

  nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE} 0 41% 63% 60u 24u "$(songstaCancel)"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $songstaFontLine 1
  SetCtlColors $0 "${SONGSTA_DIM}" "${SONGSTA_BG}"
  ${NSD_OnClick} $0 songstaCancelPressed

  nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_PATHELLIPSIS} 0 8% 88% 68% 10u "$INSTDIR"
  Pop $songstaPathLabel
  SendMessage $songstaPathLabel ${WM_SETFONT} $songstaFontSmall 1
  SetCtlColors $songstaPathLabel "${SONGSTA_DIM}" "${SONGSTA_BG}"

  nsDialogs::CreateControl STATIC ${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_RIGHT} 0 76% 88% 16% 10u "$(songstaChange)"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $songstaFontSmall 1
  SetCtlColors $0 "${SONGSTA_TEXT}" "${SONGSTA_BG}"
  ${NSD_OnClick} $0 songstaChangePressed

  nsDialogs::Show
FunctionEnd

Function songstaPageLeave
FunctionEnd

; Everything of the progress page in its place: the same spots as on the page before.
Function songstaProgressLayout
  FindWindow $5 "#32770" "" $HWNDPARENT
  Push $5
  Call songstaFill
  ; 40 dialog units in this screen's pixels.
  System::Call "*(i 0, i 0, i 40, i 40) p.r2"
  System::Call "user32::MapDialogRect(p r5, p r2)"
  System::Call "*$2(i, i, i .r9, i)"
  System::Free $2
  IntOp $6 $3 * 8
  IntOp $6 $6 / 100
  IntOp $7 $3 * 84
  IntOp $7 $7 / 100

  IntOp $8 $4 * 10
  IntOp $8 $8 / 100
  System::Call "user32::SetWindowPos(p $songstaBarLogo, p 0, i r6, i r8, i r9, i r9, i 0x14)"

  IntOp $8 $4 * 32
  IntOp $8 $8 / 100
  System::Call "user32::SetWindowPos(p $songstaBarTitle, p 0, i r6, i r8, i r7, i r9, i 0x14)"

  GetDlgItem $0 $5 1006
  IntOp $8 $4 * 47
  IntOp $8 $8 / 100
  System::Call "user32::SetWindowPos(p r0, p 0, i r6, i r8, i r7, i r9, i 0x14)"
  ShowWindow $0 ${SW_SHOW}

  ; Where the button was, thin as the app's own bars.
  GetDlgItem $0 $5 1004
  IntOp $8 $4 * 63
  IntOp $8 $8 / 100
  IntOp $2 $9 * 12
  IntOp $2 $2 / 40
  IntOp $8 $8 + $2
  System::Call "user32::SetWindowPos(p r0, p 0, i r6, i r8, i r7, i 5, i 0x14)"
  ShowWindow $0 ${SW_SHOW}
  ShowWindow $5 ${SW_SHOW}
FunctionEnd

Function songstaProgressShow
  Call songstaAssets
  !insertmacro songstaDarkFrame
  ; The template shrinks the window afterwards: remember how it was.
  System::Call "*(i, i, i, i) p.r2"
  System::Call "user32::GetWindowRect(p $HWNDPARENT, p r2)"
  System::Call "*$2(i .r3, i .r4, i .r6, i .r7)"
  System::Free $2
  StrCpy $songstaWindowX $3
  StrCpy $songstaWindowY $4
  IntOp $songstaWindowW $6 - $3
  IntOp $songstaWindowH $7 - $4

  FindWindow $5 "#32770" "" $HWNDPARENT
  SetCtlColors $5 "${SONGSTA_TEXT}" "${SONGSTA_BG}"
  !insertmacro songstaHide $5 1027
  !insertmacro songstaHide $5 1016

  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x50000000|${SS_BITMAP}, i 0, i 0, i 1, i 1, p r5, p 0, p 0, p 0) p.r0'
  StrCpy $songstaBarLogo $0
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "Songsta", i 0x50000000, i 0, i 0, i 1, i 1, p r5, p 0, p 0, p 0) p.r0'
  StrCpy $songstaBarTitle $0
  SendMessage $songstaBarTitle ${WM_SETFONT} $songstaFontTitle 1
  SetCtlColors $songstaBarTitle "${SONGSTA_TEXT}" "${SONGSTA_BG}"

  GetDlgItem $0 $5 1006
  SendMessage $0 ${WM_SETFONT} $songstaFontLine 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$(installing)"
  SetCtlColors $0 "${SONGSTA_DIM}" "${SONGSTA_BG}"

  ; A plain white bar on grey: no theme and no frame around it.
  GetDlgItem $0 $5 1004
  System::Call "uxtheme::SetWindowTheme(p r0, w '', w '')"
  System::Call "user32::SetWindowLong(p r0, i -16, i 0x50000001)"
  System::Call "user32::SetWindowLong(p r0, i -20, i 0)"
  System::Call "user32::SetWindowPos(p r0, p 0, i 0, i 0, i 0, i 0, i 0x27)"
  SendMessage $0 ${PBM_SETBARCOLOR} 0 0xFFFFFF
  SendMessage $0 ${PBM_SETBKCOLOR} 0 0x303030

  Call songstaProgressLayout

  Push $songstaBarLogo
  Call songstaSetLogo
FunctionEnd

; The template puts a small light box of its own over the page at this point: not with us.
Function songstaOwnProgress
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  FindWindow $0 "#32770" "" $HWNDPARENT
  FindWindow $1 "#32770" "" $HWNDPARENT $0
  ${If} $1 != 0
    ShowWindow $1 ${SW_HIDE}
  ${EndIf}
  System::Call "user32::SetWindowPos(p $HWNDPARENT, p 0, i $songstaWindowX, i $songstaWindowY, i $songstaWindowW, i $songstaWindowH, i 0x14)"
  Call songstaProgressLayout
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

; After that small box went up and before anything else happens.
!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${Silent}
      Call songstaOwnProgress
    ${EndIf}
  !endif
  !insertmacro _CHECK_APP_RUNNING
!macroend

; Where the template leaves room for a page of one's own.
!macro licensePage
  Function songstaSkipIfUpdated
    Call ${MUI_PAGE_CUSTOMFUNCTION_PRE}
  FunctionEnd
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  Page custom songstaPage songstaPageLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW songstaProgressShow
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    LangString songstaLine ${LANG_ENGLISH} "Your music, wherever you keep it. No account and no ads."
    LangString songstaLine ${LANG_GERMAN} "Deine Musik, wo immer du sie hast. Ohne Konto und ohne Werbung."
    LangString songstaInstall ${LANG_ENGLISH} "Install"
    LangString songstaInstall ${LANG_GERMAN} "Installieren"
    LangString songstaCancel ${LANG_ENGLISH} "Cancel"
    LangString songstaCancel ${LANG_GERMAN} "Abbrechen"
    LangString songstaChange ${LANG_ENGLISH} "Change..."
    LangString songstaChange ${LANG_GERMAN} "Ändern ..."
    LangString songstaWhere ${LANG_ENGLISH} "Where should Songsta go?"
    LangString songstaWhere ${LANG_GERMAN} "Wohin soll Songsta?"
  !endif
!macroend
