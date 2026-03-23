#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# nanobot-web: One-command installer
# Detects OS, installs Python 3.11+, Node.js 20+, sets up venv,
# installs all dependencies, builds frontend & bridge, and runs onboard.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/otman-ai/nanobot-web/main/install.sh | bash
#   # or after cloning:
#   chmod +x install.sh && ./install.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()    { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

# ── Detect OS ────────────────────────────────────────────────
detect_os() {
    OS="unknown"; DISTRO="unknown"; PKG_MGR="unknown"
    case "$(uname -s)" in
        Linux*)
            OS="linux"
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                DISTRO="${ID:-unknown}"
            elif [ -f /etc/debian_version ]; then
                DISTRO="debian"
            elif [ -f /etc/redhat-release ]; then
                DISTRO="rhel"
            fi
            case "$DISTRO" in
                ubuntu|debian|pop|linuxmint|elementary|zorin|kali)
                    PKG_MGR="apt" ;;
                fedora)
                    PKG_MGR="dnf" ;;
                centos|rhel|rocky|almalinux|ol)
                    if command -v dnf &>/dev/null; then PKG_MGR="dnf"
                    else PKG_MGR="yum"; fi ;;
                arch|manjaro|endeavouros)
                    PKG_MGR="pacman" ;;
                opensuse*|sles)
                    PKG_MGR="zypper" ;;
                alpine)
                    PKG_MGR="apk" ;;
                *)
                    warn "Unknown Linux distro: $DISTRO — will try to detect package manager"
                    for mgr in apt dnf yum pacman zypper apk; do
                        if command -v "$mgr" &>/dev/null; then PKG_MGR="$mgr"; break; fi
                    done ;;
            esac
            ;;
        Darwin*)
            OS="macos"; DISTRO="macos"; PKG_MGR="brew" ;;
        CYGWIN*|MINGW*|MSYS*)
            OS="windows"; DISTRO="windows"; PKG_MGR="winget" ;;
        *)
            error "Unsupported operating system: $(uname -s)" ;;
    esac
    info "Detected: OS=$OS  Distro=$DISTRO  Package Manager=$PKG_MGR"
}

# ── Helper: check if a command exists ────────────────────────
has() { command -v "$1" &>/dev/null; }

# ── Helper: version comparison (returns 0 if $1 >= $2) ──────
version_ge() {
    [ "$(printf '%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

# ── Get sudo command (empty if root) ─────────────────────────
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if has sudo; then
        SUDO="sudo"
    else
        warn "Not running as root and sudo not found — package installs may fail"
    fi
fi

# ── Install Python 3.11+ ────────────────────────────────────
install_python() {
    step "Checking Python"

    # Find best available python
    PYTHON_CMD=""
    for cmd in python3.12 python3.11 python3; do
        if has "$cmd"; then
            PY_VER="$($cmd --version 2>&1 | grep -oP '\d+\.\d+')"
            if version_ge "$PY_VER" "3.11"; then
                PYTHON_CMD="$cmd"
                success "Found $cmd (Python $PY_VER)"
                # On Debian/Ubuntu, always install the venv package proactively.
                # The system Python often ships without ensurepip, and detection
                # tricks (--help, test venv) are unreliable across distros.
                case "$PKG_MGR" in
                    apt)
                        if ! dpkg -s "python${PY_VER}-venv" &>/dev/null; then
                            info "Installing python${PY_VER}-venv..."
                            $SUDO apt-get update -qq
                            $SUDO apt-get install -y "python${PY_VER}-venv" 2>/dev/null \
                                || $SUDO apt-get install -y python3-venv \
                                || error "Failed to install python venv. Run: $SUDO apt install python${PY_VER}-venv"
                            success "venv module installed"
                        fi
                        ;;
                esac
                return
            fi
        fi
    done

    info "Python 3.11+ not found — installing..."
    case "$PKG_MGR" in
        apt)
            $SUDO apt-get update -qq
            # Try python3.12 first, fall back to python3.11, then default python3
            if apt-cache show python3.12 &>/dev/null 2>&1; then
                $SUDO apt-get install -y python3.12 python3.12-venv python3.12-dev python3-pip
                PYTHON_CMD="python3.12"
            elif apt-cache show python3.11 &>/dev/null 2>&1; then
                $SUDO apt-get install -y python3.11 python3.11-venv python3.11-dev python3-pip
                PYTHON_CMD="python3.11"
            else
                # Add deadsnakes PPA for older Ubuntu/Debian
                info "Adding deadsnakes PPA for Python 3.12..."
                $SUDO apt-get install -y software-properties-common
                $SUDO add-apt-repository -y ppa:deadsnakes/ppa
                $SUDO apt-get update -qq
                $SUDO apt-get install -y python3.12 python3.12-venv python3.12-dev python3-pip
                PYTHON_CMD="python3.12"
            fi
            ;;
        dnf)
            $SUDO dnf install -y python3.12 python3.12-devel python3-pip 2>/dev/null \
                || $SUDO dnf install -y python3.11 python3.11-devel python3-pip 2>/dev/null \
                || $SUDO dnf install -y python3 python3-devel python3-pip
            PYTHON_CMD="$(command -v python3.12 || command -v python3.11 || command -v python3)"
            ;;
        yum)
            $SUDO yum install -y python3 python3-devel python3-pip
            PYTHON_CMD="python3"
            ;;
        pacman)
            $SUDO pacman -Sy --noconfirm python python-pip
            PYTHON_CMD="python3"
            ;;
        zypper)
            $SUDO zypper install -y python312 python312-devel python3-pip 2>/dev/null \
                || $SUDO zypper install -y python311 python311-devel python3-pip 2>/dev/null \
                || $SUDO zypper install -y python3 python3-devel python3-pip
            PYTHON_CMD="$(command -v python3.12 || command -v python3.11 || command -v python3)"
            ;;
        apk)
            $SUDO apk add python3 python3-dev py3-pip
            PYTHON_CMD="python3"
            ;;
        brew)
            brew install python@3.12
            PYTHON_CMD="python3.12"
            ;;
        winget)
            winget install Python.Python.3.12 --accept-source-agreements --accept-package-agreements
            PYTHON_CMD="python3"
            ;;
        *)
            error "Cannot install Python — unsupported package manager: $PKG_MGR" ;;
    esac

    if ! has "$PYTHON_CMD"; then
        error "Python installation failed. Please install Python 3.11+ manually."
    fi
    PY_VER="$($PYTHON_CMD --version 2>&1 | grep -oP '\d+\.\d+')"
    if ! version_ge "$PY_VER" "3.11"; then
        error "Installed Python is $PY_VER but 3.11+ is required."
    fi
    success "Installed Python $PY_VER"
}

