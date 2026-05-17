#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""o1key 图片生成器 — 本地开发服务器
   服务静态文件 + 代理请求到 o1key 异步 API + 持久化生成历史
   用法: python server.py [port]   (默认 8080)
"""

import sys
import io

# 强制使用 UTF-8 编码（解决 Windows GBK 编码问题）
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import http.server
from http.server import ThreadingHTTPServer
import json
import os
import sys
import base64
import re
import uuid
import time
import random
import threading
import requests
from urllib.parse import urlparse, parse_qs

APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
HISTORY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
THUMBS_DIR = os.path.join(HISTORY_DIR, "thumbs")
PORT = 8080
CONFIG_FILE = os.path.join(APP_DIR, "config.json")

# ---------- 路由 → 域名映射 ----------
ROUTE_DOMAINS = {
    "global": "https://api.o1key.cn",
    "cf": "https://cf-api.o1key.com",
    "us": "https://api.o1key.com",
}

# ---------- o1key API 配置 ----------
O1KEY_BASE = "https://api.o1key.cn"
O1KEY_API_KEY = os.environ.get("O1KEY_API_KEY", "")
_CONFIGURED = False  # 用户是否已通过 API 设置面板保存过 Key
O1KEY_DEBUG = os.environ.get("O1KEY_DEBUG", "") == "1"


def load_config():
    """从 config.json 加载配置，不存在则返回默认值"""
    global O1KEY_BASE, O1KEY_API_KEY, _CONFIGURED
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            route = cfg.get("route", "global")
            O1KEY_BASE = ROUTE_DOMAINS.get(route, ROUTE_DOMAINS["global"])
            if cfg.get("api_key"):
                O1KEY_API_KEY = cfg["api_key"]
                _CONFIGURED = True
            print(f"[CONFIG] 已加载: route={route}, base={O1KEY_BASE}, configured={_CONFIGURED}, key={'***' + O1KEY_API_KEY[-8:] if O1KEY_API_KEY else 'EMPTY'}")
        except Exception as e:
            print(f"[CONFIG] 加载失败: {e}，使用默认配置")
    else:
        print("[CONFIG] config.json 不存在，使用默认/环境变量配置")


def save_config(route, api_key):
    """保存配置到 config.json"""
    global O1KEY_BASE, O1KEY_API_KEY, _CONFIGURED
    cfg = {"route": route, "api_key": api_key}
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    O1KEY_BASE = ROUTE_DOMAINS.get(route, ROUTE_DOMAINS["global"])
    O1KEY_API_KEY = api_key
    _CONFIGURED = True
    print(f"[CONFIG] 已保存并应用: route={route}, base={O1KEY_BASE}")


# 启动时加载配置
load_config()


def current_route():
    """返回当前线路 ID"""
    for k, v in ROUTE_DOMAINS.items():
        if v == O1KEY_BASE:
            return k
    return "global"

# 轮询策略
FIRST_POLL_DELAY = 20   # 提交后首次轮询等待 (秒)
POLL_INTERVAL = 5       # 后续轮询间隔 (秒)
GEN_TIMEOUT = 600       # 总超时 (秒)

# base64 图片直接传递阈值 (10MB)，超过则上传 R2
B64_DIRECT_THRESHOLD = 10 * 1024 * 1024
# 图片压缩阈值 (20MB)，超过则先压缩再上传
COMPRESS_THRESHOLD = 20 * 1024 * 1024

# ---------- 取消机制 ----------
# 全局任务注册表: request_id → {"cancel_event": threading.Event, "status": "RUNNING"|"CANCELLED"|"DONE"}
ACTIVE_TASKS = {}
ACTIVE_TASKS_LOCK = threading.Lock()

# ---------- 按量计费模型映射 ----------
PER_USE_MODELS = {
    "nano-banana-pro": "gemini-3-pro-image-preview",
    "nano-banana-2": "gemini-3.1-flash-image-preview",
    "nano-banana": "nano-banana",
    "gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image-preview",
}


def get_per_use_model(gemini_model):
    """按量计费：返回 Gemini 原始模型名，不拼接分辨率"""
    return PER_USE_MODELS.get(gemini_model, gemini_model)


def get_o1key_model(gemini_model, image_size):
    """根据模型名 + 分辨率动态构造 o1key 完整模型名

       Pro (nano-banana-pro / gemini-3-pro-image-preview):
         1K      → nano-banana-pro
         2K      → nano-banana-pro-2k
         4K      → nano-banana-pro-4k

       v2  (nano-banana-2 / gemini-3.1-flash-image-preview):
         0.5K    → nano-banana-2-0.5k
         1K      → nano-banana-2-1k
         2K      → nano-banana-2-2k
         4K      → nano-banana-2-4k
    """
    # nano-banana (无后缀): 直接返回，不拼分辨率
    if gemini_model == 'nano-banana':
        return 'nano-banana'

    if image_size == '512':
        size_suffix = '0.5k'
    else:
        size_suffix = image_size.lower()

    # v2 系列: nano-banana-2 或旧名 gemini-*flash*
    if 'flash' in gemini_model or 'banana-2' in gemini_model:
        return f'nano-banana-2-{size_suffix}'
    # Pro 系列: nano-banana-pro 或旧名 gemini-3-pro
    if image_size in ('2K', '4K'):
        return f'nano-banana-pro-{size_suffix}'
    return 'nano-banana-pro'


def to_api_size(image_size):
    """分辨率 → API size 参数: 直接传递 1K/2K/4K，0.5K 转为 512"""
    if image_size == '512':
        return '512'
    if image_size in ('1K', '2K', '4K'):
        return image_size
    return '1K'  # 默认值


# ---------- o1key API 工具函数 ----------

def _calc_retry_delay(resp, attempt):
    """计算 429 重试等待秒数。
    优先使用响应中的 Retry-After 头，否则使用指数退让 + 随机抖动。
    """
    retry_after = resp.headers.get("Retry-After")
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass

    base = 1.0 * (2 ** (attempt - 1))
    jitter = base * 0.25 * (2 * random.random() - 1)
    return max(0.5, base + jitter)


RETRY_MAX = 5  # 429 最大重试次数


def o1key_request(method, url, body=None, timeout=30):
    """调用 o1key API，返回 (status_code, data)。429 自动指数退让重试。"""
    headers = {
        "Authorization": f"Bearer {O1KEY_API_KEY}",
        "Content-Type": "application/json",
    }

    for attempt in range(RETRY_MAX + 1):
        try:
            if method == "GET":
                resp = requests.get(url, headers=headers, timeout=timeout)
            elif method == "POST":
                resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            else:
                resp = requests.request(method, url, headers=headers, json=body, timeout=timeout)
        except requests.exceptions.RequestException as e:
            return 0, {"error": str(e)}

        if resp.status_code != 429:
            try:
                return resp.status_code, resp.json()
            except ValueError:
                return resp.status_code, resp.text

        if attempt >= RETRY_MAX:
            try:
                return resp.status_code, resp.json()
            except ValueError:
                return resp.status_code, resp.text

        delay = _calc_retry_delay(resp, attempt + 1)
        print(f"[RETRY] 429 Too Many Requests, 第 {attempt + 1}/{RETRY_MAX} 次重试, 等待 {delay:.1f}s")
        time.sleep(delay)

    return 0, {"error": "max retries exceeded"}


def truncate_base64(obj, max_len=40):
    """递归截断 base64 字符串，避免日志被撑满"""
    if isinstance(obj, str):
        if len(obj) > 200 and re.match(r'^[A-Za-z0-9+/=]{100,}$', obj):
            return f"[base64, {len(obj)} chars]"
        return obj if len(obj) <= max_len else obj[:max_len] + f"…[{len(obj)}]"
    if isinstance(obj, list):
        return [truncate_base64(v, max_len) for v in obj]
    if isinstance(obj, dict):
        return {k: truncate_base64(v, max_len) for k, v in obj.items()}
    return obj


def compress_image_to_target(img_bytes, mime_type, target_size):
    """缩放图片到目标大小（等比缩放，保留原格式画质）"""
    try:
        from PIL import Image
        import io

        img = Image.open(io.BytesIO(img_bytes))
        original_size = len(img_bytes)

        # 计算缩放比例
        scale = (target_size / original_size) ** 0.5
        new_width = int(img.width * scale)
        new_height = int(img.height * scale)

        img_resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

        # 保留原格式，不降低画质
        output = io.BytesIO()
        fmt = img.format or 'PNG'
        save_kwargs = {'format': fmt}
        if fmt == 'JPEG':
            save_kwargs['quality'] = 100
            save_kwargs['subsampling'] = 0
        img_resized.save(output, **save_kwargs)
        resized_bytes = output.getvalue()

        print(f"[COMPRESS] {original_size/1024/1024:.1f}MB → {len(resized_bytes)/1024/1024:.1f}MB (scale={scale:.2f}, format={fmt})")
        return resized_bytes, mime_type
    except ImportError:
        print("[COMPRESS] PIL未安装，跳过压缩")
        return img_bytes, mime_type
    except Exception as e:
        print(f"[COMPRESS] 缩放失败: {e}")
        return img_bytes, mime_type


def upload_to_r2(b64_data, mime_type):
    """上传 base64 图片到 R2 存储，返回 public_url
       如果图片 >20MB，先压缩到20MB内再上传
    """
    img_bytes = base64.b64decode(b64_data)
    original_size = len(img_bytes)

    # 如果超过20MB，先压缩
    if original_size > COMPRESS_THRESHOLD:
        print(f"[UPLOAD] 图片 {original_size/1024/1024:.1f}MB 超过20MB，开始压缩...")
        img_bytes, mime_type = compress_image_to_target(img_bytes, mime_type, COMPRESS_THRESHOLD)

    ext = mime_type.split('/')[-1] if '/' in mime_type else 'png'
    if ext == 'jpeg':
        ext = 'jpg'
    filename = f"{uuid.uuid4().hex}.{ext}"

    # 1. 获取预签名上传 URL
    status, presign = o1key_request(
        "POST",
        f"{O1KEY_BASE}/v1/storage/presign",
        {"filename": filename, "content_type": mime_type, "size": len(img_bytes)}
    )
    if status != 200:
        err = presign if isinstance(presign, str) else json.dumps(presign, ensure_ascii=False)
        raise Exception(f"获取上传 URL 失败 [{status}]: {err}")

    upload_url = presign.get("upload_url")
    public_url = presign.get("public_url")
    if not upload_url or not public_url:
        raise Exception(f"presign 响应缺少 upload_url/public_url: {presign}")

    # 2. PUT 上传文件
    try:
        put_resp = requests.put(upload_url, data=img_bytes,
                                headers={"Content-Type": mime_type}, timeout=60)
        if put_resp.status_code not in (200, 201, 204):
            raise Exception(f"上传失败 [{put_resp.status_code}]: {put_resp.text[:200]}")
    except requests.exceptions.RequestException as e:
        raise Exception(f"上传文件网络错误: {e}")

    print(f"[UPLOAD] R2 上传成功: {public_url}")
    return public_url


def poll_task(task_id, deadline, cancel_event=None):
    """轮询 o1key 异步任务：先等 FIRST_POLL_DELAY，之后每 POLL_INTERVAL 查一次
       若 cancel_event 被设置，立即返回 CANCELLED 状态
    """
    # 提交后等待首次轮询 (分段等待以便及时响应取消)
    first_poll = time.time() + FIRST_POLL_DELAY
    while time.time() < first_poll:
        time.sleep(1)
        if cancel_event and cancel_event.is_set():
            print(f"[POLL] {task_id} → CANCELLED (初始等待期间)")
            return {"status": "CANCELLED", "error": "用户取消"}

    while time.time() < deadline:
        if cancel_event and cancel_event.is_set():
            print(f"[POLL] {task_id} → CANCELLED")
            return {"status": "CANCELLED", "error": "用户取消"}

        status, result = o1key_request(
            "GET",
            f"{O1KEY_BASE}/async/v1/tasks/{task_id}"
        )

        if status != 200:
            time.sleep(POLL_INTERVAL)
            continue

        task_status = result.get("status")

        if task_status == "SUCCESS":
            print(f"[POLL] {task_id} → SUCCESS")
            return result
        if task_status == "FAILURE":
            print(f"[POLL] {task_id} → FAILURE: {result.get('error', '未知')}")
            return result

        progress = result.get("progress", "?")
        print(f"[POLL] {task_id} → {task_status} ({progress}) 等待 {POLL_INTERVAL}s")

        # 分段等待以便及时响应取消
        waited = 0
        while waited < POLL_INTERVAL:
            time.sleep(1)
            waited += 1
            if cancel_event and cancel_event.is_set():
                print(f"[POLL] {task_id} → CANCELLED (轮询期间)")
                return {"status": "CANCELLED", "error": "用户取消"}

    return {"status": "FAILURE", "error": "任务超时 (600s)"}


class BananaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def do_POST(self):
        if self.path == "/api/generate":
            self._handle_generate_sync()
        elif self.path == "/api/generate/gpt-image":
            self._handle_generate_gpt_image()
        elif self.path == "/api/generate/gpt-image-edit":
            self._handle_generate_gpt_image_edit()
        elif self.path == "/api/generate/async":
            self._handle_generate_async()
        elif self.path == "/api/cancel":
            self._handle_cancel()
        elif self.path == "/api/images":
            self._save_images()
        elif self.path == "/api/config/test":
            self._handle_config_test()
        elif self.path == "/api/config/save":
            self._handle_config_save()
        elif self.path == "/api/config/clear":
            self._handle_config_clear()
        else:
            self._json({"error": "not found"}, 404)

    # ---------- 图片生成 (OpenAI Chat Completions API) ----------
    def _handle_generate_sync(self):
        """代理图片生成请求到 o1key /v1/chat/completions（OpenAI 兼容格式）"""
        try:
            self._handle_generate_sync_inner()
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self._json({"error": {"message": f"服务器内部错误: {e}"}}, 500)
            except Exception:
                pass

    def _parse_ref_images(self, body):
        """从请求体中提取参考图列表，统一返回 [{"mimeType": ..., "data": ...}] 或 [{"url": ...}]"""
        refs = []
        if body.get("image"):
            img_url = body["image"]
            if img_url.startswith("data:"):
                m = re.match(r'data:(.*?);base64,(.*)', img_url)
                if m:
                    refs.append({"mimeType": m.group(1), "data": m.group(2)})
            else:
                refs.append({"url": img_url})
        elif body.get("images"):
            for img_url in body["images"]:
                if img_url.startswith("data:"):
                    m = re.match(r'data:(.*?);base64,(.*)', img_url)
                    if m:
                        refs.append({"mimeType": m.group(1), "data": m.group(2)})
                else:
                    refs.append({"url": img_url})
        return refs

    def _resolve_ref_url(self, img):
        """将参考图解析为 (url, mime_type)，必要时上传到 R2"""
        if img.get("url"):
            url = img["url"]
            if url.startswith("/api/images/"):
                local_path = os.path.join(HISTORY_DIR, url.split("/")[-1])
                print(f"[REF] 本地图片: {local_path}")
                with open(local_path, "rb") as f:
                    img_bytes = f.read()
                if local_path.endswith('.webp'):
                    mime = 'image/webp'
                elif local_path.endswith('.png'):
                    mime = 'image/png'
                elif local_path.endswith('.jpg') or local_path.endswith('.jpeg'):
                    mime = 'image/jpeg'
                else:
                    mime = 'image/png'
                b64 = base64.b64encode(img_bytes).decode('utf-8')
                print(f"[REF] 上传本地图片到 R2: {len(img_bytes)/1024/1024:.1f}MB")
                return upload_to_r2(b64, mime), mime
            else:
                print(f"[REF] 使用外部 URL: {url[:80]}...")
                return url, "image/png"
        else:
            b64 = img.get("data", "")
            mime = img.get("mimeType", "image/png")
            byte_size = len(b64) * 3 // 4
            print(f"[REF] 上传 base64 图片到 R2: {byte_size/1024/1024:.1f}MB")
            return upload_to_r2(b64, mime), mime

    def _process_contents_images(self, contents):
        """处理 Gemini 原生格式 contents 中的图片引用（当前为透传模式，不做上传转换）
           后续如需启用 R2 上传，在此处恢复 inlineData→fileData 的转换逻辑。
        """
        pass  # 停用 R2 上传，全部原样透传

    def _handle_generate_sync_inner(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception:
            self._json({"error": {"message": "请求体解析失败"}}, 400)
            return

        gemini_model = body.get("model", "gemini-3-pro-image-preview")
        contents = body.get("contents")
        generation_config = body.get("generationConfig")

        # 旧格式兼容：前端发的是 prompt/asspect_ratio/size，没有 contents
        if not contents and body.get("prompt"):
            prompt = body["prompt"]
            aspect_ratio = body.get("aspect_ratio") or "1:1"
            image_size = body.get("size") or "1K"

            parts = [{"text": prompt}]
            for img in self._parse_ref_images(body):
                if img.get("url"):
                    parts.append({"fileData": {"mimeType": "image/png", "fileUri": img["url"]}})
                else:
                    parts.append({"inlineData": {"mimeType": img.get("mimeType", "image/png"), "data": img.get("data", "")}})

            contents = [{"role": "user", "parts": parts}]
            generation_config = {
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {"aspectRatio": aspect_ratio, "imageSize": image_size},
            }

            print(f"\n[GENERATE-SYNC] (旧格式兼容) prompt={prompt[:80]!r} model={gemini_model} aspect={aspect_ratio} size={image_size}")
        else:
            # 新格式：前端发 Gemini 原生格式，后端转换为 OpenAI Chat Completions 格式
            if not contents:
                self._json({"error": {"message": "缺少 prompt 或 contents"}}, 400)
                return

            image_config = (generation_config or {}).get("imageConfig", {})
            aspect_ratio = image_config.get("aspectRatio", "1:1")
            image_size = image_config.get("imageSize", "1K")

            # 统计 prompt 长度用于日志
            prompt_preview = ""
            for c in contents:
                for p in (c.get("parts") or []):
                    if p.get("text"):
                        prompt_preview = p["text"][:80]
                        break

            print(f"\n[GENERATE-SYNC] prompt={prompt_preview!r} model={gemini_model} aspect={aspect_ratio} size={image_size}")

        # 构建 OpenAI Chat Completions 格式请求体
        # 将 Gemini 原生 contents 转为 messages
        messages = []
        for c in contents:
            role = c.get("role", "user")
            parts = c.get("parts", [])
            has_images = any("inlineData" in p or "fileData" in p for p in parts)
            if has_images:
                content = []
                for p in parts:
                    if "text" in p:
                        content.append({"type": "text", "text": p["text"]})
                    elif "inlineData" in p:
                        mime = p["inlineData"].get("mimeType", "image/png")
                        data = p["inlineData"].get("data", "")
                        content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
                    elif "fileData" in p:
                        uri = p["fileData"].get("fileUri", "")
                        content.append({"type": "image_url", "image_url": {"url": uri}})
            else:
                content = " ".join(p.get("text", "") for p in parts)
            messages.append({"role": role, "content": content})

        # 构建 extra_body.google
        google_extra = {}
        image_config = (generation_config or {}).get("imageConfig", {})
        if image_config:
            google_extra["image_config"] = {
                "aspect_ratio": image_config.get("aspectRatio", "1:1"),
                "image_size": image_config.get("imageSize", "1K"),
            }
        thinking_config = (generation_config or {}).get("thinkingConfig")
        if thinking_config:
            google_extra["thinking_config"] = {
                "thinking_level": thinking_config.get("thinkingLevel", "low"),
                "include_thoughts": thinking_config.get("includeThoughts", True),
            }
        tools = body.get("tools")
        if tools:
            google_extra["tools"] = tools

        billing = body.get("billing", "per-image")
        if billing == "per-use":
            chat_model = get_per_use_model(gemini_model)
        else:
            chat_model = get_o1key_model(gemini_model, image_size)

        req_body = {
            "model": chat_model,
            "stream": True,
            "messages": messages,
        }
        if google_extra:
            req_body["extra_body"] = {"google": google_extra}

        sync_url = f"{O1KEY_BASE}/v1/chat/completions"

        print(f"[GENERATE-SYNC] POST (OpenAI chat) billing={billing} {sync_url}")
        print(f"[GENERATE-SYNC] req_body: {json.dumps(truncate_base64(req_body), ensure_ascii=False)}")
        tc = (generation_config or {}).get("thinkingConfig")
        if tc:
            print(f"[GENERATE-SYNC] thinkingConfig: {json.dumps(tc, ensure_ascii=False)}")

        # 发送请求 (不用 stream=True，避免中间代理 idle timeout 切断连接)
        headers = {
            "Authorization": f"Bearer {O1KEY_API_KEY}",
            "Content-Type": "application/json",
        }

        resp = None
        for attempt in range(RETRY_MAX + 1):
            try:
                resp = requests.post(sync_url, headers=headers, json=req_body,
                                    timeout=GEN_TIMEOUT)
            except requests.exceptions.RequestException as e:
                print(f"[ERROR] 请求失败: {e}")
                self._json({"error": {"message": f"API 请求失败: {e}"}}, 500)
                return

            if resp.status_code == 429 and attempt < RETRY_MAX:
                delay = _calc_retry_delay(resp, attempt + 1)
                print(f"[RETRY] 429 Too Many Requests, 第 {attempt + 1}/{RETRY_MAX} 次重试, 等待 {delay:.1f}s")
                time.sleep(delay)
                continue

            break

        if resp.status_code != 200:
            err_text = resp.text[:500]
            print(f"[ERROR] 请求失败 [{resp.status_code}]: {err_text}")
            if resp.status_code == 503:
                self._json({"error": {"message": "模型暂不可用，请稍后重试或检查分组"}}, resp.status_code)
            else:
                self._json({"error": {"message": f"API 错误 [{resp.status_code}]: {err_text}"}}, resp.status_code)
            return

        # 解析 OpenAI 流式 SSE 响应
        # 格式: choices[].delta.content 拼接得到 "![image](data:image/...;base64,...)"
        accumulated_content = ""
        line_count = 0
        for line in resp.text.splitlines():
            if not line:
                continue

            if line.startswith("data:"):
                line = line[5:].lstrip()

            if not line or line == "[DONE]":
                continue

            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue

            line_count += 1

            choices = chunk.get("choices", [])
            for choice in choices:
                delta = choice.get("delta", {})
                content = delta.get("content", "")
                if content:
                    accumulated_content += content

        print(f"[GENERATE-SYNC] 流完成: {line_count} 行, content={len(accumulated_content)} chars")

        # 从 Markdown 图片语法中提取 data URL: ![image](data:image/jpeg;base64,...)
        idx = accumulated_content.find("data:image/")
        if idx >= 0:
            end_idx = accumulated_content.find(")", idx)
            if end_idx >= 0:
                raw = accumulated_content[idx:end_idx]
            else:
                raw = accumulated_content[idx:]
            # 移除 base64 中可能的空白字符
            image_url = re.sub(r'\s+', '', raw)
            mime_match = re.match(r'data:(image/\w+);base64,', image_url)
            accumulated_mime = mime_match.group(1) if mime_match else "image/png"
            b64_data = image_url.split(",", 1)[-1] if "," in image_url else ""
            try:
                img_bytes = base64.b64decode(b64_data)
                print(f"[GENERATE-SYNC] 完成: {len(img_bytes)} bytes, {accumulated_mime}")
            except Exception as e:
                print(f"[GENERATE-SYNC] base64 解码失败: {e}")

            response = {
                "image_url": image_url,
            }
            if O1KEY_DEBUG:
                response["debug"] = {
                    "upstream_url": sync_url,
                    "upstream_body": req_body,
                }
            print(f"[GENERATE-SYNC] 完成: {len(img_bytes)} bytes, {accumulated_mime}")
            try:
                self._json(response)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print(f"[GENERATE-SYNC] 客户端已断开, 响应未发送")
        else:
            print(f"[GENERATE-SYNC] 未找到图片数据, content={accumulated_content[:200]}")
            self._json({"error": {"message": "响应中未找到图片数据"}}, 500)

    # ---------- 图片生成 (GPT Image 2 — /v1/images/generations) ----------
    def _handle_generate_gpt_image(self):
        """代理 GPT Image 2 文生图请求到 o1key /v1/images/generations"""
        try:
            self._handle_generate_gpt_image_inner()
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self._json({"error": {"message": f"服务器内部错误: {e}"}}, 500)
            except Exception:
                pass

    def _handle_generate_gpt_image_inner(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception:
            self._json({"error": {"message": "请求体解析失败"}}, 400)
            return

        prompt = body.get("prompt", "")
        if not prompt:
            self._json({"error": {"message": "缺少 prompt"}}, 400)
            return

        model = body.get("model", "gpt-image-2")
        n = body.get("n", 1)
        size = body.get("size", "auto")
        quality = body.get("quality")
        output_format = body.get("output_format")
        output_compression = body.get("output_compression")
        stream = body.get("stream", True)
        partial_images = body.get("partial_images", 2)

        # 构建 /v1/images/generations 请求体
        req_body = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": size,
            "stream": stream,
            "partial_images": partial_images,
        }

        if quality:
            req_body["quality"] = quality
        if output_format:
            req_body["output_format"] = output_format
        if output_compression is not None and output_format in ("jpeg", "webp"):
            req_body["output_compression"] = output_compression

        gpt_url = f"{O1KEY_BASE}/v1/images/generations"

        print(f"\n[GPT-IMAGE] POST {gpt_url}")
        print(f"[GPT-IMAGE] req_body: {json.dumps(truncate_base64(req_body), ensure_ascii=False)}")

        hdrs = {
            "Authorization": f"Bearer {O1KEY_API_KEY}",
            "Content-Type": "application/json",
        }

        # 重试循环：流式请求，逐块代理 SSE 到前端
        resp = None
        for attempt in range(RETRY_MAX + 1):
            try:
                resp = requests.post(gpt_url, headers=hdrs, json=req_body,
                                    stream=True, timeout=GEN_TIMEOUT)
            except requests.exceptions.RequestException as e:
                print(f"[GPT-IMAGE] 请求失败: {e}")
                self._json({"error": {"message": f"API 请求失败: {e}"}}, 500)
                return

            if attempt < RETRY_MAX:
                should_retry = False
                retry_reason = ""
                if resp.status_code == 429:
                    should_retry = True
                    retry_reason = "429"
                elif resp.status_code == 400:
                    try:
                        err_text = resp.text
                        if "high load" in err_text.lower():
                            should_retry = True
                            retry_reason = "400(high load)"
                    except Exception:
                        pass

                if should_retry:
                    delay = _calc_retry_delay(resp, attempt + 1)
                    print(f"[GPT-IMAGE] {retry_reason} 重试 {attempt + 1}/{RETRY_MAX}, 等待 {delay:.1f}s")
                    resp.close()
                    time.sleep(delay)
                    continue
            break

        if resp.status_code != 200:
            err_text = resp.text[:500] if resp.text else ""
            print(f"[GPT-IMAGE] 请求失败 [{resp.status_code}]: {err_text}")
            resp.close()
            err_msg = f"API 错误 [{resp.status_code}]: {err_text}"
            try:
                upstream = json.loads(err_text)
                original = upstream.get("error", {}).get("message", "")
                if original:
                    err_msg = original
            except Exception:
                pass
            self._json({"error": {"message": err_msg}}, resp.status_code)
            return

        # 返回 JSON 响应（不使用 SSE 代理）
        body_text = resp.content.decode('utf-8')
        resp.close()
        print(f"[GPT-IMAGE] 响应长度: {len(body_text)} bytes")

        try:
            data = json.loads(body_text)
        except json.JSONDecodeError:
            self._json({"error": {"message": f"上游返回非 JSON: {body_text[:200]}"}}, 500)
            return

        # 提取图片 URL
        img_url = ""
        if data.get("data") and isinstance(data["data"], list) and len(data["data"]) > 0:
            img = data["data"][0]
            if img.get("url"):
                img_url = img["url"]
            elif img.get("b64_json"):
                mime = output_format if output_format else "png"
                img_url = f"data:image/{mime};base64,{img['b64_json']}"

        if not img_url:
            self._json({"error": {"message": "响应中未找到图片数据"}}, 500)
            return

        # 若为远程 URL，下载后存到本地，返回 localhost 路径
        if img_url.startswith("http://") or img_url.startswith("https://"):
            try:
                print(f"[GPT-IMAGE] 下载结果图片: {img_url[:120]}...")
                img_resp = requests.get(img_url, timeout=30)
                img_resp.raise_for_status()
                content_type = img_resp.headers.get("Content-Type", f"image/{output_format or 'png'}")
                img_url = self._save_image_bytes(img_resp.content, content_type)
                print(f"[GPT-IMAGE] 已存本地: {img_url}")
            except Exception as e:
                print(f"[GPT-IMAGE] 下载图片失败，保留原始 URL: {e}")

        response = {
            "image_url": img_url,
        }
        if O1KEY_DEBUG:
            response["debug"] = {
                "upstream_url": gpt_url,
                "upstream_body": req_body,
            }
        self._json(response)
        print(f"[GPT-IMAGE] 完成: {len(body_text)} bytes")

    # ---------- 图片编辑 (GPT Image 2 — /v1/images/edits) ----------
    def _handle_generate_gpt_image_edit(self):
        """代理 GPT Image 2 图片编辑请求到 o1key /v1/images/edits（multipart/form-data）"""
        try:
            self._handle_generate_gpt_image_edit_inner()
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self._json({"error": {"message": f"服务器内部错误: {e}"}}, 500)
            except Exception:
                pass

    def _handle_generate_gpt_image_edit_inner(self):
        content_type = self.headers.get("Content-Type", "")
        content_length = int(self.headers.get("Content-Length", 0))

        # 读取原始 multipart 字节（只读一次，保存以供重试）
        raw_body = self.rfile.read(content_length)

        edit_url = f"{O1KEY_BASE}/v1/images/edits"
        print(f"[GPT-IMAGE-EDIT] POST {edit_url} ({content_length} bytes)")

        hdrs = {
            "Authorization": f"Bearer {O1KEY_API_KEY}",
            "Content-Type": content_type,
        }

        # 重试循环
        resp = None
        for attempt in range(RETRY_MAX + 1):
            try:
                resp = requests.post(edit_url, headers=hdrs, data=raw_body, timeout=GEN_TIMEOUT)
            except requests.exceptions.RequestException as e:
                print(f"[GPT-IMAGE-EDIT] 请求失败: {e}")
                self._json({"error": {"message": f"API 请求失败: {e}"}}, 500)
                return

            if attempt < RETRY_MAX:
                should_retry = False
                retry_reason = ""
                if resp.status_code == 429:
                    should_retry = True
                    retry_reason = "429"
                elif resp.status_code == 400:
                    try:
                        if "high load" in resp.text.lower():
                            should_retry = True
                            retry_reason = "400(high load)"
                    except Exception:
                        pass

                if should_retry:
                    delay = _calc_retry_delay(resp, attempt + 1)
                    print(f"[GPT-IMAGE-EDIT] {retry_reason} 重试 {attempt + 1}/{RETRY_MAX}, 等待 {delay:.1f}s")
                    resp.close()
                    time.sleep(delay)
                    continue
            break

        if resp.status_code != 200:
            err_text = resp.text[:500] if resp.text else ""
            print(f"[GPT-IMAGE-EDIT] 请求失败 [{resp.status_code}]: {err_text}")
            resp.close()
            err_msg = f"API 错误 [{resp.status_code}]: {err_text}"
            try:
                upstream = json.loads(err_text)
                original = upstream.get("error", {}).get("message", "")
                if original:
                    err_msg = original
            except Exception:
                pass
            self._json({"error": {"message": err_msg}}, resp.status_code)
            return

        body_text = resp.content.decode('utf-8')
        resp.close()
        print(f"[GPT-IMAGE-EDIT] 响应长度: {len(body_text)} bytes")

        try:
            data = json.loads(body_text)
        except json.JSONDecodeError:
            self._json({"error": {"message": f"上游返回非 JSON: {body_text[:200]}"}}, 500)
            return

        # 提取图片 URL（与 generations 端点同格式：data[0].url 或 data[0].b64_json）
        img_url = ""
        if data.get("data") and isinstance(data["data"], list) and len(data["data"]) > 0:
            img = data["data"][0]
            if img.get("url"):
                img_url = img["url"]
            elif img.get("b64_json"):
                img_url = f"data:image/png;base64,{img['b64_json']}"

        if not img_url:
            self._json({"error": {"message": "响应中未找到图片数据"}}, 500)
            return

        # 若为远程 URL，下载后存到本地，返回 localhost 路径
        if img_url.startswith("http://") or img_url.startswith("https://"):
            try:
                print(f"[GPT-IMAGE-EDIT] 下载结果图片: {img_url[:120]}...")
                img_resp = requests.get(img_url, timeout=30)
                img_resp.raise_for_status()
                img_ct = img_resp.headers.get("Content-Type", "image/png")
                img_url = self._save_image_bytes(img_resp.content, img_ct)
                print(f"[GPT-IMAGE-EDIT] 已存本地: {img_url}")
            except Exception as e:
                print(f"[GPT-IMAGE-EDIT] 下载图片失败，保留原始 URL: {e}")

        # 解析原始 multipart 请求体，供前端调试
        upstream_body_debug = self._parse_multipart_debug(raw_body, content_type)
        response = {
            "image_url": img_url,
        }
        if O1KEY_DEBUG:
            response["debug"] = {
                "upstream_url": edit_url,
                "upstream_body": upstream_body_debug,
            }
        self._json(response)
        print(f"[GPT-IMAGE-EDIT] 完成: {len(body_text)} bytes")

    # ---------- 图片生成 (o1key 异步 API — 暂不使用，保留备用) ----------
    def _handle_generate_async(self):
        """代理图片生成请求到 o1key 异步 API（保留，未来可能使用）"""
        try:
            self._handle_generate_async_inner()
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self._json({"error": {"message": f"服务器内部错误: {e}"}}, 500)
            except Exception:
                pass

    def _handle_generate_async_inner(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception:
            self._json({"error": {"message": "请求体解析失败"}}, 400)
            return

        print(f"\n[GENERATE-ASYNC] 请求: prompt={str(body.get('prompt',''))[:80]!r} model={body.get('model','')} size={body.get('size','')} refs={len(body.get('images') or ([body['image']] if body.get('image') else []))}")

        prompt = body.get("prompt")
        aspect_ratio = body.get("aspect_ratio")
        image_size = body.get("size")
        gemini_model = body.get("model", "gemini-3-pro-image-preview")

        ref_images = self._parse_ref_images(body)

        if not prompt:
            self._json({"error": {"message": "缺少提示词"}}, 400)
            return

        aspect_ratio = aspect_ratio or "1:1"
        image_size = image_size or "1K"
        billing = body.get("billing", "per-image")
        if billing == "per-use":
            o1key_model = get_per_use_model(gemini_model)
        else:
            o1key_model = get_o1key_model(gemini_model, image_size)

        # 处理参考图：上传到 R2
        image_urls = []
        for img in ref_images:
            try:
                url, mime = self._resolve_ref_url(img)
                image_urls.append(url)
            except Exception as e:
                print(f"[WARN] 处理参考图失败: {e}")
                self._json({"error": {"message": f"处理参考图失败: {e}"}}, 500)
                return

        # 构建 o1key 异步请求
        req_body = {
            "model": o1key_model,
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "size": to_api_size(image_size),
            "response_modalities": ["IMAGE"],
            "image_compression": "webp",
            "n": 1,
        }

        if len(image_urls) == 1:
            req_body["image"] = image_urls[0]
        elif len(image_urls) > 1:
            req_body["images"] = image_urls

        print(f"[GENERATE-ASYNC] billing={billing} model={o1key_model} aspect={aspect_ratio} "
              f"size={req_body['size']} refs={len(image_urls)} prompt={prompt[:60]}...")

        status, submit_result = o1key_request(
            "POST",
            f"{O1KEY_BASE}/async/v1/images/generations",
            req_body,
            timeout=30
        )

        if status != 200:
            err = submit_result if isinstance(submit_result, str) else submit_result.get("error", submit_result)
            err_msg = err if isinstance(err, str) else err.get("message", str(err))
            print(f"[ERROR] 提交任务失败 [{status}]: {err_msg}")
            self._json({"error": {"message": f"API 错误 [{status}]: {err_msg}"}}, status)
            return

        task_id = submit_result.get("task_id")
        if not task_id:
            self._json({"error": {"message": "未获取到 task_id"}}, 502)
            return

        print(f"[GENERATE-ASYNC] 任务已提交: {task_id}")

        request_id = self.headers.get("X-Request-ID", "")
        cancel_event = threading.Event()
        if request_id:
            with ACTIVE_TASKS_LOCK:
                ACTIVE_TASKS[request_id] = {"cancel_event": cancel_event, "status": "RUNNING"}

        try:
            deadline = time.time() + GEN_TIMEOUT
            result = poll_task(task_id, deadline, cancel_event)

            if result.get("status") == "CANCELLED":
                self._json({"error": {"message": "任务已被取消"}}, 499)
                return

            if result.get("status") != "SUCCESS":
                err_msg = result.get("error", "未知错误")
                self._json({"error": {"message": f"生成失败: {err_msg}"}}, 500)
                return

            data = result.get("data", {})
            img_url = data.get("image_url", "")
            if not img_url:
                images_data = data.get("data", [])
                if images_data and isinstance(images_data, list) and len(images_data) > 0:
                    img_url = images_data[0].get("url", "")
            if not img_url:
                self._json({"error": {"message": "生成成功但未返回图片 URL"}}, 500)
                return

            try:
                img_resp = requests.get(img_url, timeout=30)
                img_resp.raise_for_status()
                img_bytes = img_resp.content
                content_type = img_resp.headers.get("Content-Type", "image/webp")
            except Exception as e:
                self._json({"error": {"message": f"下载图片失败: {e}"}}, 500)
                return

            b64_data = base64.b64encode(img_bytes).decode("utf-8")

            response = {
                "image_url": f"data:{content_type};base64,{b64_data}",
            }

            print(f"[GENERATE-ASYNC] 完成: {task_id} → {len(img_bytes)} bytes, {content_type}")
            try:
                self._json(response)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                print(f"[GENERATE-ASYNC] 客户端已断开, 响应未发送: {task_id}")
        finally:
            if request_id:
                with ACTIVE_TASKS_LOCK:
                    ACTIVE_TASKS.pop(request_id, None)

    # ---------- 取消请求 ----------
    def _handle_cancel(self):
        """取消进行中的生成任务"""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception:
            self._json({"error": "请求体解析失败"}, 400)
            return

        request_ids = body.get("request_ids", [])
        cancelled = 0
        with ACTIVE_TASKS_LOCK:
            for rid in request_ids:
                entry = ACTIVE_TASKS.get(rid)
                if entry and entry["status"] == "RUNNING":
                    entry["cancel_event"].set()
                    entry["status"] = "CANCELLED"
                    cancelled += 1
        print(f"[CANCEL] 取消 {cancelled}/{len(request_ids)} 个任务")
        self._json({"ok": True, "cancelled": cancelled})

    # ---------- API 配置端点 ----------
    def _handle_get_config(self):
        """返回当前线路和已保存的密钥（前端回填用）"""
        global O1KEY_BASE, O1KEY_API_KEY
        route = "global"
        for k, v in ROUTE_DOMAINS.items():
            if v == O1KEY_BASE:
                route = k
                break
        self._json({
            "route": route,
            "base_url": O1KEY_BASE,
            "hasKey": bool(O1KEY_API_KEY),
            "configured": _CONFIGURED,
            "keyPreview": ("***" + O1KEY_API_KEY[-8:]) if O1KEY_API_KEY else "",
        })

    def _handle_config_test(self):
        """测试给定的 API Key + 线路是否可用"""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception:
            self._json({"ok": False, "error": "请求体解析失败"}, 400)
            return

        test_route = body.get("route", "global")
        test_key = body.get("apiKey", "").strip()
        if not test_key:
            self._json({"ok": False, "error": "API Key 不能为空"})
            return

        test_base = ROUTE_DOMAINS.get(test_route, ROUTE_DOMAINS["global"])
        test_url = f"{test_base}/v1/models"
        headers = {
            "Authorization": f"Bearer {test_key}",
        }
        try:
            resp = requests.get(test_url, headers=headers, timeout=10)
            if resp.status_code == 200:
                self._json({"ok": True})
            elif resp.status_code == 401 or resp.status_code == 403:
                self._json({"ok": False, "error": f"认证失败 [{resp.status_code}]，请检查 API Key"})
            else:
                err_text = resp.text[:200]
                self._json({"ok": False, "error": f"API 返回错误 [{resp.status_code}]: {err_text}"})
        except requests.exceptions.RequestException as e:
            self._json({"ok": False, "error": f"网络连接失败: {e}"})

    def _handle_config_save(self):
        """保存配置到 config.json"""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except Exception:
            self._json({"ok": False, "error": "请求体解析失败"}, 400)
            return

        route = body.get("route", "global")
        api_key = body.get("apiKey", "").strip()
        if not api_key:
            self._json({"ok": False, "error": "API Key 不能为空"}, 400)
            return

        try:
            save_config(route, api_key)
            self._json({"ok": True, "route": route})
        except Exception as e:
            self._json({"ok": False, "error": f"保存失败: {e}"}, 500)

    def _handle_config_clear(self):
        """清除已保存的 API Key，保留线路配置"""
        global _CONFIGURED
        try:
            save_config(current_route(), "")
            _CONFIGURED = False
            self._json({"ok": True})
        except Exception as e:
            self._json({"ok": False, "error": f"清除失败: {e}"}, 500)

    def _is_sensitive_path(self, path):
        """阻止访问敏感文件：.py .json .jsx 以及路径遍历"""
        # 防止路径遍历
        if '..' in path or '//' in path:
            return True
        # 阻止敏感扩展名
        lower = path.lower()
        for ext in ('.py', '.json', '.jsx'):
            if lower.endswith(ext) or (ext in lower and '?' in lower):
                return True
        return False

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.send_response(302)
            self.send_header("Location", "/home.html")
            self.end_headers()
        elif parsed.path == "/api/config":
            self._handle_get_config()
        elif parsed.path == "/api/images":
            self._list_images()
        elif parsed.path.startswith("/api/images/"):
            self._serve_image(parsed.path, parse_qs(parsed.query))
        elif self._is_sensitive_path(parsed.path):
            self._json({"error": "not found"}, 404)
        else:
            super().do_GET()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/images/"):
            self._delete_image(parsed.path)
        else:
            self._json({"error": "not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Request-ID")
        self.end_headers()

    # ---------- 图片历史 ----------
    def _save_image_bytes(self, img_bytes, mime):
        """保存原始字节到 history 目录，生成缩略图，返回 /api/images/xxx 路径"""
        ext = mime.split("/")[1] if "/" in mime else "png"
        if ext == "jpeg":
            ext = "jpg"
        filename = f"{uuid.uuid4().hex}.{ext}"
        filepath = os.path.join(HISTORY_DIR, filename)
        os.makedirs(HISTORY_DIR, exist_ok=True)
        with open(filepath, "wb") as f:
            f.write(img_bytes)
        # 生成缩略图
        try:
            from PIL import Image
            os.makedirs(THUMBS_DIR, exist_ok=True)
            img = Image.open(io.BytesIO(img_bytes))
            img.thumbnail((400, 400), Image.Resampling.LANCZOS)
            thumb_filename = f"{os.path.splitext(filename)[0]}.jpg"
            thumb_path = os.path.join(THUMBS_DIR, thumb_filename)
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            img.save(thumb_path, format='JPEG', quality=75)
        except Exception:
            pass
        return f"/api/images/{filename}"

    def _parse_multipart_debug(self, raw_body, content_type):
        """解析 multipart/form-data 请求体，返回字段名和简要值（文本字段显示值，文件字段显示大小）"""
        debug_info = {"_ct": content_type[:200]}
        try:
            # 从 Content-Type 提取 boundary
            boundary = None
            for part in content_type.split(";"):
                part = part.strip()
                if part.lower().startswith("boundary="):
                    boundary = part.split("=", 1)[1].strip().strip('"').strip("'")
                    break
            if not boundary:
                debug_info["_error"] = f"无法解析 boundary, parts={content_type.split(';')}"
                return debug_info

            boundary_bytes = boundary.encode("utf-8")
            # 分割各个 part
            parts = raw_body.split(b"--" + boundary_bytes)
            for part in parts:
                if not part or part == b"--" or part == b"--\r\n":
                    continue
                # 去掉末尾 \r\n
                part = part.lstrip(b"\r\n").rstrip(b"\r\n")
                # 分离头和体
                header_end = part.find(b"\r\n\r\n")
                if header_end < 0:
                    continue
                headers_bytes = part[:header_end]
                body_bytes = part[header_end + 4:]
                headers_text = headers_bytes.decode("utf-8", errors="replace")

                # 提取 name 和 filename
                name = None
                filename = None
                for hdr_line in headers_text.split("\r\n"):
                    if hdr_line.lower().startswith("content-disposition:"):
                        # Content-Disposition: form-data; name="image"; filename="foo.png"
                        for attr in hdr_line.split(";"):
                            attr = attr.strip()
                            if attr.startswith("name="):
                                name = attr.split("=", 1)[1].strip('"').strip("'")
                            elif attr.startswith("filename="):
                                filename = attr.split("=", 1)[1].strip('"').strip("'")
                if not name:
                    continue
                if filename:
                    debug_info[name] = f"[file: {filename}, {len(body_bytes)} bytes]"
                else:
                    val = body_bytes.decode("utf-8", errors="replace").strip()
                    debug_info[name] = val
        except Exception as e:
            debug_info["_parse_error"] = str(e)
        return debug_info

    def _save_base64_image(self, b64, mime):
        """保存 base64 图片到 history 目录，同时生成缩略图，返回文件名"""
        ext = mime.split("/")[1]
        if ext == "jpeg":
            ext = "jpg"
        filename = f"{uuid.uuid4().hex}.{ext}"
        filepath = os.path.join(HISTORY_DIR, filename)
        img_bytes = base64.b64decode(b64)
        with open(filepath, "wb") as f:
            f.write(img_bytes)
        # 生成缩略图 (400px 宽 JPEG)
        try:
            from PIL import Image
            os.makedirs(THUMBS_DIR, exist_ok=True)
            img = Image.open(io.BytesIO(img_bytes))
            img.thumbnail((400, 400), Image.Resampling.LANCZOS)
            thumb_path = os.path.join(THUMBS_DIR, filename)
            # 统一用 .jpg 后缀存缩略图
            thumb_filename = f"{os.path.splitext(filename)[0]}.jpg"
            thumb_path = os.path.join(THUMBS_DIR, thumb_filename)
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            img.save(thumb_path, format='JPEG', quality=75)
        except Exception:
            pass  # 缩略图生成失败不影响主流程
        return filename

    # ═══════════════════════════════════════════════════════════════════
    # 【新增模型必读】_save_images 是所有模型图片持久化的唯一入口。
    # 传入的 item["url"] 必须是以下三种格式之一，否则图片不会被保存：
    #   1. data:image/<mime>;base64,<data>   — base64 直接写入
    #   2. http:// 或 https:// 远程 URL       — 下载后写入（如 GPT Image 2 的 R2 链接）
    #   3. /api/images/<filename> 本地路径    — 已由 handler 保存到 output/，直接用文件名
    #   4. 空字符串                            — 取消/失败记录，无图片
    # 新增模型时，请确保其 handler 返回给前端的 image_url 属于上述四种格式。
    # 如果上游返回了新格式的 URL，在此处新增对应的处理分支。
    # ═══════════════════════════════════════════════════════════════════
    def _save_images(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_length))

        os.makedirs(HISTORY_DIR, exist_ok=True)

        saved = []
        for item in body.get("images", []):
            data_url = item.get("url", "")
            match = re.match(r"data:(image/\w+);base64,(.+)", data_url)
            if match:
                mime, b64 = match.groups()
                filename = self._save_base64_image(b64, mime)
            elif not data_url:
                filename = None
            elif data_url.startswith("http://") or data_url.startswith("https://"):
                # 远程 URL（如 GPT Image 2 返回的 R2 链接），下载后保存到本地
                try:
                    print(f"[SAVE] 下载远程图片: {data_url[:120]}...")
                    resp = requests.get(data_url, timeout=30)
                    resp.raise_for_status()
                    img_bytes = resp.content
                    content_type = resp.headers.get("Content-Type", "image/png")
                    mime = content_type.split(";")[0].strip()
                    b64 = base64.b64encode(img_bytes).decode("utf-8")
                    filename = self._save_base64_image(b64, mime)
                    print(f"[SAVE] 远程图片已保存: {filename} ({len(img_bytes)} bytes)")
                except Exception as e:
                    print(f"[SAVE] 下载远程图片失败: {e}")
                    filename = None
            elif data_url.startswith("/api/images/"):
                # 本地路径（已由 handler 保存到 output/），直接提取文件名
                filename = os.path.basename(data_url)
                print(f"[SAVE] 本地图片: {filename}")
            else:
                continue

            # 处理参考图 URL（保存 base64 参考图为文件）
            ref_urls = item.get("refUrls") or []
            resolved_refs = []
            for ref_url in ref_urls:
                if not ref_url:
                    continue
                ref_match = re.match(r"data:(image/\w+);base64,(.+)", ref_url)
                if ref_match:
                    ref_filename = self._save_base64_image(ref_match.group(2), ref_match.group(1))
                    resolved_refs.append(f"/api/images/{ref_filename}")
                else:
                    resolved_refs.append(ref_url)

            saved.append({
                "filename": filename,
                "prompt": item.get("prompt", ""),
                "model": item.get("model", ""),
                "resolution": item.get("resolution", ""),
                "aspect": item.get("aspect", ""),
                "elapsed": item.get("elapsed") or None,
                "tokens": item.get("tokens") or 0,
                "groupId": item.get("groupId"),
                "time": item.get("time"),
                "dateLabel": item.get("dateLabel"),
                "isBatch": item.get("isBatch", False),
                "batchPrompts": item.get("batchPrompts"),
                "responseContent": item.get("responseContent"),
                "cancelled": item.get("cancelled", False),
                "refUrls": resolved_refs if resolved_refs else None,
            })

        index_path = os.path.join(HISTORY_DIR, "index.json")
        existing = []
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
        existing = saved + existing
        with open(index_path, "w", encoding="utf-8") as f:
            json.dump(existing, f, ensure_ascii=False, indent=2)

        self._json({"ok": True, "saved": len(saved), "filenames": [s["filename"] for s in saved]})

    def _list_images(self):
        """返回历史记录索引，支持分页
           查询参数: ?offset=0&limit=20
        """
        # 解析查询参数
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        offset = int(params.get('offset', ['0'])[0])
        limit = int(params.get('limit', ['20'])[0])

        index_path = os.path.join(HISTORY_DIR, "index.json")
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = []

        # 分页返回
        total = len(data)
        page_data = data[offset:offset + limit]

        self._json({
            "items": page_data,
            "total": total,
            "offset": offset,
            "limit": limit,
            "hasMore": offset + limit < total
        })

    def _serve_image(self, path, query_params=None):
        filename = os.path.basename(path)
        want_thumb = query_params and query_params.get('thumb', [''])[0] == '1'
        if want_thumb:
            # 缩略图统一用 .jpg 后缀
            thumb_name = f"{os.path.splitext(filename)[0]}.jpg"
            thumb_path = os.path.join(THUMBS_DIR, thumb_name)
            if os.path.exists(thumb_path):
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                with open(thumb_path, "rb") as f:
                    self.wfile.write(f.read())
                return
            # 缩略图不存在则回退到原图
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

    def _delete_image(self, path):
        filename = os.path.basename(path)
        filepath = os.path.join(HISTORY_DIR, filename)
        if os.path.exists(filepath):
            os.remove(filepath)
        index_path = os.path.join(HISTORY_DIR, "index.json")
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            data = [d for d in data if d.get("filename") != filename]
            with open(index_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        self._json({"ok": True})

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    os.chdir(APP_DIR)
    if len(sys.argv) > 1:
        PORT = int(sys.argv[1])
    if len(sys.argv) > 2:
        HISTORY_DIR = sys.argv[2]
        if not os.path.isabs(HISTORY_DIR):
            HISTORY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), HISTORY_DIR)
        THUMBS_DIR = os.path.join(HISTORY_DIR, "thumbs")
    print(f"o1key Image Server: http://localhost:{PORT}/home.html")
    print(f"API Base: {O1KEY_BASE}")
    print(f"History dir: {HISTORY_DIR}")
    ThreadingHTTPServer(("0.0.0.0", PORT), BananaHandler).serve_forever()
