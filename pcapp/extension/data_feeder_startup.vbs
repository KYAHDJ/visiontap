' VisionTap Data Feeder - silent auto-start at Windows logon.
' Launches pcapp\extension\data_feeder.py with pythonw (no console window).
' It polls the Google Apps Script feed and updates data/runs.json for GitHub
' Pages. Place in the Startup folder (or use install_autostart.bat).
Set shell = CreateObject("WScript.Shell")
FEEDER = "C:\VisionTap\pcapp\extension\data_feeder.py"
PYTHONW = "C:\Users\benit\AppData\Local\Python\bin\pythonw.exe"
shell.Run """" & PYTHONW & """ """ & FEEDER & """", 0, False