# ── Install Node.js 20+ ─────────────────────────────────────
install_node() {
    step "Checking Node.js"

    if has node; then
        NODE_VER="$(node --version | tr -d 'v')"
        NODE_MAJOR="${NODE_VER%%.*}"
        if [ "$NODE_MAJOR" -ge 20 ]; then
            success "Found Node.js v$NODE_VER"
            return
        fi
        warn "Node.js v$NODE_VER found but v20+ is required — upgrading..."
    else
        info "Node.js not found — installing..."
    fi

    case "$PKG_MGR" in
        apt)
            # Use NodeSource for guaranteed v20
            if ! has curl; then $SUDO apt-get install -y curl; fi
            curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
            $SUDO apt-get install -y nodejs
            ;;
        dnf|yum)
            if ! has curl; then $SUDO $PKG_MGR install -y curl; fi
            curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
            $SUDO $PKG_MGR install -y nodejs
            ;;
        pacman)
            $SUDO pacman -Sy --noconfirm nodejs npm
            ;;
        zypper)
            if ! has curl; then $SUDO zypper install -y curl; fi
            curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
            $SUDO zypper install -y nodejs
            ;;
        apk)
            $SUDO apk add nodejs npm
            ;;
        brew)
            brew install node@20
            brew link --overwrite node@20 2>/dev/null || true
            ;;
        winget)
            winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
            ;;
        *)
            # Fallback: use nvm
            info "Using nvm to install Node.js 20..."
            if ! has curl; then
                error "curl is required to install Node.js. Please install curl first."
            fi
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            export NVM_DIR="$HOME/.nvm"
            # shellcheck disable=SC1091
            [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
            nvm install 20
            nvm use 20
            ;;
    esac

    if ! has node; then
        error "Node.js installation failed. Please install Node.js 20+ manually."
    fi
    success "Installed Node.js $(node --version)"
}

# ── Install git (needed for clone) ──────────────────────────
install_git() {
    if has git; then return; fi
    step "Installing git"
    case "$PKG_MGR" in
        apt)    $SUDO apt-get update -qq && $SUDO apt-get install -y git ;;
        dnf)    $SUDO dnf install -y git ;;
        yum)    $SUDO yum install -y git ;;
        pacman) $SUDO pacman -Sy --noconfirm git ;;
        zypper) $SUDO zypper install -y git ;;
        apk)    $SUDO apk add git ;;
        brew)   brew install git ;;
        *)      error "Cannot install git — please install it manually" ;;
    esac
    success "Installed git"
}

