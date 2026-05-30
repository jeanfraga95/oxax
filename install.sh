#!/usr/bin/env bash
# =============================================================================
#  OXAX Relay — Instalador v3
#  https://github.com/jeanfraga95/oxax
#
#  curl -fsSL https://raw.githubusercontent.com/jeanfraga95/oxax/main/install.sh | bash
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

REPO="https://raw.githubusercontent.com/jeanfraga95/oxax/main"
INSTALL_DIR="/opt/oxax"
SERVICE_NAME="oxax"
NODE_MIN=18

log()  { echo -e "${GREEN}[✔]${NC} $*"; }
info() { echo -e "${CYAN}[i]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✘]${NC} $*" >&2; exit 1; }

banner() {
  echo -e "${BOLD}${CYAN}"
  echo "  ██████╗ ██╗  ██╗ █████╗ ██╗  ██╗"
  echo " ██╔═══██╗╚██╗██╔╝██╔══██╗╚██╗██╔╝"
  echo " ██║   ██║ ╚███╔╝ ███████║ ╚███╔╝ "
  echo " ██║   ██║ ██╔██╗ ██╔══██║ ██╔██╗ "
  echo " ╚██████╔╝██╔╝ ██╗██║  ██║██╔╝ ██╗"
  echo "  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝"
  echo -e "   Relay v3 — Chromium Headless Proxy${NC}"
  echo ""
}

detect_os() {
  [ -f /etc/os-release ] && . /etc/os-release
  OS_ID="${ID:-linux}"
  info "Sistema: ${OS_ID}"
}

check_root() {
  if [ "$EUID" -ne 0 ]; then
    command -v sudo &>/dev/null && SUDO="sudo" || die "Execute como root ou instale sudo"
  else
    SUDO=""
  fi
}

_pkg() {
  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint)
      $SUDO apt-get install -y -qq "$@" ;;
    centos|rhel|fedora|rocky|almalinux)
      command -v dnf &>/dev/null && $SUDO dnf install -y "$@" || $SUDO yum install -y "$@" ;;
    arch|manjaro) $SUDO pacman -Sy --noconfirm "$@" ;;
    alpine)       $SUDO apk add --no-cache "$@" ;;
    *) warn "Instale manualmente: $*" ;;
  esac
}

install_deps() {
  info "Atualizando lista de pacotes..."
  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint) $SUDO apt-get update -qq ;;
    centos|rhel|fedora|rocky|almalinux)
      command -v dnf &>/dev/null && $SUDO dnf check-update -q || $SUDO yum check-update -q || true ;;
  esac

  command -v curl &>/dev/null || { info "Instalando curl..."; _pkg curl; }
}

install_node() {
  info "Verificando Node.js (>= ${NODE_MIN})..."
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
    if [ "$ver" -ge "$NODE_MIN" ]; then
      log "Node.js ${ver} OK"; return
    fi
    warn "Node.js ${ver} desatualizado — atualizando..."
  fi

  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      _pkg nodejs ;;
    centos|rhel|fedora|rocky|almalinux)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN}.x" | $SUDO bash -
      command -v dnf &>/dev/null && $SUDO dnf install -y nodejs || $SUDO yum install -y nodejs ;;
    arch|manjaro) _pkg nodejs npm ;;
    alpine)       _pkg nodejs npm ;;
    *) die "Instale Node.js >= ${NODE_MIN}: https://nodejs.org" ;;
  esac
  log "Node.js $(node -v) instalado"
}

install_chromium() {
  info "Verificando Chromium (necessário para bypass do bloqueio de VPS)..."

  # Verifica se já existe
  for p in /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium /usr/bin/google-chrome; do
    if [ -x "$p" ]; then
      log "Chromium encontrado: $p"; return
    fi
  done

  info "Instalando Chromium..."
  case "${OS_ID}" in
    ubuntu|debian|raspbian|linuxmint)
      # Tenta chromium (novo nome) e chromium-browser (nome antigo)
      $SUDO apt-get install -y -qq chromium 2>/dev/null || \
      $SUDO apt-get install -y -qq chromium-browser 2>/dev/null || \
      { warn "Chromium não disponível via apt — tentando snap..."; \
        $SUDO snap install chromium 2>/dev/null || \
        die "Não foi possível instalar Chromium. Instale manualmente: sudo apt install chromium"; }
      ;;
    centos|rhel|rocky|almalinux)
      $SUDO dnf install -y chromium 2>/dev/null || \
      $SUDO yum install -y chromium 2>/dev/null || \
      die "Instale chromium manualmente: sudo dnf install chromium"
      ;;
    fedora)
      $SUDO dnf install -y chromium ;;
    arch|manjaro)
      $SUDO pacman -Sy --noconfirm chromium ;;
    alpine)
      $SUDO apk add --no-cache chromium ;;
    *)
      warn "Não sei instalar Chromium em ${OS_ID}. Instale manualmente."
      ;;
  esac

  # Verifica instalação
  for p in /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
    if [ -x "$p" ]; then log "Chromium instalado: $p"; return; fi
  done
  die "Chromium não foi instalado corretamente"
}

