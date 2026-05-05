// o1key — AI 图片生成应用
// 中心化输入流，类似 ChatGPT。
// ⚠️ 安全警告：API Key 直接写在前端代码中，任何人打开页面都能看到。
//    仅用于本地开发原型。生产环境必须通过后端代理调用 Gemini API。

// ---------- Gemini API 配置 ----------
// API Key 从 config.js 注入（该文件不提交 Git）
const GEMINI_API_KEY = window.GEMINI_API_KEY || '';
// 应用模型 → Gemini API 模型映射
const GEMINI_MODEL_MAP = {
  pro: 'gemini-3-pro-image-preview',
  v2:  'gemini-3.1-flash-image-preview',
};

// 分辨率 ID → API imageSize 值 (0.5K 映射为 "512")
function toApiImageSize(resolutionId) {
  if (resolutionId === '0.5K') return '512';
  return resolutionId; // 1K / 2K / 4K 原样传递
}

// ---------- 图片压缩（Canvas 等比缩放）----------
const MAX_REQUEST_SIZE = 20 * 1024 * 1024; // 20MB

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

// 调用 Gemini 生成单张图片，返回 { url, debug }
async function callGeminiImageGeneration(prompt, refImages, aspectRatio, modelId, resolution) {
  const geminiModel = GEMINI_MODEL_MAP[modelId] || GEMINI_MODEL_MAP.pro;
  const debug = { request: null, response: null, error: null };
  const MIN_SCALE = 0.2;

  // 构建图片 parts（带压缩追踪）
  let imgParts = await Promise.all(refImages.map(async (img) => {
    const match = img.url.match(/data:(.*?);base64,(.*)/);
    return match ? { mime: match[1], data: match[2], url: img.url, scale: 1 } : null;
  }).filter(Boolean));

  // 检查请求体大小，超限则等比压缩最大图片
  const buildBody = (ip) => ({
    contents: [{ parts: [{ text: prompt }, ...ip.map(p => ({ inlineData: { mimeType: p.mime, data: p.data } }))] }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: { aspectRatio, imageSize: toApiImageSize(resolution) },
    },
  });

  let body = buildBody(imgParts);
  let size = JSON.stringify(body).length;

  while (size > MAX_REQUEST_SIZE) {
    // 找 data 最长的图片（且未缩到极限）
    let maxIdx = -1, maxLen = -1;
    imgParts.forEach((p, i) => {
      if (p.data.length > maxLen && p.scale > MIN_SCALE) {
        maxLen = p.data.length; maxIdx = i;
      }
    });
    if (maxIdx < 0) break; // 全部已到极限

    const p = imgParts[maxIdx];
    const newScale = Math.max(MIN_SCALE, p.scale * 0.65);
    console.log(`%c🗜️ 压缩参考图 #${maxIdx + 1}: ${(p.data.length / 1024 / 1024).toFixed(1)}MB → scale ${newScale.toFixed(2)}`, 'color:#F2B33D');
    const compressed = await compressImage(p.url, newScale);
    const m2 = compressed.match(/data:(.*?);base64,(.*)/);
    if (m2) {
      imgParts[maxIdx] = { ...p, mime: m2[1], data: m2[2], url: compressed, scale: newScale };
    } else {
      imgParts[maxIdx].scale = MIN_SCALE; // 压缩失败，标记为已处理
    }
    body = buildBody(imgParts);
    size = JSON.stringify(body).length;
  }

  if (imgParts.some(p => p.scale < 1)) {
    console.log('%c📦 请求体总大小:', 'color:#6366F1', `${(size / 1024 / 1024).toFixed(1)}MB`);
  }

  const parts = [{ text: prompt }, ...imgParts.map(p => ({ inlineData: { mimeType: p.mime, data: p.data } }))];

  const requestBody = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      imageConfig: {
        aspectRatio: aspectRatio,
        imageSize: toApiImageSize(resolution),
      },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;

  debug.request = {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '…(已隐藏)' },
    body: JSON.parse(JSON.stringify(requestBody)), // deep copy, hide image data
  };
  // 隐藏 body 中的 base64 图片数据以便日志可读
  debug.request.body.contents[0].parts = debug.request.body.contents[0].parts.map(p => {
    if (p.inlineData) return { inlineData: { mimeType: p.inlineData.mimeType, data: `[${p.inlineData.data.length} 字符 base64]` } };
    return p;
  });

  console.group('%c📤 Gemini API 请求', 'color:#F59E0B;font-weight:bold');
  console.log('URL:', url);
  console.log('Model:', geminiModel, `(app: ${modelId})`);
  console.log('Body:', JSON.stringify(debug.request.body, null, 2));
  console.groupEnd();

  // --- 请求（带指数退让重试） ---
  const MAX_RETRIES = 3;
  const startTime = performance.now();
  let response;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    if (attempt > 0) {
      const waitMs = Math.pow(2, attempt - 1) * 1000; // 1s → 2s → 4s
      console.log(`%c⏳ 指数退让重试 #${attempt}, 等待 ${waitMs / 1000}s...`, 'color:#F2B33D');
      await new Promise(r => setTimeout(r, waitMs));
    }
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify(requestBody),
      });
    } catch (fetchErr) {
      if (attempt >= MAX_RETRIES) {
        debug.error = `网络错误 (已重试${MAX_RETRIES}次): ${fetchErr.message}`;
        console.error('%c❌ 网络请求最终失败', 'color:#EF4444;font-weight:bold', fetchErr);
        throw new Error(debug.error);
      }
      console.warn(`%c⚠️ 网络错误, 尝试 ${attempt + 1}/${MAX_RETRIES + 1}: ${fetchErr.message}`, 'color:#F2B33D');
      attempt++;
      continue;
    }

    // 429 限流 或 5xx 服务端错误 → 重试
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= MAX_RETRIES) break; // 最后一次也失败，跳出
      console.warn(`%c⚠️ 可重试状态 [${response.status}], 尝试 ${attempt + 1}/${MAX_RETRIES + 1}`, 'color:#F2B33D');
      attempt++;
      continue;
    }

    break; // 成功 或 不可重试的 4xx → 跳出
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
    console.group('%c❌ API 返回错误 (不重试或重试耗尽)', 'color:#EF4444;font-weight:bold');
    console.log('Status:', response.status, '· 共尝试', attempt + 1, '次');
    console.log('Response:', data);
    console.groupEnd();
    throw new Error(`API 请求失败 [${response.status} · ${elapsed}ms]: ${debug.error}`);
  }

  debug.response.body = data;

  console.group('%c✅ API 响应', 'color:#10B981;font-weight:bold');
  console.log(`Status: ${response.status} · ${elapsed}ms · 尝试 ${attempt + 1} 次`);
  console.log('Raw response:', data);
  console.groupEnd();

  // 检查安全拦截
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    debug.error = `安全拦截: ${candidate.finishReason}`;
    console.warn('⚠️ 生成被拦截, finishReason:', candidate.finishReason);
    throw new Error(`生成被拦截: ${candidate.finishReason}`);
  }

  // 列出响应中的 parts 类型
  const partsList = candidate?.content?.parts || [];
  console.log('%c📋 响应 parts 类型:', 'color:#6366F1', partsList.map(p => ({ keys: Object.keys(p), thought: !!p.thought })));

  // 提取图片 (跳过 thought 中间产物)
  for (const part of partsList) {
    if (part.thought) {
      console.log('%c💭 跳过思考过程图片', 'color:#A78BFA');
      continue;
    }
    if (part.inlineData?.data) {
      console.log('%c🖼️ 提取到最终图片, mimeType:', 'color:#10B981', part.inlineData.mimeType, 'data length:', part.inlineData.data.length);
      return {
        url: `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`,
        debug,
      };
    }
  }

  // 没有图片，检查是否有文本
  const textPart = partsList.find(p => p.text);
  if (textPart) {
    debug.error = `模型返回文字而非图片: ${textPart.text.substring(0, 200)}`;
    console.warn('⚠️ 模型返回文字:', textPart.text);
    throw new Error(`模型返回文字而非图片: ${textPart.text.substring(0, 150)}`);
  }

  debug.error = '响应中未找到图片或文字';
  console.warn('⚠️ 响应 parts:', partsList);
  throw new Error('响应中未找到图片或文字内容');
}

