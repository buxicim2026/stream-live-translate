// Admin panel logic.
//   * Loads /api/config, /api/devices, /api/status
//   * Binds inputs to the patch payload, POSTs to /api/config
//   * Subscribes to /ws/subtitles for live preview

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

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

  // Per-provider-type hints
  const PROVIDER_HINTS = {
    "qwen": {
      hint: "通义 Qwen API 适用于 qwen3.5-livetranslate-flash-realtime 模型，支持实时语音同传翻译。API Key 从阿里云百炼控制台获取（格式 sk-...）。",
      modelPlaceholder: "qwen3.5-livetranslate-flash-realtime",
      modelSuggestions: [
        { value: "qwen3.5-livetranslate-flash-realtime", label: "同传翻译（推荐，多语言→目标语言）" },
        { value: "qwen3-asr-flash-realtime", label: "通义语音识别（ASR）" },
        { value: "qwen-audio-realtime-plus", label: "Qwen-Audio 实时识别" },
        { value: "qwen-audio-3.0-realtime-flash", label: "Qwen-Audio 3.0 实时" },
        { value: "qwen-audio-3.0-asr-flash-streaming", label: "Qwen-Audio 3.0 流式识别" }
      ],
      endpointPlaceholder: "留空使用内置默认地址（wss://dashscope.aliyuncs.com/api-ws/v1/realtime）",
      endpointDefault: "",
      className: "qwen-hint"
    },
    "online": {
      hint: "支持 OpenAI 兼容的 Realtime WebSocket 接口，包括 GPT、Gemini、火山引擎、讯飞等在线 API。Base URL 填对应的 WebSocket 地址（wss://...）。",
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
      hint: "支持本机部署的兼容 API（如 Ollama、LocalAI 等）。Base URL 填本机地址，例如：ws://localhost:11434/v1/realtime",
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
      hint: "本地模拟输出，不联网、不消耗额度，仅用于界面测试。",
      modelPlaceholder: "mock",
      modelSuggestions: [],
      endpointPlaceholder: "无需填写",
      endpointDefault: "",
      className: "qwen-hint"
    }
  };

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
      btn.textContent = on ? "切换到液态玻璃" : "切换到性能模式";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on
        ? "当前为性能模式（已关闭液态玻璃特效）。点击恢复液态玻璃效果。"
        : "关闭液态玻璃特效（极光动画、毛玻璃模糊、高光扫动），降低集显占用";
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
    // 0 = 自动：宽度贴合文字，高度刚好一行。
    el.style.width = w > 0 ? Math.round(w * k) + "px" : "auto";
    el.style.height = h > 0 ? Math.round(h * k) + "px" : "auto";
    el.style.borderRadius = Math.round(radius * k) + "px";

    // 与 overlay 一致：视口高度 = 最大行数 × 行高，超出部分滚动显示。
    // 这里不再用 -webkit-line-clamp —— 否则预览显示省略号，而 OBS 里在滚动，
    // 两边观感对不上。
    const lineEl = $("preview-line");
    if (lineEl) {
      const lines = Math.min(4, Math.max(1, num("ov-max-lines", 2)));
      lineEl.style.removeProperty("-webkit-line-clamp");
      lineEl.style.removeProperty("line-clamp");
      lineEl.classList.toggle("single-line", lines <= 1);
      const lh = parseFloat(getComputedStyle(el).lineHeight) || Math.round(size * k) * 1.25;
      lineEl.style.setProperty("--preview-max-height", (lines * lh).toFixed(2) + "px");
      ensurePreviewInner();
      previewScroller.restart();
    }

    stage.className = "preview-stage position-" + ($("ov-position").value || "bottom");
  }

  /// 与 overlay 同样的结构：外层 #preview-line 当视口裁切，
  /// 文字放进内层 .preview-inner，靠 transform 上移实现滚动。
  /// 动态创建，避免依赖 index.html 改版。
  function ensurePreviewInner() {
    const lineEl = $("preview-line");
    if (!lineEl) return null;
    let inner = lineEl.querySelector(".preview-inner");
    if (!inner) {
      inner = document.createElement("span");
      inner.className = "preview-inner";
      while (lineEl.firstChild) inner.appendChild(lineEl.firstChild);
      lineEl.appendChild(inner);
    }
    return inner;
  }

  /// 「超出最大行数就滚动把字吐出来」的控制器，逻辑与 overlay 一致。
  /// 预览区用它还原 OBS 里的真实观感。
  function createScroller(getLineEl, getInnerEl) {
    const ARM = 400;          // 等文字稳定的时间
    const HOLD_TOP = 1000;    // 停在开头的时间
    const HOLD_BOTTOM = 1200; // 滚到底后的停留时间
    const SPEED = 40;         // 滚动速度 px/s
    const MIN_MS = 400;
    const MAX_MS = 5000;
    const EPS = 2;            // 小于 2px 视为没溢出（亚像素误差）

    let timer = null;
    let armTimer = null;
    let gen = 0;

    function reset() {
      gen++;
      if (timer) { clearTimeout(timer); timer = null; }
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      const inner = getInnerEl();
      if (inner) {
        inner.style.transition = "none";
        inner.style.transform = "translateY(0)";
      }
      const lineEl = getLineEl();
      if (lineEl) lineEl.classList.remove("scrolling");
    }

    function after(ms, fn) {
      const myGen = gen;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // 期间换了字幕或样式：这一串回调作废。
        if (myGen !== gen) return;
        timer = null;
        fn();
      }, ms);
    }

    function run() {
      const lineEl = getLineEl();
      const inner = getInnerEl();
      if (!lineEl || !inner) return;
      if (lineEl.classList.contains("single-line")) return;
      const distance = Math.max(0, Math.round(inner.scrollHeight - lineEl.clientHeight));
      if (distance <= EPS) return; // 没溢出就保持原位
      lineEl.classList.add("scrolling");

      const dur = Math.min(
        MAX_MS,
        Math.max(MIN_MS, Math.round((distance / SPEED) * 1000))
      );
      // 开头停留 → 匀速滚到底 → 底部停留 → 回到开头 → 循环
      after(HOLD_TOP, () => {
        inner.style.transition = `transform ${dur}ms linear`;
        inner.style.transform = `translateY(${-distance}px)`;
        after(dur + HOLD_BOTTOM, () => {
          const back = Math.max(240, Math.round(dur * 0.5));
          inner.style.transition = `transform ${back}ms ease-out`;
          inner.style.transform = "translateY(0)";
          after(back + HOLD_TOP, run);
        });
      });
    }

    function restart() {
      reset();
      if (armTimer) clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armTimer = null;
        run();
      }, ARM);
    }

    return { reset: reset, restart: restart };
  }

  const previewScroller = createScroller(
    () => $("preview-line"),
    () => ensurePreviewInner()
  );

  // Update UI based on selected provider type
  function updateProviderUI() {
    const providerType = $("provider-type").value;
    const hintData = PROVIDER_HINTS[providerType];
    const hintBox = $("provider-hint-box");
    const modelInput = $("model");
    const endpointInput = $("endpoint");
    const modelDatalist = $("model-presets");

    // Update hint box
    hintBox.className = "provider-hint-box " + hintData.className;
    if (providerType === "qwen") {
      hintBox.innerHTML = `<strong>💡 通义 Qwen API</strong><br />推荐使用 <code>qwen3.5-livetranslate-flash-realtime</code> 模型，支持实时语音同传翻译。`;
    } else if (providerType === "online") {
      hintBox.innerHTML = `<strong>🌐 其它在线 API</strong><br />支持 OpenAI 兼容接口的在线服务，包括 GPT、Gemini、火山引擎、讯飞等。`;
    } else if (providerType === "local") {
      hintBox.innerHTML = `<strong>💻 本机部署 API</strong><br />连接本地运行的模型服务（如 Ollama）。需要确保服务已启动并开启 Realtime API。`;
    } else if (providerType === "mock") {
      hintBox.innerHTML = `<strong>🧪 模拟模式</strong><br />本地模拟输出，不联网、不消耗额度，仅用于界面测试。`;
    }

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
      empty.value = ""; empty.textContent = "（默认）";
      sel.appendChild(empty);
      for (const d of list) {
        const opt = document.createElement("option");
        opt.value = d.name;
        const tag = [d.supports_input && "输入", d.supports_output && "输出"]
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
        run.textContent = "● 管线运行中";
        run.className = "run-state ok";
      } else {
        run.textContent = "● 管线未运行";
        run.className = "run-state bad";
      }
      const errEl = $("engine-error");
      errEl.classList.remove("good");
      if (s.last_error) {
        errEl.textContent = "❗ " + s.last_error;
        errEl.hidden = false;
      } else if (!s.obs_connected && s.obs_error) {
        errEl.textContent = "⚠️ OBS 未连接：" + s.obs_error +
          "（请确认 OBS 已启动，且 工具 → WebSocket 服务器设置 已开启）";
        errEl.hidden = false;
      } else if (s.running) {
        errEl.textContent = "✅ 管线运行中";
        errEl.hidden = false;
        errEl.classList.add("good");
      } else {
        errEl.hidden = true;
      }
      if (s.config_path) {
        $("config-path").textContent = "配置文件：" + s.config_path;
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

  function showPreview(text) {
    const el = $("preview-caption");
    const inner = ensurePreviewInner();
    if (inner) inner.textContent = text;
    el.classList.remove("empty");
    previewScroller.restart();
  }

  function clearPreview() {
    previewScroller.reset();
    const inner = ensurePreviewInner();
    if (inner) inner.textContent = "";
    $("preview-caption").classList.add("empty");
    lastFinalText = "";
    recentSentences.length = 0;
  }

  // Wire up events.
  $("provider-type").addEventListener("change", updateProviderUI);
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
        toast("请先填写 API Key", "error");
        return;
      }
      if (/^https?:/i.test(key) || key.includes("://")) {
        toast("API Key 填成了网址！Key 是以 sk- 开头的密钥", "error");
        return;
      }
    }

    const providerType = $("provider-type").value;

    if (providerType === "qwen") {
      if (patch.llm.endpoint && /compatible-mode|http:|https:/i.test(patch.llm.endpoint)) {
        toast("Base URL 不正确：DashScope Realtime 需要 WebSocket 地址（wss://...），建议留空使用内置默认", "error");
        return;
      }
    }

    if (providerType === "online") {
      const ep = patch.llm.endpoint?.trim() || "";
      if (ep && !/^wss?:/i.test(ep)) {
        toast("Base URL 必须是 WebSocket 地址（wss:// 开头）", "error");
        return;
      }
    }

    if (providerType === "local") {
      const ep = patch.llm.endpoint?.trim() || "";
      if (!ep) {
        toast("请填写本机部署 API 的地址，例如 ws://localhost:11434/v1/realtime", "error");
        return;
      }
      if (!/^ws?:/i.test(ep)) {
        toast("本机 API 地址必须是 WebSocket 地址（ws:// 开头）", "error");
        return;
      }
    }

    const btn = $("save-btn");
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        let msg = "HTTP " + r.status;
        try { msg = (await r.json()).error || msg; } catch {}
        toast("保存失败：" + msg, "error");
        return;
      }
      await loadConfig();
      showOverlayUrl();
      const saved = currentConfig && currentConfig.llm.api_key === patch.llm.api_key
        && currentConfig.llm.model === patch.llm.model;
      if (saved) {
        toast("✅ 配置已保存并生效（管线已重启）", "ok");
      } else {
        toast("⚠️ 已保存，但读回内容不一致，请检查配置文件权限", "error");
      }
      await fetch("/api/restart", { method: "POST" });
      setTimeout(loadStatus, 800);
    } catch (e) {
      toast("保存失败：" + e, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "保存配置";
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
          showPreview(pendingPartial);
        }
      } else if (p.type === "partial") {
        const cleaned = cleanText(p.text || "");
        if (cleaned) {
          pendingPartial += cleaned;
          // Show partial if it's different enough from last final
          if (!isDuplicate(pendingPartial)) {
            showPreview(pendingPartial);
          }
        }
      } else if (p.type === "final") {
        const cleaned = cleanText(p.text || "");
        if (cleaned && !isDuplicate(cleaned)) {
          pendingPartial = cleaned;
          lastFinalText = cleaned;
          showPreview(pendingPartial);
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

  loadConfig().then(loadDevices);
  setInterval(loadStatus, 1500);
  setInterval(loadHistory, 5000);
  connectWS();
})();