download_files() {
  info "Baixando arquivos do projeto em ${INSTALL_DIR}..."
  $SUDO mkdir -p "${INSTALL_DIR}"
  $SUDO chown "$(id -u):$(id -g)" "${INSTALL_DIR}"

  for f in server.js scraper.js package.json README.md; do
    info "  → ${f}"
    curl -fsSL "${REPO}/${f}" -o "${INSTALL_DIR}/${f}"
  done
  log "Arquivos baixados"
}

install_npm() {
  info "Instalando dependências npm (inclui puppeteer-core)..."
  cd "${INSTALL_DIR}"
  # PUPPETEER_SKIP_DOWNLOAD=true evita baixar o Chromium do npm
  # (usamos o do sistema instalado via apt)
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_SKIP_DOWNLOAD=true \
  npm install --omit=dev --silent
  log "npm install concluído"
}

configure_port() {
  echo ""
  if [ -t 0 ]; then
    read -rp "$(echo -e "${CYAN}Porta do servidor${NC} [padrão: 3000]: ")" PORT_INPUT
  else
    PORT_INPUT=""
    warn "Modo não-interativo — porta padrão: 3000"
    warn "Mudar depois: echo 'PORT=XXXX' > ${INSTALL_DIR}/.env && oxax restart"
  fi
  PORT_INPUT="${PORT_INPUT:-3000}"
  [[ "$PORT_INPUT" =~ ^[0-9]+$ ]] && [ "$PORT_INPUT" -ge 1 ] && [ "$PORT_INPUT" -le 65535 ] \
    || { warn "Porta inválida, usando 3000"; PORT_INPUT=3000; }
  echo "PORT=${PORT_INPUT}" > "${INSTALL_DIR}/.env"
  log "Porta configurada: ${PORT_INPUT}"
}

open_firewall() {
  local port
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3000)
  info "Abrindo porta ${port} no firewall..."

  if command -v ufw &>/dev/null && $SUDO ufw status 2>/dev/null | grep -q "active"; then
    $SUDO ufw allow "${port}/tcp" > /dev/null 2>&1
    log "ufw: porta ${port}/tcp liberada"
  elif command -v firewall-cmd &>/dev/null && $SUDO firewall-cmd --state 2>/dev/null | grep -q "running"; then
    $SUDO firewall-cmd --permanent --add-port="${port}/tcp" > /dev/null 2>&1
    $SUDO firewall-cmd --reload > /dev/null 2>&1
    log "firewalld: porta ${port}/tcp liberada"
  elif command -v iptables &>/dev/null; then
    $SUDO iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT 2>/dev/null || \
      $SUDO iptables -I INPUT -p tcp --dport "${port}" -j ACCEPT
    log "iptables: porta ${port}/tcp liberada"
    command -v netfilter-persistent &>/dev/null && $SUDO netfilter-persistent save > /dev/null 2>&1 || true
  else
    warn "Firewall não detectado — verifique manualmente se a porta ${port} está aberta"
  fi
}

create_service() {
  command -v systemctl &>/dev/null || { warn "systemd não disponível. Inicie: cd ${INSTALL_DIR} && node server.js"; return; }

  info "Criando serviço systemd (${SERVICE_NAME})..."
  local node_bin run_user
  node_bin="$(command -v node)"
  run_user="$(id -un)"

  $SUDO tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=OXAX Relay — Chromium Headless Stream Proxy
Documentation=https://github.com/jeanfraga95/oxax
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${INSTALL_DIR}/.env
Environment=PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
Environment=PUPPETEER_SKIP_DOWNLOAD=true
ExecStart=${node_bin} server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "${SERVICE_NAME}"
  $SUDO systemctl restart "${SERVICE_NAME}"
  log "Serviço ${SERVICE_NAME} habilitado e iniciado"
}

