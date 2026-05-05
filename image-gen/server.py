#!/usr/bin/env python3
"""Banana 图片生成器 — 本地开发服务器
   服务静态文件 + API 持久化生成历史到 /history 目录
   用法: python server.py [port]   (默认 8080)
"""

import http.server
import json
import os
import base64
import re
import uuid
from urllib.parse import urlparse

HISTORY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history")
PORT = 8080

class BananaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.dirname(os.path.abspath(__file__)), **kwargs)

    def do_POST(self):
        if self.path == "/api/images":
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))

            os.makedirs(HISTORY_DIR, exist_ok=True)

            saved = []
            for item in body.get("images", []):
                # data:image/png;base64,iVBOR...
                data_url = item.get("url", "")
                match = re.match(r"data:(image/\w+);base64,(.+)", data_url)
                if not match:
                    continue
                mime, b64 = match.groups()
                ext = mime.split("/")[1]  # png, jpeg, etc.
                if ext == "jpeg":
                    ext = "jpg"

                filename = f"{uuid.uuid4().hex}.{ext}"
                filepath = os.path.join(HISTORY_DIR, filename)
                with open(filepath, "wb") as f:
                    f.write(base64.b64decode(b64))

                saved.append({
                    "filename": filename,
                    "prompt": item.get("prompt", ""),
                    "model": item.get("model", ""),
                    "resolution": item.get("resolution", ""),
                    "aspect": item.get("aspect", ""),
                })

            index_path = os.path.join(HISTORY_DIR, "index.json")
            existing = []
            if os.path.exists(index_path):
                with open(index_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
            existing = saved + existing
            with open(index_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)

            self._json({"ok": True, "saved": len(saved)})
        else:
            self._json({"error": "not found"}, 404)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/images":
            index_path = os.path.join(HISTORY_DIR, "index.json")
            if os.path.exists(index_path):
                with open(index_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            else:
                data = []
            self._json(data)
        elif parsed.path.startswith("/api/images/"):
            # 返回单张图片文件
            filename = os.path.basename(parsed.path)
            filepath = os.path.join(HISTORY_DIR, filename)
            if os.path.exists(filepath):
                self.send_response(200)
                ext = os.path.splitext(filename)[1].lower()
                ct = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
                self.send_header("Content-Type", ct.get(ext, "image/png"))
                self.end_headers()
                with open(filepath, "rb") as f:
                    self.wfile.write(f.read())
            else:
                self._json({"error": "not found"}, 404)
        else:
            super().do_GET()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/images/"):
            filename = os.path.basename(parsed.path)
            filepath = os.path.join(HISTORY_DIR, filename)
            if os.path.exists(filepath):
                os.remove(filepath)
            # 同时从 index 中移除
            index_path = os.path.join(HISTORY_DIR, "index.json")
            if os.path.exists(index_path):
                with open(index_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                data = [d for d in data if d.get("filename") != filename]
                with open(index_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
            self._json({"ok": True})
        else:
            self._json({"error": "not found"}, 404)

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        PORT = int(sys.argv[1])
    print(f"Banana 服务器启动: http://localhost:{PORT}/index.html")
    print(f"历史目录: {HISTORY_DIR}")
    http.server.HTTPServer(("0.0.0.0", PORT), BananaHandler).serve_forever()
