// Browser Source overlay JS.
//   * 启动时先拉 /api/config，这样 admin 面板「字幕样式 / 背景设置」里的
//     宽、高、圆角、背景透明度改完保存就生效，不必重新生成浏览器源 URL。
//   * URL hash（#size=&color=&bg=&bgOpacity=&bgWidth=&bgHeight=&radius=…）
//     优先级最高，用于覆盖已保存的配置。
//   * 字幕背景贴合内容；超过「最大行数」的文字不再被省略号吞掉，
//     而是滚动显示出来（英文新闻、访谈等长句场景）。
//   * 宽 / 高 / 圆角可用 bgWidth / bgHeight / radius 固定。

(function () {
  "use strict";

  const captionEl = document.getElementById("caption");
  const lineEl = document.getElementById("caption-line");
  // 文字放在内层 span 里，靠 transform 上移实现滚动；
  // 外层 .caption-line 作为固定高度的视口裁掉溢出部分。
  let textEl = null;
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

  /// 把已有内容包进 .caption-inner。动态创建而非改 index.html，
  /// 这样即使 OBS 缓存了旧版页面也能正常工作。
  function ensureInner() {
    if (textEl) return textEl;
    const inner = document.createElement("span");
    inner.className = "caption-inner";
    while (lineEl.firstChild) inner.appendChild(lineEl.firstChild);
    lineEl.appendChild(inner);
    textEl = inner;
    return inner;
  }

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
  let maxLines = 2;

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

    // 行数上限（1-4）。视口高度 = 行数 × 行高，超出的文字滚动显示。
    let lines = Math.round(Number(style.maxLines));
    if (!isFinite(lines) || lines < 1) lines = 2;
    if (lines > 4) lines = 4;
    maxLines = lines;
    lineEl.classList.toggle("single-line", lines <= 1);

    // 视口最大高度按当前字号/行高算出，字号变化时自动跟随。
    const fs = parseFloat(getComputedStyle(captionEl).fontSize);
    const lhRaw = parseFloat(getComputedStyle(captionEl).lineHeight);
    const lh = isFinite(lhRaw) && lhRaw > 0 ? lhRaw : (isFinite(fs) ? fs : 48) * 1.25;
    root.setProperty("--caption-max-height", (lines * lh).toFixed(2) + "px");

    // 行数 / 字号变了，滚动距离要重新量。
    restartScroll();
  }

  // ---- 溢出滚动 ---------------------------------------------------------
  // 英文新闻、访谈这类长句连「最大行数」都放不下时，旧版会用省略号把后半段
  // 直接吞掉。这里改成字幕滚动：先在开头停一下，再匀速把后半段「吐」出来，
  // 滚到底停一下后回到开头循环，保证整句都能看到。

  const SCROLL_ARM_DELAY = 400;    // 流式输出期间等文字稳定，防止动画被打断成抖动
  const SCROLL_HOLD_TOP = 1000;    // 停在开头的时间
  const SCROLL_HOLD_BOTTOM = 1200; // 滚到底后的停留时间
  const SCROLL_SPEED = 40;         // 滚动速度 px/s
  const SCROLL_MIN_MS = 400;
  const SCROLL_MAX_MS = 5000;
  const SCROLL_EPSILON = 2;        // 小于 2px 视为没溢出（亚像素误差）

  let scrollTimer = null;
  let armTimer = null;
  let scrollGen = 0;

  /// 立刻停下滚动并回到开头。换字幕 / 隐藏字幕 / 改样式都要调用。
  function resetScroll() {
    scrollGen++;
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (textEl) {
      textEl.style.transition = "none";
      textEl.style.transform = "translateY(0)";
    }
    lineEl.classList.remove("scrolling");
  }

  /// 视口外还藏着多少像素的文字（= 需要滚动的距离）。
  function overflowDistance() {
    if (!textEl) return 0;
    return Math.max(0, Math.round(textEl.scrollHeight - lineEl.clientHeight));
  }

  /// 文字稳定后再量距离开始滚动：流式输出每来一个 delta 就重新计时。
  function scheduleScroll() {
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armTimer = null;
      startScroll();
    }, SCROLL_ARM_DELAY);
  }

  function restartScroll() {
    hideExtended = false;
    resetScroll();
    if (currentText) scheduleScroll();
  }

  function scrollAfter(ms, fn) {
    const gen = scrollGen;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      // 期间换了字幕/样式：这一串回调作废。
      if (gen !== scrollGen) return;
      scrollTimer = null;
      fn();
    }, ms);
  }

  function startScroll() {
    if (!textEl || maxLines <= 1) return;
    const distance = overflowDistance();
    if (distance <= SCROLL_EPSILON) return; // 没溢出就保持原位
    lineEl.classList.add("scrolling");

    const dur = Math.min(
      SCROLL_MAX_MS,
      Math.max(SCROLL_MIN_MS, Math.round((distance / SCROLL_SPEED) * 1000))
    );
    // 长句要靠滚动才看得全：顺延一次自动隐藏时间，保证至少播完一轮，
    // 否则会被 4 秒的自动隐藏清掉，正好卡在「吐字」的中途。
    if (hideTimer && !hideExtended) {
      hideExtended = true;
      const cycle = SCROLL_HOLD_TOP + dur + SCROLL_HOLD_BOTTOM;
      if (cycle > HIDE_DELAY) scheduleHide(cycle - HIDE_DELAY);
    }
    // 开头停留 → 匀速滚到底 → 底部停留 → 回到开头 → 循环
    scrollAfter(SCROLL_HOLD_TOP, () => {
      textEl.style.transition = `transform ${dur}ms linear`;
      textEl.style.transform = `translateY(${-distance}px)`;
      scrollAfter(dur + SCROLL_HOLD_BOTTOM, () => {
        const back = Math.max(240, Math.round(dur * 0.5));
        textEl.style.transition = `transform ${back}ms ease-out`;
        textEl.style.transform = "translateY(0)";
        scrollAfter(back + SCROLL_HOLD_TOP, startScroll);
      });
    });
  }

  // ---- 性能模式 ---------------------------------------------------------
  // 与 admin 面板共用同一个 localStorage 开关（同源）。集显直播时关掉
  // backdrop-filter —— 它需要每帧对背景重新采样合成，是最吃 GPU 的一项。

  const PERF_MODE_KEY = "slt.perfMode";

  function applyPerfMode(on) {
    document.body.classList.toggle("perf-mode", !!on);
  }

  function initPerfMode() {
    try {
      applyPerfMode(localStorage.getItem(PERF_MODE_KEY) === "1");
    } catch {
      // localStorage 不可用时保持默认的玻璃效果。
    }
    // admin 那边一改，这里立刻跟着变，不必刷新 OBS 浏览器源。
    window.addEventListener("storage", (ev) => {
      if (ev.key === PERF_MODE_KEY) applyPerfMode(ev.newValue === "1");
    });
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
    // 只做病态输入兜底；超出的部分不再截断，交给滚动显示。
    ensureInner().textContent = line.length > 1000 ? line.slice(0, 1000) + "…" : line;
    captionEl.classList.remove("empty");
    captionEl.classList.add("show");
    restartScroll();
  }

  function hide() {
    captionEl.classList.add("empty");
    captionEl.classList.remove("show");
    resetScroll();
    if (textEl) textEl.textContent = "";
  }

  const HIDE_DELAY = 4000;   // 没有新内容时字幕自动隐藏的时间
  let hideExtended = false;  // 长句顺延过一次就不再顺延，避免字幕一直不消失

  /// extraMs：需要滚动的长句会把隐藏时间往后顺延（见 startScroll）。
  function scheduleHide(extraMs) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hide();
      recentSentences.length = 0;
    }, HIDE_DELAY + (extraMs || 0));
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
    ensureInner();
    initPerfMode();
    // 顺序很关键：先 hash（旧版留下的 URL 参数）再 /api/config，
    // 让服务端配置成为唯一权威来源 —— 这样 admin 改动即时生效，
    // 用户不必重新复制 OBS 浏览器源 URL。
    parseHash();
    await loadConfig();
    connectWS();
    // 字体加载完成会改变行高，重新量一次滚动距离。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(restartScroll);
    }
    window.addEventListener("resize", restartScroll);
  }

  init();
})();