create_cli() {
  $SUDO tee /usr/local/bin/oxax > /dev/null << 'EOCLI'
#!/usr/bin/env bash
SERVICE="oxax"
INSTALL_DIR="/opt/oxax"
case "${1:-help}" in
  start)   sudo systemctl start   "$SERVICE" && echo "✅ Iniciado" ;;
  stop)    sudo systemctl stop    "$SERVICE" && echo "🛑 Parado" ;;
  restart) sudo systemctl restart "$SERVICE" && echo "🔄 Reiniciado" ;;
  status)  sudo systemctl status  "$SERVICE" --no-pager ;;
  logs)    sudo journalctl -u "$SERVICE" -f ;;
  port)
    [[ "${2:-}" =~ ^[0-9]+$ ]] || { echo "Uso: oxax port <número>"; exit 1; }
    echo "PORT=${2}" | sudo tee "${INSTALL_DIR}/.env" > /dev/null
    command -v ufw &>/dev/null && sudo ufw status | grep -q active && sudo ufw allow "${2}/tcp" >/dev/null 2>&1 || true
    command -v firewall-cmd &>/dev/null && sudo firewall-cmd --permanent --add-port="${2}/tcp" >/dev/null 2>&1 && sudo firewall-cmd --reload >/dev/null 2>&1 || true
    sudo systemctl restart "$SERVICE"
    echo "✅ Porta alterada para ${2}"
    ;;
  update)
    echo "🔄 Atualizando..."
    curl -fsSL https://raw.githubusercontent.com/jeanfraga95/oxax/main/install.sh | bash
    ;;
  scrape)  cd "$INSTALL_DIR" && node scraper.js ;;
  help|*)
    echo ""
    echo "  oxax start           iniciar serviço"
    echo "  oxax stop            parar serviço"
    echo "  oxax restart         reiniciar"
    echo "  oxax status          status"
    echo "  oxax logs            logs em tempo real"
    echo "  oxax port <número>   mudar porta"
    echo "  oxax scrape          descobrir novos canais"
    echo "  oxax update          atualizar"
    echo ""
    ;;
esac
EOCLI
  $SUDO chmod +x /usr/local/bin/oxax
  log "Comando 'oxax' disponível"
}

health_check() {
  info "Aguardando servidor iniciar..."
  local port tries=0
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3000)
  until curl -sf "http://127.0.0.1:${port}/" > /dev/null 2>&1; do
    sleep 1; tries=$((tries+1))
    [ $tries -ge 20 ] && { warn "Servidor demorou para responder — verifique: oxax logs"; return; }
  done
  log "Servidor respondendo em http://127.0.0.1:${port}/"
}

summary() {
  local port ext_ip
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3000)
  ext_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "SEU_IP")

  echo ""
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  ✅  OXAX Relay v3 instalado com sucesso!${NC}"
  echo -e "${BOLD}${GREEN}════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  🌐  Local:       ${CYAN}http://localhost:${port}/${NC}"
  echo -e "  🌍  Rede:        ${CYAN}http://${ext_ip}:${port}/${NC}"
  echo -e "  📥  Playlist:    ${CYAN}http://${ext_ip}:${port}/playlist.m3u${NC}"
  echo ""
  echo -e "  ${YELLOW}⚡ Primeiro acesso a cada canal demora ~10s${NC}"
  echo -e "     (abre Chromium headless para extrair o stream)"
  echo -e "     Depois fica em cache por 25 minutos."
  echo ""
  echo -e "  ${BOLD}Comandos:${NC}  oxax status | logs | restart | update"
  echo ""
  echo -e "  ${YELLOW}⚠  Se a página não abrir externamente:${NC}"
  echo -e "     Libere a porta ${port}/TCP no painel do seu provedor"
  echo -e "     (Hetzner, DigitalOcean, Contabo, etc.)"
  echo ""
}

main() {
  banner
  detect_os
  check_root
  install_deps
  install_node
  install_chromium
  download_files
  install_npm
  configure_port
  open_firewall
  create_service
  create_cli
  health_check
  summary
}

main "$@"