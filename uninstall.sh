#!/usr/bin/env bash
set -euo pipefail

# SWAT Dashboard Uninstaller
# Usage: curl -fsSL https://raw.githubusercontent.com/LangSensei/swat-dashboard/main/uninstall.sh | bash

BIN_DIR="$HOME/.swat/bin"

info()  { echo -e "\033[0;36m[swat-dashboard]\033[0m $*"; }
ok()    { echo -e "\033[0;32m[swat-dashboard]\033[0m $*"; }
warn()  { echo -e "\033[0;33m[swat-dashboard]\033[0m $*"; }
err()   { echo -e "\033[0;31m[swat-dashboard]\033[0m $*" >&2; }

echo ""
echo "  SWAT Dashboard Uninstaller"
echo "  ==========================="
echo ""

# --- Parse flags ---

PURGE=false
YES=false
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=true ;;
        --yes)   YES=true ;;
    esac
done

# --- Confirm ---

if ! $YES; then
    warn "This will remove:"
    echo "  - Binary:   $BIN_DIR/swat-dashboard"
    echo "  - Symlink:  $HOME/.local/bin/swat-dashboard"
    echo ""
    if $PURGE; then
        warn "--purge: will also remove $BIN_DIR/ if empty"
    fi
    echo ""
    read -r -p "Continue? [y/N] " confirm
    if [[ "$confirm" != [yY] ]]; then
        info "Aborted."
        exit 0
    fi
fi

# --- Remove binary ---

if [[ -f "$BIN_DIR/swat-dashboard" ]]; then
    rm -f "$BIN_DIR/swat-dashboard"
    ok "Removed $BIN_DIR/swat-dashboard"
else
    info "Binary not found at $BIN_DIR/swat-dashboard (skipped)"
fi

# --- Remove symlink ---

local_bin="$HOME/.local/bin/swat-dashboard"
if [[ -L "$local_bin" ]]; then
    rm -f "$local_bin"
    ok "Removed $local_bin"
fi

# --- Purge ---

if $PURGE; then
    # Remove BIN_DIR if empty
    if [[ -d "$BIN_DIR" ]] && [[ -z "$(ls -A "$BIN_DIR" 2>/dev/null)" ]]; then
        rmdir "$BIN_DIR"
        ok "Removed empty $BIN_DIR/"
    fi
fi

# --- Remove PATH entry from shell profiles ---

for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [[ -f "$rc" ]] && grep -q "# Added by SWAT Dashboard installer" "$rc" 2>/dev/null; then
        if sed --version &>/dev/null 2>&1; then
            sed -i '/# Added by SWAT Dashboard installer/{N;d;}' "$rc"
        else
            sed -i '' '/# Added by SWAT Dashboard installer/{N;d;}' "$rc"
        fi
        ok "Cleaned PATH from $(basename "$rc")"
    fi
done

echo ""
ok "SWAT Dashboard uninstalled."
echo ""
