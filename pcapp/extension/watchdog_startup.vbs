' VisionTap watchdog - silent auto-start at Windows logon.
' Launches pcapp\extension\watchdog.py with pythonw (no console window) so the
' stall-watcher runs continuously in the background with no visible window.
' Place in the Startup folder (Win+R -> shell:startup) or run the installer.
Set shell = CreateObject("WScript.Shell")
WATCHDOG = "C:\VisionTap\pcapp\extension\watchdog.py"
PYTHONW = "C:\Users\benit\AppData\Local\Python\bin\pythonw.exe"

' Launch hidden (0 = SW_HIDE) so no window appears at login.
shell.Run """" & PYTHONW & """ """ & WATCHDOG & """", 0, False