const { useState, useRef, useEffect, useCallback } = React;

// ---------- 数据 ----------
// 所有支持的宽高比（按模型过滤）。w/h 是真实比值，仅用于形状预览。
const ASPECT_PRESETS = [
  { id: '1:1',  w: 1,  h: 1,  models: ['pro', 'v2'] },
  { id: '2:3',  w: 2,  h: 3,  models: ['pro', 'v2'] },
  { id: '3:2',  w: 3,  h: 2,  models: ['pro', 'v2'] },
  { id: '3:4',  w: 3,  h: 4,  models: ['pro', 'v2'] },
  { id: '4:3',  w: 4,  h: 3,  models: ['pro', 'v2'] },
  { id: '4:5',  w: 4,  h: 5,  models: ['pro', 'v2'] },
  { id: '5:4',  w: 5,  h: 4,  models: ['pro', 'v2'] },
  { id: '9:16', w: 9,  h: 16, models: ['pro', 'v2'] },
  { id: '16:9', w: 16, h: 9,  models: ['pro', 'v2'] },
  { id: '21:9', w: 21, h: 9,  models: ['pro', 'v2'] },
  // v2 (Flash) 独有的极致比例
  { id: '1:4',  w: 1,  h: 4,  models: ['v2'] },
  { id: '1:8',  w: 1,  h: 8,  models: ['v2'] },
  { id: '4:1',  w: 4,  h: 1,  models: ['v2'] },
  { id: '8:1',  w: 8,  h: 1,  models: ['v2'] },
];

