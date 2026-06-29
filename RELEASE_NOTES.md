# Release Notes - SleekSSH v0.1.0

We are excited to announce the initial release of **SleekSSH** (v0.1.0), a lightweight, performance-focused desktop utility designed for developers, network engineers, and system administrators. 

SleekSSH combines a modern terminal interface, secure file transfer capabilities, and Cisco VPN profile management into a single, cohesive application built with Tauri, Rust, and xterm.js.

---

## Key Features

### 🖥️ SSH Terminal
- **xterm.js Integration:** High-performance terminal rendering supporting native ANSI escapes, standard colors, copy-paste, and key combinations.
- **Dynamic Resizing:** Automatically handles terminal dimension updates (`resize_ssh`) as windows are resized.
- **Secure Persistence:** Safely store connection presets locally, encrypted with Windows DPAPI.

### 📁 SFTP File Manager
- **Directory Browsing:** Full remote filesystem visibility (file types, sizes, permissions).
- **File Transfers:** Intuitive, secure download and upload workflows integrated with native Tauri file dialog pickers.
- **Directory Modifications:** Create folders, delete unwanted files, and manage directories recursively.

### 🔑 SSH Key Management
- **Auto-Discovery:** Automatically scans `~/.ssh` on startup to detect and list your public/private keys.
- **Key Generation:** Generate new, secure SSH keypairs (Ed25519) within the application.
- **Custom Key Selection:** Manually import private keys from any directory.

### 🌐 Cisco VPN Integration
- **Profile Detection:** Automatically lists existing Cisco AnyConnect profiles on the host machine.
- **One-Click Toggles:** Instantly switch profiles or disconnect from the UI.
- **Status Monitoring:** Reads VPN statuses and handles transitions gracefully.

---

## Installation & Setup

1. Download the installer for your system from the [Releases Page](https://github.com/thechandanbhagat/terminal-utility/releases/tag/v0.1.0):
   - **MSI Installer (Recommended):** `SleekSSH_0.1.0_x64_en-US.msi`
   - **Standalone Setup EXE:** `SleekSSH_0.1.0_x64-setup.exe`
2. Run the installer and launch **SleekSSH** from your desktop or start menu.
