// o1key — AI 图片生成应用
// 中心化输入流，类似 ChatGPT。
// API Key 通过后端代理 (server.py) 读取，不暴露到前端。
// 前端发请求到 /api/generate → server.py 代理到 o1key Gemini 原生同步 API

// ---------- 模型映射 ----------
// 应用模型 ID → o1key 模型名（server.py 结合 imageSize 拼分辨率后缀）
const APP_MODEL_MAP = {
  pro:  'nano-banana-pro',
  v2:   'nano-banana-2',
  nano: 'nano-banana',
};

// 按量计费：应用模型 ID → Gemini 原始模型名（不拼分辨率）
const APP_MODEL_MAP_PER_USE = {
  pro:  'gemini-3-pro-image-preview',
  v2:   'gemini-3.1-flash-image-preview',
  nano: 'nano-banana',
};

// 分辨率 ID → API imageSize 值 (0.5K 映射为 "512")
function toApiImageSize(resolutionId) {
  if (resolutionId === '0.5K') return '512';
  return resolutionId; // 1K / 2K / 4K 原样传递
}

// ---------- 请求体大小限制（按模型系列）----------
// 规则：每个模型系列在此声明自己的请求体上限。
// 未匹配到的系列回退到 DEFAULT_MAX_REQUEST_SIZE。
const MODEL_SERIES_MAX_REQUEST_SIZE = {
  'nano-banana': 50 * 1024 * 1024, // 50MB — Nano Banana 系列 (pro, v2)
  'gpt-image':   20 * 1024 * 1024, // 20MB — GPT Image 系列
};

const DEFAULT_MAX_REQUEST_SIZE = 20 * 1024 * 1024; // 20MB（未匹配系列的默认值）

// 根据应用模型 ID 获取该模型所属系列的请求体上限
function getMaxRequestSize(modelId) {
  const apiModel = APP_MODEL_MAP[modelId] || '';
  const series = Object.keys(MODEL_SERIES_MAX_REQUEST_SIZE).find(prefix => apiModel.startsWith(prefix));
  return series ? MODEL_SERIES_MAX_REQUEST_SIZE[series] : DEFAULT_MAX_REQUEST_SIZE;
}

// 估算请求体主要载荷大小（文本 + 参考图 base64），单位 bytes
function estimateRequestBodySize(prompt, refImages) {
  let size = new TextEncoder().encode(prompt).length;
  if (refImages) {
    for (const img of refImages) {
      if (img.url && img.url.startsWith('data:')) {
        size += img.url.length; // base64 data URL，长度 ≈ 字节数
      }
    }
  }
  return size;
}

// ---------- 图片压缩（Canvas 等比缩放）----------
function compressImage(dataUrl, scale) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// 调用 o1key 生成单张图片（通过本地代理 → Gemini 原生同步 API），返回 { url, debug, responseContent }
async function callGeminiImageGeneration(prompt, refImages, aspectRatio, modelId, resolution, editContext, signal, requestId, googleSearch, thinkingLevel, billingMode) {
  const modelMap = billingMode === 'per-use' ? APP_MODEL_MAP_PER_USE : APP_MODEL_MAP;
  const apiModel = modelMap[modelId] || modelMap.pro;
  const debug = { request: null, response: null, error: null };

  // 构建 Gemini 原生格式请求体
  const parts = [{ text: prompt }];

  // 添加参考图（如果有）
  if (refImages && refImages.length > 0) {
    for (const img of refImages) {
      const m = img.url.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (m) {
        // base64 格式 → inlineData
        parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      } else if (img.url.startsWith('/api/images/')) {
        // 本地图片 → 转为 base64 inlineData
        try {
          const resp = await fetch(img.url);
          const blob = await resp.blob();
          const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          parts.push({ inlineData: { mimeType: blob.type || 'image/png', data: b64 } });
        } catch (e) {
          debug.error = `读取本地参考图失败: ${e.message}`;
          return { url: null, debug, responseContent: null };
        }
      } else {
        // URL 格式（远程）→ fileData
        parts.push({ fileData: { mimeType: 'image/png', fileUri: img.url } });
      }
    }
  }

  const requestBody = {
    model: apiModel,
    billing: billingMode || 'per-image',
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatio,
        imageSize: toApiImageSize(resolution),
      },
      ...(modelId === 'v2' ? {
        thinkingConfig: {
          thinkingLevel: thinkingLevel,
          includeThoughts: true,
        }
      } : {}),
    },
    ...(googleSearch ? { tools: [{ google_search: {} }] } : {}),
  };

  const url = '/api/generate';

  debug.request = {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { ...requestBody, contents: [{ role: 'user', parts: parts.map(p => p.inlineData ? { inlineData: { mimeType: p.inlineData.mimeType, data: `[${p.inlineData.data.length} chars]` } } : p) }] },
  };

  console.group('%c📤 Gemini 原生格式 API 请求 (via 本地代理 → o1key)', 'color:#F59E0B;font-weight:bold');
  console.log('URL:', url);
  console.log('Model:', apiModel, `(app: ${modelId})`);
  console.log('Prompt:', prompt);
  console.log('Aspect:', aspectRatio, '· Size:', toApiImageSize(resolution));
  console.log('Ref images:', refImages.length);
  console.log('Request Body:', sanitizeLog(requestBody));
  console.groupEnd();

  // --- 请求（带指数退让重试） ---
  const MAX_RETRIES = 3;
  const FETCH_TIMEOUT = 300000; // 前端兜底超时 300s
  const startTime = performance.now();
  let response;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    if (attempt > 0) {
      const waitMs = Math.pow(2, attempt - 1) * 1000;
      console.log(`%c⏳ 指数退让重试 #${attempt}, 等待 ${waitMs / 1000}s...`, 'color:#F2B33D');
      await new Promise(r => setTimeout(r, waitMs));
    }
    try {
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId || '' },
        body: JSON.stringify(requestBody),
        signal: combinedSignal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        debug.error = '已取消';
        console.log('%c⏹️ 请求已取消 (AbortError)', 'color:#F59E0B');
        throw fetchErr;
      }
      if (fetchErr.name === 'TimeoutError') {
        debug.error = `请求超时 (${FETCH_TIMEOUT / 1000}s)`;
        console.error('%c❌ 请求超时', 'color:#EF4444;font-weight:bold');
        throw new Error(debug.error);
      }
      if (attempt >= MAX_RETRIES) {
        debug.error = `网络错误 (已重试${MAX_RETRIES}次): ${fetchErr.message}`;
        console.error('%c❌ 网络请求最终失败', 'color:#EF4444;font-weight:bold', fetchErr);
        throw new Error(debug.error);
      }
      console.warn(`%c⚠️ 网络错误, 尝试 ${attempt + 1}/${MAX_RETRIES + 1}: ${fetchErr.message}`, 'color:#F2B33D');
      attempt++;
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt >= MAX_RETRIES) break;
      console.warn(`%c⚠️ 可重试状态 [${response.status}], 尝试 ${attempt + 1}/${MAX_RETRIES + 1}`, 'color:#F2B33D');
      attempt++;
      continue;
    }

    break;
  }

  const elapsed = (performance.now() - startTime).toFixed(0);
  debug.response = {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    elapsed: `${elapsed}ms`,
    attempts: attempt + 1,
    body: null,
  };

  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); } catch (e) { data = responseText; }

  if (!response.ok) {
    debug.response.body = data;
    debug.error = data?.error?.message || `HTTP ${response.status}`;
    console.group('%c❌ API 返回错误', 'color:#EF4444;font-weight:bold');
    console.log('Status:', response.status, '· 共尝试', attempt + 1, '次');
    console.log('Response:', sanitizeLog(data));
    console.groupEnd();
    throw new Error(debug.error);
  }

  debug.response.body = data;

  console.group('%c✅ API 响应', 'color:#10B981;font-weight:bold');
  console.log(`Status: ${response.status} · ${elapsed}ms · 尝试 ${attempt + 1} 次`);
  console.log('Raw response:', sanitizeLog(data));
  if (data.debug) {
    console.group('%c🔍 上游真实请求', 'color:#8B5CF6;font-weight:bold');
    console.log('URL:', data.debug.upstream_url);
    console.log('Body:', data.debug.upstream_body);
    console.groupEnd();
  }
  console.groupEnd();

  // 提取图片 URL（server.py 同步代理返回 data URL 格式）
  let imageUrl = null;
  if (data.image_url) {
    imageUrl = data.image_url;
  } else if (data.data && Array.isArray(data.data) && data.data[0]?.url) {
    imageUrl = data.data[0].url;
  }

  if (!imageUrl) {
    debug.error = '响应中未找到图片 URL';
    console.warn('⚠️ 响应格式:', data);
    throw new Error('响应中未找到图片 URL');
  }

  console.log('%c🖼️ 提取到图片 URL:', 'color:#10B981', sanitizeLog(imageUrl));

  return {
    url: imageUrl,
    tokens: 0,
    responseContent: null,
    debug,
  };
}

// 调用 GPT Image 2 文生图（通过本地代理 → o1key /v1/images/generations）
async function callGptImageGeneration(prompt, modelId, n, size, quality, outputFormat, outputCompression, billingMode, onPartialImage, signal, requestId) {
  const debug = { request: null, response: null, error: null };

  const apiModel = billingMode === 'per-image' ? 'gpt-image-2-c' : 'gpt-image-2';

  const requestBody = {
    prompt,
    model: apiModel,
    n: n || 1,
    size: size || 'auto',
    stream: true,
    partial_images: 2,
  };

  if (quality) {
    requestBody.quality = quality;
  }
  if (outputFormat) {
    requestBody.output_format = outputFormat;
  }
  if (outputCompression != null && (outputFormat === 'jpeg' || outputFormat === 'webp')) {
    requestBody.output_compression = outputCompression;
  }

  const url = '/api/generate/gpt-image';

  debug.request = {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { ...requestBody },
  };

  console.group('%c📤 GPT Image 2 API 请求', 'color:#10B981;font-weight:bold');
  console.log('URL:', url);
  console.log('Model:', requestBody.model, `(app: ${modelId})`);
  console.log('Prompt:', prompt);
  console.log('Size:', size, '· N:', n, '· Quality:', quality, '· Format:', outputFormat);
  console.log('Request Body:', sanitizeLog(requestBody));
  console.groupEnd();

  const MAX_RETRIES = 3;
  const FETCH_TIMEOUT = 300000;
  const startTime = performance.now();
  let response;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    if (attempt > 0) {
      const waitMs = Math.pow(2, attempt - 1) * 1000;
      console.log(`%c⏳ 指数退让重试 #${attempt}, 等待 ${waitMs / 1000}s...`, 'color:#F2B33D');
      await new Promise(r => setTimeout(r, waitMs));
    }
    try {
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId || '' },
        body: JSON.stringify(requestBody),
        signal: combinedSignal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        debug.error = '已取消';
        console.log('%c⏹️ 请求已取消 (AbortError)', 'color:#F59E0B');
        throw fetchErr;
      }
      if (fetchErr.name === 'TimeoutError') {
        debug.error = `请求超时 (${FETCH_TIMEOUT / 1000}s)`;
        console.error('%c❌ 请求超时', 'color:#EF4444;font-weight:bold');
        throw new Error(debug.error);
      }
      if (attempt >= MAX_RETRIES) {
        debug.error = `网络错误 (已重试${MAX_RETRIES}次): ${fetchErr.message}`;
        console.error('%c❌ 网络请求最终失败', 'color:#EF4444;font-weight:bold', fetchErr);
        throw new Error(debug.error);
      }
      console.warn(`%c⚠️ 网络错误, 尝试 ${attempt + 1}/${MAX_RETRIES + 1}: ${fetchErr.message}`, 'color:#F2B33D');
      attempt++;
      continue;
    }

    if (!response.ok) {
      let retryReason = null;
      if (response.status === 429) {
        retryReason = '429';
      } else if (response.status >= 500) {
        retryReason = `${response.status}`;
      } else if (response.status === 400) {
        try {
          const clone = response.clone();
          const errData = await clone.json();
          if (/high load/i.test(errData?.error?.message || '')) {
            retryReason = '400(high load)';
          }
        } catch (e) { /* ignore */ }
      }

      if (retryReason && attempt < MAX_RETRIES) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`%c⚠️ ${retryReason} 重试 ${attempt + 1}/${MAX_RETRIES + 1}, 等待 ${waitMs / 1000}s`, 'color:#F2B33D');
        attempt++;
        continue;
      }

      const errText = await response.text();
      let errData;
      try { errData = JSON.parse(errText); } catch (e) { errData = errText; }
      let rawMsg = errData?.error?.message || `HTTP ${response.status}`;
      if (/invalid.*token/i.test(rawMsg)) {
        rawMsg = '令牌不可用，请检查余额或是否正确！';
      } else if (/high load/i.test(rawMsg)) {
        rawMsg = '模型过载，请稍后重试';
      }
      debug.error = rawMsg;
      debug.response = { status: response.status, body: errData };
      console.group('%c❌ GPT Image API 返回错误', 'color:#EF4444;font-weight:bold');
      console.log('Status:', response.status, '· 共尝试', attempt + 1, '次');
      console.log('Response:', sanitizeLog(errData));
      console.groupEnd();
      throw new Error(debug.error);
    }
    break;
  }

  // 解析 JSON 响应
  const data = await response.json();
  debug.response = data;

  if (data.error) {
    debug.error = data.error.message || String(data.error);
    throw new Error(debug.error);
  }

  const elapsed = (performance.now() - startTime).toFixed(0);
  console.log(`%c✅ GPT Image 完成: ${elapsed}ms`, 'color:#10B981');
  console.log('Image URL:', data.image_url);

  return {
    url: data.image_url,
    tokens: 0,
    responseContent: null,
    debug,
  };
}

