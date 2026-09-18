import subprocess, sys, os

os.chdir(r"C:\VisionTap\pcapp\scanner")
log = open(r"C:\VisionTap\scanner.log", "w")
proc = subprocess.Popen(
    [sys.executable, "server.py"],
    stdout=log, stderr=log
)
with open(r"C:\VisionTap\scanner.pid", "w") as f:
    f.write(str(proc.pid))
proc.wait()
