#!/bin/bash

# macOS double-click launcher for o1key AI Generator (supports multi-instance)
# chmod +x this file if Terminal says permission denied

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Find Python runtime ──────────────────────────────────────────
PYTHON=""
if [ -f "$SCRIPT_DIR/app/venv/bin/python" ]; then
    PYTHON="$SCRIPT_DIR/app/venv/bin/python"
elif command -v python3 &> /dev/null; then
    PYTHON="python3"
elif command -v python &> /dev/null; then
    PYTHON="python"
else
    echo "ERROR: Python 3 not found!"
    echo "Please install Python 3.7+ or set up app/venv"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

# ── Find next available port starting from 8080 ──────────────────
PORT=8080
while nc -z 127.0.0.1 $PORT 2>/dev/null; do
    PORT=$((PORT + 1))
done

OUTDIR="$SCRIPT_DIR/output/$PORT"

echo "========================================"
echo "o1key ai generator - Port $PORT"
echo "========================================"
echo ""
echo "Starting server on port $PORT..."
echo "History dir: $OUTDIR"
echo ""

# ── Start server in background ───────────────────────────────────
"$PYTHON" "$SCRIPT_DIR/server.py" "$PORT" "$OUTDIR" &
SERVER_PID=$!

# ── Poll until server is ready, then open browser ────────────────
echo "Waiting for server..."
for i in $(seq 1 30); do
    if nc -z 127.0.0.1 $PORT 2>/dev/null; then
        break
    fi
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "ERROR: Server failed to start!"
        read -p "Press Enter to exit..."
        exit 1
    fi
    sleep 1
done

echo "Server ready, opening browser..."
open "http://localhost:$PORT/home.html"

echo ""
echo "Instance on port $PORT is running."
echo "Visit: http://localhost:$PORT/home.html"
echo "Close this window or press Ctrl+C to stop."
echo "========================================"
echo ""

# Keep window open; pressing Enter or Ctrl+C exits
read -p ""
