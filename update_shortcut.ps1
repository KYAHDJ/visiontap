# Update startup shortcut to use batch file
$W = New-Object -ComObject WScript.Shell
$Startup = [Environment]::GetFolderPath('Startup')
$S = $W.CreateShortcut("$Startup\VisionTap Slots.lnk")
$S.TargetPath = "C:\VisionTap\start_visiontap.bat"
$S.WorkingDirectory = "C:\VisionTap"
$S.Description = "VisionTap Color Solver - Auto Start with Desktop 2"
$S.WindowStyle = 7
$S.Save()
Write-Host "Startup shortcut updated to use batch file"
