Set WshShell = CreateObject("WScript.Shell")

' Kill existing electron only (scanner starts on-demand)
WshShell.Run "cmd /c taskkill /f /im electron.exe >nul 2>&1", 0, True
WScript.Sleep 2000

' Start VisionTap app (hidden)
WshShell.Run "cmd /c cd /d C:\VisionTap\slotbrowser && npx electron .", 0, False

Set WshShell = Nothing
