# Full clean of all VisionTap data
$ErrorActionPreference = "SilentlyContinue"

# Kill all processes
Get-Process -Name 'VisionTap*' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name 'electron' -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Processes killed"

# Clear all possible Electron data locations
$paths = @(
    "C:\VisionTap\slotbrowser\state",
    "$env:LOCALAPPDATA\VisionTap Slots",
    "$env:APPDATA\VisionTap Slots",
    "$env:LOCALAPPDATA\visiontap-slots",
    "$env:APPDATA\visiontap-slots",
    "$env:LOCALAPPDATA\VisionTap",
    "$env:APPDATA\VisionTap",
    "$env:LOCALAPPDATA\Programs\VisionTap Slots"
)

foreach ($p in $paths) {
    if (Test-Path $p) {
        Remove-Item -Recurse -Force $p
        Write-Host "Cleared: $p"
    }
}

# Clear any Electron cache folders
$electronCache = @(
    "$env:LOCALAPPDATA\electron\Cache",
    "$env:LOCALAPPDATA\electron\DawnCache",
    "$env:LOCALAPPDATA\electron\GPUCache",
    "$env:APPDATA\electron\Cache"
)

foreach ($p in $electronCache) {
    if (Test-Path $p) {
        Remove-Item -Recurse -Force $p
        Write-Host "Cleared cache: $p"
    }
}

Write-Host "`nAll data cleared! Starting fresh."
