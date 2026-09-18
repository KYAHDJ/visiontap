#!/bin/bash
set -e
LOG=/tmp/visiontap_setup.log
exec > >(tee -a $LOG) 2>&1
echo "=== VisionTap Setup Started at $(date) ==="

# Wait for dnf update to finish
echo "Waiting for dnf update..."
while pgrep -x dnf > /dev/null 2>&1; do sleep 5; done
echo "dnf update done."

# Install system deps
echo "Installing system packages..."
sudo dnf install -y git python3 python3-pip python3-devel tesseract gcc-c++ cmake \
  libX11-devel libXcomposite-devel libXdamage-devel libXrandr-devel libXtst-devel \
  alsa-lib-devel cups-devel libdrm-devel gtk3-devel nss-devel dbus-devel \
  libnotify-devel libsecret-devel libxkbcommon-devel xorg-x11-server-Xvfb \
  x11vnc fluxbox wget 2>&1 | tail -5

# Install Node.js 20
echo "Installing Node.js..."
if ! command -v node &> /dev/null; then
  sudo dnf module install nodejs:20 -y 2>&1 | tail -3
fi
echo "Node: $(node -v)  NPM: $(npm -v)"

# Clone repo
echo "Cloning repo..."
cd /home/opc
if [ ! -d "VisionTap" ]; then
  git clone https://github.com/KYAHDJ/visiontap.git VisionTap
fi
cd VisionTap

# Python deps
echo "Installing Python deps..."
pip3 install --user flask opencv-python-headless pytesseract Pillow numpy 2>&1 | tail -3

# Check tesseract
echo "Tesseract: $(tesseract --version 2>&1 | head -1)"

# Kill existing processes on ports
fuser -k 5566/tcp 2>/dev/null || true

echo "=== Setup complete at $(date) ==="
