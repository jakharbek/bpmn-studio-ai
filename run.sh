#!/usr/bin/env bash
# BPMN Studio — управление локальным запуском.
#
#   ./run.sh start          собрать сайт при необходимости и запустить в фоне
#   ./run.sh stop           остановить
#   ./run.sh restart        перезапустить (с пересборкой, если исходники менялись)
#   ./run.sh status         запущен ли, PID, адрес, время работы
#   ./run.sh logs [-f]      журнал сервера (-f — следить)
#   ./run.sh help           все команды и настройки
#
# Студия — статический сайт (dist/site): данных на сервере нет, схемы хранятся в браузере.
# Этот скрипт управляет только раздающим её веб-сервером (scripts/serve.mjs).

set -Eeuo pipefail
shopt -s nullglob

# ------------------------------------------------------------------ settings

# the project directory, also when run through a symlink (e.g. ~/bin/studio -> …/run.sh);
# a loop instead of "readlink -f", which older macOS does not have
self="${BASH_SOURCE[0]}"
while [[ -L "$self" ]]; do
  target="$(readlink -- "$self")"
  [[ "$target" == /* ]] || target="$(dirname -- "$self")/$target"
  self="$target"
done
ROOT="$(cd -- "$(dirname -- "$self")" && pwd -P)"
unset self target
# restart keeps the running instance's address unless PORT/HOST are given explicitly
PORT_SET="${PORT:+1}"
HOST_SET="${HOST:+1}"
PORT="${PORT:-3333}"
HOST="${HOST:-127.0.0.1}"
NODE="${NODE:-node}"
RUN_DIR="${BPMN_RUN_DIR:-$ROOT/.run}"
PID_FILE="$RUN_DIR/studio.pid"
META_FILE="$RUN_DIR/studio.env"
LOG_FILE="$RUN_DIR/studio.log"
LOCK_FILE="$RUN_DIR/run.lock"
LOCK_DIR="$RUN_DIR/run.lock.d"
SITE="$ROOT/dist/site"
SERVER="$ROOT/scripts/serve.mjs"
LOG_MAX_BYTES=$((10 * 1024 * 1024))   # rotate the log above 10 MB
START_TIMEOUT="${START_TIMEOUT:-15}"  # seconds to wait for the server to answer
STOP_TIMEOUT="${STOP_TIMEOUT:-10}"    # seconds before SIGKILL
NODE_MIN_MAJOR=22

# ------------------------------------------------------------------ output

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RED=$'\e[31m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_DIM=$'\e[2m' C_BOLD=$'\e[1m' C_OFF=$'\e[0m'
else
  C_RED='' C_GREEN='' C_YELLOW='' C_DIM='' C_BOLD='' C_OFF=''
fi
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$1" >&2; exit "${2:-1}"; }


# ------------------------------------------------------------------ helpers

validate_settings() {
  [[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "PORT должен быть числом 1–65535 (сейчас: $PORT)" 2
  [[ "$HOST" =~ ^[A-Za-z0-9.:_-]+$ ]] || die "Недопустимый HOST: $HOST" 2
}

check_node() {
  command -v "$NODE" >/dev/null 2>&1 || die "Не найден Node.js ($NODE). Нужен Node.js $NODE_MIN_MAJOR+: https://nodejs.org" 3
  local major
  major="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  (( major >= NODE_MIN_MAJOR )) || die "Нужен Node.js $NODE_MIN_MAJOR+, установлен $("$NODE" --version 2>/dev/null || echo '?')" 3
}

check_deps() {
  [[ -d "$ROOT/node_modules" && -d "$ROOT/web/legacy/node_modules" ]] ||
    die "Зависимости не установлены. Выполните: ./run.sh setup" 3
}

# Serialize start/stop/restart: two parallel "start" must not launch two servers.
# flock where available (Linux); elsewhere (macOS) an atomic mkdir, removed when this script exits.
LOCKED=''
take_lock() {
  [[ -z "$LOCKED" ]] || return 0
  mkdir -p "$RUN_DIR"
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    flock -w 30 9 || die "Другая команда run.sh всё ещё выполняется (блокировка $LOCK_FILE)"
  else
    local waited=0 holder
    until mkdir "$LOCK_DIR" 2>/dev/null; do
      holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
      # the holder is gone (killed run.sh): take over its stale lock
      if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$LOCK_DIR"; continue; fi
      (( waited++ < 150 )) || die "Другая команда run.sh всё ещё выполняется (блокировка $LOCK_DIR)"
      sleep 0.2
    done
    echo $$ >"$LOCK_DIR/pid"
    trap 'rm -rf "$LOCK_DIR"' EXIT
  fi
  LOCKED=1
}

# PID from the pid file, only if that process is really our server (pid reuse after a reboot/crash).
running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid cmd
  pid="$(<"$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [[ -r "/proc/$pid/cmdline" ]]; then
    cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
  else
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  fi
  # our server of this checkout on the recorded port, not any serve.mjs that happens to have this PID
  local port
  port="$(meta port)"
  [[ "$cmd" == *"$SERVER ${port:-}"* ]] || return 1
  printf '%s' "$pid"
}

# A value saved at start (port, host, started); empty if there is none.
meta() {
  [[ -f "$META_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$META_FILE" | head -n1
}

url_for() {
  local host="$1" port="$2"
  case "$host" in
    0.0.0.0|::) host=localhost ;;
    *:*) host="[$host]" ;;
  esac
  printf 'http://%s:%s/' "$host" "$port"
}

# Which process listens on a TCP port ("node pid=123"), for a helpful message; empty if unknown.
port_owner() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -Hltnp "sport = :$port" 2>/dev/null | grep -o 'users:(("[^"]*",pid=[0-9]*' | head -n1 |
      sed 's/users:(("//; s/",/ /' || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" pid="$2}' || true
  fi
}

port_in_use() {
  "$NODE" -e '
    const s = require("net").createServer();
    s.once("error", e => process.exit(e.code === "EADDRINUSE" ? 0 : 2));
    s.once("listening", () => s.close(() => process.exit(1)));
    s.listen(Number(process.argv[1]), process.argv[2]);
  ' "$1" "$2" >/dev/null 2>&1
}

http_ok() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    # --noproxy: a configured http_proxy must not intercept requests to this machine
    curl -fsS --noproxy '*' -o /dev/null --max-time 2 "$url" 2>/dev/null
  else
    "$NODE" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(2000) }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$url"
  fi
}

rotate_log() {
  [[ -f "$LOG_FILE" ]] || return 0
  local size
  size="$(wc -c <"$LOG_FILE" | tr -d ' ')"
  if (( size > LOG_MAX_BYTES )); then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
  fi
}

# Is the built site older than any of its sources?
site_outdated() {
  [[ -f "$SITE/index.html" && -f "$SITE/core.js" && -f "$SITE/legacy/modeler.js" ]] || return 0
  local newer
  # sources, build scripts and lock files (an "npm install" that changes dependencies touches them)
  newer="$(find "$ROOT/src" "$ROOT/web/public" "$ROOT/web/assistant" "$ROOT/web/legacy/src" "$ROOT/web/legacy/build.mjs" \
    "$ROOT/local-server" "$ROOT/scripts" "$ROOT/bpmn-studio.config.json" "$ROOT/bpmn-studio.config.public.json" \
    "$ROOT/package.json" "$ROOT/package-lock.json" \
    "$ROOT/web/legacy/package.json" "$ROOT/web/legacy/package-lock.json" \
    -path "$ROOT/web/public/legacy" -prune -o -type f -newer "$SITE/index.html" -print -quit 2>/dev/null || true)"
  [[ -n "$newer" ]]
}

human_duration() {
  local s="$1" d h m
  d=$((s / 86400)) h=$((s % 86400 / 3600)) m=$((s % 3600 / 60)) s=$((s % 60))
  if (( d > 0 )); then printf '%dд %dч %dм' "$d" "$h" "$m"
  elif (( h > 0 )); then printf '%dч %dм' "$h" "$m"
  elif (( m > 0 )); then printf '%dм %dс' "$m" "$s"
  else printf '%dс' "$s"; fi
}

# ------------------------------------------------------------------ commands

cmd_build() {
  check_node; check_deps
  info "Сборка сайта…"
  (cd "$ROOT" && npm run --silent build)
  ok "Сайт собран: $SITE"
}

ensure_built() {
  if [[ "${FORCE_BUILD:-0}" == 1 ]] || site_outdated; then
    cmd_build
  fi
}

cmd_start() {
  validate_settings; check_node
  take_lock
  local pid
  if pid="$(running_pid)"; then
    ok "Уже запущен (PID $pid): $(url_for "$(meta host)" "$(meta port)")"
    return 0
  fi
  rm -f "$PID_FILE" "$META_FILE"
  if [[ "${NO_BUILD:-0}" != 1 ]]; then
    check_deps
    ensure_built
  fi
  [[ -f "$SITE/index.html" ]] || die "Нет собранного сайта ($SITE). Выполните: ./run.sh build"

  if port_in_use "$PORT" "$HOST"; then
    local owner
    owner="$(port_owner "$PORT")"
    die "Порт $PORT уже занят${owner:+ ($owner)}. Остановите тот процесс или выберите другой: PORT=3334 ./run.sh start"
  fi

  rotate_log
  printf '\n=== %s start port=%s host=%s ===\n' "$(date '+%F %T')" "$PORT" "$HOST" >>"$LOG_FILE"
  # Detached from this terminal (setsid; nohup where there is none, e.g. macOS). "9>&-": the server
  # must not inherit the lock, or every later run.sh command would wait for it. The server writes
  # its own PID to $PID_FILE once it listens.
  local launcher=(nohup)
  command -v setsid >/dev/null 2>&1 && launcher=(setsid)
  (cd "$ROOT" && HOST="$HOST" STUDIO_PID_FILE="$PID_FILE" STUDIO_DETACHED=1 exec "${launcher[@]}" "$NODE" "$SERVER" "$PORT") \
    >>"$LOG_FILE" 2>&1 </dev/null 9>&- &
  local launched=$!
  printf 'port=%s\nhost=%s\nstarted=%s\n' "$PORT" "$HOST" "$(date +%s)" >"$META_FILE"

  local url deadline
  url="$(url_for "$HOST" "$PORT")"
  deadline=$((SECONDS + START_TIMEOUT))
  until pid="$(running_pid)" && http_ok "$url"; do
    if ! kill -0 "$launched" 2>/dev/null && ! running_pid >/dev/null; then
      rm -f "$PID_FILE" "$META_FILE"
      warn "Сервер завершился при запуске. Последние строки журнала:"
      tail -n 15 "$LOG_FILE" >&2
      die "Не удалось запустить"
    fi
    if (( SECONDS >= deadline )); then
      pid="$(running_pid || true)"
      kill "${pid:-$launched}" 2>/dev/null || true
      rm -f "$PID_FILE" "$META_FILE"
      tail -n 15 "$LOG_FILE" >&2
      die "Сервер не ответил за ${START_TIMEOUT} с"
    fi
    sleep 0.2
  done
  ok "BPMN Studio запущена (PID $pid): ${C_BOLD}${url}${C_OFF}"
  [[ "$HOST" == 127.0.0.1 || "$HOST" == localhost || "$HOST" == ::1 ]] ||
    warn "Студия доступна с других компьютеров ($HOST). Данных на сервере нет, но сайт видят все в сети."
}

cmd_stop() {
  take_lock
  local pid
  if ! pid="$(running_pid)"; then
    if [[ -f "$PID_FILE" ]]; then
      rm -f "$PID_FILE" "$META_FILE"
      warn "Процесс из $PID_FILE уже не работает — файл удалён"
    else
      info "Не запущен"
    fi
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  local deadline=$((SECONDS + STOP_TIMEOUT))
  while kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      warn "Не остановился за ${STOP_TIMEOUT} с — принудительно (SIGKILL)"
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 0.2
  done
  rm -f "$PID_FILE" "$META_FILE"
  printf '=== %s stopped ===\n' "$(date '+%F %T')" >>"$LOG_FILE"
  ok "Остановлен (PID $pid)"
}

cmd_restart() {
  # keep the address of the running instance unless PORT/HOST are given explicitly
  local was_port was_host
  was_port="$(meta port)"
  was_host="$(meta host)"
  if [[ -z "$PORT_SET" && -n "$was_port" ]]; then PORT="$was_port"; fi
  if [[ -z "$HOST_SET" && -n "$was_host" ]]; then HOST="$was_host"; fi
  validate_settings; check_node
  take_lock
  # moving to another address: make sure it is free before stopping the running instance
  if running_pid >/dev/null && [[ "$PORT" != "$was_port" || "$HOST" != "$was_host" ]] && port_in_use "$PORT" "$HOST"; then
    local owner
    owner="$(port_owner "$PORT")"
    die "Порт $PORT уже занят${owner:+ ($owner)}; работающий экземпляр не тронут"
  fi
  cmd_stop
  cmd_start
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then
    local port host started url
    port="$(meta port)" host="$(meta host)" started="$(meta started)"
    url="$(url_for "${host:-$HOST}" "${port:-$PORT}")"
    printf '%s●%s запущен\n' "$C_GREEN" "$C_OFF"
    printf '  PID:      %s\n' "$pid"
    printf '  Адрес:    %s\n' "$url"
    [[ -n "$started" ]] && printf '  Работает: %s\n' "$(human_duration $(( $(date +%s) - started )))"
    if http_ok "$url"; then printf '  Ответ:    %sOK%s\n' "$C_GREEN" "$C_OFF"
    else printf '  Ответ:    %sнет ответа%s\n' "$C_RED" "$C_OFF"; return 1; fi
    if site_outdated; then printf '  Сборка:   %sисходники изменены — выполните ./run.sh restart%s\n' "$C_YELLOW" "$C_OFF"
    else printf '  Сборка:   актуальна\n'; fi
    printf '  Журнал:   %s\n' "$LOG_FILE"
    return 0
  fi
  if [[ -f "$PID_FILE" ]]; then
    printf '%s●%s остановлен аварийно (остался %s)\n' "$C_RED" "$C_OFF" "$PID_FILE"
    return 1
  fi
  printf '%s○%s не запущен\n' "$C_DIM" "$C_OFF"
  return 3   # LSB: program is not running
}

cmd_logs() {
  [[ -f "$LOG_FILE" ]] || { info "Журнала пока нет ($LOG_FILE)"; return 0; }
  case "${1:-100}" in
    -f|--follow) tail -n 50 -F "$LOG_FILE" ;;
    *[!0-9]*|'') die "logs: укажите число строк или -f" 2 ;;
    *) tail -n "${1:-100}" "$LOG_FILE" ;;
  esac
}

cmd_open() {
  local pid url
  pid="$(running_pid)" || die "Не запущен. Сначала: ./run.sh start" 3
  url="$(url_for "$(meta host)" "$(meta port)")"
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$url"
  else info "$url"; return 0; fi
  ok "Открываю $url"
}

cmd_foreground() {
  validate_settings; check_node; check_deps
  ensure_built
  info "Запуск в этом терминале (Ctrl+C — остановить)…"
  cd "$ROOT" && HOST="$HOST" exec "$NODE" "$SERVER" "$PORT"
}

cmd_setup() {
  check_node
  command -v npm >/dev/null 2>&1 || die "Не найден npm" 3
  info "Установка зависимостей и сборка…"
  (cd "$ROOT" && npm run --silent setup)
  ok "Готово. Запуск: ./run.sh start"
}

cmd_test() {
  check_node; check_deps
  ensure_built
  (cd "$ROOT" && npm test)
}

cmd_doctor() {
  local bad=0
  check_item() { if eval "$2"; then ok "$1"; else warn "$1 — $3"; bad=1; fi; }
  check_item "Node.js $("$NODE" --version 2>/dev/null || echo 'не найден')" \
    '[[ "$("$NODE" -p "process.versions.node.split(\".\")[0]" 2>/dev/null || echo 0)" -ge $NODE_MIN_MAJOR ]]' "нужен $NODE_MIN_MAJOR+"
  check_item "npm" 'command -v npm >/dev/null' "не найден"
  check_item "Зависимости" '[[ -d "$ROOT/node_modules" && -d "$ROOT/web/legacy/node_modules" ]]' "выполните ./run.sh setup"
  check_item "Собранный сайт" '[[ -f "$SITE/index.html" ]]' "выполните ./run.sh build"
  check_item "Сборка актуальна" '! site_outdated' "выполните ./run.sh build (или restart)"
  local cfg="$ROOT/bpmn-studio.config.json"
  [[ -f "$cfg" ]] || cfg="$ROOT/bpmn-studio.config.public.json"
  check_item "Конфиг ${cfg##*/}" '"$NODE" -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"))" "$cfg" 2>/dev/null' "не читается как JSON"
  if running_pid >/dev/null; then ok "Сервер запущен: $(url_for "$(meta host)" "$(meta port)")"
  else info "  Сервер не запущен"; fi
  return "$bad"
}

