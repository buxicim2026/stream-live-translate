// Admin panel logic (rewritten).
// 设计目标：
//   * 任何 JS 错误立刻可见（不再被静默吞掉）
//   * 文件导入（拖放 / 选择）支持 SRT / VTT / TXT / JSON
//   * WebSocket 状态、连接、断线、重连都有明确提示
//   * 按钮有明显反馈（点击 → 进度 → 成功 / 失败）
//   * 启动只依赖 /api/*（不再需要浏览器端 i18n，避免 key 缺失）

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ---- 错误覆盖层：所有未捕获错误都会出现在这里 ------------------------
  function showError(msg) {
    console.error("[admin]", msg);
    const overlay = $("err-overlay");
    const pre = $("err-msg");
    if (!overlay || !pre) return;
    pre.textContent = (pre.textContent ? pre.textContent + "\n\n" : "") + msg;
    overlay.hidden = false;
  }
  window.addEventListener("error", (e) => {
    showError((e.error && e.error.stack) || e.message || String(e));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    showError("未处理的 Promise 拒绝: " + ((r && r.stack) || r || "unknown"));
  });
  $("err-dismiss").addEventListener("click", () => { $("err-overlay").hidden = true; });

  // ---- Toast ------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, kind) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast show " + (kind || "info");
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---- Provider hints（直接内置；不再走 i18n 避免 key 缺失） -----------
  const PROVIDER_HINTS = {
    "qwen": {
      boxHtml: `<strong>💡 通义 Qwen API</strong><br />只能用 qwen3 系列<strong>语音（多模态）Realtime</strong>实时模型。同传翻译：<code>qwen3.5-livetranslate-flash-realtime</code>；实时识别：<code>qwen3-asr-flash-realtime</code> 或 <code>qwen-audio-3.0-realtime-flash</code>。`,
      modelPlaceholder: "qwen3.5-livetranslate-flash-realtime",
      modelSuggestions: [
        { value: "qwen3.5-livetranslate-flash-realtime", label: "同传翻译（推荐，多语言→目标语言）" },
        { value: "qwen3-asr-flash-realtime", label: "实时语音识别（ASR，边说边出字幕）" },
        { value: "qwen-audio-3.0-realtime-flash", label: "Qwen-Audio 3.0 实时（语音对话）" },
        { value: "qwen-audio-realtime-plus", label: "Qwen-Audio Realtime Plus（语音对话）" }
      ],
      endpointPlaceholder: "留空使用内置默认（wss://dashscope.aliyuncs.com/api-ws/v1/realtime）",
      endpointDefault: "",
      className: "qwen-hint"
    },
    "glm": {
      boxHtml: `<strong>💡 智谱 GLM-Realtime</strong><br />OpenAI 兼容实时协议，端点默认 <code>wss://open.bigmodel.cn/api/paas/v4/realtime</code>。做直播字幕请勾选下方「实时字幕模式」。`,
      modelPlaceholder: "glm-realtime",
      modelSuggestions: [
        { value: "glm-realtime", label: "GLM-Realtime（默认）" },
        { value: "glm-realtime-flash", label: "GLM-Realtime-Flash（9B，更便宜）" },
        { value: "glm-realtime-air", label: "GLM-Realtime-Air（32B）" }
      ],
      endpointPlaceholder: "wss://open.bigmodel.cn/api/paas/v4/realtime",
      endpointDefault: "wss://open.bigmodel.cn/api/paas/v4/realtime",
      className: "online-hint"
    },
    "online": {
      boxHtml: `<strong>🌐 OpenAI / 其它在线 API</strong><br />支持 OpenAI 兼容 Realtime 接口的在线服务。直播字幕同样请勾选下方「实时字幕模式」。`,
      modelPlaceholder: "gpt-realtime",
      modelSuggestions: [
        { value: "gpt-realtime", label: "OpenAI GPT-Realtime" },
        { value: "gpt-4o-realtime-preview", label: "OpenAI GPT-4o Realtime" },
        { value: "gpt-4o-mini-realtime-preview", label: "OpenAI GPT-4o-mini Realtime" }
      ],
      endpointPlaceholder: "例如：wss://api.openai.com/v1/realtime",
      endpointDefault: "wss://api.openai.com/v1/realtime",
      className: "online-hint"
    },
    "local": {
      boxHtml: `<strong>💻 本机部署 API</strong><br />连接本地运行的模型服务（如 Ollama、huggingface/speech-to-speech）。需确保服务已启动并开启 Realtime API。`,
      modelPlaceholder: "模型名称（根据你的本地部署）",
      modelSuggestions: [
        { value: "llama3.2-realtime", label: "Llama 3.2 Realtime（Ollama）" },
        { value: "qwen2.5-realtime", label: "Qwen 2.5 Realtime（Ollama）" }
      ],
      endpointPlaceholder: "例如：ws://localhost:11434/v1/realtime",
      endpointDefault: "ws://localhost:11434/v1/realtime",
      className: "local-hint"
    },
    "funasr": {
      boxHtml: `<strong>🎙️ FunASR 本地流式识别</strong><br />对接本地 FunASR 实时识别服务（SenseVoice / Fun-ASR-Nano / Paraformer 等，Docker 一键部署）。默认 <code>ws://127.0.0.1:10095</code>。自带 VAD/断句，只返回人说话内容。`,
      modelPlaceholder: "SenseVoiceSmall（服务端已加载，可留空）",
      modelSuggestions: [
        { value: "SenseVoiceSmall", label: "SenseVoiceSmall（多语言，推荐）" },
        { value: "fun-asr-nano", label: "Fun-ASR-Nano（LLM-ASR）" },
        { value: "paraformer-zh", label: "Paraformer-zh（普通话）" }
      ],
      endpointPlaceholder: "ws://127.0.0.1:10095（FunASR Docker 默认）",
      endpointDefault: "ws://127.0.0.1:10095",
      className: "online-hint"
    },
    "mock": {
      boxHtml: `<strong>🧪 模拟模式</strong><br />本地模拟输出，不联网、不消耗额度，仅用于界面测试。`,
      modelPlaceholder: "mock",
      modelSuggestions: [],
      endpointPlaceholder: "无需填写",
      endpointDefault: "",
      className: "qwen-hint"
    }
  };
  const PROVIDER_TYPE_MAP = {
    "qwen": "qwen-realtime",
    "glm": "openai-realtime",
    "online": "openai-realtime",
    "local": "openai-realtime",
    "funasr": "fun-asr-realtime",
    "mock": "mock"
  };

  // ---- 状态 -------------------------------------------------------------
  let currentConfig = null;
  let pendingPartial = "";
  let lastFinalText = "";
  let previewText = "";
  let previewPageStart = 0;
  let previewLines = 2;
  let ws = null;
  let wsReconnectDelay = 1500;
  let localImportedRows = []; // 用户从文件导入的历史
  let lastServerHistory = []; // 服务端的历史

  // ---- OBS dock detection -----------------------------------------------
  if (new URLSearchParams(location.search).get("obsDock") === "1") {
    document.body.classList.add("dock");
  }

  // ---- 杂项辅助 --------------------------------------------------------
  function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== "#") return null;
    let h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},` +
           `${parseInt(h.slice(4, 6), 16)},${alpha})`;
  }
  const PREVIEW_SCALE = 0.45;

  function num(id, dflt) {
    const el = $(id);
    if (!el) return dflt;
    const n = parseInt(el.value, 10);
    return isFinite(n) ? n : dflt;
  }

  // ---- Form 填充 / 收集 -------------------------------------------------
  function detectProviderType(cfg) {
    if (cfg.llm.provider === "qwen-realtime") return "qwen";
    if (cfg.llm.provider === "mock") return "mock";
    if (cfg.llm.provider === "fun-asr-realtime") return "funasr";
    if (cfg.llm.provider === "openai-realtime") {
      const ep = cfg.llm.endpoint || "";
      if (ep.includes("bigmodel.cn")) return "glm";
      if (ep.includes("localhost") || ep.includes("127.0.0.1")) return "local";
      return "online";
    }
    return "online";
  }

  function fillForm(cfg) {
    const providerType = detectProviderType(cfg);
    $("provider-type").value = providerType;
    $("model").value = cfg.llm.model || "";
    $("api_key").value = cfg.llm.api_key || "";
    $("endpoint").value = cfg.llm.endpoint || "";
    $("target_lang").value = cfg.llm.target_lang || "zh";
    $("translate_chinese").checked = !!cfg.llm.translate_chinese;
    $("transcribe").checked = !!cfg.llm.transcribe;
    $("transcription_model").value = cfg.llm.transcription_model || "";
    $("gateway_text").checked = !!cfg.llm.gateway_text;
    $("low_latency").checked = !!cfg.llm.segment_ms;
    $("segment_ms").value = String(cfg.llm.segment_ms || 1200);

    // Audio
    const modeSel = $("audio-mode");
    if (![...modeSel.options].some((o) => o.value === cfg.audio.mode)) {
      const opt = document.createElement("option");
      opt.value = cfg.audio.mode;
      opt.textContent = cfg.audio.mode;
      modeSel.appendChild(opt);
    }
    modeSel.value = cfg.audio.mode;
    $("use_sck").checked = !!cfg.audio.use_screen_capture_kit;

    // OBS
    $("obs-auto").checked = !!cfg.obs.auto_connect;
    $("obs-host").value = cfg.obs.host || "127.0.0.1";
    $("obs-port").value = cfg.obs.port || 4455;
    $("obs-password").value = cfg.obs.password || "";

    // Overlay
    $("ov-size").value = cfg.overlay.font_size || 48;
    $("ov-max-lines").value = cfg.overlay.max_lines || 2;
    $("ov-bg-width").value = cfg.overlay.bg_width || 0;
    $("ov-bg-height").value = cfg.overlay.bg_height || 0;
    $("ov-border-radius").value = cfg.overlay.border_radius || 8;
    const op = cfg.overlay.bg_opacity !== undefined ? cfg.overlay.bg_opacity : 75;
    $("ov-bg-opacity").value = op;
    $("ov-opacity-display").textContent = op + "%";
    $("ov-color").value = cfg.overlay.font_color || "#ffffff";
    $("ov-bg").value = cfg.overlay.background_color || "#000000";
    $("ov-position").value = cfg.overlay.position || "bottom";
    $("ov-animation").value = cfg.overlay.animation || "typewriter";

    $("obs-dock-url").textContent = `${location.protocol}//${location.host}/admin?obsDock=1`;

    updateProviderUI();
    applyPreviewStyles();
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
        segment_ms: $("low_latency").checked ? (Number($("segment_ms").value) || 1200) : 0,
        transcribe: $("transcribe").checked,
        transcription_model: $("transcription_model").value.trim(),
        gateway_text: $("gateway_text").checked,
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
        max_lines: Math.min(4, Math.max(1, parseInt($("ov-max-lines").value, 10) || 2)),
        bg_width: Math.max(0, parseInt($("ov-bg-width").value, 10) || 0),
        bg_height: Math.max(0, parseInt($("ov-bg-height").value, 10) || 0),
        border_radius: Math.max(0, parseInt($("ov-border-radius").value, 10) || 0),
        bg_opacity: parseInt($("ov-bg-opacity").value, 10) || 75,
        font_color: $("ov-color").value,
        background_color: $("ov-bg").value,
        position: $("ov-position").value,
        animation: $("ov-animation").value,
      },
    };
  }

  function updateProviderUI() {
    const providerType = $("provider-type").value;
    const hint = PROVIDER_HINTS[providerType] || PROVIDER_HINTS.mock;
    const hintBox = $("provider-hint-box");
    hintBox.className = "provider-hint-box " + (hint.className || "");
    hintBox.innerHTML = hint.boxHtml;

    $("model").placeholder = hint.modelPlaceholder;
    const dl = $("model-presets");
    dl.innerHTML = "";
    (hint.modelSuggestions || []).forEach((s) => {
      const o = document.createElement("option");
      o.value = s.value;
      o.textContent = s.label;
      dl.appendChild(o);
    });

    $("endpoint").placeholder = hint.endpointPlaceholder;
    if (providerType !== "mock" && !$("endpoint").value) {
      $("endpoint").value = hint.endpointDefault || "";
    }

    const isFunasr = providerType === "funasr";
    const openaiLike = !isFunasr && ["glm", "online", "local"].includes(providerType);
    $("transcribe_row").style.display = openaiLike ? "" : "none";
    $("transcription_model_row").style.display =
      openaiLike && $("transcribe").checked ? "" : "none";
    $("gateway_row").style.display = providerType === "local" ? "" : "none";
    $("low_latency_ms_row").style.display = $("low_latency").checked ? "" : "none";
  }

  // ---- 预览样式 --------------------------------------------------------
  function applyPreviewStyles() {
    const el = $("preview-caption");
    const stage = $("preview-stage");
    if (!el || !stage) return;
    const size = Math.max(8, num("ov-size", 48));
    const w = Math.max(0, num("ov-bg-width", 0));
    const h = Math.max(0, num("ov-bg-height", 0));
    const radius = Math.max(0, num("ov-border-radius", 8));
    const op = Math.min(100, Math.max(0, num("ov-bg-opacity", 75)));
    const k = PREVIEW_SCALE;
    el.style.fontSize = Math.round(size * k) + "px";
    el.style.lineHeight = "1.25";
    el.style.padding = `${Math.round(10 * k)}px ${Math.round(24 * k)}px`;
    el.style.color = $("ov-color").value;
    el.style.background =
      hexToRgba($("ov-bg").value, op / 100) || `rgba(0,0,0,${op / 100})`;
    el.style.width = w > 0 ? Math.round(w * k) + "px" : "auto";
    el.style.height = h > 0 ? Math.round(h * k) + "px" : "auto";
    el.style.borderRadius = Math.round(radius * k) + "px";
    const lineEl = $("preview-line");
    if (lineEl) {
      const lines = Math.min(4, Math.max(1, num("ov-max-lines", 2)));
      lineEl.classList.toggle("single-line", lines <= 1);
      previewLines = lines;
      renderPreview();
    }
    stage.className = "preview-stage position-" + ($("ov-position").value || "bottom");
  }

  function previewMeasure(s) {
    const lineEl = $("preview-line");
    if (!lineEl) return 0;
    lineEl.textContent = s;
    return lineEl.scrollHeight;
  }
  function previewFindCut(text, start, maxH) {
    let lo = start + 1, hi = text.length, best = start + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (previewMeasure(text.slice(start, mid)) <= maxH) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }
  function renderPreview() {
    const lineEl = $("preview-line");
    if (!lineEl) return;
    if (previewLines <= 1) { lineEl.textContent = previewText; return; }
    const caption = $("preview-caption");
    const lh = parseFloat(getComputedStyle(caption).lineHeight) || 0;
    const maxH = previewLines * lh;
    if (maxH <= 0) { lineEl.textContent = previewText; return; }
    if (previewPageStart > previewText.length) previewPageStart = 0;
    if (previewMeasure(previewText.slice(previewPageStart)) > maxH) {
      previewPageStart = previewFindCut(previewText, previewPageStart, maxH);
    }
    const shown = previewText.slice(previewPageStart);
    if (lineEl.textContent !== shown) lineEl.textContent = shown;
  }
  function setPreviewText(text, append) {
    if (!append) previewPageStart = 0;
    previewText = text || "";
    renderPreview();
  }

  // ---- 历史显示 --------------------------------------------------------
  function renderHistory() {
    const cont = $("history");
    cont.innerHTML = "";
    const items = (lastServerHistory || []).slice(-30).reverse();
    const all = [...items, ...localImportedRows.slice(-30)];
    if (all.length === 0) {
      cont.innerHTML = '<div class="empty-tip">暂无字幕历史。说一句话、或导入一个 SRT/VTT 试试。</div>';
      return;
    }
    for (const line of all) {
      const row = document.createElement("div");
      row.className = "row" + (line.imported ? " imported" : "");
      const lang = document.createElement("span");
      lang.className = "lang";
      lang.textContent = line.language || (line.imported ? "导入" : "auto");
      const text = document.createElement("span");
      text.className = "text";
      text.textContent = line.text;
      row.appendChild(lang);
      row.appendChild(text);
      cont.appendChild(row);
    }
  }

  // ---- 文件导入 --------------------------------------------------------
  function parseSrtTime(s) {
    // "00:00:01,500" -> 1500
    const m = s.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4]);
  }
  function parseVttTime(s) {
    return parseSrtTime(s.replace(".", ","));
  }
  function parseSubtitleFile(name, raw) {
    const lower = (name || "").toLowerCase();
    const text = raw.replace(/\r\n/g, "\n");
    if (lower.endsWith(".srt")) {
      const blocks = text.split(/\n\s*\n/);
      const out = [];
      for (const blk of blocks) {
        const lines = blk.split("\n").map((s) => s.trim()).filter(Boolean);
        if (lines.length < 2) continue;
        const ti = lines.findIndex((l) => l.includes("-->"));
        if (ti < 0) continue;
        const startMs = parseSrtTime(lines[ti]);
        const body = lines.slice(ti + 1).join(" ");
        if (!body) continue;
        out.push({
          id: "srt-" + out.length,
          text: body,
          language: "导入",
          started_at_ms: startMs,
          updated_at_ms: startMs,
          finalised: true,
          imported: true,
        });
      }
      return out;
    }
    if (lower.endsWith(".vtt")) {
      const blocks = text.split(/\n\s*\n/).slice(1);
      const out = [];
      for (const blk of blocks) {
        const lines = blk.split("\n").map((s) => s.trim()).filter(Boolean);
        if (lines.length === 0) continue;
        const timeLine = lines.find((l) => l.includes("-->")) || "";
        if (!timeLine) continue;
        const startMs = parseVttTime(timeLine.split("-->")[0].trim());
        const idx = lines.indexOf(timeLine);
        const body = lines.slice(idx + 1).join(" ");
        if (!body) continue;
        out.push({
          id: "vtt-" + out.length,
          text: body,
          language: "导入",
          started_at_ms: startMs,
          updated_at_ms: startMs,
          finalised: true,
          imported: true,
        });
      }
      return out;
    }
    if (lower.endsWith(".json")) {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : (j.history || []);
        return arr.map((it, i) => ({
          id: "json-" + i,
          text: String(it.text || it.content || ""),
          language: it.language || "导入",
          started_at_ms: it.started_at_ms || 0,
          updated_at_ms: it.updated_at_ms || 0,
          finalised: true,
          imported: true,
        })).filter((x) => x.text);
      } catch (e) {
        throw new Error("JSON 解析失败：" + e.message);
      }
    }
    // .txt / 其它：按行当字幕
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.map((line, i) => ({
      id: "txt-" + i,
      text: line,
      language: "导入",
      started_at_ms: 0,
      updated_at_ms: 0,
      finalised: true,
      imported: true,
    }));
  }

  function setupFileImport() {
    const input = $("import-file");
    if (!input) return;
    const handle = async (file) => {
      if (!file) return;
      try {
        const raw = await file.text();
        const rows = parseSubtitleFile(file.name, raw);
        if (rows.length === 0) {
          toast("没在文件里找到任何字幕行", "error");
          return;
        }
        localImportedRows = rows;
        renderHistory();
        toast(`✅ 已导入 ${rows.length} 条字幕（${file.name}）`, "ok");
        if (rows[0]) {
          setPreviewText(rows[0].text, false);
          $("preview-caption").classList.remove("empty");
        }
      } catch (e) {
        showError("导入失败：" + (e.message || e));
        toast("导入失败：" + (e.message || e), "error");
      }
    };
    input.addEventListener("change", () => {
      handle(input.files && input.files[0]);
      input.value = "";
    });

    // 拖放支持
    const card = input.closest(".card");
    if (card) {
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      ["dragenter", "dragover"].forEach((ev) =>
        card.addEventListener(ev, (e) => { stop(e); card.classList.add("drag-over"); }));
      ["dragleave", "drop"].forEach((ev) =>
        card.addEventListener(ev, (e) => { stop(e); card.classList.remove("drag-over"); }));
      card.addEventListener("drop", (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) handle(f);
      });
    }
  }

  // ---- API 调用 --------------------------------------------------------
  async function apiGet(path) {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) throw new Error("GET " + path + " → HTTP " + r.status);
    return r.json();
  }
  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = "HTTP " + r.status;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    return r.json().catch(() => ({}));
  }

  async function loadConfig() {
    const cfg = await apiGet("/api/config");
    currentConfig = cfg;
    fillForm(cfg);
    $("overlay-url-box").hidden = false;
    $("overlay-url").value = `${location.protocol}//${location.host}/overlay`;
  }

  async function loadDevices() {
    try {
      const list = await apiGet("/api/devices");
      const sel = $("audio-device");
      sel.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "（默认）";
      sel.appendChild(empty);
      for (const d of list) {
        const opt = document.createElement("option");
        opt.value = d.name;
        const tag = [
          d.supports_input && "输入",
          d.supports_output && "输出"
        ].filter(Boolean).join(" / ");
        opt.textContent = `${d.name} ${tag ? `[${tag}]` : ""}`;
        sel.appendChild(opt);
      }
      if (currentConfig && currentConfig.audio.device) {
        sel.value = currentConfig.audio.device;
      }
    } catch (e) {
      console.warn("load devices failed", e);
    }
  }

  async function loadStatus() {
    try {
      const s = await apiGet("/api/status");
      const set = (id, ok, warn) => {
        const el = $(id);
        el.classList.remove("ok", "bad", "warn");
        el.classList.add(ok ? "ok" : warn ? "warn" : "bad");
      };
      set("dot-audio", !!s.audio_active, false);
      set("dot-llm", !!s.llm_connected, s.running && !s.last_error ? true : false);
      set("dot-obs", !!s.obs_connected, false);
      const run = $("run-state");
      if (s.running) { run.textContent = "● 管线运行中"; run.className = "run-state ok"; }
      else            { run.textContent = "● 管线未运行"; run.className = "run-state bad"; }

      const errEl = $("engine-error");
      errEl.classList.remove("good");
      if (s.last_error) {
        errEl.textContent = "❗ " + s.last_error;
        errEl.hidden = false;
      } else if (!s.obs_connected && s.obs_error) {
        errEl.textContent = "⚠️ OBS 未连接：" + s.obs_error + "（请确认 OBS 已启动，且 工具 → WebSocket 服务器设置 已开启）";
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
      const lock = $("audio-mode-lock");
      if (s.audio_mode_forced) {
        $("audio-mode").disabled = true;
        lock.hidden = false;
      } else {
        $("audio-mode").disabled = false;
        lock.hidden = true;
      }
    } catch (e) {
      console.warn("load status failed", e);
    }
  }

  async function loadHistory() {
    try {
      const j = await apiGet("/api/subtitles");
      lastServerHistory = j.history || [];
      renderHistory();
    } catch (e) {
      console.warn("load history failed", e);
    }
  }

  // ---- WebSocket --------------------------------------------------------
  function setWsState(state, label) {
    const el = $("ws-state");
    if (!el) return;
    el.className = "ws-state " + state;
    el.textContent = label;
  }
  function connectWS() {
    const wsScheme = location.protocol === "https:" ? "wss" : "ws";
    const url = `${wsScheme}://${location.host}/ws/subtitles`;
    setWsState("connecting", "WS 连接中…");
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setWsState("disconnected", "WS 失败");
      showError("WebSocket 创建失败: " + e);
      setTimeout(connectWS, wsReconnectDelay);
      return;
    }
    ws.addEventListener("open", () => {
      console.log("[admin] WS open", url);
      setWsState("connected", "WS 已连接");
    });
    ws.addEventListener("message", (ev) => {
      let p;
      try { p = JSON.parse(ev.data); } catch { return; }
      console.debug("[admin] WS msg", p);
      if (p.type === "current" && p.line) {
        const text = (p.line.text || "").trim();
        if (text && text !== lastFinalText) {
          pendingPartial = text;
          setPreviewText(pendingPartial, false);
          $("preview-caption").classList.remove("empty");
        }
      } else if (p.type === "partial") {
        const text = (p.text || "").trim();
        if (text) {
          pendingPartial = (pendingPartial || "") + text;
          setPreviewText(pendingPartial, true);
          $("preview-caption").classList.remove("empty");
        }
      } else if (p.type === "final") {
        const text = (p.text || "").trim();
        if (text) {
          pendingPartial = text;
          lastFinalText = text;
          setPreviewText(pendingPartial, false);
          $("preview-caption").classList.remove("empty");
          loadHistory();
        }
      } else if (p.type === "cleared") {
        pendingPartial = "";
        setPreviewText("", false);
        $("preview-caption").classList.add("empty");
      } else if (p.type === "config") {
        applyPreviewStyles();
      }
    });
    ws.addEventListener("close", () => {
      console.warn("[admin] WS close, retry in", wsReconnectDelay, "ms");
      setWsState("disconnected", "WS 已断开");
      setTimeout(connectWS, wsReconnectDelay);
    });
    ws.addEventListener("error", (e) => {
      console.warn("[admin] WS error", e);
      setWsState("disconnected", "WS 出错");
    });
  }

  // ---- 事件绑定 --------------------------------------------------------
  function bindEvents() {
    $("provider-type").addEventListener("change", updateProviderUI);
    $("low_latency").addEventListener("change", updateProviderUI);
    $("transcribe").addEventListener("change", updateProviderUI);

    $("model-guide-btn").addEventListener("click", () => {
      const modal = $("guide-modal");
      const body = $("guide-body");
      body.innerHTML = `
        <p>本插件只能使用能<strong>实时接收语音、并边听边返回字幕文字</strong>的<strong>语音（多模态）Realtime</strong>模型。</p>
        <p><strong>云端可用：</strong>通义 Qwen Realtime 语音（同传 / ASR / Qwen-Audio）、智谱 GLM-Realtime、OpenAI Realtime。</p>
        <p><strong>本地 / 自部署可用：</strong></p>
        <ul>
          <li><strong>FunASR 流式识别</strong>（SenseVoice / Fun-ASR-Nano / paraformer-zh）：内置通道，默认 <code>ws://127.0.0.1:10095</code>；按 FunASR 官方 runtime 文档起 Docker 即可。</li>
          <li><strong>huggingface/speech-to-speech</strong>（OpenAI Realtime 兼容网关）：<code>speech-to-speech serve --host 0.0.0.0 --stt parakeet-tdt --enable_live_transcription</code>，端点 <code>ws://&lt;主机IP&gt;:8765/v1/realtime</code>。</li>
          <li>其它 ASR（faster-whisper / whisper.cpp / Parakeet-TDT / SenseVoice）需套一个 Realtime 网关（同上）。</li>
        </ul>
        <p><strong>不可用：</strong>纯文本 / 纯视觉模型、纯语音合成（TTS）、HTTP 上传式 ASR（非实时）。</p>
        <p><strong>低延迟建议：</strong>中文直播只要中文字幕时，优先用 <strong>ASR 模型</strong>（云端 qwen3-asr-flash-realtime 或本地 FunASR）。</p>
      `;
      modal.hidden = false;
    });
    $("guide-close").addEventListener("click", () => { $("guide-modal").hidden = true; });
    $("guide-modal").addEventListener("click", (e) => {
      if (e.target === $("guide-modal")) $("guide-modal").hidden = true;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("guide-modal").hidden) $("guide-modal").hidden = true;
    });

    $("support-btn").addEventListener("click", () => {
      toast("该入口暂未开放，敬请期待。", "info");
    });

    $("ov-bg-opacity").addEventListener("input", (e) => {
      $("ov-opacity-display").textContent = e.target.value + "%";
    });
    ["ov-size", "ov-bg-width", "ov-bg-height", "ov-border-radius",
     "ov-bg-opacity", "ov-color", "ov-bg", "ov-position", "ov-max-lines"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("input", applyPreviewStyles);
    });

    $("save-btn").addEventListener("click", async () => {
      const patch = collectPatch();
      const key = (patch.llm.api_key || "").trim();
      const btn = $("save-btn");
      const status = $("save-status");

      if (patch.llm.provider !== "mock" && !key) {
        toast("请先填写 API Key", "error");
        status.textContent = "✗ 缺少 API Key";
        status.className = "status err";
        return;
      }
      if (/^https?:/i.test(key) || key.includes("://")) {
        toast("API Key 填成了网址！Key 是以 sk- 开头的密钥", "error");
        return;
      }
      const providerType = $("provider-type").value;
      if (providerType === "qwen" && patch.llm.endpoint && /compatible-mode|http:|https:/i.test(patch.llm.endpoint)) {
        toast("Base URL 不正确：DashScope Realtime 需要 WebSocket 地址（wss://...）", "error");
        return;
      }
      if (providerType === "online" && patch.llm.endpoint && !/^wss?:/i.test(patch.llm.endpoint)) {
        toast("Base URL 必须是 WebSocket 地址（wss:// 开头）", "error");
        return;
      }
      if (providerType === "local") {
        const ep = (patch.llm.endpoint || "").trim();
        if (!ep) { toast("请填写本机部署 API 的地址", "error"); return; }
        if (!/^ws?:/i.test(ep)) { toast("本机 API 地址必须是 ws:// 开头", "error"); return; }
      }

      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = "保存中…";
      status.textContent = "";
      status.className = "status";
      try {
        await apiPost("/api/config", patch);
        await loadConfig();
        const saved = currentConfig
          && currentConfig.llm.api_key === patch.llm.api_key
          && currentConfig.llm.model === patch.llm.model;
        if (saved) {
          status.textContent = "✓ 已保存";
          status.className = "status ok";
          toast("✅ 配置已保存并生效（管线已重启）", "ok");
        } else {
          status.textContent = "⚠ 已保存但校验失败";
          status.className = "status err";
          toast("⚠️ 已保存，但读回内容不一致", "error");
        }
        await apiPost("/api/restart");
        setTimeout(loadStatus, 800);
      } catch (e) {
        status.textContent = "✗ " + (e.message || e);
        status.className = "status err";
        toast("保存失败：" + (e.message || e), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });

    $("restart-btn").addEventListener("click", async () => {
      const btn = $("restart-btn");
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = "重启中…";
      try {
        await apiPost("/api/restart");
        toast("已重启管线", "ok");
        setTimeout(loadStatus, 500);
      } catch (e) {
        toast("重启失败：" + (e.message || e), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });

    $("clear-btn").addEventListener("click", async () => {
      try {
        await apiPost("/api/subtitles/clear");
        pendingPartial = "";
        setPreviewText("", false);
        $("preview-caption").classList.add("empty");
        toast("字幕已清空", "ok");
      } catch (e) {
        toast("清空失败：" + (e.message || e), "error");
      }
    });

    $("clear-history-btn").addEventListener("click", () => {
      localImportedRows = [];
      renderHistory();
      toast("已清空本地历史", "ok");
    });
  }

  // ---- 启动 ------------------------------------------------------------
  async function boot() {
    try {
      bindEvents();
      setupFileImport();
      await loadConfig();
      await loadDevices();
      loadStatus();
      loadHistory();
      connectWS();
    } catch (e) {
      showError("启动失败: " + ((e && e.stack) || e));
    }
  }

  // 立即启动，不要等 DOMContentLoaded（script 在 body 末尾，DOM 已就绪）
  boot();
})();
