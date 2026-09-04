' VisionTap Scanner Server - silent auto-start at Windows logon.
' Launches pcapp\scanner\server.py with pythonw (no console window) so the
' local OpenCV detection server is always ready when Alt+M is pressed.
' Copy/place this file in the Startup folder:
'   Win+R -> shell:startup
' (or run install_startup.bat for automatic setup).
Set shell = CreateObject("WScript.Shell")
SERVER = "C:\VisionTap\pcapp\scanner\server.py"
PYTHONW = "C:\Users\benit\AppData\Local\Python\bin\pythonw.exe"

' Launch hidden (0 = SW_HIDE) so no window appears at login.
shell.Run """" & PYTHONW & """ """ & SERVER & """", 0, False
