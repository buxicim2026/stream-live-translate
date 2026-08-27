// Browser Source overlay JS.
//   * Connects to /ws/subtitles to receive live partial + final events.
//   * Renders a single caption line with a typewriter / fade / slide
//     animation depending on the body class.
//   * Reads style overrides from the URL hash: #color=%23ff0&size=56...

(function () {
  "use strict";

  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${wsScheme}://${location.host}/ws/subtitles`);

  const captionEl = document.getElementById("caption");
  const lineEl = document.getElementById("caption-line");
  let pendingText = "";
  let currentText = "";
  let hideTimer = null;
  let partialBuffer = "";
  let lastPartialAt = 0;

  // Watermark/filler words to filter
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

  function parseHash() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const color = params.get("color");
    if (color) {
      document.documentElement.style.setProperty("--caption-color", color);
    }
    const bg = params.get("bg");
    if (bg) {
      document.documentElement.style.setProperty("--caption-bg", bg);
    }
    const size = params.get("size");
    if (size) {
      document.documentElement.style.setProperty("--caption-size", size + "px");
    }
    const bgWidth = params.get("bgWidth");
    if (bgWidth && bgWidth !== "0") {
      document.documentElement.style.setProperty("--caption-width", bgWidth + "px");
    }
    const bgHeight = params.get("bgHeight");
    if (bgHeight && bgHeight !== "0") {
      document.documentElement.style.setProperty("--caption-height", bgHeight + "px");
    }
    const radius = params.get("radius");
    if (radius) {
      document.documentElement.style.setProperty("--caption-radius", radius + "px");
    }
    if (params.get("position")) {
      document.body.className = document.body.className.replace(/position-\w+/g, "");
      document.body.classList.add("position-" + params.get("position"));
    }
    if (params.get("layout")) {
      document.body.className = document.body.className.replace(/layout-\w+/g, "");
      document.body.classList.add("layout-" + params.get("layout"));
    }
    if (params.get("animation")) {
      document.body.className = document.body.className.replace(/animation-\w+/g, "");
      document.body.classList.add("animation-" + params.get("animation"));
    }
  }

  function show(text) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    // Force single line - truncate if too long
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
      // Skip duplicate, hide immediately
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

  ws.addEventListener("open", () => {
    console.log("overlay ws connected");
  });

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
    setTimeout(() => location.reload(), 2000);
  });

  parseHash();
})();