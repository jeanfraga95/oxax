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

# ── Cores ─────────────────────────────────────────────────────────────────────
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

# ── Funções de log ─────────────────────────────────────────────────────────────
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

# ── Detecta sistema ────────────────────────────────────────────────────────────
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

# ── Verifica root / sudo ───────────────────────────────────────────────────────
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

# ── Instala pacote genérico ────────────────────────────────────────────────────
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
      warn "Não foi possível instalar '$pkg' automaticamente."
      ;;
  esac
}

# ── Instala dependências do sistema ───────────────────────────────────────────
install_deps() {
  info "Verificando dependências do sistema..."
  if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
    warn "curl/wget não encontrado — instalando..."
    _pkg_install curl
  fi
}

# ── Instala Node.js ────────────────────────────────────────────────────────────
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
      die "Instale Node.js >= ${NODE_MIN} manualmente: https://nodejs.org/en/download"
      ;;
  esac

  log "Node.js $(node -v) instalado"
}

# ── Baixa os arquivos do projeto ───────────────────────────────────────────────
download_files() {
  info "Baixando arquivos do projeto em ${INSTALL_DIR}..."

  $SUDO mkdir -p "${INSTALL_DIR}"
  $SUDO chown "$(id -u):$(id -g)" "${INSTALL_DIR}"

  local files=("server.js" "scraper.js" "package.json" "README.md")

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

# ── Instala dependências npm ───────────────────────────────────────────────────
install_npm() {
  info "Instalando dependências npm..."
  cd "${INSTALL_DIR}"
  npm install --omit=dev --silent
  log "npm install concluído"
}

# ── Configura a porta ──────────────────────────────────────────────────────────
configure_port() {
  echo ""

  # Se vier via pipe (stdin não é terminal), usa padrão sem perguntar
  if [ -t 0 ]; then
    read -rp "$(echo -e "${CYAN}Porta do servidor${NC} [padrão: 3000]: ")" PORT_INPUT
  else
    PORT_INPUT=""
    warn "Instalação via pipe detectada — usando porta padrão 3000"
    warn "Para mudar depois: echo 'PORT=XXXX' > ${INSTALL_DIR}/.env && oxax restart"
  fi

  PORT_INPUT="${PORT_INPUT:-3000}"

  if ! [[ "$PORT_INPUT" =~ ^[0-9]+$ ]] || [ "$PORT_INPUT" -lt 1 ] || [ "$PORT_INPUT" -gt 65535 ]; then
    warn "Porta inválida, usando 3000"
    PORT_INPUT=3000
  fi

  echo "PORT=${PORT_INPUT}" > "${INSTALL_DIR}/.env"
  log "Porta configurada: ${PORT_INPUT}"
}

# ── Abre a porta no firewall ───────────────────────────────────────────────────
open_firewall() {
  local port
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3000)

  info "Verificando firewall para porta ${port}..."

  # ufw (Ubuntu/Debian)
  if command -v ufw &>/dev/null; then
    if $SUDO ufw status | grep -q "Status: active"; then
      $SUDO ufw allow "${port}/tcp" > /dev/null 2>&1 && \
        log "ufw: porta ${port}/tcp liberada"
    else
      info "ufw inativo — sem alterações"
    fi
    return
  fi

  # firewalld (CentOS/RHEL/Fedora)
  if command -v firewall-cmd &>/dev/null; then
    if $SUDO firewall-cmd --state 2>/dev/null | grep -q "running"; then
      $SUDO firewall-cmd --permanent --add-port="${port}/tcp" > /dev/null 2>&1
      $SUDO firewall-cmd --reload > /dev/null 2>&1
      log "firewalld: porta ${port}/tcp liberada"
    else
      info "firewalld inativo — sem alterações"
    fi
    return
  fi

  # iptables direto
  if command -v iptables &>/dev/null; then
    if ! $SUDO iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT 2>/dev/null; then
      $SUDO iptables -I INPUT -p tcp --dport "${port}" -j ACCEPT
      log "iptables: porta ${port}/tcp liberada"
      # Tenta persistir
      if command -v netfilter-persistent &>/dev/null; then
        $SUDO netfilter-persistent save > /dev/null 2>&1 || true
      elif command -v service &>/dev/null && $SUDO service iptables save &>/dev/null 2>&1; then
        true
      fi
    else
      log "iptables: porta ${port} já liberada"
    fi
    return
  fi

  warn "Nenhum firewall detectado — verifique manualmente se a porta ${port} está aberta"
}

