' VisionTap Keeper - silent auto-start at Windows logon.
' Launches pcapp\extension\keeper.py with pythonw (no console window). Fully
' local: it only handles heartbeat/command for the failsafe watchdog, never
' sends anything off-machine. Copy/place this file in the Startup folder:
'   Win+R -> shell:startup
' (or run install_keeper_startup.bat as Administrator for a scheduled task).
Set shell = CreateObject("WScript.Shell")
KEEPER = "C:\VisionTap\pcapp\extension\keeper.py"
PYTHONW = "C:\Users\benit\AppData\Local\Python\bin\pythonw.exe"

' Launch hidden (0 = SW_HIDE) so no window appears at login.
shell.Run """" & PYTHONW & """ """ & KEEPER & """", 0, False