// 调用 GPT Image 2 图片编辑（通过本地代理 → o1key /v1/images/edits，multipart/form-data）
// ⚠️ 【教训 2026-05-17】return 之前的任何代码抛出异常都会导致 tile 静默空白。
// console.log 中调用了未定义的 truncateBase64 → ReferenceError → 函数抛异常
// → return 永远不执行 → 调用方 catch 到 error → tile.status='error'
// → 但 error 状态没有 UI 渲染 → 用户只看到空白占格。
// 规则：return 前的代码必须零异常；新增辅助函数必须确保定义；所有 tile 状态必须有 UI。
async function callGptImageEdit(prompt, modelId, n, size, quality, outputFormat, outputCompression, billingMode, imageUrl, maskFile, signal, requestId) {
  const debug = { request: null, response: null, error: null };

  const apiModel = billingMode === 'per-image' ? 'gpt-image-2-c' : 'gpt-image-2';

  // 从 URL 获取源图片为 Blob
  let imageBlob;
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`获取源图片失败: ${resp.status}`);
    imageBlob = await resp.blob();
  } catch (err) {
    debug.error = `无法加载源图片: ${err.message}`;
    throw new Error(debug.error);
  }

  // 推断源图扩展名
  let imageExt = 'png';
  const urlMatch = imageUrl.match(/\.(\w+)(?:\?|$)/);
  if (urlMatch) imageExt = urlMatch[1] === 'jpeg' ? 'jpg' : urlMatch[1];
  const mimeMatch = imageUrl.match(/data:image\/(\w+);/);
  if (mimeMatch) imageExt = mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1];

  // 构建 FormData
  const fd = new FormData();
  fd.append('image', imageBlob, `source.${imageExt}`);
  fd.append('prompt', prompt);
  fd.append('model', apiModel);
  fd.append('n', String(n || 1));
  fd.append('size', size || 'auto');

  if (quality) {
    fd.append('quality', quality);
  }
  if (outputFormat) {
    fd.append('output_format', outputFormat);
  }
  if (outputCompression != null && (outputFormat === 'jpeg' || outputFormat === 'webp')) {
    fd.append('output_compression', String(outputCompression));
  }

  // 可选的 mask 文件
  if (maskFile) {
    let maskName = 'mask.png';
    if (maskFile.name) {
      maskName = maskFile.name;
    } else if (maskFile.type === 'image/png') {
      maskName = 'mask.png';
    } else if (maskFile.type === 'image/jpeg') {
      maskName = 'mask.jpg';
    }
    fd.append('mask', maskFile, maskName);
  }

  const url = '/api/generate/gpt-image-edit';

  debug.request = {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data' },
    body: { prompt, model: apiModel, n, size, quality, outputFormat, outputCompression, hasImage: true, hasMask: !!maskFile },
  };

  console.group('%c📤 GPT Image 2 Edit API 请求', 'color:#10B981;font-weight:bold');
  console.log('URL:', url);
  console.log('Model:', apiModel, `(app: ${modelId})`);
  console.log('Prompt:', prompt);
  console.log('Size:', size, '· N:', n, '· Quality:', quality, '· Format:', outputFormat);
  console.log('Source image:', imageUrl ? imageUrl.substring(0, 80) + '...' : 'none');
  console.log('Mask:', maskFile ? `${maskFile.name || 'unnamed'} (${maskFile.size} bytes)` : 'none');
  console.groupEnd();

  const MAX_RETRIES = 3;
  const FETCH_TIMEOUT = 300000;
  let response;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    if (attempt > 0) {
      const waitMs = Math.pow(2, attempt - 1) * 1000;
      console.log(`%c⏳ 指数退让重试 #${attempt}, 等待 ${waitMs / 1000}s...`, 'color:#F2B33D');
      await new Promise(r => setTimeout(r, waitMs));
    }
    try {
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      response = await fetch(url, {
        method: 'POST',
        headers: { 'X-Request-ID': requestId || '' },
        body: fd,
        signal: combinedSignal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        debug.error = '已取消';
        console.log('%c⏹️ 请求已取消 (AbortError)', 'color:#F59E0B');
        throw fetchErr;
      }
      if (fetchErr.name === 'TimeoutError') {
        debug.error = `请求超时 (${FETCH_TIMEOUT / 1000}s)`;
        console.error('%c❌ 请求超时', 'color:#EF4444;font-weight:bold');
        throw new Error(debug.error);
      }
      if (attempt >= MAX_RETRIES) {
        debug.error = `网络错误 (已重试${MAX_RETRIES}次): ${fetchErr.message}`;
        console.error('%c❌ 网络请求最终失败', 'color:#EF4444;font-weight:bold', fetchErr);
        throw new Error(debug.error);
      }
      console.warn(`%c⚠️ 网络错误, 尝试 ${attempt + 1}/${MAX_RETRIES + 1}: ${fetchErr.message}`, 'color:#F2B33D');
      attempt++;
      continue;
    }

    if (!response.ok) {
      let retryReason = null;
      if (response.status === 429) {
        retryReason = '429';
      } else if (response.status >= 500) {
        retryReason = `${response.status}`;
      } else if (response.status === 400) {
        try {
          const clone = response.clone();
          const errData = await clone.json();
          if (/high load/i.test(errData?.error?.message || '')) {
            retryReason = '400(high load)';
          }
        } catch (e) { /* ignore */ }
      }

      if (retryReason && attempt < MAX_RETRIES) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`%c⚠️ ${retryReason} 重试 ${attempt + 1}/${MAX_RETRIES + 1}, 等待 ${waitMs / 1000}s`, 'color:#F2B33D');
        attempt++;
        continue;
      }

      const errText = await response.text();
      let errData;
      try { errData = JSON.parse(errText); } catch (e) { errData = errText; }
      let rawMsg = errData?.error?.message || `HTTP ${response.status}`;
      if (/invalid.*token/i.test(rawMsg)) {
        rawMsg = '令牌不可用，请检查余额或是否正确！';
      } else if (/high load/i.test(rawMsg)) {
        rawMsg = '模型过载，请稍后重试';
      }
      debug.error = rawMsg;
      debug.response = { status: response.status, body: errData };
      console.group('%c❌ GPT Image Edit API 返回错误', 'color:#EF4444;font-weight:bold');
      console.log('Status:', response.status, '· 共尝试', attempt + 1, '次');
      console.log('Response:', sanitizeLog(errData));
      console.groupEnd();
      throw new Error(debug.error);
    }
    break;
  }

  const data = await response.json();
  debug.response = data;

  if (data.error) {
    debug.error = data.error.message || String(data.error);
    throw new Error(debug.error);
  }

  // ⚠️ return 前的代码切勿调用未定义函数，否则抛异常导致 return 永不执行，tile 为 error 状态
  return {
    url: data.image_url,
    tokens: 0,
    responseContent: null,
    debug,
  };
}

function sanitizeLog(obj) {
  if (typeof obj === 'string') {
    if (obj.startsWith('data:') && obj.includes(';base64,')) {
      const m = obj.match(/^(data:image\/\w+;base64,)/);
      const prefix = m ? m[1] : 'data:;base64,';
      const dataLen = obj.length - prefix.length;
      return `${prefix}[${dataLen} chars]`;
    }
    if (obj.length > 200 && /^[A-Za-z0-9+/=]{100,}$/.test(obj)) {
      return `[base64, ${obj.length} chars]`;
    }
    return obj.length > 500 ? obj.slice(0, 500) + `…[${obj.length} total]` : obj;
  }
  if (Array.isArray(obj)) return obj.map(sanitizeLog);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeLog(v);
    return out;
  }
  return obj;
}

