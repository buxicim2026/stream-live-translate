// Browser Source overlay JS.
//   * 启动时先拉 /api/config，这样 admin 面板「字幕样式 / 背景设置」里的
//     宽、高、圆角、背景透明度改完保存就生效，不必重新生成浏览器源 URL。
//   * URL hash（#size=&color=&bg=&bgOpacity=&bgWidth=&bgHeight=&radius=…）
//     优先级最高，用于覆盖已保存的配置。
//   * 字幕恒为一行；背景默认刚好一行高，可用 bgWidth / bgHeight 固定。

(function () {
  "use strict";

  const captionEl = document.getElementById("caption");
  const lineEl = document.getElementById("caption-line");
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
      const regex = new RegExp(`^${word}[\\s,.，、.]*|[\\s,.，、.]*${word}$|^${word}$`, "gi");
      cleaned = cleaned.replace(regex, "");
    }
    cleaned = cleaned.replace(/(.)\1{3,}/g, "$1$1$1");
    cleaned = cleaned.replace(/\s+/g, " ");
    return cleaned.trim();
  }

  function isDuplicate(text) {
    const cleaned = cleanText(text);
    if (!cleaned || cleaned.length < 3) return true;
    for (const recent of recentSentences) {
      const aWords = new Set(cleaned.toLowerCase().split(/\s+/));
      const bWords = new Set(recent.toLowerCase().split(/\s+/));
      const intersection = [...aWords].filter((x) => bWords.has(x));
      if (aWords.size > 0 && intersection.length / aWords.size > 0.7) return true;
    }
    recentSentences.push(cleaned);
    if (recentSentences.length > MAX_RECENT) recentSentences.shift();
    return false;
  }

  // ---- style -------------------------------------------------------------

  function hexToRgba(hex, alpha) {
    if (!hex || hex[0] !== "#") return null;
    let h = hex.slice(1);
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /// 0–100 的透明度百分比 → 0.0–1.0 的 alpha。缺省 75。
  function toAlpha(v) {
    let n = Number(v);
    if (!isFinite(n)) n = 75;
    n = Math.min(100, Math.max(0, n));
    return Math.round(n) / 100;
  }

  // 所有样式先写进这里，最后统一 render，避免「配置」和「hash」互相打架。
  const style = {
    size: null,
    color: null,
    bgColor: "#000000",
    bgOpacity: 75,
    width: 0,
    height: 0,
    radius: 8,
    maxLines: 2,
  };

  function renderStyle() {
    const root = document.documentElement.style;

    if (style.size) root.setProperty("--caption-size", style.size + "px");
    if (style.color) root.setProperty("--caption-color", style.color);

    // 半透明背景：颜色 + 透明度合成为 rgba()，这一步是「半透明化」的关键。
    const alpha = toAlpha(style.bgOpacity);
    const bg = hexToRgba(style.bgColor, alpha) || `rgba(0,0,0,${alpha})`;
    root.setProperty("--caption-bg", bg);

    // 0 = 自动：宽度贴合文字，高度恒为一行。
    root.setProperty("--caption-width", Number(style.width) > 0 ? Number(style.width) + "px" : "auto");
    root.setProperty("--caption-height", Number(style.height) > 0 ? Number(style.height) + "px" : "auto");
    const r = Number(style.radius);
    root.setProperty("--caption-radius", (isFinite(r) && r >= 0 ? r : 8) + "px");

    // 行数上限直接写到元素上：var() 在 -webkit-line-clamp 里兼容性不可靠。
    let lines = Math.round(Number(style.maxLines));
    if (!isFinite(lines) || lines < 1) lines = 2;
    if (lines > 3) lines = 3;
    lineEl.style.setProperty("-webkit-line-clamp", String(lines));
    lineEl.style.setProperty("line-clamp", String(lines));
  }

  function setBodyVariant(prefix, value) {
    if (!value) return;
    document.body.className = document.body.className.replace(
      new RegExp(prefix + "-\\w+", "g"),
      ""
    );
    document.body.classList.add(prefix + "-" + value);
  }

  function applyOverlayConfig(ov) {
    if (!ov) return;
    if (ov.font_size) style.size = ov.font_size;
    if (ov.font_color) style.color = ov.font_color;
    if (ov.background_color) style.bgColor = ov.background_color;
    // 老配置只有 0–1 的 background_opacity，这里兼容一下。
    if (ov.bg_opacity !== undefined && ov.bg_opacity !== null) {
      style.bgOpacity = ov.bg_opacity;
    } else if (ov.background_opacity !== undefined && ov.background_opacity !== null) {
      style.bgOpacity = ov.background_opacity * 100;
    }
    if (ov.bg_width !== undefined) style.width = Number(ov.bg_width) || 0;
    if (ov.bg_height !== undefined) style.height = Number(ov.bg_height) || 0;
    if (ov.border_radius !== undefined) style.radius = Number(ov.border_radius) || 0;
    if (ov.max_lines !== undefined) style.maxLines = Number(ov.max_lines) || 2;
    renderStyle();
    setBodyVariant("position", ov.position);
    setBodyVariant("animation", ov.animation);
    setBodyVariant("layout", ov.layout);
  }

  function parseHash() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const get = (k) => {
      const v = params.get(k);
      return v === null || v === "" ? null : v;
    };

    if (get("size") !== null) style.size = Number(get("size")) || null;
    if (get("color") !== null) style.color = decodeURIComponent(get("color"));
    if (get("bg") !== null) style.bgColor = decodeURIComponent(get("bg"));
    if (get("bgOpacity") !== null) style.bgOpacity = Number(get("bgOpacity"));
    if (get("bgWidth") !== null) style.width = Number(get("bgWidth")) || 0;
    if (get("bgHeight") !== null) style.height = Number(get("bgHeight")) || 0;
    if (get("radius") !== null) style.radius = Number(get("radius")) || 0;
    if (get("maxLines") !== null) style.maxLines = Number(get("maxLines")) || 2;
    renderStyle();

    setBodyVariant("position", get("position"));
    setBodyVariant("animation", get("animation"));
    setBodyVariant("layout", get("layout"));
  }

  // ---- rendering ---------------------------------------------------------

  /// 折叠模型可能吐出的换行与多余空白。是否折行由 CSS 依据宽度决定，
  /// 所以这里只需保证没有「硬换行」把背景撑成三行。
  function toSingleLine(text) {
    return String(text == null ? "" : text)
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function show(text) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    const line = toSingleLine(text);
    currentText = line;
    // 只做病态输入兜底；真正的「超出多少字」由 CSS line-clamp 处理，
    // 这样才能在正确的位置显示省略号（JS 截断会提前把句子砍短）。
    lineEl.textContent = line.length > 400 ? line.slice(0, 400) + "…" : line;
    captionEl.classList.remove("empty");
    captionEl.classList.add("show");
  }

  function hide() {
    captionEl.classList.add("empty");
    captionEl.classList.remove("show");
    lineEl.textContent = "";
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hide();
      recentSentences.length = 0;
    }, 4000);
  }

  function appendPartial(delta) {
    partialBuffer += delta;
    lastPartialAt = Date.now();
    if (cleanText(delta)) {
      show(partialBuffer);
      scheduleHide();
    }
  }

  function finalize(text) {
    if (text) partialBuffer = text;
    const cleaned = cleanText(partialBuffer);
    partialBuffer = "";
    if (cleaned && !isDuplicate(cleaned)) {
      show(cleaned);
      scheduleHide();
    } else {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      hide();
    }
  }

  function clearAll() {
    partialBuffer = "";
    currentText = "";
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    hide();
    recentSentences.length = 0;
  }

  // ---- transport ---------------------------------------------------------

  /// admin 保存配置后由服务端 /api/config 广播推来，overlay 立即重刷样式。
  async function loadConfig() {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      const cfg = await r.json();
      if (cfg.overlay) applyOverlayConfig(cfg.overlay);
    } catch (e) {
      console.warn("overlay: failed to load config from API, using defaults", e);
    }
  }

  function connectWS() {
    const wsScheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${wsScheme}://${location.host}/ws/subtitles`);
    ws.addEventListener("open", () => {
      console.log("overlay ws connected");
      // 兜底：即使服务端是旧版（不会主动推 config），重连后也能拿到最新样式。
      loadConfig();
    });
    ws.addEventListener("message", (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      if (payload.type === "config") {
        if (payload.overlay) applyOverlayConfig(payload.overlay);
      } else if (payload.type === "current" && payload.line) {
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
    // 顺序很关键：先 hash（旧版留下的 URL 参数）再 /api/config，
    // 让服务端配置成为唯一权威来源 —— 这样 admin 改动即时生效，
    // 用户不必重新复制 OBS 浏览器源 URL。
    parseHash();
    await loadConfig();
    connectWS();
  }

  init();
})();
