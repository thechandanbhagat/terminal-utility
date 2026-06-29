# SleekSSH & VPN Terminal Utility

A lightweight, modern desktop application combining a full-featured SSH terminal client, SFTP file browser, and Cisco VPN profile manager. Built with Tauri, Rust, and xterm.js.

![App Icon](src/assets/sleekssh-icon.png)

## Features

### 🖥️ SSH Terminal
- **xterm.js Integration:** Full terminal emulation supporting standard ANSI escapes, colors, and keybindings.
- **Responsive Layout:** Automatically handles terminal resizing (`resize_ssh`) on window size changes.
- **Session Management:** Securely store and load connections using Windows DPAPI encryption.

### 📁 SFTP File Manager
- **Remote Operations:** Browse remote directories, list files, and view metadata.
- **File Actions:** Download, upload, delete files/directories, and create folders directly from the interface.
- **File Dialogs:** Native file picker integration via Tauri for uploads and download destinations.

### 🔒 SSH Key Management
- **Key Generation:** Generate new secure SSH keypairs directly within the app.
- **Auto-Discovery:** Automatically scans default paths (`~/.ssh`) to list existing private keys.
- **Import Key:** Easily select custom private key files using native dialogs.

### 🌐 Cisco VPN Integration
- **Profile Swapper:** Detects and lists installed Cisco AnyConnect profiles on the host machine.
- **One-Click Switch:** Switch VPN profiles or disconnect from the UI, with automatic CLI tracking.
- **Status Monitoring:** Tracks VPN connection state and manages credentials securely.

---

## Technology Stack

- **Frontend:** HTML5, Vanilla CSS, Vanilla JavaScript
- **Terminal Emulator:** [xterm.js](https://xtermjs.org/) (with Fit Addon)
- **Framework:** [Tauri v2](https://v2.tauri.app/) (Desktop Application Framework)
- **Backend:** Rust (async handling using `tokio`, SSH connection via `ssh2`, DPAPI encryption, and system command interfaces)

---

## Development & Setup

### Prerequisites

To build and run this application locally, you will need:
1. **Node.js** (v18 or higher recommended)
2. **Rust & Cargo** (latest stable release)
3. **Tauri Prerequisites** (System dependencies depending on your platform; see the [Tauri Getting Started Guide](https://v2.tauri.app/start/prerequisites/))

### Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/thechandanbhagat/terminal-utility.git
   cd terminal-utility
   ```

2. Install npm dependencies:
   ```bash
   npm install
   ```

### Running the App

Start the Tauri development server:
```bash
npm run tauri dev
```

### Building the Production App

To package the application for production:
```bash
npm run tauri build
```

---

## License

This project is private/licensed for personal use. See the workspace configurations for details.
