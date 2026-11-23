#!/bin/bash
# sendust playlist backend: ./run.sh [start|stop|restart|log]
cd "$(dirname "$0")"
mkdir -p logs
PIDF=logs/backend.pid
stop() { [ -f $PIDF ] && kill "$(cat $PIDF)" 2>/dev/null; rm -f $PIDF; sleep 0.5; }
start() { nohup .venv/bin/python -m backend.main >> logs/backend.log 2>&1 & echo $! > $PIDF; echo "started pid $(cat $PIDF)"; }
case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  log) tail -f logs/backend.log ;;
esac
