Set WshShell = CreateObject("WScript.Shell")

' Kill existing
WshShell.Run "cmd /c taskkill /f /im python.exe >nul 2>&1 & taskkill /f /im electron.exe >nul 2>&1", 0, True
WScript.Sleep 2000

' Start scanner server (hidden)
WshShell.Run "cmd /c cd /d C:\VisionTap\pcapp\scanner && python server.py", 0, False
WScript.Sleep 3000

' Start VisionTap app (hidden)
WshShell.Run "cmd /c cd /d C:\VisionTap\slotbrowser && npx electron .", 0, False

Set WshShell = Nothing
