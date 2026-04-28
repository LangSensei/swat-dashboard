# SWAT Dashboard — Web-based monitoring UI for SWAT operations

## Features
- Operation monitoring
- Terminal sessions (Copilot/Gemini CLI)
- Filtering by squad, status, and keyword
- Operation detail viewer

## Installation

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/LangSensei/swat-dashboard/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/LangSensei/swat-dashboard/main/install.ps1 | iex
```

After installation, run `swat-dashboard` to open the dashboard in your browser at [http://localhost:8370](http://localhost:8370).

### Uninstall

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/LangSensei/swat-dashboard/main/uninstall.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/LangSensei/swat-dashboard/main/uninstall.ps1 | iex
```

Use `--purge` to also remove the `~/.swat/bin/` directory if empty. Use `--yes` to skip the confirmation prompt.

## Prerequisites
- Go 1.24+ (for building from source)

## Build & Run

1. Build the application:
   ```bash
   go build -o swat-dashboard .
   ```

2. Run the application:
   ```bash
   ./swat-dashboard
   ```
   This will open your browser at [http://localhost:8370](http://localhost:8370).

   To customize the port, use the `PORT` environment variable:
   ```bash
   PORT=9090 ./swat-dashboard
   ```

## Architecture
The SWAT Dashboard features a Go backend with embedded static files. It serves a WebSocket-based PTY session utilizing `creack/pty` (Unix) and `conpty` (Windows) for real-time terminal interaction. Operation scanning is handled via the `swat/commander/operation` package.

## Tech Stack
- **Backend:** Go, `gorilla/websocket`, `creack/pty`, `conpty`
- **Frontend:** xterm.js
- **Integration:** `swat/commander/operation`
