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
    $("ov-bg-opacity").value = cfg.overlay.bg_opacity !== undefined ? cfg.overlay.bg_opacity : 75;
    $("ov-opacity-display").textContent = (cfg.overlay.bg_opacity !== undefined ? cfg.overlay.bg_opacity : 75) + "%";
    $("ov-color").value = cfg.overlay.font_color || "#ffffff";
    $("ov-bg").value = cfg.overlay.background_color || "#000000";
    $("ov-position").value = cfg.overlay.position || "bottom";
    $("ov-animation").value = cfg.overlay.animation || "typewriter";
    $("obs-dock-url").textContent =
      `${location.protocol}//${location.host}/admin?obsDock=1`;

    updateProviderUI();
  }

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

  function buildOverlayUrl(cfg) {
    const proto = location.protocol === "https:" ? "https:" : "http:";
    const host = location.host;
    const params = new URLSearchParams();
    if (cfg.overlay.font_size) params.set("size", cfg.overlay.font_size);
    if (cfg.overlay.font_color) params.set("color", cfg.overlay.font_color);
    if (cfg.overlay.background_color) params.set("bg", cfg.overlay.background_color);
    if (cfg.overlay.bg_opacity !== undefined) params.set("bgOpacity", cfg.overlay.bg_opacity);
    if (cfg.overlay.position) params.set("position", cfg.overlay.position);
    if (cfg.overlay.animation) params.set("animation", cfg.overlay.animation);
    if (cfg.overlay.bg_width) params.set("bgWidth", cfg.overlay.bg_width);
    if (cfg.overlay.bg_height) params.set("bgHeight", cfg.overlay.bg_height);
    if (cfg.overlay.border_radius) params.set("radius", cfg.overlay.border_radius);
    const hash = params.toString();
    return `${proto}//${host}/overlay${hash ? '#' + hash : ''}`;
  }

  function showOverlayUrl() {
    const box = $("overlay-url-box");
    const input = $("overlay-url");
    if (!box || !input || !currentConfig) return;
    input.value = buildOverlayUrl(currentConfig);
    box.hidden = false;
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
    $("preview-line").textContent = text;
    el.classList.remove("empty");
  }

  function clearPreview() {
    $("preview-line").textContent = "";
    $("preview-caption").classList.add("empty");
    lastFinalText = "";
    recentSentences.length = 0;
  }

  // Wire up events.
  $("provider-type").addEventListener("change", updateProviderUI);
  $("ov-bg-opacity").addEventListener("input", (e) => {
    $("ov-opacity-display").textContent = e.target.value + "%";
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