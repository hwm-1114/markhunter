; MarkHunter 安装器扩展：添加用户 PATH 环境变量 + 资源管理器右键菜单（任意目录以当前目录打开）
; 注意：不要定义 HWND_BROADCAST / WM_SETTINGCHANGE 宏——
; WinMessages.nsh（electron-builder 模板引入）会定义它们，重复定义会编译失败。
; SendMessage 中直接使用字面量 0xFFFF / 0x001A。
; 不使用 StrContains.nsh（其函数在 install 段未引用会触发 6010 警告，
; 而 electron-builder 以 /WX 编译导致失败）——包含检查用原生循环实现。

; ---------- 安装：添加用户 PATH（HKCU\Environment，无需管理员） ----------
!macro AddPathEntry
  ReadRegStr $R0 HKCU "Environment" "Path"
  ; 分段检查 PATH 是否已包含 $INSTDIR
  StrCpy $R5 $R0
  StrCpy $R6 ""
checkLoop:
  StrCpy $R7 $R5 1 0
  StrCmp $R7 "" checkTail
  StrCmp $R7 ";" checkSep
  StrCpy $R6 "$R6$R7"
  StrCpy $R5 $R5 "" 1
  Goto checkLoop
checkSep:
  StrCmp $R6 "$INSTDIR" donePath
  StrCpy $R6 ""
  StrCpy $R5 $R5 "" 1
  Goto checkLoop
checkTail:
  StrCmp $R6 "$INSTDIR" donePath
  StrCmp $R0 "" emptyPath
  WriteRegExpandStr HKCU "Environment" "Path" "$R0;$INSTDIR"
  Goto broadcastPath
emptyPath:
  WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
broadcastPath:
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
donePath:
!macroend

; ---------- 卸载：从用户 PATH 移除安装目录（按分号拆分重建） ----------
!macro RemovePathEntry
  ReadRegStr $R0 HKCU "Environment" "Path"
  StrCmp $R0 "" donePath2
  StrCpy $R1 ""            ; 结果
  StrCpy $R2 $R0           ; 剩余串
  StrCpy $R3 ""            ; 当前段
loopSeg:
  StrCpy $R4 $R2 1 0
  StrCmp $R4 "" tailSeg
  StrCmp $R4 ";" sepSeg
  StrCpy $R3 "$R3$R4"
  StrCpy $R2 $R2 "" 1
  Goto loopSeg
sepSeg:
  StrCmp $R3 "$INSTDIR" 0 keepSeg
  StrCpy $R3 ""
keepSeg:
  StrCmp $R3 "" 0 addSeg
  Goto clearSeg
addSeg:
  StrCmp $R1 "" 0 addSegSep
  StrCpy $R1 $R3
  Goto clearSeg
addSegSep:
  StrCpy $R1 "$R1;$R3"
clearSeg:
  StrCpy $R3 ""
  StrCpy $R2 $R2 "" 1
  Goto loopSeg
tailSeg:
  StrCmp $R3 "$INSTDIR" 0 keepTail
  StrCpy $R3 ""
keepTail:
  StrCmp $R3 "" 0 addTail
  Goto doneSeg
addTail:
  StrCmp $R1 "" 0 addTailSep
  StrCpy $R1 $R3
  Goto doneSeg
addTailSep:
  StrCpy $R1 "$R1;$R3"
doneSeg:
  StrCmp $R1 $R0 donePath2
  WriteRegExpandStr HKCU "Environment" "Path" "$R1"
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
donePath2:
!macroend

; ---------- 安装：注册右键菜单（目录背景空白处 + 目录本身） ----------
!macro AddContextMenu
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\MarkHunter" "" "用 MarkHunter 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\MarkHunter" "Icon" "$INSTDIR\MarkHunter.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\MarkHunter\command" "" '"$INSTDIR\MarkHunter.exe" --dir "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\MarkHunter" "" "用 MarkHunter 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\MarkHunter" "Icon" "$INSTDIR\MarkHunter.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\MarkHunter\command" "" '"$INSTDIR\MarkHunter.exe" --dir "%1"'
!macroend

; ---------- 卸载：移除右键菜单 ----------
!macro RemoveContextMenu
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\MarkHunter"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\MarkHunter"
!macroend

; ---------- electron-builder 钩子 ----------
; 目录记忆：electron-builder 内置用 ${INSTALL_REGISTRY_KEY}\InstallLocation 记录上次安装目录，
; 升级时自动装回上次目录。这里补一个默认值：全新安装（无记忆）时默认 F:\MarkHunter。
!macro customInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" setDefault
  StrCpy $INSTDIR $0
  Goto doneInit
setDefault:
  StrCpy $INSTDIR "F:\MarkHunter"
doneInit:
!macroend

!macro customInstall
  !insertmacro AddPathEntry
  !insertmacro AddContextMenu
!macroend

!macro customUnInstall
  !insertmacro RemovePathEntry
  !insertmacro RemoveContextMenu
!macroend