# ── Clone or locate repo ────────────────────────────────────
setup_repo() {
    step "Setting up repository"

    # If we're already inside the repo (install.sh was run from the repo)
    if [ -f "pyproject.toml" ] && grep -q "nanobot-web" pyproject.toml 2>/dev/null; then
        REPO_DIR="$(pwd)"
        success "Already in nanobot-web repo: $REPO_DIR"
        return
    fi

    # If the script is being piped from curl, clone the repo
    REPO_DIR="${INSTALL_DIR:-$HOME/nanobot-web}"
    if [ -d "$REPO_DIR" ] && [ -f "$REPO_DIR/pyproject.toml" ]; then
        info "Found existing repo at $REPO_DIR — pulling latest..."
        cd "$REPO_DIR" && git pull --ff-only 2>/dev/null || true
    else
        info "Cloning nanobot-web into $REPO_DIR..."
        install_git
        git clone https://github.com/otman-ai/nanobot-web.git "$REPO_DIR"
    fi
    cd "$REPO_DIR"
    success "Repo ready at $REPO_DIR"
}

# ── Create Python venv & install packages ────────────────────
setup_python_env() {
    step "Setting up Python environment"

    VENV_DIR="$REPO_DIR/venv"
    if [ -d "$VENV_DIR" ] && [ -f "$VENV_DIR/bin/activate" ] && [ -f "$VENV_DIR/bin/pip" ]; then
        info "Existing venv found — reusing it"
    else
        # Remove broken/incomplete venv from a previous failed attempt
        [ -d "$VENV_DIR" ] && rm -rf "$VENV_DIR"
        info "Creating virtual environment..."
        $PYTHON_CMD -m venv "$VENV_DIR"
    fi

    # Activate venv
    # shellcheck disable=SC1091
    . "$VENV_DIR/bin/activate"
    success "Virtual environment activated"

    info "Upgrading pip..."
    pip install --upgrade pip --quiet

    info "Installing nanobot-web with all extras..."
    pip install -e ".[web,dev]" --quiet
    success "Python packages installed"
}

# ── Build frontend ───────────────────────────────────────────
build_frontend() {
    step "Building frontend"

    if [ ! -d "$REPO_DIR/frontend" ]; then
        warn "No frontend/ directory found — skipping frontend build"
        return
    fi

    cd "$REPO_DIR/frontend"
    info "Installing npm dependencies..."
    npm install --silent 2>&1 | tail -1
    info "Building frontend..."
    npm run build

    # Copy built frontend into the Python package for serving
    mkdir -p "$REPO_DIR/nanobot_web/frontend"
    if [ -d "$REPO_DIR/frontend/dist" ]; then
        cp -r "$REPO_DIR/frontend/dist" "$REPO_DIR/nanobot_web/frontend/"
        success "Frontend built and copied to nanobot_web/frontend/dist"
    else
        warn "Frontend build did not produce dist/ — check for errors above"
    fi
    cd "$REPO_DIR"
}

# ── Build WhatsApp bridge ───────────────────────────────────
build_bridge() {
    step "Building WhatsApp bridge"

    if [ ! -d "$REPO_DIR/bridge" ] || [ ! -f "$REPO_DIR/bridge/package.json" ]; then
        warn "No bridge/ directory found — skipping WhatsApp bridge build"
        return
    fi

    cd "$REPO_DIR/bridge"
    info "Installing bridge npm dependencies..."
    npm install --silent 2>&1 | tail -1
    info "Building bridge..."
    npm run build 2>/dev/null || warn "Bridge build had warnings (non-critical)"
    cd "$REPO_DIR"
    success "WhatsApp bridge built"
}

# ── Run onboard (wizard walks through setup, then auto-launches) ──
run_onboard() {
    step "Running onboard setup"

    # Activate venv again in case we're in a subshell
    # shellcheck disable=SC1091
    . "$REPO_DIR/venv/bin/activate"

    if has nanobot-web; then
        # The onboard command now includes the full wizard (model, channels,
        # Composio, etc.) and offers to auto-launch web+gateway at the end.
        nanobot-web onboard || warn "Onboard may have had issues"
    else
        warn "nanobot-web command not found in PATH — try: source $REPO_DIR/venv/bin/activate"
    fi
}

# ── Main ─────────────────────────────────────────────────────
main() {
    echo -e "${CYAN}"
    echo "  ╔═══════════════════════════════════════════════╗"
    echo "  ║       nanobot-web — One-Command Installer     ║"
    echo "  ╚═══════════════════════════════════════════════╝"
    echo -e "${NC}"

    detect_os
    install_python
    install_node
    setup_repo
    setup_python_env
    build_frontend
    build_bridge
    run_onboard
    # Onboard now handles the wizard and auto-launches web+gateway.
    # If onboard didn't launch (e.g. non-TTY), show fallback instructions.
    echo ""
    echo -e "  ${CYAN}To start manually:${NC}"
    echo -e "    source $REPO_DIR/venv/bin/activate"
    echo -e "    nanobot-web web"
    echo ""
}

main "$@"
