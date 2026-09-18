# Kill all VisionTap processes
Get-Process -Name 'VisionTap*' -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Processes killed"

# Clear state folder
Remove-Item -Recurse -Force 'C:\VisionTap\slotbrowser\state' -ErrorAction SilentlyContinue
Write-Host "State folder cleared"

# Clear Electron user data (sessions, cache, localStorage)
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$roamingAppData = [Environment]::GetFolderPath('ApplicationData')

$paths = @(
    "$localAppData\VisionTap Slots",
    "$roamingAppData\VisionTap Slots",
    "$localAppData\visiontap-slots",
    "$roamingAppData\visiontap-slots"
)

foreach ($p in $paths) {
    if (Test-Path $p) {
        Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue
        Write-Host "Cleared: $p"
    }
}

Write-Host "All cache and state cleared!"
