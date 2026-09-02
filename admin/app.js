// Admin panel logic.
//   * Loads /api/config, /api/devices, /api/status
//   * Binds inputs to the patch payload, POSTs to /api/config
//   * Subscribes to /ws/subtitles for live preview

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---- i18n ---------------------------------------------------------------
  // 界面语言自动跟随**电脑系统语言**（服务端 /api/locale 检测），不提供手动
  // 切换按钮：英文系统打开就是英文，中文系统打开就是中文。
  //
  // 元素通过 data-i18n（纯文本）/ data-i18n-html（含标签）/ data-i18n-ph
  // （placeholder）/ data-i18n-title（title）声明自己用哪条文案。

  const I18N = {
    zh: {
      "app.title": "Stream Live Translate · 控制台",

      "status.audio": "音频",
      "status.llm": "大模型",
      "status.obs": "OBS",
      "status.checking": "检测中…",
      "status.running": "● 管线运行中",
      "status.stopped": "● 管线未运行",

      "perf.btn": "切换到性能模式",
      "perf.btn.active": "切换到液态玻璃",
      "perf.title": "关闭液态玻璃特效（极光动画、毛玻璃模糊、高光扫动），降低集显占用",
      "perf.title.active": "当前为性能模式（已关闭液态玻璃特效）。点击恢复液态玻璃效果。",

      "sec.llm": "1. 大模型",
      "sec.audio": "2. 音频输入",
      "sec.obs": "3. OBS 集成",
      "sec.style": "4. 字幕样式",
      "sec.preview": "5. 实时字幕预览",
      "sec.history": "6. 翻译结果历史",

      "llm.hint": "填入你自己的大模型 API Key。所有内容只在本地保存。",
      "llm.provider": "API 服务",
      "llm.provider.qwen": "通义 Qwen API（推荐）",
      "llm.provider.online": "其它在线 API（GPT / Gemini / 火山引擎 / 讯飞等）",
      "llm.provider.local": "本机部署 API（Ollama / LocalAI 等）",
      "llm.provider.mock": "模拟模式（不消耗额度）",
      "llm.model": "Model（模型名称）",
      "llm.apikey": "API Key",
      "llm.baseurl": "Base URL（接口地址）",
      "llm.baseurl.ph": "留空使用内置默认地址",
      "llm.target": "翻译目标语言",
      "llm.translate_zh": "对中文也调用翻译（默认否，节省 token）",
      "llm.lowlat": "低延迟模式：不等一句话说完，字幕边说边出",
      "llm.lowlat.ms": "分段时长",
      "llm.lowlat.hint": "开启后每段约 1–1.5 秒即出，适合实时同传；延迟低但长句会被切短。中文直播只要中文字幕时，建议把模型换成 qwen3-asr-flash-realtime（ASR）效果最佳。",

      "lang.zh": "中文",
      "lang.en": "英语",
      "lang.fr": "法语",
      "lang.ja": "日语",
      "lang.ko": "韩语",
      "lang.es": "西班牙语",

      "audio.hint": "系统音频环回 = 抓取 OBS 当前听到的声音；麦克风 = 抓指定输入设备。",
      "audio.mode": "模式",
      "audio.mode.obs": "OBS 插件送音（插件模式下自动使用，请勿更改）",
      "audio.mode.system": "系统音频环回（独立运行时）",
      "audio.mode.device": "指定输入/输出设备",
      "audio.locked": "🔒 引擎由 OBS 插件启动，音频由插件直接送入，模式已锁定。",
      "audio.device": "设备",
      "audio.device.default": "（默认）",
      "audio.tag.input": "输入",
      "audio.tag.output": "输出",
      "audio.sck": "macOS 使用 ScreenCaptureKit（需要授予“屏幕录制”权限）",

      "obs.hint": "插件自动连接本机 OBS（obs-websocket v5），可把字幕同步写入一个“Subtitles”文本源。",
      "obs.auto": "启动时自动连接",
      "obs.host": "OBS WebSocket 地址",
      "obs.port": "OBS 端口",
      "obs.password": "OBS 密码（如果开启了）",
      "obs.dockhint.a": "想把控制台钉到 OBS 侧边栏？OBS → 顶部菜单",
      "obs.dockhint.tools": "工具",
      "obs.dockhint.arrow": "→",
      "obs.dockhint.docks": "自定义浏览器停靠面板 (Custom Browser Docks)",
      "obs.dockhint.then": "→ 填入",
      "obs.dockhint.name": "，名称随意。",

      "style.hint": "保存后 OBS 字幕<b>立即生效</b>，无需重新复制下方 URL。",
      "style.size": "字体大小 (px)",
      "style.maxlines": "最大行数",
      "style.maxlines.note": "行数按需增长：短句一行，放不下自动折到 2/3/4 行。<b>超出上限的部分直接换到下一句字幕显示</b>（英文新闻、访谈等长句场景），全程无滚动效果。填 1 = 严格单行 + 省略号。",
      "style.bgsize": "背景尺寸（px）",
      "style.width": "宽度",
      "style.height": "高度",
      "style.radius": "圆角",
      "style.opacity": "背景透明度",
      "style.color": "颜色",
      "style.bg": "背景",
      "style.position": "位置",
      "style.pos.bottom": "底部",
      "style.pos.top": "顶部",
      "style.pos.middle": "中间",
      "style.animation": "动画",
      "style.anim.typewriter": "打字机",
      "style.anim.fade": "淡入淡出",
      "style.anim.slide": "滑入",

      "preview.save": "保存配置",
      "preview.restart": "重启管线",
      "preview.clear": "清空字幕",

      "overlay.url.label": "OBS 字幕源 URL（复制到 OBS 浏览器源）",
      "overlay.sizehint": "OBS 浏览器源推荐 1920×540 的尺寸",

      "footer": "本插件由不息传播制作",

      "config.path": "配置文件：",
      "err.prefix": "❗ ",
      "err.running": "✅ 管线运行中",
      "err.obs": "⚠️ OBS 未连接：",
      "err.obs.tail": "（请确认 OBS 已启动，且 工具 → WebSocket 服务器设置 已开启）",

      "toast.saving": "保存中…",
      "toast.savefail": "保存失败：",
      "toast.saved": "✅ 配置已保存并生效（管线已重启）",
      "toast.mismatch": "⚠️ 已保存，但读回内容不一致，请检查配置文件权限",
      "toast.needkey": "请先填写 API Key",
      "toast.keyurl": "API Key 填成了网址！Key 是以 sk- 开头的密钥",
      "toast.qwenurl": "Base URL 不正确：DashScope Realtime 需要 WebSocket 地址（wss://...），建议留空使用内置默认",
      "toast.onlineurl": "Base URL 必须是 WebSocket 地址（wss:// 开头）",
      "toast.localneedep": "请填写本机部署 API 的地址，例如 ws://localhost:11434/v1/realtime",
      "toast.localurl": "本机 API 地址必须是 WebSocket 地址（ws:// 开头）",
    },

    en: {
      "app.title": "Stream Live Translate · Console",

      "status.audio": "Audio",
      "status.llm": "Model",
      "status.obs": "OBS",
      "status.checking": "Checking…",
      "status.running": "● Pipeline running",
      "status.stopped": "● Pipeline stopped",

      "perf.btn": "Switch to Performance Mode",
      "perf.btn.active": "Switch to Liquid Glass",
      "perf.title": "Turn off liquid-glass effects (aurora animation, blur, sheen) to reduce load on integrated GPUs",
      "perf.title.active": "Performance mode is on (liquid-glass effects disabled). Click to restore liquid glass.",

      "sec.llm": "1. AI Model",
      "sec.audio": "2. Audio Input",
      "sec.obs": "3. OBS Integration",
      "sec.style": "4. Subtitle Style",
      "sec.preview": "5. Live Preview",
      "sec.history": "6. Translation History",

      "llm.hint": "Enter your own model API key. Everything is stored locally only.",
      "llm.provider": "API Provider",
      "llm.provider.qwen": "Qwen API (recommended)",
      "llm.provider.online": "Other online API (GPT / Gemini / Volcengine / iFlytek …)",
      "llm.provider.local": "Self-hosted API (Ollama / LocalAI …)",
      "llm.provider.mock": "Mock mode (no quota used)",
      "llm.model": "Model",
      "llm.apikey": "API Key",
      "llm.baseurl": "Base URL (endpoint)",
      "llm.baseurl.ph": "Leave empty for the built-in default",
      "llm.target": "Target language",
      "llm.translate_zh": "Also translate Chinese input (off by default, saves tokens)",
      "llm.lowlat": "Low-latency mode: show subtitles while speaking, no need to wait for a full sentence",
      "llm.lowlat.ms": "Segment length",
      "llm.lowlat.hint": "When on, a subtitle segment appears every ~1–1.5s — great for live interpretation; latency is low but long sentences get split. For Chinese livestreams that only need Chinese captions, switch the model to qwen3-asr-flash-realtime (ASR) for best results.",

      "lang.zh": "Chinese",
      "lang.en": "English",
      "lang.fr": "French",
      "lang.ja": "Japanese",
      "lang.ko": "Korean",
      "lang.es": "Spanish",

      "audio.hint": "System loopback = capture what OBS hears; Microphone = a specific input device.",
      "audio.mode": "Mode",
      "audio.mode.obs": "OBS plugin feed (auto-selected in plugin mode, do not change)",
      "audio.mode.system": "System audio loopback (standalone)",
      "audio.mode.device": "Specific input/output device",
      "audio.locked": "🔒 Started by the OBS plugin: audio is fed directly by the plugin, mode locked.",
      "audio.device": "Device",
      "audio.device.default": "(Default)",
      "audio.tag.input": "Input",
      "audio.tag.output": "Output",
      "audio.sck": "Use ScreenCaptureKit on macOS (requires Screen Recording permission)",

      "obs.hint": "Auto-connects to local OBS (obs-websocket v5) and mirrors subtitles into a “Subtitles” text source.",
      "obs.auto": "Connect automatically on start",
      "obs.host": "OBS WebSocket host",
      "obs.port": "OBS port",
      "obs.password": "OBS password (if enabled)",
      "obs.dockhint.a": "Want the console docked in OBS? Go to OBS → top menu",
      "obs.dockhint.tools": "Tools",
      "obs.dockhint.arrow": "→",
      "obs.dockhint.docks": "Custom Browser Docks",
      "obs.dockhint.then": "→ enter",
      "obs.dockhint.name": " — any name works.",

      "style.hint": "Saved changes apply to the OBS overlay <b>immediately</b> — no need to re-copy the URL below.",
      "style.size": "Font size (px)",
      "style.maxlines": "Max lines",
      "style.maxlines.note": "Grows as needed: one line for short text, wrapping to 2/3/4 lines when it doesn’t fit. <b>Text past the limit rolls over into the next subtitle</b> (long-form news, interviews) — no scrolling effect. Set 1 for a strict single line with an ellipsis.",
      "style.bgsize": "Background size (px)",
      "style.width": "Width",
      "style.height": "Height",
      "style.radius": "Radius",
      "style.opacity": "Background opacity",
      "style.color": "Text",
      "style.bg": "Background",
      "style.position": "Position",
      "style.pos.bottom": "Bottom",
      "style.pos.top": "Top",
      "style.pos.middle": "Middle",
      "style.animation": "Animation",
      "style.anim.typewriter": "Typewriter",
      "style.anim.fade": "Fade",
      "style.anim.slide": "Slide",

      "preview.save": "Save",
      "preview.restart": "Restart pipeline",
      "preview.clear": "Clear subtitles",

      "overlay.url.label": "Overlay URL (paste into an OBS browser source)",
      "overlay.sizehint": "Recommended browser source size: 1920×540",

      "footer": "Made by Buxi Studio",

      "config.path": "Config file: ",
      "err.prefix": "❗ ",
      "err.running": "✅ Pipeline running",
      "err.obs": "⚠️ OBS not connected: ",
      "err.obs.tail": " (make sure OBS is running and Tools → WebSocket Server Settings is enabled)",

      "toast.saving": "Saving…",
      "toast.savefail": "Failed to save: ",
      "toast.saved": "✅ Configuration saved and applied (pipeline restarted)",
      "toast.mismatch": "⚠️ Saved, but the value read back differs — check config file permissions",
      "toast.needkey": "Please enter an API key first",
      "toast.keyurl": "That looks like a URL, not an API key. Keys start with sk-",
      "toast.qwenurl": "Invalid Base URL: DashScope Realtime needs a WebSocket address (wss://…). Leave it empty to use the built-in default.",
      "toast.onlineurl": "Base URL must be a WebSocket address (starting with wss://)",
      "toast.localneedep": "Enter your local API address, e.g. ws://localhost:11434/v1/realtime",
      "toast.localurl": "Local API address must be a WebSocket address (starting with ws://)",
    },
  };

  let currentLang = "zh";

  /// 查文案。英文缺某条时退回中文，避免界面出现空白。
  function t(key) {
    const dict = I18N[currentLang] || I18N.zh;
    if (dict[key] !== undefined) return dict[key];
    if (I18N.zh[key] !== undefined) return I18N.zh[key];
    return key;
  }

  /// 把当前语言的文案套到所有标记了 data-i18n* 的元素上。
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-ph"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
    document.title = t("app.title");
  }

  /// 由服务端判定系统语言；旧版服务端没有 /api/locale 时退回浏览器语言。
  async function initI18n() {
    let lang = null;
    try {
      const r = await fetch("/api/locale", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.language) lang = j.language === "zh" ? "zh" : "en";
      }
    } catch {
      // 服务端不可达：走下面的浏览器兜底。
    }
    if (!lang) {
      lang = (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    currentLang = lang;
    applyI18n();
    // 顶栏性能模式按钮在语言检测之前（initPerfMode 于顶层同步执行）就已
    // 按默认语言上过一次文案，这里按最终语言重刷，否则英文系统下按钮会
    // 被 applyI18n 覆盖成"未激活"的那一句。
    setPerfMode(document.body.classList.contains("perf-mode"));
  }

  // OBS dock detection.
  if (new URLSearchParams(location.search).get("obsDock") === "1") {
    document.body.classList.add("dock");
  }

  let currentConfig = null;
  let pendingPartial = "";
  let lastFinalText = "";
  let toastTimer = null;

  // Common watermark/filler words to filter out
  const WATERMARK_WORDS = [
    "字幕", "subtitle", "翻译", "translate", "实时", "real-time", "live",
    "AI", "人工智能", "智能翻译", "同声传译", "直播", "stream"
  ];

  // Debounce duplicate filter - cache recent sentences
  const recentSentences = [];
  const MAX_RECENT = 5;

  function cleanText(text) {
    if (!text) return "";
    let cleaned = text.trim();
    
    // Remove watermark words if they appear as standalone segments
    for (const word of WATERMARK_WORDS) {
      const regex = new RegExp(`^${word}[\\s,.，、.]*|[\\s,.，、.]*${word}$|^${word}$`, 'gi');
      cleaned = cleaned.replace(regex, '');
    }
    
    // Remove repeated characters (more than 3 same chars)
    cleaned = cleaned.replace(/(.)\1{3,}/g, '$1$1$1');
    
    // Remove multiple spaces
    cleaned = cleaned.replace(/\s+/g, ' ');
    
    return cleaned.trim();
  }

  function isDuplicate(text) {
    const cleaned = cleanText(text);
    if (!cleaned || cleaned.length < 3) return true;
    
    // Check against recent sentences
    for (const recent of recentSentences) {
      // If more than 70% similarity, consider duplicate
      const similarity = calculateSimilarity(cleaned, recent);
      if (similarity > 0.7) return true;
    }
    
    // Add to recent
    recentSentences.push(cleaned);
    if (recentSentences.length > MAX_RECENT) {
      recentSentences.shift();
    }
    
    return false;
  }

  function calculateSimilarity(a, b) {
    if (!a || !b) return 0;
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    
    // Simple word-based similarity
    const aWords = new Set(a.toLowerCase().split(/\s+/));
    const bWords = new Set(b.toLowerCase().split(/\s+/));
    const intersection = [...aWords].filter(x => bWords.has(x));
    
    return intersection.length / aWords.size;
  }

  // Toast feedback
  function toast(msg, kind) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show " + (kind || "info");
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // Provider type to internal provider name mapping
  const PROVIDER_TYPE_MAP = {
    "qwen": "qwen-realtime",
    "online": "openai-realtime",
    "local": "openai-realtime",
    "mock": "mock"
  };

  // Per-provider-type hints, per language.
  const PROVIDER_HINTS = {
    zh: {
      "qwen": {
        boxHtml: `<strong>💡 通义 Qwen API</strong><br />只能用 qwen3 系列<strong>语音（多模态）Realtime</strong> 实时模型，不能用非语音、非实时模型运行。同传翻译用 <code>qwen3.5-livetranslate-flash-realtime</code>；实时识别转写用 <code>qwen3-asr-flash-realtime</code> 或 <code>qwen-audio-3.0-realtime-flash</code>。`,
        modelPlaceholder: "qwen3.5-livetranslate-flash-realtime",
        modelSuggestions: [
          { value: "qwen3.5-livetranslate-flash-realtime", label: "同传翻译（推荐，多语言→目标语言）" },
          { value: "qwen3-asr-flash-realtime", label: "实时语音识别（ASR，边说边出字幕）" },
          { value: "qwen-audio-3.0-realtime-flash", label: "Qwen-Audio 3.0 实时（语音对话）" },
          { value: "qwen-audio-realtime-plus", label: "Qwen-Audio Realtime Plus（语音对话）" }
        ],
        endpointPlaceholder: "留空使用内置默认地址（wss://dashscope.aliyuncs.com/api-ws/v1/realtime）",
        endpointDefault: "",
        className: "qwen-hint"
      },
      "online": {
        boxHtml: `<strong>🌐 其它在线 API</strong><br />支持 OpenAI 兼容接口的在线服务，包括 GPT、Gemini、火山引擎、讯飞等。`,
        modelPlaceholder: "gpt-4o-realtime",
        modelSuggestions: [
          { value: "gpt-4o-realtime", label: "OpenAI GPT-4o Realtime" },
          { value: "gpt-4o-mini-realtime", label: "OpenAI GPT-4o-mini Realtime" },
          { value: "gemini-2.0-flash-exp", label: "Google Gemini 2.0 Flash" }
        ],
        endpointPlaceholder: "例如：wss://api.openai.com/v1/realtime",
        endpointDefault: "wss://api.openai.com/v1/realtime",
        className: "online-hint"
      },
      "local": {
        boxHtml: `<strong>💻 本机部署 API</strong><br />连接本地运行的模型服务（如 Ollama）。需要确保服务已启动并开启 Realtime API。`,
        modelPlaceholder: "模型名称（根据你的本地部署）",
        modelSuggestions: [
          { value: "llama3.2-realtime", label: "Llama 3.2 Realtime（Ollama）" },
          { value: "qwen2.5-realtime", label: "Qwen 2.5 Realtime（Ollama）" }
        ],
        endpointPlaceholder: "例如：ws://localhost:11434/v1/realtime",
        endpointDefault: "ws://localhost:11434/v1/realtime",
        className: "local-hint"
      },
      "mock": {
        boxHtml: `<strong>🧪 模拟模式</strong><br />本地模拟输出，不联网、不消耗额度，仅用于界面测试。`,
        modelPlaceholder: "mock",
        modelSuggestions: [],
        endpointPlaceholder: "无需填写",
        endpointDefault: "",
        className: "qwen-hint"
      }
    },

    en: {
      "qwen": {
        boxHtml: `<strong>💡 Qwen API</strong><br />Only qwen3 <strong>speech (multimodal) Realtime</strong> models work — non-speech / non-realtime models cannot run. Use <code>qwen3.5-livetranslate-flash-realtime</code> for simultaneous translation, or <code>qwen3-asr-flash-realtime</code> / <code>qwen-audio-3.0-realtime-flash</code> for live recognition.`,
        modelPlaceholder: "qwen3.5-livetranslate-flash-realtime",
        modelSuggestions: [
          { value: "qwen3.5-livetranslate-flash-realtime", label: "Simultaneous translation (recommended, multi-language → target)" },
          { value: "qwen3-asr-flash-realtime", label: "Live speech recognition (ASR, captions while speaking)" },
          { value: "qwen-audio-3.0-realtime-flash", label: "Qwen-Audio 3.0 realtime (speech conversation)" },
          { value: "qwen-audio-realtime-plus", label: "Qwen-Audio Realtime Plus (speech conversation)" }
        ],
        endpointPlaceholder: "Leave empty for the built-in default (wss://dashscope.aliyuncs.com/api-ws/v1/realtime)",
        endpointDefault: "",
        className: "qwen-hint"
      },
      "online": {
        boxHtml: `<strong>🌐 Other Online APIs</strong><br />Any OpenAI-compatible online service, including GPT, Gemini, Volcengine and iFlytek.`,
        modelPlaceholder: "gpt-4o-realtime",
        modelSuggestions: [
          { value: "gpt-4o-realtime", label: "OpenAI GPT-4o Realtime" },
          { value: "gpt-4o-mini-realtime", label: "OpenAI GPT-4o-mini Realtime" },
          { value: "gemini-2.0-flash-exp", label: "Google Gemini 2.0 Flash" }
        ],
        endpointPlaceholder: "e.g. wss://api.openai.com/v1/realtime",
        endpointDefault: "wss://api.openai.com/v1/realtime",
        className: "online-hint"
      },
      "local": {
        boxHtml: `<strong>💻 Self-hosted API</strong><br />Connect to a model service running locally (e.g. Ollama). Make sure it is started and exposes the Realtime API.`,
        modelPlaceholder: "Model name (as deployed locally)",
        modelSuggestions: [
          { value: "llama3.2-realtime", label: "Llama 3.2 Realtime (Ollama)" },
          { value: "qwen2.5-realtime", label: "Qwen 2.5 Realtime (Ollama)" }
        ],
        endpointPlaceholder: "e.g. ws://localhost:11434/v1/realtime",
        endpointDefault: "ws://localhost:11434/v1/realtime",
        className: "local-hint"
      },
      "mock": {
        boxHtml: `<strong>🧪 Mock Mode</strong><br />Local simulated output — no network, no quota, for UI testing only.`,
        modelPlaceholder: "mock",
        modelSuggestions: [],
        endpointPlaceholder: "Not required",
        endpointDefault: "",
        className: "qwen-hint"
      }
    }
  };

  /// 当前语言下的 provider 提示；英文缺项时退回中文。
  function providerHint(providerType) {
    return (PROVIDER_HINTS[currentLang] || PROVIDER_HINTS.zh)[providerType];
  }

  /// 低延迟模式：勾选 → 显示分段时长选择；取消 → 退回整句模式。
  function syncLowLatencyRows(on) {
    const row = $("low_latency_ms_row");
    const hint = $("low_latency_hint");
    if (row) row.style.display = on ? "" : "none";
    if (hint) hint.style.display = on ? "" : "none";
  }

  /// 用已保存的 segment_ms 同步低延迟控件状态。
  function syncLowLatency(segmentMs) {
    const on = !!segmentMs && Number(segmentMs) > 0;
    const cb = $("low_latency");
    if (!cb) return;
    cb.checked = on;
    const sel = $("segment_ms");
    if (sel && on) {
      const v = String(segmentMs);
      if (![...sel.options].some((o) => o.value === v)) {
        sel.value = "1200";
      } else {
        sel.value = v;
      }
    }
    syncLowLatencyRows(on);
  }

  function fillForm(cfg) {
    // Determine provider type from internal provider name
    let providerType = "online";
    if (cfg.llm.provider === "qwen-realtime") providerType = "qwen";
    else if (cfg.llm.provider === "mock") providerType = "mock";
    else if (cfg.llm.provider === "openai-realtime") {
      const ep = cfg.llm.endpoint || "";
      if (ep.includes("localhost") || ep.includes("127.0.0.1")) {
        providerType = "local";
      } else {
        providerType = "online";
      }
    }
    
    $("provider-type").value = providerType;
    $("model").value = cfg.llm.model;
    $("api_key").value = cfg.llm.api_key;
    $("endpoint").value = cfg.llm.endpoint || "";
    $("target_lang").value = cfg.llm.target_lang || "zh";
    $("translate_chinese").checked = cfg.llm.translate_chinese;
    syncLowLatency(cfg.llm.segment_ms || 0);

    // Defensive: if the config's mode isn't among the options
    const modeSel = $("audio-mode");
    if (![...modeSel.options].some((o) => o.value === cfg.audio.mode)) {
      const opt = document.createElement("option");
      opt.value = cfg.audio.mode;
      opt.textContent = cfg.audio.mode;
      modeSel.appendChild(opt);
    }
    modeSel.value = cfg.audio.mode;
    $("use_sck").checked = cfg.audio.use_screen_capture_kit;
    $("obs-auto").checked = cfg.obs.auto_connect;
    $("obs-host").value = cfg.obs.host;
    $("obs-port").value = cfg.obs.port;
    $("obs-password").value = cfg.obs.password;
    $("ov-size").value = cfg.overlay.font_size || 48;
    $("ov-bg-width").value = cfg.overlay.bg_width || 0;
    $("ov-bg-height").value = cfg.overlay.bg_height || 0;
    $("ov-border-radius").value = cfg.overlay.border_radius || 8;
    const maxLinesEl = $("ov-max-lines");
    if (maxLinesEl) maxLinesEl.value = cfg.overlay.max_lines || 2;
    $("ov-bg-opacity").value = cfg.overlay.bg_opacity !== undefined ? cfg.overlay.bg_opacity : 75;
    $("ov-opacity-display").textContent = (cfg.overlay.bg_opacity !== undefined ? cfg.overlay.bg_opacity : 75) + "%";
    $("ov-color").value = cfg.overlay.font_color || "#ffffff";
    $("ov-bg").value = cfg.overlay.background_color || "#000000";
    $("ov-position").value = cfg.overlay.position || "bottom";
    $("ov-animation").value = cfg.overlay.animation || "typewriter";
    $("obs-dock-url").textContent =
      `${location.protocol}//${location.host}/admin?obsDock=1`;

    updateProviderUI();
    applyPreviewStyles();
  }

  // ---- 性能模式 ---------------------------------------------------------

  const PERF_MODE_KEY = "slt.perfMode";

  function readPerfMode() {
    try {
      return localStorage.getItem(PERF_MODE_KEY) === "1";
    } catch {
      // 隐私模式等场景下 localStorage 不可用，退回默认的玻璃效果。
      return false;
    }
  }

  function writePerfMode(on) {
    try { localStorage.setItem(PERF_MODE_KEY, on ? "1" : "0"); } catch { /* 忽略 */ }
  }

  function setPerfMode(on) {
    document.body.classList.toggle("perf-mode", on);
    const btn = $("perf-mode-btn");
    if (btn) {
      btn.textContent = on ? t("perf.btn.active") : t("perf.btn");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on ? t("perf.title.active") : t("perf.title");
    }
    writePerfMode(on);
  }

  /// 默认开启液态玻璃；已保存的选择会覆盖默认值。
  /// 只在启动时绑定一次：updateUI 会被轮询和保存反复调用，
  /// 放进那里会导致重复挂监听（点一下切换多次）。
  function initPerfMode() {
    setPerfMode(readPerfMode());
    const btn = $("perf-mode-btn");
    if (btn) {
      btn.addEventListener("click", () => {
        setPerfMode(!document.body.classList.contains("perf-mode"));
      });
    }
  }
  initPerfMode();

  function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== "#") return null;
    let h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},` +
           `${parseInt(h.slice(4, 6), 16)},${alpha})`;
  }

  // 预览区按 1920px 画布的 0.45 倍等比缩放，观感与 OBS 里一致。
  const PREVIEW_SCALE = 0.45;

  /// 把「字幕样式 / 背景设置」实时套用到预览字幕上，改完立即看到效果。
  function applyPreviewStyles() {
    const el = $("preview-caption");
    const stage = $("preview-stage");
    if (!el || !stage) return;

    // 元素缺失时（例如浏览器缓存了旧版 index.html）退回默认值，
    // 避免整个面板因为多了一个新字段而白屏。
    const num = (id, dflt) => {
      const el = $(id);
      const n = el ? parseInt(el.value, 10) : NaN;
      return isFinite(n) ? n : dflt;
    };
    const size = Math.max(8, num("ov-size", 48));
    const w = Math.max(0, num("ov-bg-width", 0));
    const h = Math.max(0, num("ov-bg-height", 0));
    const radius = Math.max(0, num("ov-border-radius", 8));
    const opacity = Math.min(100, Math.max(0, num("ov-bg-opacity", 75)));
    const k = PREVIEW_SCALE;

    el.style.fontSize = Math.round(size * k) + "px";
    el.style.lineHeight = "1.25";
    el.style.padding = `${Math.round(10 * k)}px ${Math.round(24 * k)}px`;
    el.style.color = $("ov-color").value;
    el.style.background =
      hexToRgba($("ov-bg").value, opacity / 100) || `rgba(0,0,0,${opacity / 100})`;
    // 0 = 自动：宽度贴合文字，高度按行数自适应。
    el.style.width = w > 0 ? Math.round(w * k) + "px" : "auto";
    el.style.height = h > 0 ? Math.round(h * k) + "px" : "auto";
    el.style.borderRadius = Math.round(radius * k) + "px";

    // 与 overlay 一致：超出最大行数就换到下一句显示，不做滚动/位移。
    // 这里不再用 -webkit-line-clamp —— 否则预览显示省略号，而 OBS 里在
    // 换句，两边观感对不上。
    const lineEl = $("preview-line");
    if (lineEl) {
      const lines = Math.min(4, Math.max(1, num("ov-max-lines", 2)));
      lineEl.style.removeProperty("-webkit-line-clamp");
      lineEl.style.removeProperty("line-clamp");
      lineEl.classList.toggle("single-line", lines <= 1);
      previewLines = lines;
      renderPreview();
    }

    stage.className = "preview-stage position-" + ($("ov-position").value || "bottom");
  }

  // 预览区用与 overlay 完全相同的换句逻辑：文字实时渲染，超出最大行数
  // 就从溢出处另起一句，不做滚动/位移。
  let previewLines = 2;      // 当前预览的最大行数
  let previewPageStart = 0;  // 当前这句在预览文本中的起始下标
  let previewText = "";      // 预览的完整文本

  function previewMeasure(s) {
    const lineEl = $("preview-line");
    if (!lineEl) return 0;
    lineEl.textContent = s;
    return lineEl.scrollHeight;
  }

  function previewFindCut(text, start, maxH) {
    let lo = start + 1;
    let hi = text.length;
    let best = start + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (previewMeasure(text.slice(start, mid)) <= maxH) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /// 按当前样式把 previewText 渲染成「当前这句」。
  function renderPreview() {
    const lineEl = $("preview-line");
    if (!lineEl) return;
    if (previewLines <= 1) {
      lineEl.textContent = previewText;
      return;
    }
    const caption = $("preview-caption");
    const lh = parseFloat(getComputedStyle(caption).lineHeight) || 0;
    const maxH = previewLines * lh;
    if (maxH <= 0) {
      lineEl.textContent = previewText;
      return;
    }
    if (previewPageStart > previewText.length) previewPageStart = 0;
    if (previewMeasure(previewText.slice(previewPageStart)) > maxH) {
      previewPageStart = previewFindCut(previewText, previewPageStart, maxH);
    }
    const shown = previewText.slice(previewPageStart);
    if (lineEl.textContent !== shown) lineEl.textContent = shown;
  }

  /// 更新预览文本。新句子（不是在上文后面追加）时从头开始显示。
  function setPreviewText(text, append) {
    if (!append) previewPageStart = 0;
    previewText = text || "";
    renderPreview();
  }

  // Update UI based on selected provider type
  function updateProviderUI() {
    const providerType = $("provider-type").value;
    const hintData = providerHint(providerType);
    const hintBox = $("provider-hint-box");
    const modelInput = $("model");
    const endpointInput = $("endpoint");
    const modelDatalist = $("model-presets");

    // Update hint box
    hintBox.className = "provider-hint-box " + hintData.className;
    hintBox.innerHTML = hintData.boxHtml;

    // Update model placeholder
    modelInput.placeholder = hintData.modelPlaceholder;

    // Update model datalist
    modelDatalist.innerHTML = "";
    hintData.modelSuggestions.forEach(suggestion => {
      const option = document.createElement("option");
      option.value = suggestion.value;
      option.textContent = suggestion.label;
      modelDatalist.appendChild(option);
    });

    // Update endpoint
    endpointInput.placeholder = hintData.endpointPlaceholder;
    if (providerType !== "mock" && !endpointInput.value) {
      endpointInput.value = hintData.endpointDefault;
    }
  }

  function collectPatch() {
    const providerType = $("provider-type").value;
    const provider = PROVIDER_TYPE_MAP[providerType];
    
    return {
      llm: {
        provider: provider,
        model: $("model").value,
        api_key: $("api_key").value,
        endpoint: $("endpoint").value.trim() || null,
        target_lang: $("target_lang").value,
        translate_chinese: $("translate_chinese").checked,
        // 低延迟模式：勾选才写分段时长；否则存 0 = 整句模式。
        segment_ms: ($("low_latency") && $("low_latency").checked)
          ? (Number($("segment_ms").value) || 1200)
          : 0,
      },
      audio: {
        mode: $("audio-mode").value,
        device: $("audio-device").value,
        use_screen_capture_kit: $("use_sck").checked,
      },
      obs: {
        auto_connect: $("obs-auto").checked,
        host: $("obs-host").value,
        port: parseInt($("obs-port").value, 10) || 4455,
        password: $("obs-password").value,
      },
      overlay: {
        font_size: parseInt($("ov-size").value, 10) || 48,
        max_lines: Math.min(4, Math.max(1, parseInt(($("ov-max-lines") || {}).value, 10) || 2)),
        bg_width: Math.max(0, parseInt($("ov-bg-width").value, 10) || 0),
        bg_height: Math.max(0, parseInt($("ov-bg-height").value, 10) || 0),
        border_radius: Math.max(0, parseInt($("ov-border-radius").value, 10) || 8),
        bg_opacity: parseInt($("ov-bg-opacity").value, 10) || 75,
        font_color: $("ov-color").value,
        background_color: $("ov-bg").value,
        position: $("ov-position").value,
        animation: $("ov-animation").value,
      },
    };
  }

  // 样式不再写进 URL hash：样式由 overlay 从 /api/config 拉取，并在保存时
  // 通过 WebSocket 实时推送。旧 URL 里残留的 hash 参数会被服务端配置覆盖，
  // 所以已经填好的 OBS 浏览器源不必重新复制。
  function buildOverlayUrl() {
    const proto = location.protocol === "https:" ? "https:" : "http:";
    return `${proto}//${location.host}/overlay`;
  }

  function showOverlayUrl() {
    const box = $("overlay-url-box");
    const input = $("overlay-url");
    if (!box || !input || !currentConfig) return;
    input.value = buildOverlayUrl();
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function loadConfig() {
    const r = await fetch("/api/config");
    const cfg = await r.json();
    currentConfig = cfg;
    fillForm(cfg);
    showOverlayUrl();
  }

  async function loadDevices() {
    try {
      const r = await fetch("/api/devices");
      const list = await r.json();
      const sel = $("audio-device");
      sel.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = t("audio.device.default");
      sel.appendChild(empty);
      for (const d of list) {
        const opt = document.createElement("option");
        opt.value = d.name;
        // 设备名由驱动提供，不翻译；只翻译「输入 / 输出」标记。
        const tag = [
          d.supports_input && t("audio.tag.input"),
          d.supports_output && t("audio.tag.output"),
        ]
          .filter(Boolean).join(" / ");
        opt.textContent = `${d.name} ${tag ? `[${tag}]` : ""}`;
        sel.appendChild(opt);
      }
      if (currentConfig?.audio.device) {
        sel.value = currentConfig.audio.device;
      }
    } catch (e) {
      console.warn("load devices failed", e);
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch("/api/status");
      const s = await r.json();
      const set = (id, ok, warn) => {
        const el = $(id);
        el.classList.remove("ok", "bad", "warn");
        el.classList.add(ok ? "ok" : warn ? "warn" : "bad");
      };
      set("dot-audio", s.audio_active, false);
      set("dot-llm", s.llm_connected, s.running && !s.last_error ? true : false);
      set("dot-obs", s.obs_connected, false);
      const run = $("run-state");
      if (s.running) {
        run.textContent = t("status.running");
        run.className = "run-state ok";
      } else {
        run.textContent = t("status.stopped");
        run.className = "run-state bad";
      }
      const errEl = $("engine-error");
      errEl.classList.remove("good");
      if (s.last_error) {
        // 引擎报错原文不翻译（通常已是英文），只翻译前缀。
        errEl.textContent = t("err.prefix") + s.last_error;
        errEl.hidden = false;
      } else if (!s.obs_connected && s.obs_error) {
        errEl.textContent =
          t("err.obs") + s.obs_error + t("err.obs.tail");
        errEl.hidden = false;
      } else if (s.running) {
        errEl.textContent = t("err.running");
        errEl.hidden = false;
        errEl.classList.add("good");
      } else {
        errEl.hidden = true;
      }
      if (s.config_path) {
        $("config-path").textContent = t("config.path") + s.config_path;
      }
      const modeSel = $("audio-mode");
      const lock = $("audio-mode-lock");
      if (s.audio_mode_forced) {
        modeSel.disabled = true;
        lock.hidden = false;
      } else {
        modeSel.disabled = false;
        lock.hidden = true;
      }
    } catch (e) {
      console.warn("load status failed", e);
    }
  }

  async function loadHistory() {
    try {
      const r = await fetch("/api/subtitles");
      const j = await r.json();
      const cont = $("history");
      cont.innerHTML = "";
      const items = (j.history || []).slice(-30).reverse();
      for (const line of items) {
        const row = document.createElement("div");
        row.className = "row";
        const lang = document.createElement("span");
        lang.className = "lang";
        lang.textContent = line.language || "auto";
        const text = document.createElement("span");
        text.className = "text";
        text.textContent = line.text;
        row.appendChild(lang);
        row.appendChild(text);
        cont.appendChild(row);
      }
    } catch (e) {
      console.warn("load history failed", e);
    }
  }

  /// append 为 true 表示是在上一句后面继续（partial 流式），
  /// 否则视为新的一句，从头开始显示。
  function showPreview(text, append) {
    setPreviewText(text, append);
    $("preview-caption").classList.remove("empty");
  }

  function clearPreview() {
    previewText = "";
    previewPageStart = 0;
    const lineEl = $("preview-line");
    if (lineEl) lineEl.textContent = "";
    $("preview-caption").classList.add("empty");
    lastFinalText = "";
    recentSentences.length = 0;
  }

  // Wire up events.
  $("provider-type").addEventListener("change", updateProviderUI);
  const lowLatCb = $("low_latency");
  if (lowLatCb) lowLatCb.addEventListener("change", () => syncLowLatencyRows(lowLatCb.checked));
  $("ov-bg-opacity").addEventListener("input", (e) => {
    $("ov-opacity-display").textContent = e.target.value + "%";
  });
  // 背景设置改动即时反映到预览（保存后同样作用于 OBS 浏览器源）。
  ["ov-size", "ov-bg-width", "ov-bg-height", "ov-border-radius",
   "ov-bg-opacity", "ov-color", "ov-bg", "ov-position", "ov-max-lines"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("input", applyPreviewStyles);
  });
  $("save-btn").addEventListener("click", async () => {
    const patch = collectPatch();
    const key = patch.llm.api_key.trim();

    if (patch.llm.provider !== "mock") {
      if (!key) {
        toast(t("toast.needkey"), "error");
        return;
      }
      if (/^https?:/i.test(key) || key.includes("://")) {
        toast(t("toast.keyurl"), "error");
        return;
      }
    }

    const providerType = $("provider-type").value;

    if (providerType === "qwen") {
      if (patch.llm.endpoint && /compatible-mode|http:|https:/i.test(patch.llm.endpoint)) {
        toast(t("toast.qwenurl"), "error");
        return;
      }
    }

    if (providerType === "online") {
      const ep = patch.llm.endpoint?.trim() || "";
      if (ep && !/^wss?:/i.test(ep)) {
        toast(t("toast.onlineurl"), "error");
        return;
      }
    }

    if (providerType === "local") {
      const ep = patch.llm.endpoint?.trim() || "";
      if (!ep) {
        toast(t("toast.localneedep"), "error");
        return;
      }
      if (!/^ws?:/i.test(ep)) {
        toast(t("toast.localurl"), "error");
        return;
      }
    }

    const btn = $("save-btn");
    btn.disabled = true;
    btn.textContent = t("toast.saving");
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        let msg = "HTTP " + r.status;
        try { msg = (await r.json()).error || msg; } catch {}
        toast(t("toast.savefail") + msg, "error");
        return;
      }
      await loadConfig();
      showOverlayUrl();
      const saved = currentConfig && currentConfig.llm.api_key === patch.llm.api_key
        && currentConfig.llm.model === patch.llm.model;
      if (saved) {
        toast(t("toast.saved"), "ok");
      } else {
        toast(t("toast.mismatch"), "error");
      }
      await fetch("/api/restart", { method: "POST" });
      setTimeout(loadStatus, 800);
    } catch (e) {
      toast(t("toast.savefail") + e, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = t("preview.save");
    }
  });

  $("restart-btn").addEventListener("click", async () => {
    await fetch("/api/restart", { method: "POST" });
  });

  $("clear-btn").addEventListener("click", async () => {
    await fetch("/api/subtitles/clear", { method: "POST" });
    clearPreview();
  });

  // Live preview via WebSocket.
  function connectWS() {
    const wsScheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${wsScheme}://${location.host}/ws/subtitles`);
    ws.addEventListener("message", (ev) => {
      let p;
      try { p = JSON.parse(ev.data); } catch { return; }
      if (p.type === "current" && p.line) {
        const cleaned = cleanText(p.line.text || "");
        if (cleaned && !isDuplicate(cleaned)) {
          pendingPartial = cleaned;
          showPreview(pendingPartial, false);
        }
      } else if (p.type === "partial") {
        const cleaned = cleanText(p.text || "");
        if (cleaned) {
          pendingPartial += cleaned;
          // Show partial if it's different enough from last final
          if (!isDuplicate(pendingPartial)) {
            showPreview(pendingPartial, true);
          }
        }
      } else if (p.type === "final") {
        const cleaned = cleanText(p.text || "");
        if (cleaned && !isDuplicate(cleaned)) {
          pendingPartial = cleaned;
          lastFinalText = cleaned;
          showPreview(pendingPartial, false);
          loadHistory();
        }
      } else if (p.type === "cleared") {
        pendingPartial = "";
        clearPreview();
      }
    });
    ws.addEventListener("close", () => {
      setTimeout(connectWS, 1500);
    });
  }

  // 先定语言再渲染：否则界面会先闪一版中文再跳成英文。
  initI18n().then(() => {
    loadConfig().then(loadDevices);
  });
  setInterval(loadStatus, 1500);
  setInterval(loadHistory, 5000);
  connectWS();
})();