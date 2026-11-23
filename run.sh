#!/bin/bash
# sendust playlist backend: ./run.sh [start|stop|restart|log]
cd "$(dirname "$0")"
mkdir -p logs
PIDF=logs/backend.pid
stop() {
  [ -f $PIDF ] || return 0
  local pid; pid=$(cat $PIDF)
  kill "$pid" 2>/dev/null
  for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$pid" 2>/dev/null
  rm -f $PIDF
}
start() { nohup .venv/bin/python -m backend.main >> logs/backend.log 2>&1 & echo $! > $PIDF; echo "started pid $(cat $PIDF)"; }
case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  log) tail -f logs/backend.log ;;
esac