function formatTokens(n) {
  if (!n || n <= 0) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K tokens`;
  return `${n} tokens`;
}

const { useState, useRef, useEffect, useCallback } = React;

// ---------- 数据 ----------
// 所有支持的宽高比（按模型过滤）。w/h 是真实比值，仅用于形状预览。
const ASPECT_PRESETS = [
  { id: '1:1',  w: 1,  h: 1,  models: ['pro', 'v2', 'nano'] },
  { id: '2:3',  w: 2,  h: 3,  models: ['pro', 'v2', 'nano'] },
  { id: '3:2',  w: 3,  h: 2,  models: ['pro', 'v2', 'nano'] },
  { id: '3:4',  w: 3,  h: 4,  models: ['pro', 'v2', 'nano'] },
  { id: '4:3',  w: 4,  h: 3,  models: ['pro', 'v2', 'nano'] },
  { id: '4:5',  w: 4,  h: 5,  models: ['pro', 'v2', 'nano'] },
  { id: '5:4',  w: 5,  h: 4,  models: ['pro', 'v2', 'nano'] },
  { id: '9:16', w: 9,  h: 16, models: ['pro', 'v2', 'nano'] },
  { id: '16:9', w: 16, h: 9,  models: ['pro', 'v2', 'nano'] },
  { id: '21:9', w: 21, h: 9,  models: ['pro', 'v2', 'nano'] },
  // v2 (Flash) 独有的极致比例
  { id: '1:4',  w: 1,  h: 4,  models: ['v2'] },
  { id: '1:8',  w: 1,  h: 8,  models: ['v2'] },
  { id: '4:1',  w: 4,  h: 1,  models: ['v2'] },
  { id: '8:1',  w: 8,  h: 1,  models: ['v2'] },
];

const MODELS = [
  { id: 'pro', name: 'Nano Banana Pro', short: 'Pro',  desc: '高质量 · 复杂推理' },
  { id: 'v2',  name: 'Nano Banana 2',   short: 'v2',   desc: '快速 · 高用量' },
  { id: 'nano', name: 'Nano Banana',     short: 'Nano', desc: '均衡 · 通用生成' },
  { id: 'gpt2', name: 'GPT Image 2', short: 'GPT2', desc: 'OpenAI · 高质量图像生成' },
];

// GPT Image 2 尺寸预设
const GPT_IMAGE_SIZES = [
  { id: 'auto', label: '自动（默认）', w: null, h: null },
  { id: '1024x1024', label: '1K 正方形', w: 1024, h: 1024 },
  { id: '1536x1024', label: '1.5K 景观', w: 1536, h: 1024 },
  { id: '1024x1536', label: '1.5K 肖像', w: 1024, h: 1536 },
  { id: '2048x2048', label: '2K 正方形', w: 2048, h: 2048 },
  { id: '2048x1152', label: '2K 横屏', w: 2048, h: 1152 },
  { id: '2048x1536', label: '2K 竖屏', w: 2048, h: 1536 },
  { id: '3840x2160', label: '4K 横屏', w: 3840, h: 2160 },
  { id: '2160x3840', label: '4K 竖屏', w: 2160, h: 3840 },
  { id: 'custom', label: '自定义', w: null, h: null },
];

// GPT Image 2 图片质量
const GPT_IMAGE_QUALITIES = [
  { id: 'auto', label: '自动' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
];

// GPT Image 2 输出格式
const GPT_IMAGE_FORMATS = [
  { id: 'png', label: 'PNG' },
  { id: 'jpeg', label: 'JPEG' },
  { id: 'webp', label: 'WebP' },
];

// GPT Image 2 自定义尺寸约束校验
// 规则：16px倍数 · 3:1宽高比 · 105万~829万像素（≥1K） · 单边≤3840
function clampGptSize(w, h) {
  for (let i = 0; i < 3; i++) {
    w = Math.max(16, Math.min(3840, w));
    h = Math.max(16, Math.min(3840, h));
    w = Math.round(w / 16) * 16 || 16;
    h = Math.round(h / 16) * 16 || 16;
    const maxDim = Math.max(w, h);
    const minDim = Math.min(w, h);
    if (minDim > 0 && maxDim / minDim > 3) {
      if (w > h) w = Math.round((h * 3) / 16) * 16;
      else h = Math.round((w * 3) / 16) * 16;
    }
    const pixels = w * h;
    if (pixels < 1048576) { // 1K = 1024×1024，低于此值 API 不保证精确尺寸
      const scale = Math.sqrt(1048576 / pixels);
      w = Math.round((w * scale) / 16) * 16;
      h = Math.round((h * scale) / 16) * 16;
    } else if (pixels > 8294400) {
      const scale = Math.sqrt(8294400 / pixels);
      w = Math.round((w * scale) / 16) * 16;
      h = Math.round((h * scale) / 16) * 16;
    }
  }
  w = Math.max(16, Math.min(3840, Math.round(w / 16) * 16 || 16));
  h = Math.max(16, Math.min(3840, Math.round(h / 16) * 16 || 16));
  return { w, h };
}

// GPT Image 2 尺寸 → { w, h }，auto 返回 null
function getGptSizeDims(gptSize, customW, customH) {
  const MAP = {
    '1024x1024':  { w: 1024, h: 1024 },
    '1536x1024':  { w: 1536, h: 1024 },
    '1024x1536':  { w: 1024, h: 1536 },
    '2048x2048':  { w: 2048, h: 2048 },
    '2048x1152':  { w: 2048, h: 1152 },
    '2048x1536':  { w: 2048, h: 1536 },
    '3840x2160':  { w: 3840, h: 2160 },
    '2160x3840':  { w: 2160, h: 3840 },
  };
  if (gptSize === 'auto') return null;
  if (gptSize === 'custom') return { w: customW || 1024, h: customH || 1024 };
  return MAP[gptSize] || null;
}

// 测量图片实际输出尺寸（用于纠正 API 未严格遵循自定义尺寸的情况）
function getImageDims(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---------- 批量模式 ----------
const BATCH_MODES = [
  { id: 'none',       label: '关闭',   desc: '普通模式' },
  { id: 'single',     label: '逐张',   desc: '每张图独立生成' },
  { id: 'oneToMany',  label: '1对多',   desc: '一张图对多张图（自动检测方向）' },
  { id: 'oneToOne',   label: '1对1',   desc: '按顺序一一配对' },
  { id: 'allPairs',   label: '全配对', desc: '全部交叉组合' },
];

function getBatchModeDisplay(mode) {
  const m = BATCH_MODES.find(p => p.id === mode);
  return `批量模式${mode === 'none' ? ' \u00b7 ' : '\uff1a'}${m ? m.label : '关闭'}`;
}

function getExpectedPairCount(mode, countA, countB, tilesPerPair) {
  if (mode === 'none') return 0;
  if (mode === 'single') return countA > 0 ? tilesPerPair * countA : 0;
  if (countA === 0 || countB === 0) return 0;
  if (mode === 'oneToMany') return tilesPerPair * Math.max(countA, countB);
  if (mode === 'oneToOne')  return tilesPerPair * Math.min(countA, countB);
  if (mode === 'allPairs')  return tilesPerPair * countA * countB;
  return 0;
}

function generatePairs(mode, groupA, groupB) {
  const pairs = [];
  if (mode === 'oneToMany') {
    if (groupA.length === 1) {
      groupB.forEach(b => pairs.push({ a: groupA[0], b }));
    } else if (groupB.length === 1) {
      groupA.forEach(a => pairs.push({ a, b: groupB[0] }));
    } else {
      if (groupA.length <= groupB.length) {
        groupB.forEach(b => pairs.push({ a: groupA[0], b }));
      } else {
        groupA.forEach(a => pairs.push({ a, b: groupB[0] }));
      }
    }
  } else if (mode === 'oneToOne') {
    const len = Math.min(groupA.length, groupB.length);
    for (let i = 0; i < len; i++) pairs.push({ a: groupA[i], b: groupB[i] });
  } else if (mode === 'allPairs') {
    groupA.forEach(a => groupB.forEach(b => pairs.push({ a, b })));
  }
  return pairs;
}

function GeminiIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 22C12 17.5 8.5 14 4 14C8.5 14 12 10.5 12 6C12 10.5 15.5 14 20 14C15.5 14 12 17.5 12 22Z" fill="#1AABFF"/>
    </svg>
  );
}

function OpenAIIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <title>OpenAI</title>
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>
    </svg>
  );
}

function ModelSelect({ model, setModel }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const ref = React.useRef(null);
  const btnRef = React.useRef(null);
  const current = MODELS.find(m => m.id === model) || MODELS[0];

  React.useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target) && btnRef.current && !btnRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div style={{ position: 'relative' }}>
      <button ref={btnRef} className="bar-select model-select-btn" onClick={() => {
        if (!open && btnRef.current) {
          const r = btnRef.current.getBoundingClientRect();
          setPos({ top: r.bottom + 8, left: r.left });
        }
        setOpen(o => !o);
      }}>
        {model === 'gpt2' ? <OpenAIIcon size={14} /> : <GeminiIcon size={14} />}
        <span>{current.name}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .15s', flexShrink: 0 }}>
          <path d="M3 4.5L6 7.5L9 4.5"/>
        </svg>
      </button>
      {open && (
        <div ref={ref} className="model-dropdown" style={{ top: pos.top, left: pos.left }}>
          {MODELS.map(m => (
            <button key={m.id} className={`model-dropdown-item ${model === m.id ? 'active' : ''}`}
              onClick={() => { setModel(m.id); setOpen(false); }}>
              {m.id === 'gpt2' ? <OpenAIIcon size={14} /> : <GeminiIcon size={14} />}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left' }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</span>
                <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>{m.desc}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 各模型支持的分辨率档位
const RESOLUTIONS = {
  pro: [
    { id: '1K', label: '1K', desc: '标清' },
    { id: '2K', label: '2K', desc: '高清' },
    { id: '4K', label: '4K', desc: '超清' },
  ],
  nano: [
    { id: '1K', label: '1K', desc: '标清' },
  ],
  v2: [
    { id: '0.5K', label: '0.5K', desc: '草稿' },
    { id: '1K',   label: '1K',   desc: '标清' },
    { id: '2K',   label: '2K',   desc: '高清' },
    { id: '4K',   label: '4K',   desc: '超清' },
  ],
};

// 给定 aspect + resolution，返回真实输出像素尺寸（用于在 UI 中展示 "1024×1024" 等）
function getOutputDims(aspectId, resolutionId) {
  const a = ASPECT_PRESETS.find(p => p.id === aspectId);
  if (!a) return null;
  // 基准短边（按用户提供的 1K 表，1K ≈ 短边 ~1024，长边按比例放大）
  const baseShort = { '0.5K': 512, '1K': 1024, '2K': 2048, '4K': 4096 }[resolutionId] || 1024;
  const ratio = a.w / a.h;
  let w, h;
  if (ratio >= 1) { h = baseShort; w = Math.round(baseShort * ratio); }
  else            { w = baseShort; h = Math.round(baseShort / ratio); }
  // 对齐到 8 的倍数（生成模型的常见约束）
  w = Math.round(w / 8) * 8; h = Math.round(h / 8) * 8;
  return { w, h };
}

// 从 "W×H" 字符串解析尺寸（GPT Image 2 实际输出或自定义分辨率）
function parseResolutionDims(resolution) {
  if (!resolution || typeof resolution !== 'string') return null;
  const m = resolution.match(/^(\d+)[×x](\d+)$/);
  if (m) return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
  return null;
}


// ---------- 图标 (lucide-style inline SVGs) ----------
const Icon = ({ name, size = 18, className = '' }) => {
  const props = {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.75,
    strokeLinecap: 'round', strokeLinejoin: 'round', className,
  };
  switch (name) {
    case 'banana':
      return <svg {...props}><path d="M4 13c.6 5.6 6.5 9 11 7 4.5-2 6-7 5-10-.5 1.5-2 2.5-4 2.5C12 12.5 9 9 4 13z"/><path d="M19 10c1-1.5 1-3 .5-4.5"/></svg>;
    case 'send':
      return <svg {...props}><path d="M5 12l14-7-7 14-2-5-5-2z"/></svg>;
    case 'image':
      return <svg {...props}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>;
    case 'upload':
      return <svg {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>;
    case 'history':
      return <svg {...props}><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>;
    case 'download':
      return <svg {...props}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>;
    case 'share':
      return <svg {...props}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>;
    case 'close':
      return <svg {...props}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
    case 'plus':
      return <svg {...props}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case 'sliders':
      return <svg {...props}><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>;
    case 'menu':
      return <svg {...props}><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>;
    case 'copy':
      return <svg {...props}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
    case 'edit':
      return <svg {...props}><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>;
    case 'refresh':
      return <svg {...props}><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>;
    case 'gear':
      return <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    default: return null;
  }
};

// ---------- 子组件 ----------
function AspectChip({ preset, active, onClick }) {
  // 形状预览：14×14 容器，按比例填充
  const max = 14;
  const ratio = preset.w / preset.h;
  let bw, bh;
  if (ratio >= 1) { bw = max; bh = Math.max(2, Math.round(max / ratio)); }
  else            { bh = max; bw = Math.max(2, Math.round(max * ratio)); }
  return (
    <button className={`chip ${active ? 'active' : ''}`} onClick={onClick} title={preset.id}>
      <span className="chip-ratio" style={{ width: bw, height: bh }} />
      {preset.id}
    </button>
  );
}

function ResolutionSegment({ resolution, setResolution, model }) {
  const items = RESOLUTIONS[model] || [];
  return (
    <div className="seg">
      {items.map(r => (
        <button key={r.id}
          className={`seg-item ${resolution === r.id ? 'active' : ''}`}
          onClick={() => setResolution(r.id)}
          title={r.desc}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

function BillingSegment({ billingMode, setBillingMode, hidePerUse }) {
  return (
    <div className="seg">
      <button className={`seg-item ${billingMode === 'per-image' ? 'active' : ''}`} onClick={() => setBillingMode('per-image')}>
        按张计费
      </button>
      {!hidePerUse && (
      <button className={`seg-item ${billingMode === 'per-use' ? 'active' : ''}`} onClick={() => setBillingMode('per-use')}>
        按量计费
      </button>
      )}
    </div>
  );
}

function SettingsPanel({ aspect, setAspect, count, setCount, model, setModel, resolution, setResolution, layout = 'desktop' }) {
  const visibleAspects = ASPECT_PRESETS.filter(p => p.models.includes(model));
  const dims = getOutputDims(aspect, resolution);
  return (
    <div className={`settings ${layout}`}>
      <div className="setting">
        <div className="setting-label">
          <span>模型</span>
        </div>
        <select className="model-select" value={model} onChange={e => setModel(e.target.value)}>
          {MODELS.map(m => (
            <option key={m.id} value={m.id}>{m.name} — {m.desc}</option>
          ))}
        </select>
      </div>
      <div className="setting">
        <div className="setting-label">
          <span>分辨率</span>
          {dims && <span className="val" style={{ fontFamily: 'var(--font-mono)' }}>{dims.w}×{dims.h}</span>}
        </div>
        <ResolutionSegment resolution={resolution} setResolution={setResolution} model={model} />
      </div>
      <div className="setting">
        <div className="setting-label">
          <span>宽高比例</span>
          <span className="val">{aspect}</span>
        </div>
        <div className="chips">
          {visibleAspects.map(p => (
            <AspectChip key={p.id} preset={p} active={aspect === p.id} onClick={() => setAspect(p.id)} />
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="setting-label">
          <span>生图数量</span>
          <span className="val">{count}</span>
        </div>
        <div className="slider-wrap">
          <input type="range" min="1" max="8" value={count}
            onChange={e => setCount(Number(e.target.value))} className="slider" />
        </div>
      </div>
    </div>
  );
}

// ---------- API 网络线路 ----------
const ROUTES = [
  { id: 'global', label: '全球加速', desc: '默认线路，全球访问优化' },
  { id: 'cf', label: 'CF 加速', desc: 'Cloudflare 加速节点' },
  { id: 'us', label: '美国直连', desc: '美国服务器直连' },
];

function ApiSettingsModal({ open, onClose, currentRoute, hasSavedKey, selectedRoute, onRouteChange, inputApiKey, onApiKeyChange, testStatus, testMessage, onTest, onConfirm, onClear, saving, showApiKey, onToggleShowKey }) {
  if (!open) return null;
  const canConfirm = testStatus === 'success' && !saving;
  const keyConfigured = hasSavedKey;
  return (
    <React.Fragment>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">
        <div className="modal-header">
          <h3 className="modal-title">API 设置</h3>
          <button className="icon-btn" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>

        <div className="modal-body">
          <div className="modal-section">
            <div className="modal-section-label">网络线路</div>
            <div className="route-cards">
              {ROUTES.map(r => {
                const isCurrent = currentRoute === r.id;
                const isSelected = selectedRoute === r.id;
                return (
                  <div key={r.id}
                    className={`route-card ${isSelected ? 'active' : ''}`}
                    onClick={() => onRouteChange(r.id)}>
                    <div className="route-card-label">
                      {r.label}
                      {isCurrent && <span className="route-card-badge">当前</span>}
                    </div>

                    <div className="route-card-desc">{r.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="modal-section">
            <div className="modal-section-label">
              API 密钥
              <span className="modal-section-hint">
                {keyConfigured ? '已配置 · 输入可替换' : '未配置 · 保存后可启用'}
              </span>
            </div>
            <div className="api-key-input-wrap">
              <input
                type="text"
                className={`api-key-input ${showApiKey ? '' : 'masked'}`}
                placeholder="请输入你的 API Key"
                value={inputApiKey}
                onChange={e => onApiKeyChange(e.target.value)}
                autoComplete="off"
                name="api-key-input"
              />
              <button className="api-key-toggle" onClick={onToggleShowKey} tabIndex={-1}>
                {showApiKey ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            </div>
          </div>

          {testMessage && (
            <div className={`test-result ${testStatus === 'success' ? 'success' : testStatus === 'error' ? 'error' : ''}`}>
              {testStatus === 'testing' && <span className="test-spinner" />}
              <span>{testMessage}</span>
            </div>
          )}

          <div className="modal-actions">
            <button
              className="api-btn api-btn-test"
              onClick={onTest}
              disabled={!inputApiKey.trim() || testStatus === 'testing'}>
              {testStatus === 'testing' ? '测试中...' : '测试连接'}
            </button>
            <button
              className={`api-btn api-btn-confirm ${canConfirm ? '' : 'disabled'}`}
              onClick={onConfirm}
              disabled={!canConfirm}>
              {saving ? '保存中...' : '确认保存'}
            </button>
          </div>
          {hasSavedKey && (
            <div className="modal-actions-clear">
              <button className="api-btn-clear" onClick={onClear}>清除已保存的 API Key</button>
            </div>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

function Drawer({ open, onClose, children }) {
  if (!open) return null;
  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose} style={{ display: 'block' }} />
      <div className="drawer" style={{ display: 'block' }}>
        <div className="drawer-handle" />
        <h3 className="drawer-title">生图设置</h3>
        {children}
        <button className="tool-btn" style={{ width: '100%', justifyContent: 'center', padding: '12px', marginTop: '8px', background: 'var(--fg-1)', color: '#fff' }} onClick={onClose}>完成</button>
      </div>
    </React.Fragment>
  );
}

function Toast({ msg }) {
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}

// ---------- 主应用 ----------
function App() {
  const [prompt, setPrompt] = useState(() => {
    try { return localStorage.getItem('draft_prompt') || ''; } catch { return ''; }
  });
  const [images, setImages] = useState(() => {
    try {
      const saved = localStorage.getItem('draft_images');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  }); // {id, url}
  const [aspect, setAspect] = useState('1:1');
  const [count, setCount] = useState(1);
  const [model, setModel] = useState('pro');
  const [resolution, setResolution] = useState('1K');
  const [billingMode, setBillingMode] = useState('per-image'); // 'per-image' | 'per-use'
  const [gptSize, setGptSize] = useState('auto');
  const [gptQuality, setGptQuality] = useState('auto');
  const [gptFormat, setGptFormat] = useState('png');
  const [gptCompression, setGptCompression] = useState(100);
  const [gptCustomW, setGptCustomW] = useState(1024);
  const [gptCustomH, setGptCustomH] = useState(1024);
  const [gptCustomWStr, setGptCustomWStr] = useState('1024');
  const [gptCustomHStr, setGptCustomHStr] = useState('1024');
  const [gptMask, setGptMask] = useState(null);       // 编辑蒙版 File（编辑模式 + 非编辑模式通用）
  const [gptMaskUrl, setGptMaskUrl] = useState(null);  // 蒙版预览 data URL

  // 草稿持久化：prompt 实时写，images 防抖 300ms
  useEffect(() => {
    try { localStorage.setItem('draft_prompt', prompt); } catch {}
  }, [prompt]);

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem('draft_images', JSON.stringify(images)); } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [images]);

  // 离开 GPT 模型或清空参考图时，清除蒙版
  useEffect(() => {
    if (model !== 'gpt2' || images.length === 0) {
      setGptMask(null);
      setGptMaskUrl(null);
    }
  }, [model, images.length]);

  // 切换模型时：若当前 aspect / resolution 在新模型下不可用，clamp 到合法值
  // Nano Banana 固定为按张计费
  useEffect(() => {
    const aspectOk = ASPECT_PRESETS.some(p => p.id === aspect && p.models.includes(model));
    if (!aspectOk) setAspect('1:1');
    const resOk = (RESOLUTIONS[model] || []).some(r => r.id === resolution);
    if (!resOk) setResolution('1K');
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps
  const [generations, setGenerations] = useState([]); // newest first
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [googleSearch, setGoogleSearch] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState('High');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [galleryView, setGalleryView] = useState('grid'); // 'grid' | 'date'
  const [lightbox, setLightbox] = useState(null); // { url, prompt, model, resolution, aspect, outDims, elapsed, time, tokens, isEdit, originalPrompt } or null
  const [imgZoom, setImgZoom] = useState(1);
  const [imgPan, setImgPan] = useState({ x: 0, y: 0 });
  const [imgDragging, setImgDragging] = useState(false);
  const imgDragRef = useRef(null);
  const imgWrapRef = useRef(null);
  const imgZoomRef = useRef(imgZoom);
  const handleImgWheelRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [tick, setTick] = useState(0); // 每秒递增，驱动 loading tile 计时刷新
  const [editSource, setEditSource] = useState(null); // { gen, tile } — 编辑模式：恢复所有参数
  const [paramsPanelPos, setParamsPanelPos] = useState({ top: 0, left: 0 });
  const fileInputRef = useRef(null);
  const maskInputRef = useRef(null);
  const textareaRef = useRef(null);
  const paramsPillRef = useRef(null);
  const paramsPanelRef = useRef(null);
  const activeGenerationsRef = useRef(new Map()); // genId → { controllers: [{ requestId, abortController, tileId }], cancelled: bool }

  // 批量模式
  const [batchMode, setBatchMode] = useState('none'); // 'none' | 'single' | 'oneToMany' | 'oneToOne' | 'allPairs'
  const [groupAImages, setGroupAImages] = useState([]);
  const [groupBImages, setGroupBImages] = useState([]);
  const [groupCImages, setGroupCImages] = useState([]);
  const [batchModeOpen, setBatchModeOpen] = useState(false);
  const [batchPanelPos, setBatchPanelPos] = useState({ top: 0, left: 0 });
  const batchPillRef = useRef(null);
  const batchPanelRef = useRef(null);
  const fileInputARef = useRef(null);
  const fileInputBRef = useRef(null);
  const fileInputCRef = useRef(null);

  // API 设置
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const [currentRoute, setCurrentRoute] = useState('global');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [savedApiKey, setSavedApiKey] = useState('');
  const [selectedRoute, setSelectedRoute] = useState('global');
  const [inputApiKey, setInputApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState(null); // null | 'testing' | 'success' | 'error'
  const [testMessage, setTestMessage] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [keyPreview, setKeyPreview] = useState('');

  // 点击外部关闭参数面板
  useEffect(() => {
    if (!paramsOpen) return;
    const handler = (e) => {
      if (
        paramsPillRef.current && !paramsPillRef.current.contains(e.target) &&
        paramsPanelRef.current && !paramsPanelRef.current.contains(e.target)
      ) setParamsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [paramsOpen]);

  // 点击外部关闭配对下拉
  useEffect(() => {
    if (!batchModeOpen) return;
    const handler = (e) => {
      if (
        batchPillRef.current && !batchPillRef.current.contains(e.target) &&
        batchPanelRef.current && !batchPanelRef.current.contains(e.target)
      ) setBatchModeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [batchModeOpen]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  }, []);

  // 加载当前 API 配置
  const loadApiConfig = useCallback(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => {
        setCurrentRoute(cfg.route || 'global');
        setSelectedRoute(cfg.route || 'global');
        const configured = cfg.configured || false;
        setHasSavedKey(configured);
        setSavedApiKey(configured ? (cfg.apiKey || '') : '');
        setKeyPreview(cfg.keyPreview || '');
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadApiConfig(); }, [loadApiConfig]);

  // 打开设置时同步当前状态
  const openApiSettings = useCallback(() => {
    // 先用当前已知值立即打开，避免白屏等待
    setSelectedRoute(currentRoute);
    setInputApiKey(savedApiKey);
    setShowApiKey(false);
    setTestStatus(null);
    setTestMessage('');
    setApiSettingsOpen(true);
    // 异步刷新最新配置
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => {
        setCurrentRoute(cfg.route || 'global');
        setSelectedRoute(cfg.route || 'global');
        const configured = cfg.configured || false;
        setHasSavedKey(configured);
        const key = configured ? (cfg.apiKey || '') : '';
        setSavedApiKey(key);
        setInputApiKey(key);
        setKeyPreview(cfg.keyPreview || '');
      })
      .catch(() => {});
  }, [currentRoute, savedApiKey]);
  const testApiConnection = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const res = await fetch('/api/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: selectedRoute, apiKey: inputApiKey }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus('success');
        setTestMessage('连接成功，API 可用');
      } else {
        setTestStatus('error');
        setTestMessage(data.error || '测试失败');
      }
    } catch (e) {
      setTestStatus('error');
      setTestMessage(`网络错误: ${e.message}`);
    }
  }, [selectedRoute, inputApiKey]);

  // 确认保存配置
  const confirmSaveConfig = useCallback(async () => {
    if (testStatus !== 'success') return;
    setSavingConfig(true);
    try {
      const res = await fetch('/api/config/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: selectedRoute, apiKey: inputApiKey }),
      });
      const data = await res.json();
      if (data.ok) {
        setCurrentRoute(selectedRoute);
        setHasSavedKey(true);
        setSavedApiKey(inputApiKey);
        setKeyPreview(inputApiKey.slice(0,5) + '****' + inputApiKey.slice(-4));
        setApiSettingsOpen(false);
        showToast('API 配置已保存');
      } else {
        showToast(data.error || '保存失败');
      }
    } catch (e) {
      showToast(`保存失败: ${e.message}`);
    } finally {
      setSavingConfig(false);
    }
  }, [testStatus, selectedRoute, inputApiKey, showToast]);

  // 清除 API 配置
  const clearApiConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config/clear', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setHasSavedKey(false);
        setSavedApiKey('');
        setKeyPreview('');
        setInputApiKey('');
        setTestStatus(null);
        setTestMessage('');
        showToast('API Key 已清除');
      } else {
        showToast(data.error || '清除失败');
      }
    } catch (e) {
      showToast(`清除失败: ${e.message}`);
    }
  }, [showToast]);

  // 输入变更时重置测试状态
  const handleApiKeyChange = useCallback((val) => {
    setInputApiKey(val);
    if (testStatus === 'success') {
      setTestStatus(null);
      setTestMessage('');
    }
  }, [testStatus]);

  const handleRouteChange = useCallback((route) => {
    setSelectedRoute(route);
    if (testStatus === 'success') {
      setTestStatus(null);
      setTestMessage('');
    }
  }, [testStatus]);

  // 自适应 textarea 高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [prompt]);

  // loading tile 计时器
  useEffect(() => {
    const hasLoading = generations.some(gen => gen.tiles.some(t => t.status === 'loading'));
    if (!hasLoading) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [generations]);

  // 添加图片（公共函数）
  const addImages = useCallback((files) => {
    const fileArr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (fileArr.length === 0) return;
    const remaining = 14 - images.length;
    if (remaining <= 0) {
      showToast('最多上传 14 张图片');
      return;
    }
    const accepted = fileArr.slice(0, remaining);
    if (fileArr.length > remaining) showToast(`仅添加前 ${remaining} 张（最多 14 张）`);
    accepted.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        setImages(prev => [...prev, { id: Math.random().toString(36).slice(2), url: e.target.result }]);
      };
      reader.readAsDataURL(file);
    });
  }, [images.length, showToast]);

  const removeImage = (id) => setImages(prev => prev.filter(i => i.id !== id));

  // A/B 组图片管理（批量模式）
  const addImagesToGroupA = useCallback((files) => {
    const fileArr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (fileArr.length === 0) return;
    fileArr.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => setGroupAImages(prev => [...prev, { id: Math.random().toString(36).slice(2), url: e.target.result }]);
      reader.readAsDataURL(file);
    });
  }, []);

  const addImagesToGroupB = useCallback((files) => {
    const fileArr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (fileArr.length === 0) return;
    fileArr.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => setGroupBImages(prev => [...prev, { id: Math.random().toString(36).slice(2), url: e.target.result }]);
      reader.readAsDataURL(file);
    });
  }, []);

  const removeImageFromGroupA = (id) => setGroupAImages(prev => prev.filter(i => i.id !== id));
  const removeImageFromGroupB = (id) => setGroupBImages(prev => prev.filter(i => i.id !== id));

  const addImagesToGroupC = useCallback((files) => {
    const fileArr = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (fileArr.length === 0) return;
    const remaining = 14 - groupCImages.length;
    if (remaining <= 0) { showToast('参考图最多上传 14 张图片'); return; }
    const accepted = fileArr.slice(0, remaining);
    if (fileArr.length > remaining) showToast(`仅添加前 ${remaining} 张`);
    accepted.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => setGroupCImages(prev => [...prev, { id: Math.random().toString(36).slice(2), url: e.target.result }]);
      reader.readAsDataURL(file);
    });
  }, [groupCImages.length, showToast]);

  const removeImageFromGroupC = (id) => setGroupCImages(prev => prev.filter(i => i.id !== id));

  // 全局拖拽监听
  useEffect(() => {
    let counter = 0;
    const onEnter = (e) => { e.preventDefault(); counter++; if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) setDragging(true); };
    const onOver  = (e) => { e.preventDefault(); };
    const onLeave = (e) => { e.preventDefault(); counter--; if (counter <= 0) { counter = 0; setDragging(false); } };
    const onDrop  = (e) => { e.preventDefault(); counter = 0; setDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        if (batchMode !== 'none') addImagesToGroupA(e.dataTransfer.files);
        else addImages(e.dataTransfer.files);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addImages, addImagesToGroupA, batchMode]);

  // 粘贴上传
  useEffect(() => {
    const onPaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        if (batchMode !== 'none') addImagesToGroupA(files);
        else addImages(files);
        showToast('已从剪贴板添加图片');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImages, addImagesToGroupA, batchMode, showToast]);

  const canSend = prompt.trim().length > 0;

  const dispatchGenCard = (singlePrompt, refs, overrides = {}) => {
    const a = overrides.aspect != null ? overrides.aspect : aspect;
    const r = overrides.resolution || resolution;
    const m = overrides.modelId || model;
    const c = overrides.count || count;
    const isEdit = !!overrides.isEdit;
    const parentImageUrl = overrides.parentImageUrl || null;
    const originalPrompt = overrides.originalPrompt || null;
    const pairInfo = overrides.pairInfo || null;

    const genId = Math.random().toString(36).slice(2);
    const modelObj = MODELS.find(mo => mo.id === m);
    const isGpt = m === 'gpt2';

    // GPT 从 gptSize 算尺寸 / 比例；Gemini 从 aspect + resolution 算
    const gptDims = isGpt ? getGptSizeDims(gptSize, gptCustomW, gptCustomH) : null;
    const aspectPreset = isGpt ? null : ASPECT_PRESETS.find(p => p.id === a);
    const outDims = isGpt ? gptDims : getOutputDims(a, r);
    const displayAspect = isGpt
      ? (gptDims ? `${gptDims.w}:${gptDims.h}` : 'auto')
      : a;
    const aspectStyle = isGpt
      ? (gptDims ? { aspectRatio: `${gptDims.w} / ${gptDims.h}` } : {})
      : (aspectPreset ? { aspectRatio: `${aspectPreset.w} / ${aspectPreset.h}` } : {});

    const gen = {
      id: genId,
      prompt: singlePrompt,
      aspect: displayAspect,
      aspectStyle,
      resolution: isGpt ? (gptDims ? `${gptDims.w}×${gptDims.h}` : 'auto') : r,
      outDims,
      count: c,
      model: modelObj.name,
      modelShort: modelObj.short,
      modelId: m,
      billingMode,
      refs,
      googleSearch,
      thinkingLevel,
      gptSize,
      gptQuality,
      gptFormat,
      gptCompression,
      gptCustomW,
      gptCustomH,
      tiles: Array.from({ length: c }, (_, j) => ({ id: `${genId}-${j}`, status: 'loading', url: null })),
      time: new Date(),
      dateLabel: new Date().toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' }),
      isEdit,
      parentImageUrl,
      originalPrompt,
      pairInfo,
    };

    setGenerations(prev => [gen, ...prev]);

    const controllers = [];
    gen.tiles.forEach((tile) => {
      const abortController = new AbortController();
      const requestId = `${genId}-${tile.id}`;
      controllers.push({ requestId, abortController, tileId: tile.id });
    });
    activeGenerationsRef.current.set(genId, { controllers, cancelled: false });

    const genStart = performance.now();
    let completedTiles = 0;
    const totalTiles = gen.tiles.length;

    gen.tiles.forEach((tile) => {
      (async () => {
        const ctrl = controllers.find(ct => ct.tileId === tile.id);
        try {
          const isGpt = gen.modelId === 'gpt2';
          const gptSizeStr = gen.gptSize === 'custom' ? `${gen.gptCustomW}x${gen.gptCustomH}` : gen.gptSize;
          // GPT 图生图：显式编辑模式用 parentImageUrl，上传参考图时取第一张作为底图
          const gptSourceUrl = gen.isEdit
            ? gen.parentImageUrl
            : (gen.refs.length > 0 ? gen.refs[0].url : null);
          // GPT 蒙版：编辑模式或有参考图时均可使用
          const gptEditMask = (gen.isEdit || gen.refs.length > 0) ? gptMask : null;
          const result = isGpt && gptSourceUrl
            ? await callGptImageEdit(
                singlePrompt, gen.modelId, gen.count || 1, gptSizeStr, gen.gptQuality,
                gen.gptFormat, gen.gptCompression, gen.billingMode,
                gptSourceUrl, gptEditMask,
                ctrl?.abortController?.signal, ctrl?.requestId
              )
            : isGpt
            ? await callGptImageGeneration(
                singlePrompt, gen.modelId, gen.count || 1, gptSizeStr, gen.gptQuality,
                gen.gptFormat, gen.gptCompression, gen.billingMode,
                (partialB64) => {
                  const partialUrl = `data:image/${gen.gptFormat || 'png'};base64,${partialB64}`;
                  setGenerations(prev => prev.map(g => {
                    if (g.id !== genId) return g;
                    return { ...g, tiles: g.tiles.map(t => t.id === tile.id ? { ...t, partialUrl } : t) };
                  }));
                },
                ctrl?.abortController?.signal, ctrl?.requestId
              )
            : await callGeminiImageGeneration(
                singlePrompt, gen.refs, gen.aspect, gen.modelId, gen.resolution, null,
                ctrl?.abortController?.signal, ctrl?.requestId, gen.googleSearch, gen.thinkingLevel, gen.billingMode
              );
          setGenerations(prev => prev.map(g => {
            if (g.id !== genId) return g;
            const updated = {
              ...g,
              tiles: g.tiles.map(t => t.id === tile.id ? { ...t, status: 'done', url: result.url, tokens: result.tokens, responseContent: result.responseContent, debug: result.debug } : t),
            };
            return updated;
          }));
        } catch (err) {
          if (err.name === 'AbortError') {
            setGenerations(prev => prev.map(g => {
              if (g.id !== genId) return g;
              return {
                ...g,
                tiles: g.tiles.map(t => t.id === tile.id ? { ...t, status: 'cancelled' } : t),
              };
            }));
          } else {
            setGenerations(prev => prev.map(g => {
              if (g.id !== genId) return g;
              return {
                ...g,
                tiles: g.tiles.map(t => t.id === tile.id ? { ...t, status: 'error', error: err.message } : t),
              };
            }));
          }
        } finally {
          completedTiles++;
          if (completedTiles >= totalTiles) {
            const elapsed = ((performance.now() - genStart) / 1000).toFixed(1);
            const entry = activeGenerationsRef.current.get(genId);
            setGenerations(prev => {
              const updated = prev.map(g => g.id === genId ? { ...g, elapsed } : g);
              const final = updated.find(g => g.id === genId);
              if (final && !(entry && entry.cancelled)) saveGeneration(final);
              return updated;
            });
            activeGenerationsRef.current.delete(genId);
          }
        }
      })();
    });
  };

  const doGenerate = (params) => {
    const input = (params ? params.prompt : prompt).trim();
    if (!input) return;
    if (!hasSavedKey) {
      openApiSettings();
      return;
    }
    const a = params ? params.aspect : aspect;
    const r = params ? params.resolution : resolution;
    const m = params ? params.modelId : model;
    const c = params ? (params.count || 1) : count;
    const imgs = params ? (params.refs || []) : images;
    const editSrc = params ? null : editSource;

    // 批量模式 — 逐张
    if (batchMode === 'single' && groupAImages.length > 0) {
      if (editSrc) {
        showToast('批量模式下不支持编辑，请先关闭批量模式');
        return;
      }
      const maxReqSize = getMaxRequestSize(m);
      const firstRefs = [groupAImages[0], ...groupCImages];
      const estSize = estimateRequestBodySize(input, firstRefs);
      if (estSize > maxReqSize) {
        console.warn(`%c⚠️ 请求体估算 ${(estSize / 1024 / 1024).toFixed(1)}MB 超出 ${m} 系列上限 ${(maxReqSize / 1024 / 1024).toFixed(0)}MB`, 'color:#F2B33D');
        showToast(`参考图过大 (${(estSize / 1024 / 1024).toFixed(1)}MB)，请减少或缩小图片`);
        return;
      }
      const prompts = input.split(/(?:^|\n)---(?:\n|$)/).map(s => s.trim()).filter(Boolean);
      if (prompts.length === 0) prompts.push(input);
      // 图 × 提示词 裂变：每张图依次和每个提示词配对
      groupAImages.forEach((img) => {
        prompts.forEach((p) => {
          dispatchGenCard(p, [img, ...groupCImages], { count: c });
        });
      });
      return;
    }

    // 批量模式 — 配对
    if (batchMode !== 'none' && groupAImages.length > 0 && groupBImages.length > 0) {
      if (editSrc) {
        showToast('批量模式下不支持编辑，请先关闭批量模式');
        return;
      }
      const maxReqSize = getMaxRequestSize(m);
      const firstRefs = [groupAImages[0], groupBImages[0], ...groupCImages];
      const estSize = estimateRequestBodySize(input, firstRefs);
      if (estSize > maxReqSize) {
        console.warn(`%c⚠️ 请求体估算 ${(estSize / 1024 / 1024).toFixed(1)}MB 超出 ${m} 系列上限 ${(maxReqSize / 1024 / 1024).toFixed(0)}MB`, 'color:#F2B33D');
        showToast(`参考图过大 (${(estSize / 1024 / 1024).toFixed(1)}MB)，请减少或缩小图片`);
        return;
      }
      const pairs = generatePairs(batchMode, groupAImages, groupBImages);
      const prompts = input.split(/(?:^|\n)---(?:\n|$)/).map(s => s.trim()).filter(Boolean);
      pairs.forEach((pair, idx) => {
        const pairPrompt = prompts.length === pairs.length ? prompts[idx] : (prompts[0] || input);
        const refs = [pair.a, pair.b, ...groupCImages];
        dispatchGenCard(pairPrompt, refs, { count: c, pairInfo: { mode: batchMode, aId: pair.a.id, bId: pair.b.id } });
      });
      return;
    }

    // 普通模式 — 以 --- 分隔多套提示词
    const prompts = input.split(/(?:^|\n)---(?:\n|$)/).map(s => s.trim()).filter(Boolean);
    const currentEditSource = prompts.length > 1 ? null : editSrc;
    const isEditMode = !!currentEditSource;

    const maxReqSize = getMaxRequestSize(m);
    const estSize = estimateRequestBodySize(prompts[0], imgs);
    if (estSize > maxReqSize) {
      console.warn(`%c⚠️ 请求体估算 ${(estSize / 1024 / 1024).toFixed(1)}MB 超出 ${m} 系列上限 ${(maxReqSize / 1024 / 1024).toFixed(0)}MB`, 'color:#F2B33D');
      showToast(`参考图过大 (${(estSize / 1024 / 1024).toFixed(1)}MB)，请减少或缩小图片`);
      return;
    }

    if (currentEditSource) setEditSource(null);

    prompts.forEach((singlePrompt, promptIndex) => {
      dispatchGenCard(singlePrompt, imgs, {
        isEdit: isEditMode && promptIndex === 0,
        parentImageUrl: isEditMode ? currentEditSource.parentImageUrl : null,
        originalPrompt: isEditMode ? currentEditSource.originalPrompt : null,
      });
    });
  };

  const handleGenerate = () => doGenerate();

  const handleRerun = (gen) => {
    setEditSource(null);
    setPrompt(gen.prompt);
    setAspect(gen.aspect);
    setResolution(gen.resolution);
    setModel(gen.modelId);
    if (gen.gptSize) setGptSize(gen.gptSize);
    if (gen.gptQuality) setGptQuality(gen.gptQuality);
    if (gen.gptFormat) setGptFormat(gen.gptFormat);
    if (gen.gptCompression != null) setGptCompression(gen.gptCompression);
    if (gen.gptCustomW) { setGptCustomW(gen.gptCustomW); setGptCustomWStr(String(gen.gptCustomW)); }
    if (gen.gptCustomH) { setGptCustomH(gen.gptCustomH); setGptCustomHStr(String(gen.gptCustomH)); }
    setImages(gen.refs.map(r => ({ id: `rerun-${Math.random().toString(36).slice(2)}`, url: r.url, file: null })));
    doGenerate({
      prompt: gen.prompt,
      aspect: gen.aspect,
      resolution: gen.resolution,
      modelId: gen.modelId,
      count: gen.count || 1,
      refs: gen.refs,
    });
  };

  // 工具函数：从 responseContent 中移除图片数据以节省存储空间
  const stripImageDataFromResponse = (responseContent) => {
    if (!responseContent || !responseContent.body) return responseContent;

    const cleaned = JSON.parse(JSON.stringify(responseContent)); // 深拷贝

    if (cleaned.body.candidates) {
      cleaned.body.candidates.forEach(candidate => {
        if (candidate.content && candidate.content.parts) {
          candidate.content.parts.forEach(part => {
            if (part.inlineData && part.inlineData.data) {
              // 保留 mimeType，但移除 base64 数据
              part.inlineData.data = '[已移除以节省空间]';
            }
          });
        }
      });
    }

    return cleaned;
  };

  // 持久化 — 保存生成结果到服务端 /api/images
  const saveGeneration = useCallback(async (gen) => {
    const doneTiles = gen.tiles.filter(t => t.status === 'done');
    // 取消的生成也保存（无图片的元数据记录）
    if (doneTiles.length === 0 && !gen.cancelled) return;
    try {
      const refUrls = gen.refs.map(r => r.url);
      const images = doneTiles.length > 0 ? doneTiles.map(t => ({
        url: t.url,
        prompt: gen.prompt,
        model: gen.model,
        resolution: gen.resolution,
        aspect: gen.aspect,
        elapsed: gen.elapsed,
        tokens: t.tokens || 0,
        groupId: gen.id,
        time: gen.time,
        dateLabel: gen.dateLabel,
        responseContent: t.responseContent ? stripImageDataFromResponse(t.responseContent) : null,
        isEdit: gen.isEdit || false,
        parentImageUrl: gen.parentImageUrl || null,
        originalPrompt: gen.originalPrompt || null,
        pairInfo: gen.pairInfo || null,
        cancelled: gen.cancelled || false,
        refUrls,
      })) : [{
        // 取消的记录：无图片，仅保存元数据
        url: '',
        prompt: gen.prompt,
        model: gen.model,
        resolution: gen.resolution,
        aspect: gen.aspect,
        elapsed: gen.elapsed || null,
        tokens: 0,
        groupId: gen.id,
        time: gen.time,
        dateLabel: gen.dateLabel,
        responseContent: null,
        isEdit: gen.isEdit || false,
        parentImageUrl: gen.parentImageUrl || null,
        originalPrompt: gen.originalPrompt || null,
        pairInfo: gen.pairInfo || null,
        cancelled: true,
        refUrls,
      }];
      const res = await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      const data = await res.json();
      // 保存成功后，将 tile URL 从 data URL 替换为服务端路径，确保右键另存为格式正确
      if (data.filenames && data.filenames.length > 0) {
        const firstLocalUrl = `/api/images/${data.filenames[0]}`;
        setGenerations(prev => prev.map(g => {
          if (g.id !== gen.id) return g;
          return {
            ...g,
            tiles: g.tiles.map(t => {
              const doneIdx = doneTiles.findIndex(dt => dt.id === t.id);
              if (doneIdx >= 0 && data.filenames[doneIdx]) {
                return { ...t, url: `/api/images/${data.filenames[doneIdx]}` };
              }
              return t;
            }),
          };
        }));
        // 测量实际图片尺寸，纠正 GPT Image 2 未严格遵循自定义分辨率的情况
        // 注意：仅对 GPT 模型更新 resolution/outDims，Gemini 的 resolution ID 用于 re-run 不可覆盖
        if (gen.modelId === 'gpt2') {
          getImageDims(firstLocalUrl).then(actual => {
            if (actual && actual.w && actual.h) {
              setGenerations(prev => prev.map(g => {
                if (g.id !== gen.id) return g;
                return { ...g, outDims: actual, resolution: `${actual.w}×${actual.h}` };
              }));
            }
          });
        }
      }
    } catch (e) {
      console.warn('保存历史失败:', e.message);
    }
  }, []);

  const handleCancel = useCallback(async (genId) => {
    const entry = activeGenerationsRef.current.get(genId);
    if (!entry) return;

    // 1. 标记取消
    entry.cancelled = true;

    // 2. 中断所有前端 fetch 请求
    entry.controllers.forEach(c => c.abortController.abort());

    // 3. 通知后端取消 (发后不管)
    fetch('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_ids: entry.controllers.map(c => c.requestId) }),
    }).catch(() => {});

    // 4. 移除仍在 loading 的 tile，保留已完成的，标记取消
    setGenerations(prev => {
      const updated = prev.map(g => {
        if (g.id !== genId) return g;
        return {
          ...g,
          tiles: g.tiles.filter(t => t.status !== 'loading'),
          cancelled: true,
        };
      });
      const cancelled = updated.find(g => g.id === genId);
      if (cancelled) saveGeneration(cancelled);
      return updated;
    });

    showToast('已取消生成');
  }, [showToast, saveGeneration]);

  // 编辑功能：恢复原图和所有参数
  const handleEdit = (gen, tile) => {
    if (batchMode !== 'none') {
      showToast('批量模式下不支持编辑，请先关闭批量模式');
      return;
    }
    setPrompt(gen.prompt);

    setImages([{
      id: `edit-${tile.id}`,
      url: tile.url,
      file: null,
    }]);

    setModel(gen.modelId || 'pro');
    setResolution(gen.resolution || '1K');
    setAspect(gen.aspect || '1:1');
    if (gen.gptSize) setGptSize(gen.gptSize);
    if (gen.gptQuality) setGptQuality(gen.gptQuality);
    if (gen.gptFormat) setGptFormat(gen.gptFormat);
    if (gen.gptCompression != null) setGptCompression(gen.gptCompression);
    if (gen.gptCustomW) { setGptCustomW(gen.gptCustomW); setGptCustomWStr(String(gen.gptCustomW)); }
    if (gen.gptCustomH) { setGptCustomH(gen.gptCustomH); setGptCustomHStr(String(gen.gptCustomH)); }

    setGptMask(null);
    setGptMaskUrl(null);

    setEditSource({
      gen,
      tile,
      parentImageUrl: tile.url,
      originalPrompt: gen.prompt
    });

    setTimeout(() => {
      textareaRef.current?.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);

    showToast('已加载图片和参数，可以修改后重新生成');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleDownload = (url) => {
    showToast('开始下载…');
    let ext = 'png';
    // data URL: data:image/jpeg;base64,...
    let m = url.match(/data:image\/(\w+);/);
    if (m) {
      ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    } else {
      // server URL: /api/images/xxx.jpg
      m = url.match(/\.(\w+)(?:\?|$)/);
      if (m) ext = m[1];
    }
    const a = document.createElement('a');
    a.href = url; a.download = `banana-${Date.now()}.${ext}`; a.target = '_blank';
    document.body.appendChild(a); a.click(); a.remove();
  };
  const handleShare = () => showToast('链接已复制到剪贴板');
  const handleCopyPrompt = (text) => {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(()=>{});
    showToast('提示词已复制');
  };

  // Lightbox 图片缩放与拖拽
  const clampImgPan = (zoom, pan) => {
    const wrap = imgWrapRef.current;
    const img = wrap?.querySelector('img');
    if (!wrap || !img) return pan;
    const baseW = img.clientWidth;
    const baseH = img.clientHeight;
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const maxX = Math.max(0, (baseW * zoom - wrapW) / 2);
    const maxY = Math.max(0, (baseH * zoom - wrapH) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, pan.x)),
      y: Math.max(-maxY, Math.min(maxY, pan.y)),
    };
  };

  // 切换图片时重置缩放
  useEffect(() => {
    setImgZoom(1);
    setImgPan({ x: 0, y: 0 });
  }, [lightbox?.url]);

  const handleImgWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1 / 1.15 : 1.15;
    const prevZoom = imgZoomRef.current;
    const newZoom = Math.min(10, Math.max(1, prevZoom * factor));
    if (newZoom === prevZoom) return;
    setImgZoom(newZoom);
    setImgPan(prev => clampImgPan(newZoom, prev));
  };

  const handleImgMouseDown = (e) => {
    if (imgZoom <= 1) return;
    e.preventDefault();
    setImgDragging(true);
    imgDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: imgPan.x,
      panY: imgPan.y,
    };
  };

  useEffect(() => {
    if (!imgDragging) return;
    const handleMove = (e) => {
      const ref = imgDragRef.current;
      if (!ref) return;
      setImgPan(clampImgPan(imgZoom, {
        x: ref.panX + (e.clientX - ref.startX),
        y: ref.panY + (e.clientY - ref.startY),
      }));
    };
    const handleUp = () => setImgDragging(false);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [imgDragging, imgZoom]);

  // 保持 imgZoomRef 与 handleImgWheelRef 为最新值，避免闭包过期
  useEffect(() => { imgZoomRef.current = imgZoom; }, [imgZoom]);
  useEffect(() => { handleImgWheelRef.current = handleImgWheel; });

  // 用原生事件注册 wheel，避免 React passive 模式下 preventDefault 报错
  // lightbox 是条件渲染的，必须等它打开后 imgWrapRef 才有值
  useEffect(() => {
    const wrap = imgWrapRef.current;
    if (!wrap) return;
    const handler = (e) => handleImgWheelRef.current(e);
    wrap.addEventListener('wheel', handler, { passive: false });
    return () => wrap.removeEventListener('wheel', handler);
  }, [lightbox]);

  // 页面加载时从服务端恢复历史（分页加载）
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/images?offset=0&limit=50');
        if (!res.ok) return;
        const response = await res.json();

        const data = response.items || response;

        if (!Array.isArray(data) || !data.length) return;

        const restored = data.filter(item => item.filename || item.groupId).map(item => {
          const aspectPreset = ASPECT_PRESETS.find(p => p.id === item.aspect);
          return {
            id: item.groupId || item.filename || `old-${Math.random().toString(36).slice(2)}`,
            prompt: item.prompt || '',
            aspect: item.aspect || '',
            aspectStyle: aspectPreset ? { aspectRatio: `${aspectPreset.w} / ${aspectPreset.h}` } : undefined,
            resolution: item.resolution || '',
            outDims: getOutputDims(item.aspect, item.resolution) || parseResolutionDims(item.resolution),
            model: item.model || '',
            modelShort: item.model?.includes('GPT') ? 'GPT2' : item.model?.includes('2') ? 'v2' : 'Pro',
            modelId: item.model?.includes('GPT') ? 'gpt2' : item.model?.includes('2') ? 'v2' : 'pro',
            count: item.filename ? 1 : 0,
            refs: (item.refUrls || []).map((url, i) => ({ id: `ref-${item.filename || 'old'}-${i}`, url, file: null })),
            elapsed: item.elapsed || null,
            cancelled: item.cancelled || false,
            pairInfo: item.pairInfo || null,
            tiles: item.filename ? [{
              id: item.filename,
              status: 'done',
              url: `/api/images/${item.filename}`,
              tokens: item.tokens || 0,
              responseContent: item.responseContent || null,
            }] : [],
            time: item.time ? new Date(item.time) : null,
            dateLabel: item.dateLabel || null,
          };
        });

        setGenerations(prev => {
          const existingIds = new Set(prev.map(g => g.id));
          const newItems = restored.filter(r => !existingIds.has(r.id));
          return [...prev, ...newItems];
        });
      } catch (e) {
        // silent
      }
    })();
  }, []);

  const isEmpty = generations.length === 0;

  return (
    <div className="app" data-screen-label="01 Banana 图片生成">
      {/* 顶栏 */}
      <header className="header">
        <div className="brand">
          <div className="brand-mark">
            <img src="logo.png" alt="o1key" style={{width:32,height:32,borderRadius:9,display:'block'}} />
          </div>
          <span className="brand-name">o1key</span>
        </div>
      </header>

      <main className="main">
        {/* Hero */}
        <div className="hero">
          <h1 className="hero-title">开始 <span className="grad">高效创作吧！</span></h1>
        </div>

        {/* 输入区 */}
        <div className={`composer ${dragging ? 'dropping' : ''}`}>
          {/* 普通模式上传区 */}
          {!editSource && batchMode === 'none' && (
            <div className="upload-row">
              {images.map(img => (
                <div key={img.id} className="thumb">
                  <img src={img.url} alt="" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: img.url })} />
                  <button className="thumb-remove" onClick={() => removeImage(img.id)} aria-label="移除">
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
              {images.length < 14 && (
                <button className="thumb" style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => fileInputRef.current?.click()} aria-label="添加参考图">
                  <Icon name="plus" size={20} />
                </button>
              )}
              {/* GPT Image 2 蒙版上传（非编辑模式） */}
              {model === 'gpt2' && images.length > 0 && (
                gptMaskUrl ? (
                  <div className="thumb" style={{ borderColor: 'var(--warning, #F2B33D)' }}>
                    <img src={gptMaskUrl} alt="mask" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: gptMaskUrl })} />
                    <button className="thumb-remove" onClick={() => { setGptMask(null); setGptMaskUrl(null); }} aria-label="移除蒙版">
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                ) : (
                  <button className="thumb"
                    style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onClick={() => maskInputRef.current?.click()}
                    title="添加蒙版（可选，用于局部编辑）"
                    aria-label="添加蒙版">
                    <span style={{ fontSize: 11 }}>蒙版</span>
                  </button>
                )
              )}
            </div>
          )}

          {/* 批量模式上传区 */}
          {!editSource && batchMode !== 'none' && (
            <div>
              {/* 逐张模式：仅单排 */}
              {batchMode === 'single' && (
                <div className="batch-section">
                  <span className="batch-label">图片</span>
                  <div className="upload-row" style={{ paddingTop: 4 }}>
                    {groupAImages.map(img => (
                      <div key={img.id} className="thumb">
                        <img src={img.url} alt="" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: img.url })} />
                        <button className="thumb-remove" onClick={() => removeImageFromGroupA(img.id)} aria-label="移除">
                          <Icon name="close" size={11} />
                        </button>
                      </div>
                    ))}
                    <button className="thumb" style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onClick={() => fileInputARef.current?.click()} aria-label="添加图片">
                      <Icon name="plus" size={20} />
                    </button>
                  </div>
                </div>
              )}
              {/* 配对模式：A/B 双排 */}
              {batchMode !== 'single' && (
                <>
                  <div className="batch-section">
                    <span className="batch-label">A 主体</span>
                    <div className="upload-row" style={{ paddingTop: 4 }}>
                      {groupAImages.map(img => (
                        <div key={img.id} className="thumb">
                          <img src={img.url} alt="" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: img.url })} />
                          <button className="thumb-remove" onClick={() => removeImageFromGroupA(img.id)} aria-label="移除">
                            <Icon name="close" size={11} />
                          </button>
                        </div>
                      ))}
                      <button className="thumb" style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => fileInputARef.current?.click()} aria-label="添加A组图片">
                        <Icon name="plus" size={20} />
                      </button>
                    </div>
                  </div>
                  <div className="batch-section">
                    <span className="batch-label">B 目标</span>
                    <div className="upload-row" style={{ paddingTop: 4 }}>
                      {groupBImages.map(img => (
                        <div key={img.id} className="thumb">
                          <img src={img.url} alt="" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: img.url })} />
                          <button className="thumb-remove" onClick={() => removeImageFromGroupB(img.id)} aria-label="移除">
                            <Icon name="close" size={11} />
                          </button>
                        </div>
                      ))}
                      <button className="thumb" style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => fileInputBRef.current?.click()} aria-label="添加B组图片">
                        <Icon name="plus" size={20} />
                      </button>
                    </div>
                  </div>
                </>
              )}
              {/* 参考图 — 所有批量模式均显示 */}
              <div className="batch-section">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="batch-label">参考图（附加可选，最多14张）</span>
                  {groupCImages.length > 0 && (
                    <button onClick={() => setGroupCImages([])} style={{ fontSize: 11, color: 'var(--fg-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>清空</button>
                  )}
                </div>
                <div className="upload-row" style={{ paddingTop: 4 }}>
                  {groupCImages.map(img => (
                    <div key={img.id} className="thumb">
                      <img src={img.url} alt="" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: img.url })} />
                      <button className="thumb-remove" onClick={() => removeImageFromGroupC(img.id)} aria-label="移除">
                        <Icon name="close" size={11} />
                      </button>
                    </div>
                  ))}
                  {groupCImages.length < 14 && (
                    <button className="thumb" style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onClick={() => fileInputCRef.current?.click()} aria-label="添加参考图">
                      <Icon name="plus" size={20} />
                    </button>
                  )}
                </div>
              </div>
              {/* 预计数量 */}
              {((batchMode === 'single' && groupAImages.length > 0) ||
                (batchMode !== 'single' && groupAImages.length > 0 && groupBImages.length > 0)) && (
                <div className="batch-expected">
                  {batchMode === 'single'
                    ? `预计 ${getExpectedPairCount(batchMode, groupAImages.length, groupBImages.length, count)} 张 (${groupAImages.length} 张 × ${count} 张/张)`
                    : `预计 ${getExpectedPairCount(batchMode, groupAImages.length, groupBImages.length, count)} 张 (${generatePairs(batchMode, groupAImages, groupBImages).length} 组 × ${count} 张/组)`
                  }
                </div>
              )}
              <input ref={fileInputARef} type="file" accept="image/*" multiple style={{ display: 'none' }}
                onChange={(e) => { addImagesToGroupA(e.target.files); e.target.value = ''; }} />
              {batchMode !== 'single' && (
                <input ref={fileInputBRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
                  onChange={(e) => { addImagesToGroupB(e.target.files); e.target.value = ''; }} />
              )}
              <input ref={fileInputCRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
                onChange={(e) => { addImagesToGroupC(e.target.files); e.target.value = ''; }} />
            </div>
          )}

          {/* 编辑模式缩略图 */}
          {editSource && (
            <div className="upload-row">
              <div className="thumb" style={{ borderColor: 'var(--accent)' }}>
                <img src={editSource.tile.url} alt="" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: editSource.tile.url })} />
              </div>
              {/* 蒙版缩略图或上传按钮 */}
              {gptMaskUrl ? (
                <div className="thumb" style={{ borderColor: 'var(--warning, #F2B33D)' }}>
                  <img src={gptMaskUrl} alt="mask" style={{cursor:'zoom-in'}} onClick={() => setLightbox({ url: gptMaskUrl })} />
                  <button className="thumb-remove" onClick={() => { setGptMask(null); setGptMaskUrl(null); }} aria-label="移除蒙版">
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ) : (
                <button className="thumb"
                  style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => maskInputRef.current?.click()}
                  title="添加蒙版（可选）"
                  aria-label="添加蒙版">
                  <span style={{ fontSize: 11 }}>蒙版</span>
                </button>
              )}
              <div style={{ display:'flex',flexDirection:'column',justifyContent:'center',gap:2 }}>
                <span style={{ fontSize:12,fontWeight:500,color:'var(--fg-1)' }}>编辑模式</span>
                <span style={{ fontSize:11,color:'var(--fg-3)',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                  编辑自: {editSource.gen.prompt}
                </span>
              </div>
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="composer-input"
            placeholder={editSource ? '描述你想要的修改…  例：给这只猫戴上一顶巫师帽' : '描述你想生成的画面…  例：一只在月光下的橘猫，水彩风格\n\n多套提示词：用单独一行的 --- 分隔，每套独立生成'}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
          />

          <div className="composer-bar">
            <div className="composer-bar-left">
              {/* 模型 */}
              <ModelSelect model={model} setModel={setModel} />
              <span className="composer-bar-divider" />
              {/* 参数摘要按钮 + 浮层 */}
              <div style={{ position: 'relative' }}>
                <button ref={paramsPillRef} className={`params-pill ${paramsOpen ? 'active' : ''}`} onClick={() => {
                  if (!paramsOpen && paramsPillRef.current) {
                    const r = paramsPillRef.current.getBoundingClientRect();
                    setParamsPanelPos({ top: r.bottom + 8, left: r.left });
                  }
                  setParamsOpen(o => !o);
                }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{model === 'gpt2' ? `${(() => { if (gptSize === 'custom') return `${gptCustomW}×${gptCustomH}`; const sz = GPT_IMAGE_SIZES.find(s => s.id === gptSize); return sz && sz.w ? `${sz.w}×${sz.h}` : '自动'; })()} · ${GPT_IMAGE_QUALITIES.find(q => q.id === gptQuality)?.label} · ${count}张` : `${aspect} · ${resolution} · ${count}张`}</span>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: paramsOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .15s', flexShrink: 0 }}>
                    <path d="M3 4.5L6 7.5L9 4.5"/>
                  </svg>
                </button>
                {paramsOpen && (
                  <div ref={paramsPanelRef} className="params-panel" style={{ top: paramsPanelPos.top, left: paramsPanelPos.left }}>
                    {model !== 'gpt2' && (
                      <React.Fragment>
                        <div className="params-section">
                          <div className="params-label">宽高比例 <span className="params-val">{aspect}</span></div>
                          <div className="chips">
                            {ASPECT_PRESETS.filter(p => p.models.includes(model)).map(p => (
                              <AspectChip key={p.id} preset={p} active={aspect === p.id} onClick={() => setAspect(p.id)} />
                            ))}
                          </div>
                        </div>
                        <div className="params-section">
                          <div className="params-label">分辨率 <span className="params-val">{resolution}</span></div>
                          <ResolutionSegment resolution={resolution} setResolution={setResolution} model={model} />
                        </div>
                      </React.Fragment>
                    )}
                    {model === 'gpt2' && (
                      <React.Fragment>
                        <div className="params-section">
                          <div className="params-label">
                            尺寸
                            {(() => { const sz = GPT_IMAGE_SIZES.find(s => s.id === gptSize); return sz && sz.w ? <span className="params-val">{sz.w}×{sz.h}</span> : gptSize === 'custom' ? <span className="params-val">{gptCustomW}×{gptCustomH}</span> : null; })()}
                          </div>
                          <div className="seg" style={{ flexWrap: 'wrap' }}>
                            {GPT_IMAGE_SIZES.map(sz => (
                              <button key={sz.id} className={`seg-item ${gptSize === sz.id ? 'active' : ''}`} onClick={() => setGptSize(sz.id)} title={sz.w ? `${sz.w}×${sz.h}` : sz.id === 'custom' ? '自定义宽高' : '自动'}>
                                {sz.label}
                              </button>
                            ))}
                          </div>
                          {gptSize === 'custom' && (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <input type="number" className="custom-size-input" value={gptCustomWStr} onChange={e => setGptCustomWStr(e.target.value)} onBlur={() => { const w = gptCustomWStr === '' ? 1024 : Number(gptCustomWStr); const h = gptCustomHStr === '' ? 1024 : Number(gptCustomHStr); const c = clampGptSize(w, h); setGptCustomW(c.w); setGptCustomH(c.h); setGptCustomWStr(String(c.w)); setGptCustomHStr(String(c.h)); }} style={{ width: 80, padding: '6px 8px', background: 'var(--bg-raised)', border: 'var(--border-default) solid var(--line-1)', borderRadius: 'var(--radius-1)', color: 'var(--fg-1)', fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none' }} />
                                <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>×</span>
                                <input type="number" className="custom-size-input" value={gptCustomHStr} onChange={e => setGptCustomHStr(e.target.value)} onBlur={() => { const w = gptCustomWStr === '' ? 1024 : Number(gptCustomWStr); const h = gptCustomHStr === '' ? 1024 : Number(gptCustomHStr); const c = clampGptSize(w, h); setGptCustomW(c.w); setGptCustomH(c.h); setGptCustomWStr(String(c.w)); setGptCustomHStr(String(c.h)); }} style={{ width: 80, padding: '6px 8px', background: 'var(--bg-raised)', border: 'var(--border-default) solid var(--line-1)', borderRadius: 'var(--radius-1)', color: 'var(--fg-1)', fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none' }} />
                              </div>
                              <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 4 }}>16px倍数 · 3:1宽高比 · 105万~829万像素（≥1K）</div>
                            </div>
                          )}
                        </div>
                        <div className="params-section">
                          <div className="params-label">图片质量 <span className="params-val">{GPT_IMAGE_QUALITIES.find(q => q.id === gptQuality)?.label}</span></div>
                          <div className="seg">
                            {GPT_IMAGE_QUALITIES.map(q => (
                              <button key={q.id} className={`seg-item ${gptQuality === q.id ? 'active' : ''}`} onClick={() => setGptQuality(q.id)}>
                                {q.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="params-section">
                          <div className="params-label">输出格式 <span className="params-val">{GPT_IMAGE_FORMATS.find(f => f.id === gptFormat)?.label}</span></div>
                          <div className="seg">
                            {GPT_IMAGE_FORMATS.map(f => (
                              <button key={f.id} className={`seg-item ${gptFormat === f.id ? 'active' : ''}`} onClick={() => setGptFormat(f.id)}>
                                {f.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {(gptFormat === 'jpeg' || gptFormat === 'webp') && (
                          <div className="params-section">
                            <div className="params-label">输出压缩 <span className="params-val">{gptCompression}%</span></div>
                            <div className="slider-wrap"><input type="range" min="0" max="100" value={gptCompression} onChange={e => setGptCompression(Number(e.target.value))} className="slider" /></div>
                          </div>
                        )}
                      </React.Fragment>
                    )}
                    <div className="params-section">
                      <div className="params-label">
                        生图数量 <span className="params-val">{count} 张</span>
                        <span className="params-tip" title="多套提示词（用 --- 分隔）时，建议将数量改为 1">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                          </svg>
                          <span className="params-tip-text">多套提示词时建议改为 1</span>
                        </span>
                      </div>
                      <div className="seg">
                        {(model === 'gpt2' ? [1,2,3,4,5,6,7,8,9,10] : [1,2,3,4,5,6,7,8]).map(n => (
                          <button key={n} className={`seg-item ${count === n ? 'active' : ''}`} onClick={() => setCount(n)}>{n}</button>
                        ))}
                      </div>
                    </div>
                    {model !== 'gpt2' && model !== 'nano' && (
                      <React.Fragment>
                        <div className="params-section">
                          <div className="params-label">谷歌搜索</div>
                          <div className="seg">
                            <button className={`seg-item ${!googleSearch ? 'active' : ''}`} onClick={() => setGoogleSearch(false)}>关闭</button>
                            <button className={`seg-item ${googleSearch ? 'active' : ''}`} onClick={() => setGoogleSearch(true)}>打开</button>
                          </div>
                        </div>
                        {model === 'v2' && (
                          <div className="params-section">
                            <div className="params-label">思考等级</div>
                            <div className="seg">
                              <button className={`seg-item ${thinkingLevel === 'minimal' ? 'active' : ''}`} onClick={() => setThinkingLevel('minimal')}>最小</button>
                              <button className={`seg-item ${thinkingLevel === 'High' ? 'active' : ''}`} onClick={() => setThinkingLevel('High')}>高</button>
                            </div>
                          </div>
                        )}
                      </React.Fragment>
                    )}
                    <div className="params-section">
                      <div className="params-label">计费方式 <span className="params-val">{billingMode === 'per-use' ? '按量' : '按张'}</span></div>
                      <BillingSegment billingMode={billingMode} setBillingMode={setBillingMode} hidePerUse={model === 'nano'} />
                    </div>
                  </div>
                )}
              </div>
              <span className="composer-bar-divider" />
              {/* 批量模式 */}
              <div style={{ position: 'relative' }}>
                <button ref={batchPillRef} className={`params-pill ${batchMode !== 'none' ? 'batch-active' : ''} ${batchModeOpen ? 'active' : ''}`} onClick={() => {
                  if (!batchModeOpen && batchPillRef.current) {
                    const r = batchPillRef.current.getBoundingClientRect();
                    setBatchPanelPos({ top: r.bottom + 8, left: r.left });
                  }
                  setBatchModeOpen(o => !o);
                }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{getBatchModeDisplay(batchMode)}</span>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: batchModeOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform .15s', flexShrink: 0 }}>
                    <path d="M3 4.5L6 7.5L9 4.5"/>
                  </svg>
                </button>
                {batchModeOpen && (
                  <div ref={batchPanelRef} className="batch-dropdown" style={{ top: batchPanelPos.top, left: batchPanelPos.left }}>
                    <div className="batch-grid">
                      {BATCH_MODES.map(pm => {
                        const isSel = batchMode === pm.id;
                        return (
                          <button key={pm.id} className={`batch-mode-card ${isSel ? 'selected' : ''}`} onClick={() => {
                            if (pm.id !== batchMode) {
                              const pairingModes = ['oneToMany', 'oneToOne', 'allPairs'];
                              const keepImages = pairingModes.includes(batchMode) && pairingModes.includes(pm.id);
                              if (!keepImages) {
                                setImages([]);
                                setGroupAImages([]);
                                setGroupBImages([]);
                              }
                              setGroupCImages([]);
                            }
                            setBatchMode(pm.id);
                            setBatchModeOpen(false);
                          }}>
                            {isSel && (
                              <span className="batch-mode-check">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                              </span>
                            )}
                            <span className="batch-mode-icon">
                              {pm.id === 'none' && (
                                <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                  <circle cx="18" cy="18" r="10" />
                                  <line x1="11" y1="11" x2="25" y2="25" />
                                </svg>
                              )}
                              {pm.id === 'single' && (
                                <svg width="16" height="36" viewBox="0 0 16 36">
                                  <rect x="1" y="0" width="14" height="10" rx="3" fill="currentColor" opacity="0.9"/>
                                  <rect x="1" y="13" width="14" height="10" rx="3" fill="currentColor" opacity="0.9"/>
                                  <rect x="1" y="26" width="14" height="10" rx="3" fill="currentColor" opacity="0.9"/>
                                </svg>
                              )}
                              {pm.id === 'oneToMany' && (
                                <svg width="48" height="36" viewBox="0 0 48 36">
                                  <rect x="0" y="8" width="14" height="14" rx="3" fill="currentColor" opacity="0.9"/>
                                  <line x1="16" y1="15" x2="25" y2="15" stroke="currentColor" strokeWidth="1.3" opacity="0.5"/>
                                  <polygon points="26,11 32,15 26,19" fill="currentColor" opacity="0.5"/>
                                  <rect x="36" y="0" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                  <rect x="36" y="13" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                  <rect x="36" y="26" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                </svg>
                              )}
                              {pm.id === 'oneToOne' && (
                                <svg width="48" height="36" viewBox="0 0 48 36">
                                  <rect x="0" y="2" width="14" height="10" rx="3" fill="currentColor" opacity="0.9"/>
                                  <rect x="34" y="2" width="14" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                  <line x1="15" y1="7" x2="33" y2="7" stroke="currentColor" strokeWidth="1.3" opacity="0.5"/>
                                  <rect x="0" y="20" width="14" height="10" rx="3" fill="currentColor" opacity="0.9"/>
                                  <rect x="34" y="20" width="14" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                  <line x1="15" y1="25" x2="33" y2="25" stroke="currentColor" strokeWidth="1.3" opacity="0.5"/>
                                </svg>
                              )}
                              {pm.id === 'allPairs' && (
                                <svg width="48" height="36" viewBox="0 0 48 36">
                                  <rect x="0" y="2" width="14" height="10" rx="3" fill="currentColor" opacity="0.9"/>
                                  <rect x="0" y="20" width="14" height="10" rx="3" fill="currentColor" opacity="0.9"/>
                                  <rect x="34" y="0" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                  <rect x="34" y="13" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                  <rect x="34" y="26" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.6"/>
                                  <line x1="15" y1="7" x2="33" y2="5" stroke="currentColor" strokeWidth="1" opacity="0.35"/>
                                  <line x1="15" y1="7" x2="33" y2="18" stroke="currentColor" strokeWidth="1" opacity="0.35"/>
                                  <line x1="15" y1="7" x2="33" y2="31" stroke="currentColor" strokeWidth="1" opacity="0.35"/>
                                  <line x1="15" y1="25" x2="33" y2="5" stroke="currentColor" strokeWidth="1" opacity="0.35"/>
                                  <line x1="15" y1="25" x2="33" y2="18" stroke="currentColor" strokeWidth="1" opacity="0.35"/>
                                  <line x1="15" y1="25" x2="33" y2="31" stroke="currentColor" strokeWidth="1" opacity="0.35"/>
                                </svg>
                              )}
                            </span>
                            <span className="batch-mode-label">{pm.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <span className="composer-bar-divider" />
              <button className="tool-btn mobile-drawer-toggle" onClick={() => setDrawerOpen(true)}>
                <Icon name="sliders" size={16} />
                <span>{(MODELS.find(m => m.id === model) || MODELS[0]).short} · {resolution} · {aspect} · {count} 张</span>
              </button>
            </div>
            <div className="composer-bar-right">
              {editSource && (
                <button className="tool-btn" onClick={() => { setEditSource(null); setPrompt(''); setImages([]); setGptMask(null); setGptMaskUrl(null); }}
                  style={{ background:'var(--surface-2)',marginRight:4 }}>
                  <Icon name="close" size={14} />
                  <span style={{fontSize:12}}>取消编辑</span>
                </button>
              )}
              <span style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', marginRight: 4 }}>⌘ + ↵</span>
              <button className={`send-btn ${editSource ? 'editing' : ''} ${canSend ? 'ready' : ''}`}
                onClick={handleGenerate} disabled={!canSend} aria-label="生成">
                <Icon name="send" size={16} />
              </button>
            </div>
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
          <input ref={maskInputRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setGptMask(file);
                const reader = new FileReader();
                reader.onload = (ev) => setGptMaskUrl(ev.target.result);
                reader.readAsDataURL(file);
              }
              e.target.value = '';
            }} />
        </div>

        {/* 画廊标签栏 */}
        {generations.length > 0 && (
          <div className="section-head">
            <div className="gallery-tabs">
              <button className={`gallery-tab ${galleryView === 'grid' ? 'active' : ''}`}
                onClick={() => setGalleryView('grid')}>画廊</button>
              <button className={`gallery-tab ${galleryView === 'date' ? 'active' : ''}`}
                onClick={() => setGalleryView('date')}>日期</button>
            </div>
          </div>
        )}

        {/* 生成结果 — 统一画廊 */}
        {generations.length > 0 && (() => {
          const renderTile = ({ gen, tile }) => (
            <div key={tile.id}
              className={`gen-tile ${tile.status === 'loading' ? 'skeleton' : ''} ${tile.status === 'done' ? 'tile-enter' : ''}`}
              style={{ aspectRatio: gen.aspect ? gen.aspect.replace(':', ' / ') : '1 / 1' }}>
              {tile.status === 'loading' && (() => {
                const elapsed = gen.time ? Math.floor((Date.now() - new Date(gen.time).getTime()) / 1000) : 0;
                return (
                  <React.Fragment>
                    {tile.partialUrl && (
                      <img className="gen-tile-img" src={tile.partialUrl} alt="" style={{position:'absolute',inset:0,opacity:.7}} />
                    )}
                    <div className="skeleton-inner" style={{flexDirection:'column',gap:8,zIndex:1}}>
                      <div className="skeleton-spinner" />
                      <span style={{fontSize:11,color:'var(--fg-3)',fontFamily:'var(--font-mono)'}}>
                        {elapsed}s
                      </span>
                    </div>
                  </React.Fragment>
                );
              })()}
              {tile.status === 'cancelled' && (
                <div style={{
                  position:'absolute',inset:0,
                  display:'flex',alignItems:'center',justifyContent:'center',
                  padding:12,textAlign:'center',
                  fontSize:12,color:'var(--fg-3)',lineHeight:1.5,
                  flexDirection:'column',gap:4,
                  background:'var(--surface-2)',
                }}>
                  <div style={{
                    width:28,height:28,borderRadius:999,
                    background:'var(--line)',
                    display:'flex',alignItems:'center',justifyContent:'center',
                  }}>
                    <Icon name="close" size={14} />
                  </div>
                  <span style={{fontSize:11,color:'var(--fg-3)'}}>已取消</span>
                </div>
              )}
              {tile.status === 'done' && (
                <React.Fragment>
                  <img className="gen-tile-img"
                    src={tile.url && tile.url.startsWith('/api/images/') ? tile.url + '?thumb=1' : tile.url || undefined}
                    alt="" style={{cursor:'pointer'}}
                    loading="lazy"
                    onClick={() => {
                      const totalTokens = gen.tiles.reduce((sum, t) => sum + (t.tokens || 0), 0);
                      setLightbox({
                        url: tile.url,
                        prompt: gen.prompt,
                        model: gen.model,
                        modelId: gen.modelId,
                        resolution: gen.resolution,
                        aspect: gen.aspect,
                        outDims: gen.outDims,
                        elapsed: gen.elapsed,
                        time: gen.time,
                        tokens: tile.tokens || 0,
                        totalTokens,
                        isEdit: gen.isEdit,
                        originalPrompt: gen.originalPrompt,
                        cancelled: gen.cancelled,
                        gptQuality: gen.gptQuality,
                        gptFormat: gen.gptFormat,
                        gptCompression: gen.gptCompression,
                      });
                    }} />
                  <div className="gen-tile-overlay">
                    <button className="tile-action" title="编辑此图" onClick={() => handleEdit(gen, tile)}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button className="tile-action" title="再次生成" onClick={() => handleRerun(gen)}>
                      <Icon name="refresh" size={14} />
                    </button>
                  </div>
                </React.Fragment>
              )}
              {tile.status === 'error' && (
                <div style={{
                  position:'absolute',inset:0,
                  display:'flex',alignItems:'center',justifyContent:'center',
                  padding:12,textAlign:'center',
                  fontSize:12,color:'var(--error, #EF4444)',lineHeight:1.5,
                  flexDirection:'column',gap:4,
                  background:'var(--surface-2)',
                }}>
                  <span style={{fontWeight:600}}>生成失败</span>
                  <span style={{fontSize:11,opacity:.75}}>{tile.error || '未知错误'}</span>
                </div>
              )}
            </div>
          );

          if (galleryView === 'grid') {
            return (
              <div className="gen-grid">
                {generations.flatMap(gen => gen.tiles.map(tile => ({ gen, tile }))).map(renderTile)}
              </div>
            );
          }

          // 日期视图：按年月日分组，倒序排列
          // 优先使用创建时锁定的 dateLabel，避免时区变化导致日期漂移
          const tiles = generations.flatMap(gen => gen.tiles.map(tile => ({ gen, tile })));
          const groups = new Map();
          const unk = '未知日期';
          tiles.forEach(item => {
            let dateKey;
            if (item.gen.dateLabel) {
              dateKey = item.gen.dateLabel;
            } else if (item.gen.time) {
              dateKey = new Date(item.gen.time).toLocaleDateString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit' });
            } else {
              dateKey = unk;
            }
            if (!groups.has(dateKey)) groups.set(dateKey, []);
            groups.get(dateKey).push(item);
          });
          const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
            if (a === unk) return 1;
            if (b === unk) return -1;
            return b.localeCompare(a);
          });

          return (
            <div style={{ display:'flex', flexDirection:'column', gap: 24 }}>
              {sortedKeys.map(dateKey => (
                <div key={dateKey}>
                  <div className="date-header">{dateKey}</div>
                  <div className="gen-grid" style={{ marginTop: 8 }}>
                    {groups.get(dateKey).map(renderTile)}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </main>

      {/* 移动端抽屉 */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <div className="drawer-section">
          <div className="setting-label" style={{ marginBottom: 10 }}><span>模型</span></div>
          <select className="model-select" value={model} onChange={e => setModel(e.target.value)}>
            {MODELS.map(m => (<option key={m.id} value={m.id}>{m.name} — {m.desc}</option>))}
          </select>
        </div>
        {model !== 'gpt2' && (
          <React.Fragment>
            <div className="drawer-section">
              <div className="setting-label" style={{ marginBottom: 10 }}>
                <span>分辨率</span>
                {(() => { const d = getOutputDims(aspect, resolution); return d && <span className="val" style={{ fontFamily: 'var(--font-mono)' }}>{d.w}×{d.h}</span>; })()}
              </div>
              <ResolutionSegment resolution={resolution} setResolution={setResolution} model={model} />
            </div>
            <div className="drawer-section">
              <div className="setting-label" style={{ marginBottom: 10 }}><span>宽高比例</span><span className="val">{aspect}</span></div>
              <div className="chips">
                {ASPECT_PRESETS.filter(p => p.models.includes(model)).map(p => (
                  <AspectChip key={p.id} preset={p} active={aspect === p.id} onClick={() => setAspect(p.id)} />
                ))}
              </div>
            </div>
          </React.Fragment>
        )}
        {model === 'gpt2' && (
          <React.Fragment>
            <div className="drawer-section">
              <div className="setting-label" style={{ marginBottom: 10 }}>
                <span>尺寸</span>
                {(() => { const sz = GPT_IMAGE_SIZES.find(s => s.id === gptSize); return sz && sz.w ? <span className="val" style={{ fontFamily: 'var(--font-mono)' }}>{sz.w}×{sz.h}</span> : gptSize === 'custom' ? <span className="val" style={{ fontFamily: 'var(--font-mono)' }}>{gptCustomW}×{gptCustomH}</span> : <span className="val">自动</span>; })()}
              </div>
              <div className="seg" style={{ flexWrap: 'wrap' }}>
                {GPT_IMAGE_SIZES.map(sz => (
                  <button key={sz.id} className={`seg-item ${gptSize === sz.id ? 'active' : ''}`} onClick={() => setGptSize(sz.id)} title={sz.w ? `${sz.w}×${sz.h}` : sz.id === 'custom' ? '自定义宽高' : '自动'}>
                    {sz.label}
                  </button>
                ))}
              </div>
              {gptSize === 'custom' && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="number" className="custom-size-input" value={gptCustomWStr} onChange={e => setGptCustomWStr(e.target.value)} onBlur={() => { const w = gptCustomWStr === '' ? 1024 : Number(gptCustomWStr); const h = gptCustomHStr === '' ? 1024 : Number(gptCustomHStr); const c = clampGptSize(w, h); setGptCustomW(c.w); setGptCustomH(c.h); setGptCustomWStr(String(c.w)); setGptCustomHStr(String(c.h)); }} style={{ width: 80, padding: '6px 8px', background: 'var(--bg-raised)', border: 'var(--border-default) solid var(--line-1)', borderRadius: 'var(--radius-1)', color: 'var(--fg-1)', fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none' }} />
                    <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>×</span>
                    <input type="number" className="custom-size-input" value={gptCustomHStr} onChange={e => setGptCustomHStr(e.target.value)} onBlur={() => { const w = gptCustomWStr === '' ? 1024 : Number(gptCustomWStr); const h = gptCustomHStr === '' ? 1024 : Number(gptCustomHStr); const c = clampGptSize(w, h); setGptCustomW(c.w); setGptCustomH(c.h); setGptCustomWStr(String(c.w)); setGptCustomHStr(String(c.h)); }} style={{ width: 80, padding: '6px 8px', background: 'var(--bg-raised)', border: 'var(--border-default) solid var(--line-1)', borderRadius: 'var(--radius-1)', color: 'var(--fg-1)', fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none' }} />
                  </div>
                  <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 4 }}>16px倍数 · 3:1宽高比 · 105万~829万像素（≥1K）</div>
                </div>
              )}
            </div>
            <div className="drawer-section">
              <div className="setting-label" style={{ marginBottom: 10 }}>
                <span>图片质量</span>
                <span className="val">{GPT_IMAGE_QUALITIES.find(q => q.id === gptQuality)?.label}</span>
              </div>
              <div className="seg">
                {GPT_IMAGE_QUALITIES.map(q => (
                  <button key={q.id} className={`seg-item ${gptQuality === q.id ? 'active' : ''}`} onClick={() => setGptQuality(q.id)}>
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="drawer-section">
              <div className="setting-label" style={{ marginBottom: 10 }}>
                <span>输出格式</span>
                <span className="val">{GPT_IMAGE_FORMATS.find(f => f.id === gptFormat)?.label}</span>
              </div>
              <div className="seg">
                {GPT_IMAGE_FORMATS.map(f => (
                  <button key={f.id} className={`seg-item ${gptFormat === f.id ? 'active' : ''}`} onClick={() => setGptFormat(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            {(gptFormat === 'jpeg' || gptFormat === 'webp') && (
              <div className="drawer-section">
                <div className="setting-label" style={{ marginBottom: 10 }}><span>输出压缩</span><span className="val">{gptCompression}%</span></div>
                <div className="slider-wrap"><input type="range" min="0" max="100" value={gptCompression} onChange={e => setGptCompression(Number(e.target.value))} className="slider" /></div>
              </div>
            )}
          </React.Fragment>
        )}
        <div className="drawer-section">
          <div className="setting-label" style={{ marginBottom: 10 }}><span>生图数量</span><span className="val">{count}</span></div>
          <div className="slider-wrap"><input type="range" min="1" max={model === 'gpt2' ? 10 : 8} value={count} onChange={e => setCount(Number(e.target.value))} className="slider" /></div>
        </div>
        <div className="drawer-section">
          <div className="setting-label" style={{ marginBottom: 10 }}><span>计费方式</span><span className="val">{billingMode === 'per-use' ? '按量' : '按张'}</span></div>
          <BillingSegment billingMode={billingMode} setBillingMode={setBillingMode} hidePerUse={model === 'nano'} />
        </div>
      </Drawer>

      {/* 历史画廊 */}
      <div className={`history-panel ${historyOpen ? 'open' : ''}`}>
        <div className="history-head">
          <h3>历史记录</h3>
          <button className="icon-btn" onClick={() => setHistoryOpen(false)}><Icon name="close" size={18} /></button>
        </div>
        <div className="history-list">
          {generations.length === 0 && <div style={{ color: 'var(--fg-3)', fontSize: 13, padding: 16, textAlign: 'center' }}>暂无历史记录</div>}
          {generations.flatMap(g => g.tiles.filter(t => t.status === 'done').map(t => ({ tile: t, gen: g }))).map(({ tile, gen }) => (
            <div key={tile.id} className="history-item" onClick={() => handleDownload(tile.url)}>
              <div className="history-thumb"><img src={tile.url && tile.url.startsWith('/api/images/') ? tile.url + '?thumb=1' : tile.url || undefined} alt="" loading="lazy" /></div>
              <div className="history-meta">
                <div className="history-prompt">{gen.prompt}</div>
                <div className="history-time">{gen.aspect} · {gen.resolution} · {gen.model}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 拖拽蒙层 */}
      {dragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-inner">
            <h3>放开以上传图片</h3>
            <p>支持 JPG / PNG / WEBP，最多 14 张</p>
          </div>
        </div>
      )}

      <Toast msg={toast} />

      {/* 左下角令牌指示器 */}
      <div className={`token-indicator ${hasSavedKey ? 'has-key' : ''}`} onClick={openApiSettings} title={hasSavedKey ? '已配置令牌' : '点击添加令牌'}>
        {hasSavedKey ? (
          <React.Fragment>
            <span className="token-dot" />
            <span className="token-key">{keyPreview}</span>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <svg className="token-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            <span className="token-label">添加令牌</span>
          </React.Fragment>
        )}
      </div>

      {/* API 设置弹窗 */}
      <ApiSettingsModal
        open={apiSettingsOpen}
        onClose={() => { setApiSettingsOpen(false); setShowApiKey(false); }}
        currentRoute={currentRoute}
        hasSavedKey={hasSavedKey}
        selectedRoute={selectedRoute}
        onRouteChange={handleRouteChange}
        inputApiKey={inputApiKey}
        onApiKeyChange={handleApiKeyChange}
        testStatus={testStatus}
        testMessage={testMessage}
        onTest={testApiConnection}
        onConfirm={confirmSaveConfig}
        onClear={clearApiConfig}
        saving={savingConfig}
        showApiKey={showApiKey}
        onToggleShowKey={() => setShowApiKey(v => !v)}
      />

      {/* Lightbox — 点击图片放大 + 详情 */}
      {lightbox && (
        <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
          <div className="lightbox-container" onClick={e => e.stopPropagation()}>
            {lightbox.prompt && (
            <div className="lightbox-header">
              <span className="lightbox-title">{lightbox.prompt}</span>
              <button className="icon-btn" onClick={() => setLightbox(null)} style={{color:'#fff',background:'rgba(255,255,255,.15)',marginLeft:'auto'}}>
                <Icon name="close" size={20} />
              </button>
            </div>
            )}
            <div
              className="lightbox-img-wrap"
              ref={imgWrapRef}
              onMouseDown={handleImgMouseDown}
              onDoubleClick={() => { setImgZoom(1); setImgPan({ x: 0, y: 0 }); }}
              style={{ cursor: imgZoom > 1 ? (imgDragging ? 'grabbing' : 'grab') : 'default' }}
            >
              <img
                className="lightbox-img"
                src={lightbox.url}
                alt=""
                draggable={false}
                style={{ transform: `translate(${imgPan.x}px, ${imgPan.y}px) scale(${imgZoom})` }}
              />
              {imgZoom !== 1 && (
                <span className="lightbox-zoom-badge">{Math.round(imgZoom * 100)}%</span>
              )}
            </div>
            {lightbox.prompt && (
            <div className="lightbox-info">
              <div className="lightbox-meta">
                <span className="lightbox-meta-item"><span className="lightbox-meta-label">模型</span>{lightbox.model}</span>
                <span className="lightbox-meta-item"><span className="lightbox-meta-label">尺寸</span>{lightbox.outDims ? `${lightbox.outDims.w}×${lightbox.outDims.h}` : (lightbox.resolution || '—')}</span>
                {lightbox.modelId === 'gpt2' ? (
                  <React.Fragment>
                    <span className="lightbox-meta-item"><span className="lightbox-meta-label">质量</span>{lightbox.gptQuality || 'auto'}</span>
                    <span className="lightbox-meta-item"><span className="lightbox-meta-label">格式</span>{lightbox.gptFormat || 'png'}{lightbox.gptCompression != null && (lightbox.gptFormat === 'jpeg' || lightbox.gptFormat === 'webp') ? ` · ${lightbox.gptCompression}%` : ''}</span>
                  </React.Fragment>
                ) : (
                  <React.Fragment>
                    <span className="lightbox-meta-item"><span className="lightbox-meta-label">分辨率</span>{lightbox.resolution}</span>
                    <span className="lightbox-meta-item"><span className="lightbox-meta-label">比例</span>{lightbox.aspect}</span>
                  </React.Fragment>
                )}
                {lightbox.totalTokens > 0 && (
                  <span className="lightbox-meta-item"><span className="lightbox-meta-label">Tokens</span>{formatTokens(lightbox.totalTokens)}</span>
                )}
                {lightbox.elapsed && (
                  <span className="lightbox-meta-item"><span className="lightbox-meta-label">耗时</span>{lightbox.elapsed}s</span>
                )}
                {lightbox.time && (
                  <span className="lightbox-meta-item"><span className="lightbox-meta-label">时间</span>{new Date(lightbox.time).toLocaleString('zh-CN', { year:'numeric', month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit' })}</span>
                )}
                {lightbox.isEdit && lightbox.originalPrompt && (
                  <span className="lightbox-meta-item" style={{gridColumn:'1/-1'}}><span className="lightbox-meta-label">编辑自</span>{lightbox.originalPrompt}</span>
                )}
                {lightbox.cancelled && (
                  <span className="lightbox-meta-item" style={{color:'var(--error)'}}>⏹ 已取消</span>
                )}
              </div>
            </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================
// ChatPanel — 对话流（独立于 <App/>，完全不共享状态）
// 设计目标：
//   1. /v1/chat/completions 透传，多模型通用（Claude/Gemini/GPT 走 o1key 网关）
//   2. 消息结构遵循 OpenAI 规范，预留 tool_calls / tool_call_id，
//      后期开 agent（function calling）时无需改 schema 与解析器
//   3. localStorage key 用 chat_v1_ 前缀，方便后续 schema 迁移
//   4. AbortController 控制流，停止时不污染后端连接（drain_conn 在 server 侧已处理）
// ================================================================

const CHAT_MODELS = [
  { id: 'claude-sonnet-4-6',       label: 'Claude Sonnet 4.6',   provider: 'claude',   icon: '/assets/claude-color.svg' },
  { id: 'claude-opus-4-6',         label: 'Claude Opus 4.6',     provider: 'claude',   icon: '/assets/claude-color.svg' },
  { id: 'claude-opus-4-7',         label: 'Claude Opus 4.7',     provider: 'claude',   icon: '/assets/claude-color.svg' },
  { id: 'gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro',     provider: 'gemini',   icon: '/assets/gemini-color.svg' },
  { id: 'gpt-5.5',                 label: 'GPT-5.5',            provider: 'gpt',      icon: '/assets/openai.svg' },
  { id: 'deepseek-v4-pro',         label: 'DeepSeek V4 Pro',    provider: 'deepseek', icon: '/assets/deepseek-color.svg' },
  { id: 'doubao-seed-2.0-pro',     label: 'Doubao Seed 2.0 Pro', provider: 'doubao',  icon: '/assets/doubao-color.svg' },
];

// v2: 只存 UI 偏好（messages 已迁到服务端 chats/）
const CHAT_PREF_KEY = 'chat_v2_state';
const CHAT_LEGACY_KEY = 'chat_v1_state';

function loadChatPref() {
  try {
    const raw = localStorage.getItem(CHAT_PREF_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveChatPref(state) {
  try { localStorage.setItem(CHAT_PREF_KEY, JSON.stringify(state)); } catch {}
}

function chatGenId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  return 'c' + Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
}

function chatDeriveTitle(messages) {
  const firstUser = (messages || []).find(m => m.role === 'user');
  if (!firstUser) return '新对话';
  const text = (typeof firstUser.content === 'string' ? firstUser.content : '').trim();
  return text.slice(0, 40) || '新对话';
}

function chatFormatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 604800) return Math.floor(diff / 86400) + ' 天前';
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function getModelMeta(modelId) {
  return CHAT_MODELS.find(m => m.id === modelId) || CHAT_MODELS[0];
}

// 累加 OpenAI delta 到 message（同时支持 content 与 tool_calls，为 agent 预留）
function applyChatDelta(msg, delta) {
  if (!delta) return;
  if (typeof delta.content === 'string' && delta.content) {
    msg.content = (msg.content || '') + delta.content;
  }
  if (Array.isArray(delta.tool_calls)) {
    msg.tool_calls = msg.tool_calls || [];
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!msg.tool_calls[idx]) {
        msg.tool_calls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      }
      const slot = msg.tool_calls[idx];
      if (tc.id) slot.id = tc.id;
      if (tc.type) slot.type = tc.type;
      if (tc.function) {
        if (tc.function.name)      slot.function.name      = (slot.function.name || '') + tc.function.name;
        if (tc.function.arguments) slot.function.arguments = (slot.function.arguments || '') + tc.function.arguments;
      }
    }
  }
}

// Markdown 渲染（CDN marked + DOMPurify，未加载时回退转义文本）
function renderChatMarkdown(text) {
  if (!text) return '';
  if (window.marked && window.DOMPurify) {
    try {
      const html = window.marked.parse(text, { breaks: true, gfm: true });
      return window.DOMPurify.sanitize(html);
    } catch (e) {
      console.warn('[chat] markdown render failed', e);
    }
  }
  return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// SSE 行级解析器：从 fetch ReadableStream 拆出每个 data: payload
async function* readChatSSE(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      const tail = buf.trim();
      if (tail.startsWith('data:')) {
        const p = tail.slice(5).trim();
        if (p) yield p;
      }
      return;
    }
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) {
        const p = line.slice(5).trim();
        if (p) yield p;
      }
    }
  }
}

function ChatPanel() {
  const pref = loadChatPref();
  const [open, setOpen]         = useState(pref?.open ?? false);
  const [model, setModel]       = useState(pref?.model || CHAT_MODELS[0].id);
  const [activeId, setActiveId] = useState(pref?.activeId || null);

  const [messages, setMessages] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [view, setView]         = useState('chat');

  const [input, setInput]       = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError]       = useState('');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [modelDropOpen, setModelDropOpen] = useState(false);

  const abortRef     = useRef(null);
  const listRef      = useRef(null);
  const hydratedRef  = useRef(false);
  const modelDropRef = useRef(null);

  // ------- UI 偏好持久化 -------
  useEffect(() => {
    saveChatPref({ open, model, activeId });
  }, [open, model, activeId]);

  // ------- 自动滚动 -------
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, view]);

  // ------- 点击外部关闭模型下拉 -------
  useEffect(() => {
    if (!modelDropOpen) return;
    const handler = (e) => {
      if (modelDropRef.current && !modelDropRef.current.contains(e.target)) setModelDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelDropOpen]);

  // ------- 拉取会话列表 -------
  const refreshSessions = async () => {
    setSessionsLoading(true);
    try {
      const r = await fetch('/api/chats');
      const j = await r.json();
      setSessions(Array.isArray(j.items) ? j.items : []);
    } catch (e) {
      console.warn('[chat] refreshSessions failed', e);
    } finally {
      setSessionsLoading(false);
    }
  };

  // ------- 旧 localStorage 迁移（一次性） -------
  const migrateLegacy = async () => {
    let raw;
    try { raw = localStorage.getItem(CHAT_LEGACY_KEY); } catch { return null; }
    if (!raw) return null;
    let legacy;
    try { legacy = JSON.parse(raw); } catch { localStorage.removeItem(CHAT_LEGACY_KEY); return null; }
    const oldMsgs = Array.isArray(legacy?.messages) ? legacy.messages : [];
    if (oldMsgs.length === 0) { localStorage.removeItem(CHAT_LEGACY_KEY); return null; }
    const id = chatGenId();
    const payload = {
      title: chatDeriveTitle(oldMsgs),
      provider: legacy?.provider || getModelMeta(model).provider,
      model: legacy?.model || model,
      messages: oldMsgs,
    };
    try {
      const r = await fetch(`/api/chats/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        try { localStorage.removeItem(CHAT_LEGACY_KEY); } catch {}
        return id;
      }
    } catch (e) {
      console.warn('[chat] legacy migrate failed', e);
    }
    return null;
  };

  // ------- 初始化：迁移 → 拉列表 → 恢复活动会话 -------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const migratedId = await migrateLegacy();
      await refreshSessions();
      if (cancelled) return;

      const restoreId = migratedId || activeId;
      if (restoreId) {
        try {
          const r = await fetch(`/api/chats/${restoreId}`);
          if (r.ok) {
            const data = await r.json();
            if (!cancelled) {
              setMessages(Array.isArray(data.messages) ? data.messages : []);
              if (data.model) setModel(data.model);
              setActiveId(restoreId);
            }
          } else if (r.status === 404) {
            if (!cancelled) setActiveId(null);
          }
        } catch (e) {
          console.warn('[chat] restore failed', e);
        }
      }
      hydratedRef.current = true;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------- 保存当前会话到服务端 -------
  const persistActive = async (idArg, msgsArg, modelArg) => {
    const id     = idArg     ?? activeId;
    const msgs   = msgsArg   ?? messages;
    const mdl    = modelArg  ?? model;
    if (!id || msgs.length === 0) return;
    try {
      const r = await fetch(`/api/chats/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: chatDeriveTitle(msgs),
          provider: getModelMeta(mdl).provider,
          model: mdl,
          messages: msgs,
        }),
      });
      if (r.ok) refreshSessions();
    } catch (e) {
      console.warn('[chat] persist failed', e);
    }
  };

  const currentModel = getModelMeta(model);

  // ------- 新建对话 -------
  const newSession = () => {
    if (streaming) return;
    setActiveId(null);
    setMessages([]);
    setError('');
    setView('chat');
  };

  // ------- 切换会话 -------
  const selectSession = async (id) => {
    if (streaming) return;
    if (id === activeId) { setView('chat'); return; }
    try {
      const r = await fetch(`/api/chats/${id}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      setActiveId(id);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      if (data.model) setModel(data.model);
      setError('');
      setView('chat');
    } catch (e) {
      console.warn('[chat] selectSession failed', e);
      setError('加载会话失败: ' + e.message);
    }
  };

  // ------- 删除会话 -------
  const deleteSession = async (id, e) => {
    e?.stopPropagation?.();
    if (!confirm('删除这个对话？此操作不可恢复。')) return;
    try {
      await fetch(`/api/chats/${id}`, { method: 'DELETE' });
      if (id === activeId) {
        setActiveId(null);
        setMessages([]);
      }
      refreshSessions();
    } catch (e2) {
      console.warn('[chat] delete failed', e2);
    }
  };

  // ------- 发送消息 -------
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || streaming) return;

    let sid = activeId;
    if (!sid) { sid = chatGenId(); setActiveId(sid); }

    const userMsg = { role: 'user', content: text };
    const placeholderMsg = { role: 'assistant', content: '' };
    const baseMsgs = [...messages, userMsg];
    setMessages([...baseMsgs, placeholderMsg]);
    setInput('');
    setStreaming(true);
    setError('');

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const payloadMessages = baseMsgs.map(m => {
      const out = { role: m.role, content: m.content };
      if (m.tool_calls)    out.tool_calls    = m.tool_calls;
      if (m.tool_call_id)  out.tool_call_id  = m.tool_call_id;
      if (m.name)          out.name          = m.name;
      return out;
    });

    let working = { role: 'assistant', content: '' };
    let finalMsgs = null;

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: payloadMessages }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        let detail = '';
        try { const j = await resp.json(); detail = j.error?.message || JSON.stringify(j); }
        catch { detail = await resp.text().catch(() => ''); }
        throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 300)}`);
      }

      for await (const payload of readChatSSE(resp)) {
        if (payload === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        applyChatDelta(working, choice.delta || {});
        const snapshot = { ...working, tool_calls: working.tool_calls ? [...working.tool_calls] : undefined };
        setMessages(prev => {
          const arr = [...prev];
          arr[arr.length - 1] = snapshot;
          return arr;
        });
      }

      finalMsgs = [...baseMsgs, { ...working, tool_calls: working.tool_calls ? [...working.tool_calls] : undefined }];
    } catch (e) {
      if (e.name === 'AbortError') {
        const stopped = { ...working, content: (working.content || '') + '\n\n_（已停止）_' };
        setMessages(prev => {
          const arr = [...prev];
          arr[arr.length - 1] = stopped;
          return arr;
        });
        finalMsgs = [...baseMsgs, stopped];
      } else {
        console.error('[chat] error', e);
        setError(e.message || '请求失败');
        setMessages(prev => prev.slice(0, -1)); // 移除占位 assistant
        // 即便失败也持久化 user message，不让用户白打一遍
        finalMsgs = baseMsgs;
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      if (finalMsgs && finalMsgs.length > 0) {
        persistActive(sid, finalMsgs, model);
      }
    }
  };

  const stopStreaming = () => { if (abortRef.current) abortRef.current.abort(); };

  const onInputKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ------- 折叠态 -------
  if (!open) {
    return (
      <button className="chat-fab" onClick={() => setOpen(true)} title="打开对话">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
    );
  }

  // ------- 历史视图 -------
  if (view === 'history') {
    return (
      <div className="chat-panel">
        <div className="chat-header">
          <div className="chat-header-title">
            <button className="chat-icon-btn" onClick={() => setView('chat')} title="返回">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
              </svg>
            </button>
            <span className="chat-history-title">对话列表</span>
            {sessionsLoading && <span className="chat-loading-tag">加载中…</span>}
          </div>
          <div className="chat-header-actions">
            <button className="chat-icon-btn" onClick={() => { newSession(); }} disabled={streaming} title="新建对话">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button className="chat-icon-btn" onClick={() => setOpen(false)} title="收起">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" />
              </svg>
            </button>
          </div>
        </div>
        <div className="chat-history-list">
          {sessions.length === 0 && !sessionsLoading && (
            <div className="chat-empty">
              <div className="chat-empty-title">还没有对话</div>
              <div className="chat-empty-hint">点击右上角 + 开始第一个对话</div>
            </div>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`chat-history-item${s.id === activeId ? ' chat-history-item-active' : ''}`}
              onClick={() => selectSession(s.id)}
            >
              <div className="chat-history-item-main">
                <div className="chat-history-item-title">{s.title || '新对话'}</div>
                <div className="chat-history-item-meta">
                  <span className="chat-history-item-model">{s.model || ''}</span>
                  <span className="chat-history-item-dot">·</span>
                  <span>{chatFormatTime(s.updated_at)}</span>
                  <span className="chat-history-item-dot">·</span>
                  <span>{s.message_count || 0} 条</span>
                </div>
              </div>
              <button className="chat-icon-btn chat-history-item-del" onClick={e => deleteSession(s.id, e)} title="删除">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ------- 对话视图 -------
  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-title">
          <span className={`chat-dot${streaming ? ' chat-dot-busy' : ''}`}></span>
          <div className="chat-model-picker" ref={modelDropRef}>
            <button className="chat-model-trigger" onClick={() => !streaming && setModelDropOpen(!modelDropOpen)} disabled={streaming}>
              <img className="chat-model-icon" src={currentModel.icon} alt="" width="16" height="16" />
              <span className="chat-model-trigger-label">{currentModel.label}</span>
              <svg className="chat-model-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {modelDropOpen && (
              <div className="chat-model-dropdown">
                {CHAT_MODELS.map(m => (
                  <button
                    key={m.id}
                    className={`chat-model-option${m.id === model ? ' chat-model-option-active' : ''}`}
                    onClick={() => { setModel(m.id); setModelDropOpen(false); }}
                  >
                    <img className="chat-model-icon" src={m.icon} alt="" width="16" height="16" />
                    <span className="chat-model-option-label">{m.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="chat-icon-btn" onClick={() => { setView('history'); refreshSessions(); }} title="历史对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <button className="chat-icon-btn" onClick={newSession} disabled={streaming} title="新建对话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button className="chat-icon-btn" onClick={() => setOpen(false)} title="收起">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">开始对话</div>
            <div className="chat-empty-hint">使用 {currentModel.label}<br/>与生图功能并行，互不影响</div>
          </div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          const showTyping = streaming && isLast && !m.content && !(m.tool_calls && m.tool_calls.length);
          return (
            <div key={i} className={`chat-msg chat-msg-${m.role}`}>
              <div className="chat-msg-role">
                {m.role === 'user' ? '你'
                  : m.role === 'assistant' ? currentModel.label
                  : m.role === 'tool' ? `工具结果${m.name ? `（${m.name}）` : ''}`
                  : m.role}
              </div>
              {showTyping ? (
                <div className="chat-msg-body">
                  <span className="chat-typing-dot"></span>
                  <span className="chat-typing-dot"></span>
                  <span className="chat-typing-dot"></span>
                </div>
              ) : (
                <div className="chat-msg-body" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(m.content) }} />
              )}
              {m.tool_calls && m.tool_calls.length > 0 && (
                <div className="chat-msg-toolcalls">
                  {m.tool_calls.map((tc, j) => (
                    <div key={j} className="chat-toolcall">
                      <span className="chat-toolcall-name">{tc.function?.name || '(unnamed)'}</span>
                      {tc.function?.arguments ? `(${tc.function.arguments})` : '()'}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {error && <div className="chat-error">⚠ {error}</div>}
      </div>

      <div className="chat-input-wrap">
        <textarea
          className="chat-input"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          rows={2}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onInputKeyDown}
          disabled={streaming}
        />
        {streaming ? (
          <button className="chat-send chat-send-stop" onClick={stopStreaming} title="停止生成">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
          </button>
        ) : (
          <button className="chat-send" onClick={sendMessage} disabled={!input.trim()} title="发送 (Enter)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.Fragment>
    <App />
    <ChatPanel />
  </React.Fragment>
);
