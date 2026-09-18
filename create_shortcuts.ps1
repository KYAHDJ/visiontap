$W = New-Object -ComObject WScript.Shell
$Desktop = [Environment]::GetFolderPath('Desktop')

# Desktop shortcut -> runs from source (npx electron .)
$S = $W.CreateShortcut("$Desktop\VisionTap Slots.lnk")
$S.TargetPath = "C:\VisionTap\start_visiontap.bat"
$S.WorkingDirectory = "C:\VisionTap\slotbrowser"
$S.Description = "VisionTap Color Solver Browser (solving-colors)"
$S.IconLocation = "C:\VisionTap\slotbrowser\dist\win-unpacked\VisionTap Slots.exe,0"
$S.Save()
Write-Host "Desktop shortcut created -> solving-colors"

# Startup folder shortcut
$Startup = [Environment]::GetFolderPath('Startup')
$S2 = $W.CreateShortcut("$Startup\VisionTap Slots.lnk")
$S2.TargetPath = "C:\VisionTap\start_visiontap.bat"
$S2.WorkingDirectory = "C:\VisionTap\slotbrowser"
$S2.Description = "VisionTap Color Solver Browser - Auto Start (solving-colors)"
$S2.IconLocation = "C:\VisionTap\slotbrowser\dist\win-unpacked\VisionTap Slots.exe,0"
$S2.WindowStyle = 7
$S2.Save()
Write-Host "Startup shortcut created -> solving-colors"

# Registry auto-start
$RegPath = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
$RegName = "VisionTapSlots"
$RegValue = "cmd.exe /c `"cd /d C:\VisionTap\slotbrowser && npx electron .`""
Set-ItemProperty -Path $RegPath -Name $RegName -Value $RegValue -Force
Write-Host "Registry auto-start entry created -> solving-colors"

Write-Host "`nAll shortcuts point to solving-colors (source build)!"
