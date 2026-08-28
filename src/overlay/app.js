// Browser Source overlay JS.
//   * Connects to /ws/subtitles to receive live partial + final events.
//   * Renders a single caption line with a typewriter / fade / slide
//     animation depending on the body class.
//   * Reads style from /api/config first, then URL hash overrides.

(function () {
  "use strict";

  const captionEl = document.getElementById("caption");
  const lineEl = document.getElementById("caption-line");
  let pendingText = "";
  let currentText = "";
  let hideTimer = null;
  let partialBuffer = "";
  let lastPartialAt = 0;
  let ws = null;

  const WATERMARK_WORDS = [
    "字幕", "subtitle", "翻译", "translate", "实时", "real-time", "live",
    "AI", "人工智能", "智能翻译", "同声传译", "直播", "stream"
  ];

  const recentSentences = [];
  const MAX_RECENT = 5;

  function cleanText(text) {
    if (!text) return "";
    let cleaned = text.trim();
    for (const word of WATERMARK_WORDS) {
      const regex = new RegExp(`^${word}[\\s,.，、.]*|[\\s,.，、.]*${word}$|^${word}$`, 'gi');
      cleaned = cleaned.replace(regex, '');
    }
    cleaned = cleaned.replace(/(.)\1{3,}/g, '$1$1$1');
    cleaned = cleaned.replace(/\s+/g, ' ');
    return cleaned.trim();
  }

  function isDuplicate(text) {
    const cleaned = cleanText(text);
    if (!cleaned || cleaned.length < 3) return true;
    for (const recent of recentSentences) {
      const aWords = new Set(cleaned.toLowerCase().split(/\s+/));
      const bWords = new Set(recent.toLowerCase().split(/\s+/));
      const intersection = [...aWords].filter(x => bWords.has(x));
      if (aWords.size > 0 && intersection.length / aWords.size > 0.7) return true;
    }
    recentSentences.push(cleaned);
    if (recentSentences.length > MAX_RECENT) recentSentences.shift();
    return false;
  }

  function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith("#")) return null;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function applyOverlayConfig(ov) {
    if (!ov) return;
    const root = document.documentElement.style;
    if (ov.font_size) root.setProperty("--caption-size", ov.font_size + "px");
    if (ov.font_color) root.setProperty("--caption-color", ov.font_color);
    const alpha = ov.bg_opacity !== undefined ? (ov.bg_opacity / 100) : 0.75;
    const bgColor = ov.background_color && ov.background_color.trim() ? ov.background_color : "#000000";
    const rgba = hexToRgba(bgColor, alpha);
    root.setProperty("--caption-bg", rgba || `rgba(0,0,0,${alpha})`);
    if (ov.bg_width && ov.bg_width > 0) root.setProperty("--caption-width", ov.bg_width + "px");
    if (ov.bg_height && ov.bg_height > 0) root.setProperty("--caption-height", ov.bg_height + "px");
    if (ov.border_radius) root.setProperty("--caption-radius", ov.border_radius + "px");
    if (ov.position) {
      document.body.className = document.body.className.replace(/position-\w+/g, "");
      document.body.classList.add("position-" + ov.position);
    }
    if (ov.animation) {
      document.body.className = document.body.className.replace(/animation-\w+/g, "");
      document.body.classList.add("animation-" + ov.animation);
    }
    if (ov.layout) {
      document.body.className = document.body.className.replace(/layout-\w+/g, "");
      document.body.classList.add("layout-" + ov.layout);
    }
  }

  function parseHash() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const root = document.documentElement.style;
    if (params.get("color")) root.setProperty("--caption-color", params.get("color"));
    if (params.get("size")) root.setProperty("--caption-size", params.get("size") + "px");
    const bg = params.get("bg");
    const bgOpacity = params.get("bgOpacity");
    if (bg) {
      const alpha = bgOpacity ? (parseInt(bgOpacity, 10) / 100) : 0.75;
      const rgba = hexToRgba(bg, alpha);
      root.setProperty("--caption-bg", rgba || `rgba(0,0,0,${alpha})`);
    } else if (bgOpacity) {
      root.setProperty("--caption-bg", `rgba(0,0,0,${parseInt(bgOpacity, 10) / 100})`);
    }
    if (params.get("bgWidth") && params.get("bgWidth") !== "0") root.setProperty("--caption-width", params.get("bgWidth") + "px");
    if (params.get("bgHeight") && params.get("bgHeight") !== "0") root.setProperty("--caption-height", params.get("bgHeight") + "px");
    if (params.get("radius")) root.setProperty("--caption-radius", params.get("radius") + "px");
    if (params.get("position")) {
      document.body.className = document.body.className.replace(/position-\w+/g, "");
      document.body.classList.add("position-" + params.get("position"));
    }
    if (params.get("animation")) {
      document.body.className = document.body.className.replace(/animation-\w+/g, "");
      document.body.classList.add("animation-" + params.get("animation"));
    }
    if (params.get("layout")) {
      document.body.className = document.body.className.replace(/layout-\w+/g, "");
      document.body.classList.add("layout-" + params.get("layout"));
    }
  }

  function show(text) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    const singleLine = text.length > 200 ? text.slice(0, 200) + "…" : text;
    lineEl.textContent = singleLine;
    currentText = singleLine;
    captionEl.classList.remove("empty");
    captionEl.classList.add("show");
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      captionEl.classList.add("empty");
      captionEl.classList.remove("show");
      lineEl.textContent = "";
      recentSentences.length = 0;
    }, 4000);
  }

  function appendPartial(delta) {
    partialBuffer += delta;
    lastPartialAt = Date.now();
    const cleaned = cleanText(delta);
    if (cleaned) {
      show(partialBuffer);
      scheduleHide();
    }
  }

  function finalize(text) {
    if (text) partialBuffer = text;
    const cleaned = cleanText(partialBuffer);
    if (cleaned && !isDuplicate(cleaned)) {
      show(cleaned);
      partialBuffer = "";
      scheduleHide();
    } else {
      if (hideTimer) clearTimeout(hideTimer);
      captionEl.classList.add("empty");
      captionEl.classList.remove("show");
      lineEl.textContent = "";
      partialBuffer = "";
    }
  }

  function clearAll() {
    partialBuffer = "";
    currentText = "";
    lineEl.textContent = "";
    captionEl.classList.add("empty");
    captionEl.classList.remove("show");
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    recentSentences.length = 0;
  }

  function connectWS() {
    const wsScheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${wsScheme}://${location.host}/ws/subtitles`);
    ws.addEventListener("open", () => { console.log("overlay ws connected"); });
    ws.addEventListener("message", (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      if (payload.type === "current" && payload.line) {
        const cleaned = cleanText(payload.line.text || "");
        if (cleaned && !isDuplicate(cleaned)) {
          show(cleaned);
          scheduleHide();
        }
      } else if (payload.type === "partial") {
        appendPartial(payload.text || "");
      } else if (payload.type === "final") {
        finalize(payload.text || "");
      } else if (payload.type === "cleared") {
        clearAll();
      }
    });
    ws.addEventListener("close", () => {
      setTimeout(connectWS, 2000);
    });
  }

  async function init() {
    try {
      const r = await fetch("/api/config");
      const cfg = await r.json();
      if (cfg.overlay) applyOverlayConfig(cfg.overlay);
    } catch (e) {
      console.warn("overlay: failed to load config from API, using defaults", e);
    }
    parseHash();
    connectWS();
  }

  init();
})();