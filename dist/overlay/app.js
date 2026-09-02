// Browser Source overlay JS.
//   * 样式以服务端 /api/config 为权威（保存后经 WebSocket 实时推送）；
//     URL hash（#size=&color=&bg=…）只作为首帧兜底，会被配置覆盖，
//     因此 admin 改完样式 OBS 字幕立即生效，无需重新复制浏览器源 URL。
//   * 字幕实时渲染：模型每吐一个字就立刻显示（不等人把话说完），
//     追求尽可能低的延迟。
//   * 超过「最大行数」的部分不再省略，而是直接换到下一句字幕显示，
//     不做滚动 / 位移。
//   * 宽 / 高 / 圆角可用 bgWidth / bgHeight / radius 固定。

(function () {
  "use strict";

  const captionEl = document.getElementById("caption");
  const lineEl = document.getElementById("caption-line");
  // 字幕文字直接写在 #caption-line 上：超出最大行数的部分会换到下一句，
  // 不做位移，因此不需要「视口 + 内层」那套结构。
  // textEl 只是给渲染代码用的别名，保持内部写法统一。
  const textEl = lineEl;
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

    // 行数 / 字号变了，当前这句要重新切。
    refreshCaption();
  }

  // ---- 长句换句显示 -----------------------------------------------------
  // 英文新闻、访谈这类长句超过「最大行数」时，多出来的部分直接换到下一句
  // 字幕显示 —— 不做任何滚动或位移动画。
  //
  // 做法是「分页跟随」：文字一边流式增长一边实时显示（所以半句话就能立刻
  // 看到），一旦当前这句超过最大行数，就从超出的地方另起一句，字幕内容
  // 整块替换成新的一句。前面那句在增长过程中已经被实时显示过了，不会丢。
  //
  // 只有两个 DOM 操作：测量高度 + 写入文本，没有 transform 也没有定时器，
  // 因此没有延迟累积。

  let pageStart = 0; // 当前这句在完整文本中的起始字符下标

  /// 把 s 写进字幕测高度，读完立即恢复原文本 —— 绝不能让测量破坏打字机
  /// 的显示进度。
  function measureHeight(s) {
    const prev = textEl.textContent;
    textEl.textContent = s;
    const h = textEl.scrollHeight;
    textEl.textContent = prev;
    return h;
  }

  /**
   * 找换句位置：从 start 起，能塞进一屏的最长片段的结束下标。
   * 二分查找而非逐字符试排 —— 后者每次 partial 都要几十次强制重排，
   * 会直接把字幕拖出可感知的延迟。
   */
  function findCut(text, start, maxH) {
    let lo = start + 1;
    let hi = text.length;
    let best = start + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (measureHeight(text.slice(start, mid)) <= maxH) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /// 渲染完整累积文本中「当前这句」。
  function renderCaption(full) {
    if (!textEl) return;
    const shown = pickShown(full);
    displayShown(shown);
  }

  /// 决定应显示哪一段：单行模式全文给 CSS 省略号；多行超限时从溢出处另起。
  function pickShown(full) {
    if (maxLines <= 1) return full;
    const lh = parseFloat(getComputedStyle(captionEl).lineHeight) || 0;
    const maxH = maxLines * lh;
    if (maxH <= 0) return full;
    // 文本被替换成更短的内容时下标会越界，回到开头。
    if (pageStart > full.length) pageStart = 0;
    if (measureHeight(full.slice(pageStart)) > maxH) {
      pageStart = findCut(full, pageStart, maxH);
    }
    return full.slice(pageStart);
  }

  /// 文字或行数/字号变化后重画当前这句。
  function refreshCaption() {
    renderCaption(currentText);
  }

  // ---- 逐单位显示（打字机） ---------------------------------------------
  // typewriter 动画模式：字幕按语言粒度「逐一蹦出」——
  //   * 拉丁语系（英/法/西等，空格分词）→ 一个词一个词出现
  //   * 中日韩（无空格分词）→ 一个字一个字蹦出来
  // 由字幕文本内容判定：含 CJK（汉字/假名/谚文）逐字，否则逐词。这也与
  // config 的 target_lang 天然一致（日/韩/中目标 → 文本必是 CJK）。
  //
  // 与流式 partial 协同：partial 追加时只是把目标文本变长，打字游标不动，
  // 继续把新增内容逐单位打出来；整句（mock / final / 重连快照）一次到达时
  // 则自动从当前显示处往下打，观感接近实时。

  const TYPE_WORD_MS = 75;  // 拉丁语：一个词间隔（ms）
  const TYPE_CHAR_MS = 45;  // CJK：一个字间隔（ms）
  let typeTimer = null;
  let typeMode = "word";
  let typeTarget = "";      // 期望显示的整段
  let typePos = 0;          // 已打到的字符下标

  function isTypewriterMode() {
    return document.body.classList.contains("animation-typewriter");
  }

  function setUnitMode(text) {
    typeMode = /[\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(text)
      ? "char"
      : "word";
  }

  /// 返回从 from 起一个单位的结束下标（char 一个码点；word 一段连续同类）。
  function nextUnitEnd(text, from) {
    if (from >= text.length) return text.length;
    if (typeMode === "char") {
      const cp = text.codePointAt(from);
      return from + (cp > 0xffff ? 2 : 1);
    }
    let i = from;
    const ws = /\s/.test(text[i]);
    while (i < text.length && /\s/.test(text[i]) === ws) i++;
    return i;
  }

  function stopTyping() {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
  }

  /// 隐藏 / 换字幕时重置打字机。
  function resetTyping() {
    stopTyping();
    typeTarget = "";
    typePos = 0;
  }

  function typeTick() {
    typeTimer = null;
    if (typePos >= typeTarget.length) return; // 打完了
    typePos = nextUnitEnd(typeTarget, typePos);
    textEl.textContent = typeTarget.slice(0, typePos);
    if (typePos < typeTarget.length) {
      typeTimer = setTimeout(typeTick, typeMode === "word" ? TYPE_WORD_MS : TYPE_CHAR_MS);
    }
  }

  /// 把应显示内容交出去：typewriter 模式走打字机，其余模式整段即时显示。
  function displayShown(shown) {
    if (!textEl) return;
    if (!isTypewriterMode()) {
      stopTyping();
      if (textEl.textContent !== shown) textEl.textContent = shown;
      return;
    }
    // 同一句的延展（partial 追加 / final 收尾）：游标不动，继续打增量。
    // 全新内容（换句 / 修正）：从头逐单位打。
    const sameSentence = typeTarget && shown.startsWith(typeTarget);
    typeTarget = shown;
    if (!sameSentence) {
      typePos = 0;
      setUnitMode(shown);
      textEl.textContent = "";
    }
    if (typePos > typeTarget.length) typePos = typeTarget.length;
    if (typePos < typeTarget.length) {
      if (!typeTimer) {
        typeTimer = setTimeout(typeTick, typeMode === "word" ? TYPE_WORD_MS : TYPE_CHAR_MS);
      }
    } else {
      textEl.textContent = typeTarget;
    }
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
    captionEl.classList.remove("empty");
    captionEl.classList.add("show");
    // 病态输入兜底；超出的部分由 renderCaption 换到下一句显示。
    renderCaption(line.length > 1000 ? line.slice(0, 1000) + "…" : line);
  }

  function hide() {
    captionEl.classList.add("empty");
    captionEl.classList.remove("show");
    pageStart = 0;
    resetTyping();
    if (textEl) textEl.textContent = "";
  }

  const HIDE_DELAY = 4000;   // 没有新内容时字幕自动隐藏的时间

  function scheduleHide(extraMs) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hide();
      recentSentences.length = 0;
    }, HIDE_DELAY + (extraMs || 0));
  }

  function appendPartial(delta) {
    if (!delta) return;
    // 上一句已经收尾（finalize 会清空 buffer），这是新的一句，从头开始显示。
    if (partialBuffer.length === 0) pageStart = 0;
    partialBuffer += delta;
    lastPartialAt = Date.now();
    // 不做任何过滤，直接渲染：cleanText 的水印词表是针对整句设计的，
    // 套在流式片段上会误伤（delta 恰好是 "live" / "AI" 就被整段丢掉），
    // 既吞内容又让人误以为字幕要等说完才出。水印只在 finalize 时清理。
    show(partialBuffer);
    scheduleHide();
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
    initPerfMode();
    // 顺序很关键：先 hash（旧版留下的 URL 参数）再 /api/config，
    // 让服务端配置成为唯一权威来源 —— 这样 admin 改动即时生效，
    // 用户不必重新复制 OBS 浏览器源 URL。
    parseHash();
    await loadConfig();
    connectWS();
    // 字体加载完成会改变行高，重新切一次当前这句。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(refreshCaption);
    }
    window.addEventListener("resize", refreshCaption);
  }

  init();
})();
