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
  let toastTimer = null;

  // Big, unmissable feedback for save/test actions.
  function toast(msg, kind) {
    const el = $("toast");
    el.textContent = msg;
    el.className = "toast show " + (kind || "info");
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function fillForm(cfg) {
    $("provider").value = cfg.llm.provider;
    $("model").value = cfg.llm.model;
    $("api_key").value = cfg.llm.api_key;
    $("endpoint").value = cfg.llm.endpoint || "";
    $("target_lang").value = cfg.llm.target_lang;
    $("translate_chinese").checked = cfg.llm.translate_chinese;
    $("audio-mode").value = cfg.audio.mode;
    $("use_sck").checked = cfg.audio.use_screen_capture_kit;
    $("obs-auto").checked = cfg.obs.auto_connect;
    $("obs-host").value = cfg.obs.host;
    $("obs-port").value = cfg.obs.port;
    $("obs-password").value = cfg.obs.password;
    $("ov-size").value = cfg.overlay.font_size;
    $("ov-color").value = cfg.overlay.font_color;
    $("ov-bg").value = cfg.overlay.background_color;
    $("ov-position").value = cfg.overlay.position;
    $("ov-animation").value = cfg.overlay.animation;
    $("obs-dock-url").textContent =
      `${location.protocol}//${location.host}/admin?obsDock=1`;
    const bindUrl = `${location.protocol}//${location.host}/overlay` +
      `#size=${cfg.overlay.font_size}&color=${encodeURIComponent(cfg.overlay.font_color)}` +
      `&bg=${encodeURIComponent(cfg.overlay.background_color + hexAlpha(cfg.overlay.background_opacity))}` +
      `&position=${cfg.overlay.position}&animation=${cfg.overlay.animation}`;
    $("bind-url").href = bindUrl;
    $("bind-url").textContent = "打开 /overlay";
    $("overlay-url").href = bindUrl;
    $("overlay-url").textContent = "/overlay";
  }

  function hexAlpha(a) {
    const n = Math.max(0, Math.min(1, a));
    return Math.round(n * 255).toString(16).padStart(2, "0");
  }

  function collectPatch() {
    return {
      llm: {
        provider: $("provider").value,
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
        font_color: $("ov-color").value,
        background_color: $("ov-bg").value,
        position: $("ov-position").value,
        animation: $("ov-animation").value,
      },
    };
  }

  async function loadConfig() {
    const r = await fetch("/api/config");
    const cfg = await r.json();
    currentConfig = cfg;
    fillForm(cfg);
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
      // Surface the engine's last error + where the config is persisted, so
      // users can tell whether saving actually took effect.
      const errEl = $("engine-error");
      errEl.classList.remove("good");
      if (s.last_error) {
        errEl.textContent = "❗ " + s.last_error;
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
  }

  // Wire up events.
  $("save-btn").addEventListener("click", async () => {
    const patch = collectPatch();
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
      // Verify the value really landed in the persisted config.
      await loadConfig();
      const saved = currentConfig && currentConfig.llm.api_key === patch.llm.api_key
        && currentConfig.llm.model === patch.llm.model;
      if (saved) {
        toast("✅ 配置已保存并生效（管线已重启）", "ok");
      } else {
        toast("⚠️ 已保存，但读回内容不一致，请检查配置文件权限", "error");
      }
      // Restart the pipeline so the new key/model/endpoint are used.
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
        pendingPartial = p.line.text || "";
        showPreview(pendingPartial);
      } else if (p.type === "partial") {
        pendingPartial += p.text || "";
        showPreview(pendingPartial);
      } else if (p.type === "final") {
        pendingPartial = p.text || "";
        showPreview(pendingPartial);
        loadHistory();
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