const MODELS = [
  { id: 'pro', name: 'Nano Banana Pro', short: 'Pro',  desc: '更高质量 · 较慢' },
  { id: 'v2',  name: 'Nano Banana 2',   short: 'v2',   desc: '更快 · 标准质量' },
];

// 各模型支持的分辨率档位
const RESOLUTIONS = {
  pro: [
    { id: '1K', label: '1K', desc: '标清' },
    { id: '2K', label: '2K', desc: '高清' },
    { id: '4K', label: '4K', desc: '超清' },
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

const TEMPLATES = [
  '一只赛博朋克风格的猫，霓虹光，电影感',
  '极简日式室内，柔光，胶片颗粒',
  '复古旅行海报，扁平插画，70 年代调色',
  '产品摄影：陶瓷杯子，柔和白底，柔光',
  '宫崎骏风格田野晨雾，水彩质感',
];

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
    case 'sparkles':
      return <svg {...props}><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>;
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
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState([]); // {id, url}
  const [aspect, setAspect] = useState('1:1');
  const [count, setCount] = useState(1);
  const [model, setModel] = useState('pro');
  const [resolution, setResolution] = useState('1K');

  // 切换模型时：若当前 aspect / resolution 在新模型下不可用，clamp 到合法值
  useEffect(() => {
    const aspectOk = ASPECT_PRESETS.some(p => p.id === aspect && p.models.includes(model));
    if (!aspectOk) setAspect('1:1');
    const resOk = (RESOLUTIONS[model] || []).some(r => r.id === resolution);
    if (!resOk) setResolution('1K');
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps
  const [generations, setGenerations] = useState([]); // newest first
  const [generating, setGenerating] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [lightbox, setLightbox] = useState(null); // { url, prompt } or null
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  }, []);

  // 自适应 textarea 高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [prompt]);

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

  // 全局拖拽监听
  useEffect(() => {
    let counter = 0;
    const onEnter = (e) => { e.preventDefault(); counter++; if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) setDragging(true); };
    const onOver  = (e) => { e.preventDefault(); };
    const onLeave = (e) => { e.preventDefault(); counter--; if (counter <= 0) { counter = 0; setDragging(false); } };
    const onDrop  = (e) => { e.preventDefault(); counter = 0; setDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length) addImages(e.dataTransfer.files);
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
  }, [addImages]);

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
        addImages(files);
        showToast('已从剪贴板添加图片');
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImages, showToast]);

  const removeImage = (id) => setImages(prev => prev.filter(i => i.id !== id));

  const canSend = prompt.trim().length > 0 && !generating;

  const handleGenerate = () => {
    if (!canSend) return;
    const aspectPreset = ASPECT_PRESETS.find(p => p.id === aspect);
    const modelObj = MODELS.find(m => m.id === model);
    const outDims = getOutputDims(aspect, resolution);
    const genId = Math.random().toString(36).slice(2);
    const gen = {
      id: genId,
      prompt: prompt.trim(),
      aspect,
      aspectStyle: { aspectRatio: `${aspectPreset.w} / ${aspectPreset.h}` },
      resolution,
      outDims,
      count,
      model: modelObj.name,
      modelShort: modelObj.short,
      modelId: model,
      refs: images,
      tiles: Array.from({ length: count }, (_, i) => ({ id: `${genId}-${i}`, status: 'loading', url: null })),
      time: new Date(),
    };
    setGenerations(prev => [gen, ...prev]);
    setGenerating(true);
    const startTime = performance.now();
    // 高并发：所有请求同时发出
    let completedCount = 0;
    const totalTiles = gen.tiles.length;
    gen.tiles.forEach((tile) => {
      (async () => {
        try {
          const result = await callGeminiImageGeneration(
            gen.prompt,
            gen.refs,
            gen.aspect,
            gen.modelId,
            gen.resolution
          );
          setGenerations(prev => prev.map(g => {
            if (g.id !== genId) return g;
            return {
              ...g,
              tiles: g.tiles.map(t => t.id === tile.id ? { ...t, status: 'done', url: result.url, debug: result.debug } : t),
            };
          }));
        } catch (err) {
          setGenerations(prev => prev.map(g => {
            if (g.id !== genId) return g;
            return {
              ...g,
              tiles: g.tiles.map(t => t.id === tile.id ? { ...t, status: 'error', error: err.message } : t),
            };
          }));
        } finally {
          completedCount++;
          if (completedCount >= totalTiles) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            setGenerations(prev => {
              const updated = prev.map(g => g.id === genId ? { ...g, elapsed } : g);
              const final = updated.find(g => g.id === genId);
              if (final) saveGeneration(final);
              return updated;
            });
            setGenerating(false);
          }
        }
      })();
    });
    // 重置输入但保留参数
    setPrompt('');
    setImages([]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const handleDownload = (url) => {
    showToast('开始下载…');
    const a = document.createElement('a');
    a.href = url; a.download = `banana-${Date.now()}.jpg`; a.target = '_blank';
    document.body.appendChild(a); a.click(); a.remove();
  };
  const handleShare = () => showToast('链接已复制到剪贴板');
  const handleCopyPrompt = (text) => {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(()=>{});
    showToast('提示词已复制');
  };

  // 持久化 — 保存生成结果到服务端 /api/images
  const saveGeneration = useCallback(async (gen) => {
    const doneTiles = gen.tiles.filter(t => t.status === 'done');
    if (doneTiles.length === 0) return;
    try {
      await fetch('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: doneTiles.map(t => ({
            url: t.url,
            prompt: gen.prompt,
            model: gen.model,
            resolution: gen.resolution,
            aspect: gen.aspect,
            elapsed: gen.elapsed,
          })),
        }),
      });
    } catch (e) {
      console.warn('保存历史失败:', e.message);
    }
  }, []);

  // 页面加载时从服务端恢复历史
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/images');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.length) return;
        // 转为 generation 格式
        const restored = data.map(item => ({
          id: item.filename,
          prompt: item.prompt || '',
          aspect: item.aspect || '',
          resolution: item.resolution || '',
          model: item.model || '',
          modelShort: item.model?.includes('2') ? 'v2' : 'Pro',
          modelId: item.model?.includes('2') ? 'v2' : 'pro',
          count: 1,
          refs: [],
          elapsed: item.elapsed || null,
          tiles: [{
            id: item.filename,
            status: 'done',
            url: `/api/images/${item.filename}`,
          }],
          time: new Date(),
        }));
        setGenerations(prev => {
          const existingIds = new Set(prev.map(g => g.id));
          return [...prev, ...restored.filter(r => !existingIds.has(r.id))];
        });
      } catch (e) {
        console.warn('加载历史失败:', e.message);
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
            <Icon name="banana" size={18} className="" />
          </div>
          <span className="brand-name">o1key</span>
          <span className="brand-tag">图片生成</span>
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={() => setHistoryOpen(true)} title="历史记录">
            <Icon name="history" size={18} />
          </button>
          <button className="icon-btn" title="新建">
            <Icon name="plus" size={18} />
          </button>
        </div>
      </header>

      <main className="main">
        {/* Hero — 仅在空状态展示 */}
        {isEmpty && (
          <div className="hero">
            <h1 className="hero-title">用一句话<span className="grad">画出你的想象</span></h1>
            <p className="hero-sub">上传参考图，描述你想要的画面，让 o1key 帮你生成。</p>
          </div>
        )}

        {/* 输入区 */}
        <div className={`composer ${dragging ? 'dropping' : ''}`}>
          {/* 已上传缩略图 */}
          {images.length > 0 && (
            <div className="upload-row">
              {images.map(img => (
                <div key={img.id} className="thumb">
                  <img src={img.url} alt="" />
                  <button className="thumb-remove" onClick={() => removeImage(img.id)} aria-label="移除">
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
              {images.length < 14 && (
                <button className="thumb" style={{ background: 'var(--surface-2)', border: '1px dashed var(--line-strong)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onClick={() => fileInputRef.current?.click()} aria-label="再添加一张">
                  <Icon name="plus" size={20} />
                </button>
              )}
            </div>
          )}

          <textarea
            ref={textareaRef}
            className="composer-input"
            placeholder="描述你想生成的画面…  例：一只在月光下的橘猫，水彩风格"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
          />

          <div className="composer-bar">
            <div className="composer-bar-left">
              {/* 模型 */}
              <select className="bar-select" value={model} onChange={e => setModel(e.target.value)}>
                {MODELS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <span className="composer-bar-divider" />
              {/* 分辨率 */}
              <select className="bar-select" value={resolution} onChange={e => setResolution(e.target.value)}
                style={{maxWidth:80,fontFamily:'var(--font-mono)'}}>
                {(RESOLUTIONS[model] || []).map(r => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
              <span className="composer-bar-divider" />
              {/* 宽高比 */}
              <select className="bar-select" value={aspect} onChange={e => setAspect(e.target.value)}
                style={{maxWidth:80,fontFamily:'var(--font-mono)'}}>
                {ASPECT_PRESETS.filter(p => p.models.includes(model)).map(p => (
                  <option key={p.id} value={p.id}>{p.id}</option>
                ))}
              </select>
              <span className="composer-bar-divider" />
              {/* 生图数量 */}
              <select className="bar-select" value={count} onChange={e => setCount(Number(e.target.value))}
                style={{maxWidth:72,fontFamily:'var(--font-mono)'}}>
                {[1,2,3,4,5,6,7,8].map(n => (
                  <option key={n} value={n}>{n} 张</option>
                ))}
              </select>
              <span className="composer-bar-divider" />
              {/* 参考图 */}
              <button className="tool-btn" onClick={() => fileInputRef.current?.click()}>
                <Icon name="image" size={16} />
                <span className="label-full">参考图</span>
                {images.length > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-hover)' }}>{images.length}</span>}
              </button>
              <button className="tool-btn mobile-drawer-toggle" onClick={() => setDrawerOpen(true)}>
                <Icon name="sliders" size={16} />
                <span>{model === 'pro' ? 'Pro' : 'v2'} · {resolution} · {aspect} · {count} 张</span>
              </button>
            </div>
            <div className="composer-bar-right">
              <span style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)', marginRight: 4 }}>⌘ + ↵</span>
              <button className={`send-btn ${canSend ? 'ready' : ''}`} onClick={handleGenerate} disabled={!canSend} aria-label="生成">
                {generating
                  ? <div className="skeleton-spinner" style={{ borderColor: 'rgba(255,255,255,.3)', borderTopColor: '#fff', width: 16, height: 16 }} />
                  : <Icon name="send" size={16} />}
              </button>
            </div>
          </div>

          <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
        </div>

        {/* 灵感模板 — 仅空状态 */}
        {isEmpty && (
          <div>
            <div className="section-head">
              <span className="section-title"><Icon name="sparkles" size={12} className="" /> &nbsp; 灵感</span>
            </div>
            <div className="templates">
              {TEMPLATES.map(t => (
                <button key={t} className="template" onClick={() => setPrompt(t)}>{t}</button>
              ))}
            </div>
          </div>
        )}

        {/* 生成结果 */}
        {generations.map(gen => (
          <div className="generation" key={gen.id}>
            <div className="gen-prompt">
              <div style={{ flex: 1 }}>
                <div className="gen-prompt-text">{gen.prompt}</div>
                <div className="gen-meta">
                  <span>{gen.model}</span>
                  <span>· {gen.resolution}{gen.outDims ? ` · ${gen.outDims.w}×${gen.outDims.h}` : ''}</span>
                  <span>· {gen.aspect}</span>
                  <span>· {gen.count} 张</span>
                  {gen.refs.length > 0 && <span>· {gen.refs.length} 张参考图</span>}
                  {gen.elapsed && <span>· {gen.elapsed}s</span>}
                </div>
              </div>
              <button className="icon-btn" title="复制提示词" onClick={() => handleCopyPrompt(gen.prompt)}>
                <Icon name="copy" size={16} />
              </button>
            </div>
            <div className="gen-grid">
              {gen.tiles.map(tile => (
                <div key={tile.id}
                  className={`gen-tile ${tile.status === 'loading' ? 'skeleton' : ''}`}
                  style={gen.aspectStyle}>
                  {tile.status === 'loading' && (
                    <div className="skeleton-inner" style={{flexDirection:'column',gap:8}}>
                      <div className="skeleton-spinner" />
                      <span style={{fontSize:11,color:'var(--fg-3)',fontFamily:'var(--font-mono)'}}>
                        请求中…
                      </span>
                    </div>
                  )}
                  {tile.status === 'done' && (
                    <React.Fragment>
                      <img className="gen-tile-img" src={tile.url} alt=""
                        style={{cursor:'pointer'}}
                        onClick={() => setLightbox({ url: tile.url, prompt: gen.prompt })} />
                      <div className="gen-tile-overlay">
                        <button className="tile-action" title="下载" onClick={() => handleDownload(tile.url)}>
                          <Icon name="download" size={14} />
                        </button>
                        <button className="tile-action" title="分享" onClick={handleShare}>
                          <Icon name="share" size={14} />
                        </button>
                      </div>
                    </React.Fragment>
                  )}
                  {tile.status === 'error' && (
                    <div style={{
                      display:'flex',alignItems:'center',justifyContent:'center',
                      height:'100%',padding:12,textAlign:'center',
                      fontSize:12,color:'var(--error, #EF4444)',lineHeight:1.5,
                      flexDirection:'column',gap:4,
                    }}>
                      <span style={{fontWeight:600}}>生成失败</span>
                      <span style={{fontSize:11,opacity:.75}}>{tile.error || '未知错误'}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* 调试面板 — 展示请求/响应详情 */}
            {gen.tiles.some(t => t.debug) && (
              <details style={{
                marginTop:12,background:'#1C1917',color:'#D6D3D1',
                borderRadius:10,padding:12,fontSize:12,
                fontFamily:'var(--font-mono)',
              }}>
                <summary style={{cursor:'pointer',color:'#F59E0B',fontWeight:600,fontSize:13}}>
                  🔍 调试信息（请求/响应）
                </summary>
                {gen.tiles.filter(t => t.debug).map((tile, idx) => (
                  <div key={tile.id} style={{
                    marginTop:idx>0?16:8,paddingTop:idx>0?12:0,
                    borderTop:idx>0?'1px solid #2A2520':'none',
                  }}>
                    <div style={{color:'#F59E0B',marginBottom:6}}>─ Tile #{idx + 1} · {tile.status}</div>
                    {tile.debug.request && (
                      <div style={{marginBottom:8}}>
                        <span style={{color:'#10B981'}}>📤 Request</span>
                        <pre style={{
                          margin:'4px 0 0',padding:8,background:'#0A0908',
                          borderRadius:6,overflow:'auto',maxHeight:200,
                          fontSize:11,lineHeight:1.5,
                        }}>
                          {JSON.stringify(tile.debug.request, null, 2)}
                        </pre>
                      </div>
                    )}
                    {tile.debug.response && (
                      <div style={{marginBottom:8}}>
                        <span style={{color:'#6366F1'}}>
                          {tile.debug.response.status < 400 ? '✅' : '❌'} Response · {tile.debug.response.status} · {tile.debug.response.elapsed}
                        </span>
                        <pre style={{
                          margin:'4px 0 0',padding:8,background:'#0A0908',
                          borderRadius:6,overflow:'auto',maxHeight:300,
                          fontSize:11,lineHeight:1.5,
                        }}>
                          {JSON.stringify(tile.debug.response, (key, val) => {
                            // 隐藏 base64 图片数据，太长无法阅读
                            if (key === 'data' && typeof val === 'string' && val.length > 500) return `[${val.length} 字符 base64]`;
                            if (key === 'body' && typeof val === 'object' && val !== null) {
                              const cleaned = JSON.parse(JSON.stringify(val));
                              const cleanParts = (parts) => parts.map(p => {
                                if (p.inlineData) return { inlineData: { mimeType: p.inlineData.mimeType, data: `[${p.inlineData.data?.length || 0} 字符]` } };
                                return p;
                              });
                              if (cleaned.candidates?.[0]?.content?.parts) {
                                cleaned.candidates[0].content.parts = cleanParts(cleaned.candidates[0].content.parts);
                              }
                              return cleaned;
                            }
                            return val;
                          }, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </details>
            )}
          </div>
        ))}
      </main>

      {/* 移动端抽屉 */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <div className="drawer-section">
          <div className="setting-label" style={{ marginBottom: 10 }}><span>模型</span></div>
          <select className="model-select" value={model} onChange={e => setModel(e.target.value)}>
            {MODELS.map(m => (<option key={m.id} value={m.id}>{m.name} — {m.desc}</option>))}
          </select>
        </div>
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
        <div className="drawer-section">
          <div className="setting-label" style={{ marginBottom: 10 }}><span>生图数量</span><span className="val">{count}</span></div>
          <div className="slider-wrap"><input type="range" min="1" max="8" value={count} onChange={e => setCount(Number(e.target.value))} className="slider" /></div>
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
              <div className="history-thumb"><img src={tile.url} alt="" /></div>
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

      {/* Lightbox — 点击图片放大 */}
      {lightbox && (
        <div className="lightbox-backdrop" onClick={() => setLightbox(null)}>
          <div className="lightbox-container" onClick={e => e.stopPropagation()}>
            <div className="lightbox-header">
              <span className="lightbox-title" style={{fontFamily:'var(--font-sans)',fontSize:13,color:'var(--fg-2)',maxWidth:'80%',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                {lightbox.prompt}
              </span>
              <button className="icon-btn" onClick={() => setLightbox(null)} style={{color:'#fff',background:'rgba(255,255,255,.15)'}}>
                <Icon name="close" size={20} />
              </button>
            </div>
            <img className="lightbox-img" src={lightbox.url} alt="" />
          </div>
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
