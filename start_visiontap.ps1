# VisionTap Auto-Start Script
# Starts VisionTap and moves it to Virtual Desktop 2

$ExePath = "C:\VisionTap\slotbrowser\dist\win-unpacked\VisionTap Slots.exe"
$WorkingDir = "C:\VisionTap\slotbrowser\dist\win-unpacked"

# Check if VisionTap is already running
$existing = Get-Process -Name "VisionTap Slots" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "VisionTap is already running."
    # Bring to foreground
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class WinAPI {
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
    [WinAPI]::SetForegroundWindow($existing.MainWindowHandle)
    [WinAPI]::ShowWindow($existing.MainWindowHandle, 5)
    exit
}

Write-Host "Starting VisionTap..."
$proc = Start-Process -FilePath $ExePath -WorkingDirectory $WorkingDir -PassThru

# Wait for window to be created
$maxWait = 30
$waited = 0
while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 1
    $waited++
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        Write-Host "Window found after $waited seconds"
        break
    }
}

if ($proc.MainWindowHandle -eq [IntPtr]::Zero) {
    Write-Host "Warning: Could not find window handle"
    exit
}

$hwnd = $proc.MainWindowHandle
Write-Host "Window handle: $hwnd"

# Try to move to Virtual Desktop 2 using Windows 10/11 API
try {
    # Load the VirtualDesktopManager COM object
    $vdm = New-Object -ComObject "C2f528D0-5CB8-4E26-8FD8-B80F9E4F92A1"
    
    # Get virtual desktop information from registry
    $regPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops"
    $desktopGuids = @()
    
    if (Test-Path $regPath) {
        $desktops = Get-ItemProperty -Path $regPath -Name "Desktops" -ErrorAction SilentlyContinue
        if ($desktops -and $desktops.Desktops) {
            $desktopGuids = $desktops.Desktops
        }
    }
    
    Write-Host "Found $($desktopGuids.Count) virtual desktop(s)"
    
    # If we have at least 2 desktops, try to move to desktop 2
    if ($desktopGuids.Count -ge 2) {
        $desktop2Guid = [Guid]$desktopGuids[1]
        Write-Host "Moving to Virtual Desktop 2: $desktop2Guid"
        
        $result = $vdm.MoveWindowToDesktop($hwnd, $desktop2Guid)
        if ($result -eq 0) {
            Write-Host "Successfully moved to Virtual Desktop 2!"
        } else {
            Write-Host "Move returned code: $result"
        }
    } else {
        Write-Host "Only $($desktopGuids.Count) desktop(s) found. Desktop 2 doesn't exist yet."
        Write-Host "Creating new desktop and moving window..."
        
        # Try to create desktop 2 by moving window to new desktop
        $newGuid = [Guid]::NewGuid()
        $result = $vdm.MoveWindowToDesktop($hwnd, $newGuid)
        
        if ($result -eq 0) {
            Write-Host "Moved to new desktop!"
        } else {
            Write-Host "Could not auto-move. Please use Win+Tab to manually move the window."
        }
    }
} catch {
    Write-Host "Virtual Desktop API not available: $($_.Exception.Message)"
    Write-Host "App started on current desktop. Use Win+Tab to move to Desktop 2."
}

# Bring window to front
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ForegroundWindow {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
[ForegroundWindow]::SetForegroundWindow($hwnd)
[ForegroundWindow]::ShowWindow($hwnd, 5)

Write-Host "`nVisionTap is running!"
Write-Host "Tip: Use Win+Tab to drag the window to Desktop 2 if auto-move didn't work"