# ── Cria serviço systemd ───────────────────────────────────────────────────────
create_service() {
  if ! command -v systemctl &>/dev/null; then
    warn "systemd não disponível"
    warn "Inicie manualmente: cd ${INSTALL_DIR} && node server.js"
    return
  fi

  info "Criando serviço systemd (${SERVICE_NAME})..."

  local node_bin
  node_bin="$(command -v node)"
  local run_user
  run_user="$(id -un)"

  $SUDO tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=OXAX Relay — Links Fixos para OXAX.TV
Documentation=https://github.com/jeanfraga95/oxax
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${INSTALL_DIR}/.env
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

# ── Cria atalho CLI ────────────────────────────────────────────────────────────
create_cli() {
  $SUDO tee /usr/local/bin/oxax > /dev/null <<'EOCLI'
#!/usr/bin/env bash
SERVICE="oxax"
INSTALL_DIR="/opt/oxax"

case "${1:-help}" in
  start)    sudo systemctl start   "$SERVICE" && echo "✅ Iniciado"   ;;
  stop)     sudo systemctl stop    "$SERVICE" && echo "🛑 Parado"     ;;
  restart)  sudo systemctl restart "$SERVICE" && echo "🔄 Reiniciado" ;;
  status)   sudo systemctl status  "$SERVICE" --no-pager              ;;
  logs)     sudo journalctl -u "$SERVICE" -f                          ;;
  port)
    PORT_NEW="${2:-}"
    if [[ "$PORT_NEW" =~ ^[0-9]+$ ]]; then
      echo "PORT=${PORT_NEW}" | sudo tee "${INSTALL_DIR}/.env" > /dev/null
      # Abre no firewall
      if command -v ufw &>/dev/null && sudo ufw status | grep -q "active"; then
        sudo ufw allow "${PORT_NEW}/tcp" > /dev/null 2>&1
      elif command -v firewall-cmd &>/dev/null; then
        sudo firewall-cmd --permanent --add-port="${PORT_NEW}/tcp" > /dev/null 2>&1
        sudo firewall-cmd --reload > /dev/null 2>&1
      fi
      sudo systemctl restart "$SERVICE"
      echo "✅ Porta alterada para ${PORT_NEW} e serviço reiniciado"
    else
      echo "Uso: oxax port <numero>"
    fi
    ;;
  update)
    echo "🔄 Atualizando..."
    curl -fsSL https://raw.githubusercontent.com/jeanfraga95/oxax/main/install.sh | bash
    ;;
  scrape)
    cd "$INSTALL_DIR" && node scraper.js
    ;;
  help|*)
    echo ""
    echo "  oxax start          — inicia o serviço"
    echo "  oxax stop           — para o serviço"
    echo "  oxax restart        — reinicia o serviço"
    echo "  oxax status         — exibe status"
    echo "  oxax logs           — logs em tempo real"
    echo "  oxax port <número>  — muda a porta e reinicia"
    echo "  oxax scrape         — descobre novos canais"
    echo "  oxax update         — atualiza para versão mais recente"
    echo ""
    ;;
esac
EOCLI

  $SUDO chmod +x /usr/local/bin/oxax
  log "Comando 'oxax' disponível no terminal"
}

# ── Health check ───────────────────────────────────────────────────────────────
health_check() {
  info "Aguardando servidor iniciar..."
  local port
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3000)
  local tries=0
  until curl -sf "http://127.0.0.1:${port}/" > /dev/null 2>&1; do
    sleep 1
    tries=$((tries+1))
    if [ $tries -ge 20 ]; then
      warn "Health check falhou. Veja os logs: oxax logs"
      return
    fi
  done
  log "Servidor respondendo em http://127.0.0.1:${port}/"
}

# ── Resumo final ───────────────────────────────────────────────────────────────
summary() {
  local port
  port=$(grep -oP 'PORT=\K\d+' "${INSTALL_DIR}/.env" 2>/dev/null || echo 3000)

  # Detecta IP externo
  local ext_ip
  ext_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "SEU_IP")

  echo ""
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  ✅  OXAX Relay instalado com sucesso!${NC}"
  echo -e "${BOLD}${GREEN}══════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  🌐  Local:       ${CYAN}http://localhost:${port}/${NC}"
  echo -e "  🌍  Rede:        ${CYAN}http://${ext_ip}:${port}/${NC}"
  echo -e "  📥  Playlist:    ${CYAN}http://${ext_ip}:${port}/playlist.m3u${NC}"
  echo -e "  📁  Diretório:   ${INSTALL_DIR}"
  echo ""
  echo -e "  ${BOLD}Alterar porta:${NC}  oxax port 3051"
  echo -e "  ${BOLD}Ver logs:${NC}       oxax logs"
  echo -e "  ${BOLD}Status:${NC}         oxax status"
  echo ""
  echo -e "  ${YELLOW}⚠  Se não acessar externamente, verifique:${NC}"
  echo -e "     1. Firewall do provedor/painel (Hetzner, DigitalOcean, etc.)"
  echo -e "        Libere a porta ${port}/TCP nas regras de entrada"
  echo -e "     2. ${CYAN}oxax logs${NC} para ver se há erros"
  echo ""
  echo -e "  📖  Docs: ${CYAN}https://github.com/jeanfraga95/oxax${NC}"
  echo ""
}

# ── MAIN ───────────────────────────────────────────────────────────────────────
main() {
  banner
  detect_os
  check_root
  install_deps
  install_node
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