cmd_help() {
  cat <<EOF
${C_BOLD}BPMN Studio — управление${C_OFF}

  ./run.sh ${C_BOLD}start${C_OFF}         запустить в фоне (собирает сайт, если исходники новее сборки)
  ./run.sh ${C_BOLD}stop${C_OFF}          остановить
  ./run.sh ${C_BOLD}restart${C_OFF}       перезапустить (на том же адресе)
  ./run.sh ${C_BOLD}status${C_OFF}        состояние: PID, адрес, время работы, актуальность сборки
  ./run.sh ${C_BOLD}logs${C_OFF} [N|-f]   последние N строк журнала (по умолчанию 100) или следить (-f)
  ./run.sh ${C_BOLD}open${C_OFF}          открыть студию в браузере
  ./run.sh ${C_BOLD}run${C_OFF}           запустить в этом терминале (без фона)
  ./run.sh ${C_BOLD}build${C_OFF}         собрать сайт (dist/site)
  ./run.sh ${C_BOLD}setup${C_OFF}         установить зависимости и собрать (первый запуск)
  ./run.sh ${C_BOLD}test${C_OFF}          прогнать тесты
  ./run.sh ${C_BOLD}doctor${C_OFF}        проверить окружение

Настройки (переменные окружения):
  PORT=3333            порт
  HOST=127.0.0.1       адрес; HOST=0.0.0.0 — доступ из локальной сети
  FORCE_BUILD=1        всегда пересобирать при start/restart
  NO_BUILD=1           не собирать при start (взять готовую dist/site)
  START_TIMEOUT=15     сколько секунд ждать ответа сервера
  STOP_TIMEOUT=10      сколько секунд ждать остановки до SIGKILL
  BPMN_RUN_DIR=.run    где хранить PID и журнал

Примеры:
  ./run.sh start
  PORT=8080 HOST=0.0.0.0 ./run.sh restart
  ./run.sh logs -f

Коды выхода status: 0 — работает, 1 — упал/не отвечает, 3 — не запущен.
Журнал: ${LOG_FILE#"$ROOT/"} (ротация при ${LOG_MAX_BYTES} байт).
EOF
}

# ------------------------------------------------------------------ main

main() {
  local cmd="${1:-help}"
  shift || true
  case "$cmd" in
    start)            cmd_start "$@" ;;
    stop)             cmd_stop "$@" ;;
    restart|reload)   cmd_restart "$@" ;;
    status)           cmd_status "$@" ;;
    logs|log)         cmd_logs "$@" ;;
    open)             cmd_open "$@" ;;
    run|fg|foreground) cmd_foreground "$@" ;;
    build)            cmd_build "$@" ;;
    setup|install)    cmd_setup "$@" ;;
    test)             cmd_test "$@" ;;
    doctor|check)     cmd_doctor "$@" ;;
    help|-h|--help)   cmd_help ;;
    *) warn "Неизвестная команда: $cmd"; cmd_help >&2; exit 2 ;;
  esac
}

main "$@"
