#!/usr/bin/env bash
# =============================================================================
#  OXAX Relay — Instalador
#  Repositório: https://github.com/jeanfraga95/oxax
#
#  Uso:
#    curl -fsSL https://raw.githubusercontent.com/jeanfraga95/oxax/main/install.sh | bash
#  ou:
#    wget -qO- https://raw.githubusercontent.com/jeanfraga95/oxax/main/install.sh | bash
# =============================================================================

set -euo pipefail

# ── Cores ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

REPO="https://raw.githubusercontent.com/jeanfraga95/oxax/main"
INSTALL_DIR="/opt/oxax"
SERVICE_NAME="oxax"
NODE_MIN=18

# ── Funções de log ────────────────────────────────────────────────────────────
log()  { echo -e "${GREEN}[✔]${NC} $*"; }
info() { echo -e "${CYAN}[i]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✘]${NC} $*" >&2; }
die()  { err "$*"; exit 1; }

banner() {
  echo -e "${BOLD}${CYAN}"
  echo "  ██████╗ ██╗  ██╗ █████╗ ██╗  ██╗"
  echo " ██╔═══██╗╚██╗██╔╝██╔══██╗╚██╗██╔╝"
  echo " ██║   ██║ ╚███╔╝ ███████║ ╚███╔╝ "
  echo " ██║   ██║ ██╔██╗ ██╔══██║ ██╔██╗ "
  echo " ╚██████╔╝██╔╝ ██╗██║  ██║██╔╝ ██╗"
  echo "  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝"
  echo -e "   Relay — Links Fixos para OXAX.TV${NC}"
  echo ""
}

# ── Detecta sistema ───────────────────────────────────────────────────────────
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="${ID:-linux}"
    OS_LIKE="${ID_LIKE:-}"
  elif command -v uname &>/dev/null; then
    OS_ID="$(uname -s | tr '[:upper:]' '[:lower:]')"
    OS_LIKE=""
  else
    OS_ID="unknown"
    OS_LIKE=""
  fi
  info "Sistema detectado: ${OS_ID}"
}

# ── Verifica root / sudo ──────────────────────────────────────────────────────
check_root() {
  if [ "$EUID" -ne 0 ]; then
    if command -v sudo &>/dev/null; then
      SUDO="sudo"
      info "Usando sudo para operações privilegiadas"
    else
      die "Execute como root ou instale sudo"
    fi
  else
    SUDO=""
  fi
}

# ── Instala dependências do sistema ──────────────────────────────────────────
install_deps() {
  info "Verificando dependências do sistema..."

  # curl / wget
  if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
    warn "curl/wget não encontrado — instalando..."
    _pkg_install curl
  fi

  # git
  if ! command -v git &>/dev/null; then
    warn "git não encontrado — instalando..."
    _pkg_install git
  fi
}

_pkg_install() {
  local pkg="$1"
  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint)
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq "$pkg"
      ;;
    centos|rhel|fedora|rocky|almalinux)
      if command -v dnf &>/dev/null; then
        $SUDO dnf install -y "$pkg"
      else
        $SUDO yum install -y "$pkg"
      fi
      ;;
    arch|manjaro)
      $SUDO pacman -Sy --noconfirm "$pkg"
      ;;
    alpine)
      $SUDO apk add --no-cache "$pkg"
      ;;
    *)
      warn "Não foi possível instalar '$pkg' automaticamente. Instale manualmente e rode o script novamente."
      ;;
  esac
}

# ── Instala Node.js ───────────────────────────────────────────────────────────
install_node() {
  info "Verificando Node.js..."

  if command -v node &>/dev/null; then
    local ver
    ver=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
    if [ "$ver" -ge "$NODE_MIN" ]; then
      log "Node.js ${ver} já instalado"
      return
    fi
    warn "Node.js ${ver} encontrado, mas é necessário >= ${NODE_MIN}"
  fi

  info "Instalando Node.js ${NODE_MIN} via NodeSource..."

  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      $SUDO apt-get install -y -qq nodejs
      ;;
    centos|rhel|fedora|rocky|almalinux)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      if command -v dnf &>/dev/null; then
        $SUDO dnf install -y nodejs
      else
        $SUDO yum install -y nodejs
      fi
      ;;
    arch|manjaro)
      $SUDO pacman -Sy --noconfirm nodejs npm
      ;;
    alpine)
      $SUDO apk add --no-cache nodejs npm
      ;;
    *)
      die "Não foi possível instalar Node.js automaticamente.\nInstale manualmente: https://nodejs.org/en/download\nVersão mínima: ${NODE_MIN}"
      ;;
  esac

  log "Node.js $(node -v) instalado"
}

# ── Baixa os arquivos do projeto ──────────────────────────────────────────────
download_files() {
  info "Baixando arquivos do projeto em ${INSTALL_DIR}..."

  $SUDO mkdir -p "${INSTALL_DIR}"
  $SUDO chown "$(id -u):$(id -g)" "${INSTALL_DIR}"

  local files=(
    "server.js"
    "scraper.js"
    "package.json"
    "README.md"
  )

  for f in "${files[@]}"; do
    info "  → ${f}"
    if command -v curl &>/dev/null; then
      curl -fsSL "${REPO}/${f}" -o "${INSTALL_DIR}/${f}"
    else
      wget -qO "${INSTALL_DIR}/${f}" "${REPO}/${f}"
    fi
  done

  log "Arquivos baixados"
}

# ── Instala dependências npm ──────────────────────────────────────────────────
install_npm() {
  info "Instalando dependências npm..."
  cd "${INSTALL_DIR}"
  npm install --omit=dev --silent
  log "npm install concluído"
}

# ── Configura a porta ─────────────────────────────────────────────────────────
configure_port() {
  echo ""
  read -rp "$(echo -e "${CYAN}Porta do servidor${NC} [padrão: 3051]: ")" PORT_INPUT
  PORT_INPUT="${PORT_INPUT:-3051}"

  # Valida que é número
  if ! [[ "$PORT_INPUT" =~ ^[0-9]+$ ]] || [ "$PORT_INPUT" -lt 1 ] || [ "$PORT_INPUT" -gt 65535 ]; then
    warn "Porta inválida, usando 3051"
    PORT_INPUT=3051
  fi

  # Salva no .env
  echo "PORT=${PORT_INPUT}" > "${INSTALL_DIR}/.env"
  log "Porta configurada: ${PORT_INPUT}"
}

# ── Cria serviço systemd ──────────────────────────────────────────────────────
create_service() {
  if ! command -v systemctl &>/dev/null; then
    warn "systemd não disponível — o serviço não será criado automaticamente"
    warn "Para iniciar manualmente: cd ${INSTALL_DIR} && node server.js"
    return
  fi

  info "Criando serviço systemd (${SERVICE_NAME})..."

  local node_bin
  node_bin="$(command -v node)"

  $SUDO tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=OXAX Relay — Links Fixos para OXAX.TV
Documentation=https://github.com/jeanfraga95/oxax
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${INSTALL_DIR}/.env
ExecStart=${node_bin} server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Segurança básica
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable  "${SERVICE_NAME}" --now
  log "Serviço ${SERVICE_NAME} habilitado e iniciado"
}

# ── Cria atalho de linha de comando ──────────────────────────────────────────
create_cli() {
  $SUDO tee /usr/local/bin/oxax > /dev/null <<'EOCLI'
#!/usr/bin/env bash
# CLI helper para gerenciar o OXAX Relay
SERVICE="oxax"
INSTALL_DIR="/opt/oxax"

case "${1:-help}" in
  start)    sudo systemctl start   "$SERVICE" && echo "✅ Iniciado"     ;;
  stop)     sudo systemctl stop    "$SERVICE" && echo "🛑 Parado"       ;;
  restart)  sudo systemctl restart "$SERVICE" && echo "🔄 Reiniciado"   ;;
  status)   sudo systemctl status  "$SERVICE" --no-pager                ;;
  logs)     sudo journalctl -u "$SERVICE" -f                            ;;
  update)
    echo "🔄 Atualizando..."
    curl -fsSL https://raw.githubusercontent.com/jeanfraga95/oxax/main/install.sh | bash
    ;;
  scrape)
    cd "$INSTALL_DIR" && node scraper.js
    ;;
  *)
    echo "Uso: oxax {start|stop|restart|status|logs|update|scrape}"
    ;;
esac
EOCLI

  $SUDO chmod +x /usr/local/bin/oxax
  log "Comando 'oxax' disponível no terminal"
}

# ── Verifica se o servidor respondeu ─────────────────────────────────────────
health_check() {
  info "Aguardando servidor iniciar..."
  local port
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3051)
  local tries=0
  until curl -sf "http://localhost:${port}/" > /dev/null 2>&1; do
    sleep 1
    tries=$((tries+1))
    [ $tries -ge 15 ] && { warn "Health check falhou — verifique: oxax logs"; return; }
  done
  log "Servidor respondendo em http://localhost:${port}/"
}

# ── Resumo final ──────────────────────────────────────────────────────────────
summary() {
  local port
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3051)
  echo ""
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════${NC}"
  echo -e "${BOLD}  ✅  OXAX Relay instalado com sucesso!${NC}"
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════${NC}"
  echo ""
  echo -e "  🌐  Acesse:      ${CYAN}http://localhost:${port}/${NC}"
  echo -e "  📥  Playlist:    ${CYAN}http://localhost:${port}/playlist.m3u${NC}"
  echo -e "  📁  Instalado em: ${INSTALL_DIR}"
  echo ""
  echo -e "  ${BOLD}Comandos úteis:${NC}"
  echo -e "    oxax status    — ver status do serviço"
  echo -e "    oxax logs      — ver logs em tempo real"
  echo -e "    oxax restart   — reiniciar"
  echo -e "    oxax scrape    — descobrir novos canais"
  echo -e "    oxax update    — atualizar para versão mais recente"
  echo ""
  echo -e "  📖  Docs: ${CYAN}https://github.com/jeanfraga95/oxax${NC}"
  echo ""
}

# ── MAIN ──────────────────────────────────────────────────────────────────────
main() {
  banner
  detect_os
  check_root
  install_deps
  install_node
  download_files
  install_npm
  configure_port
  create_service
  create_cli
  health_check
  summary
}

main "$@"
