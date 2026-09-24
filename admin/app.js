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

  // ---- 液态玻璃 / 性能模式 ----------------------------------------------
  // 默认开启液态玻璃（极光背景 + 毛玻璃）；顶栏按钮可切到性能模式
  // （关闭全部特效，省集显），选择记在 localStorage 里下次沿用。
  const PERF_MODE_KEY = "slt.perfMode";
  function readPerfMode() {
    try { return localStorage.getItem(PERF_MODE_KEY) === "1"; } catch { return false; }
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

  // ---- Provider hints（直接内置；不再走 i18n 避免 key 缺失） -----------
  const PROVIDER_HINTS = {
    "qwen": {
      boxHtml: `<strong>💡 通义 Qwen API</strong><br />只能选<strong>实时</strong>语音模型（名字带 realtime，或双工识别的 asr-flash-message）；filetrans 等非 realtime 是 HTTP 接口，做不了字幕。<br />翻译：<code>qwen3.8-livetranslate-flash-realtime</code>；识别：<code>qwen3-asr-flash-realtime</code> / <code>qwen-audio-3.1-asr-flash-message</code>；对话：<code>qwen-audio-3.1-realtime-plus</code> 等。<br /><strong>注意：</strong>3.8 系列（同传 / Omni）、3.1 Realtime Plus 等新模型建议用<strong>业务空间专属地址</strong>：<code>wss://&lt;WorkspaceId&gt;.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime</code>（双工识别为 .../api-ws/v1/inference）。3.8 同传的会话字段（output_modalities / audio.input.turn_detection）已按官方文档单独适配，它自带增量译文输出；「低延迟模式」对它自动忽略，主要给 3.5 同传 / ASR 模型用。`,
      modelPlaceholder: "qwen3.8-livetranslate-flash-realtime",
      modelSuggestions: [
        { value: "qwen3.8-livetranslate-flash-realtime", label: "同传翻译·3.8（推荐）" },
        { value: "qwen3.5-livetranslate-flash-realtime", label: "同传翻译·3.5" },
        { value: "qwen3-asr-flash-realtime", label: "实时语音识别（ASR）" },
        { value: "qwen-audio-3.1-asr-flash-message", label: "实时识别·3.1 双工（消息式）" },
        { value: "qwen-audio-3.1-asr-flash-streaming", label: "实时识别·3.1 流式" },
        { value: "qwen-audio-3.1-realtime-plus", label: "实时语音对话·3.1 Plus（转写当字幕）" },
        { value: "qwen3.8-omni-flash-realtime", label: "全模态实时·3.8 Omni（需专属域名）" }
      ],
      endpointPlaceholder: "留空用默认；新模型建议填业务空间专属地址",
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
    },
    "azure": {
      boxHtml: `<strong>☁️ Azure OpenAI Realtime</strong><br />协议与 OpenAI Realtime 相同，但<strong>鉴权用 <code>api-key</code> 头</strong>，且地址要<strong>整条粘贴</strong>（含 <code>api-version</code> / <code>deployment</code>），例如 <code>wss://&lt;资源名&gt;.openai.azure.com/openai/v1/realtime?model=&lt;部署名&gt;</code>。做字幕请勾选「实时字幕模式」；<code>gpt-live-transcribe</code> / <code>gpt-realtime-whisper</code> 会自动走新版听录会话。`,
      modelPlaceholder: "gpt-realtime（或你的部署名）",
      modelSuggestions: [
        { value: "gpt-realtime", label: "GPT-Realtime（对话/转写）" },
        { value: "gpt-live-transcribe", label: "gpt-live-transcribe（听录，GA 会话）" },
        { value: "gpt-realtime-whisper", label: "gpt-realtime-whisper（流式听录）" },
        { value: "gpt-4o-realtime-preview", label: "GPT-4o Realtime（旧版）" }
      ],
      endpointPlaceholder: "wss://<资源名>.openai.azure.com/openai/v1/realtime?model=<部署名>",
      endpointDefault: "",
      className: "online-hint"
    },
    "gemini": {
      boxHtml: `<strong>✨ Google Gemini Live API</strong><br />原生 WebSocket 双向流式，Key 填 <strong>Google AI Studio 的 API Key</strong>。转写用 <code>gemini-2.5-flash-live</code>；实时翻译用 <code>gemini-3.5-live-translate-preview</code>（字幕显示译文）。本插件自动发送 16kHz PCM，并只取「说话人转写」通道，不会把模型自己的话当字幕。<br /><strong>注意：</strong>需能直连 Google；国内一般要自建中转，把 Base URL 换成你的中转端点即可（端点需保留路径，只是域名不同）。`,
      modelPlaceholder: "gemini-2.5-flash-live",
      modelSuggestions: [
        { value: "gemini-2.5-flash-live", label: "Gemini 2.5 Flash Live（转写，推荐）" },
        { value: "gemini-2.0-flash-live-001", label: "Gemini 2.0 Flash Live" },
        { value: "gemini-3.5-live-translate-preview", label: "Live Translate（实时翻译→译文）" },
        { value: "gemini-2.5-flash-native-audio-preview", label: "2.5 Flash Native Audio（对话）" }
      ],
      endpointPlaceholder: "留空用官方默认端点；国内可填自建中转地址",
      endpointDefault: "",
      className: "qwen-hint"
    },
    "deepgram": {
      boxHtml: `<strong>🎧 Deepgram 实时转写</strong><br />英文/多语种流式转写（<code>nova-3</code>），Key 用 Deepgram 控制台的 API Key。默认端点 <code>wss://api.deepgram.com/v1/listen</code>，插件已自动带 16kHz PCM 与中间结果参数；<strong>要指定语言可在 Base URL 追加 <code>?language=zh</code></strong>（已写过的参数不会被覆盖）。<br /><strong>只做转写，不做翻译</strong>，适合「英文直播配英文字幕」或缺中文模型时的兜底。`,
      modelPlaceholder: "nova-3",
      modelSuggestions: [
        { value: "nova-3", label: "Nova-3（多语种，推荐）" },
        { value: "nova-2", label: "Nova-2" },
        { value: "enhanced", label: "Enhanced（便宜）" }
      ],
      endpointPlaceholder: "wss://api.deepgram.com/v1/listen（可加 ?language=zh）",
      endpointDefault: "wss://api.deepgram.com/v1/listen",
      className: "online-hint"
    },
    "assemblyai": {
      boxHtml: `<strong>🎧 AssemblyAI 实时转写（Streaming v3）</strong><br />英文流式转写，Key 用 AssemblyAI 控制台的 API Key（<strong>只填 key，不要加 Bearer</strong>，插件会按 v3 规范拼 <code>Authorization: &lt;key&gt;</code>）。默认端点 <code>wss://streaming.assemblyai.com/v3/ws</code>，按「轮次(turn)」输出字幕。<br /><strong>只做转写，不做翻译。</strong>`,
      modelPlaceholder: "universal-streaming-english（可留空）",
      modelSuggestions: [
        { value: "universal-streaming-english", label: "Universal Streaming English" },
        { value: "universal-3-5-pro", label: "Universal 3.5 Pro" }
      ],
      endpointPlaceholder: "wss://streaming.assemblyai.com/v3/ws",
      endpointDefault: "wss://streaming.assemblyai.com/v3/ws",
      className: "online-hint"
    },
    "volc": {
      boxHtml: `<strong>🔥 火山引擎 · 豆包流式语音识别</strong><br />国内直播最常用、性价比高，<strong>边说边出字</strong>。Key 填豆包语音控制台的 <strong>API Key</strong>；Model 字段填<strong>资源 ID</strong>（默认 <code>volc.seedasr.sauc.duration</code> = 2.0 小时版）。<br /><strong>注意：</strong>需先在控制台开通「流式语音识别」，并保证该资源 ID 已授权；本适配走官方二进制协议（16kHz PCM），分句结果会自动断句。<strong>只做识别、不做翻译。</strong>`,
      modelPlaceholder: "volc.seedasr.sauc.duration",
      modelSuggestions: [
        { value: "volc.seedasr.sauc.duration", label: "豆包流式识别 2.0 · 小时版（推荐）" },
        { value: "volc.seedasr.sauc.concurrent", label: "豆包流式识别 2.0 · 并发版" },
        { value: "volc.bigasr.sauc.duration", label: "豆包流式识别 1.0 · 小时版" },
        { value: "volc.bigasr.sauc.concurrent", label: "豆包流式识别 1.0 · 并发版" }
      ],
      endpointPlaceholder: "留空用官方默认（openspeech.bytedance.com 双向流式接口）",
      endpointDefault: "",
      className: "qwen-hint"
    },
    "xfyun": {
      boxHtml: `<strong>🎙️ 讯飞 · 实时语音转写（RTASR）</strong><br />Key 必须填 <strong><code>appid:apiKey</code> 两段</strong>（在讯飞控制台应用里取，用英文冒号连接）；Model 字段填<strong>源语言</strong>：<code>cn</code>（中文/中英混合，默认）或 <code>en</code>。<br />本适配只做<strong>听写</strong>（返回原文、不做翻译），签名（HMAC-SHA1）与 40ms 分帧已自动处理。`,
      modelPlaceholder: "cn 或 en（源语言，可留空）",
      modelSuggestions: [
        { value: "cn", label: "cn（中文 / 中英混合，默认）" },
        { value: "en", label: "en（英文）" }
      ],
      endpointPlaceholder: "留空用官方默认（ws[s]://rtasr.xfyun.cn/v1/ws）",
      endpointDefault: "",
      className: "online-hint"
    }
  };
  const PROVIDER_TYPE_MAP = {
    "qwen": "qwen-realtime",
    "glm": "openai-realtime",
    "online": "openai-realtime",
    "azure": "openai-realtime",
    "local": "openai-realtime",
    "funasr": "fun-asr-realtime",
    "gemini": "gemini-live",
    "deepgram": "deepgram",
    "assemblyai": "assemblyai",
    "volc": "volc-asr",
    "xfyun": "xfyun-rtasr",
    "mock": "mock"
  };

  // ---- 「模型适配说明」内容 ----------------------------------------------
  // 每家一段：Key 怎么填 / Model 怎么填 / Base URL / 推荐场景 / 注意。
  // 段落开头的简介复用 PROVIDER_HINTS[t].boxHtml，避免两处维护。
  const GUIDE_SECTIONS = [
    {
      t: "qwen",
      title: "① 通义 Qwen（阿里云百炼）",
      badge: "首选 · 同传翻译",
      key: "百炼控制台（Model Studio）的 API Key，形如 <code>sk-…</code>。",
      model: "外语→中文字幕：<code>qwen3.8-livetranslate-flash-realtime</code>（首选）或 <code>qwen3.5-livetranslate-flash-realtime</code>；中文→中文字幕：<code>qwen3-asr-flash-realtime</code>；双工识别：<code>qwen-audio-3.1-asr-flash-message</code>；语音对话：<code>qwen-audio-3.1-realtime-plus</code>。",
      url: "留空即用官方默认 <code>wss://dashscope.aliyuncs.com/api-ws/v1/realtime</code>；<strong>3.8 / 3.1 等新模型建议填业务空间专属地址</strong> <code>wss://&lt;WorkspaceId&gt;.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime</code>（双工识别为 <code>.../api-ws/v1/inference</code>）。",
      use: "外语直播的同声传译（3.8 同传自带增量输出、延迟更低）；纯中文直播只要中文字幕时建议改用 ASR 模型。",
      note: "不能填 <code>filetrans</code> 这类离线 HTTP 接口，做不了实时字幕；3.8 同传的会话字段已按官方文档单独适配，「低延迟模式」对它自动忽略。"
    },
    {
      t: "volc",
      title: "② 火山引擎 · 豆包流式语音识别",
      badge: "国内推荐 · 便宜快",
      key: "豆包语音控制台的 API Key（新版控制台）。插件按官方要求发 <code>X-Api-Key</code>，无需手拼签名。",
      model: "这里要填<strong>资源 ID</strong>（不是模型名）：<code>volc.seedasr.sauc.duration</code>（2.0 小时版，推荐）、<code>volc.seedasr.sauc.concurrent</code>（2.0 并发版）、<code>volc.bigasr.sauc.duration</code>（1.0 小时版）。",
      url: "留空即用官方双向流式地址 <code>wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async</code>。",
      use: "中文直播 / 会议字幕，国内延迟低、按小时计费便宜；长时段直播最划算。",
      note: "需先在控制台开通「流式语音识别」并保证该资源 ID 已授权；本适配走官方二进制协议（16kHz PCM），分句自动断句。<strong>只识别、不翻译。</strong>"
    },
    {
      t: "xfyun",
      title: "③ 讯飞 · 实时语音转写（RTASR）",
      badge: "中文听写",
      key: "必须填 <strong><code>appid:apiKey</code></strong> 两段（讯飞控制台应用里取，用英文冒号连接）。签名（HMAC-SHA1）由插件自动生成。",
      model: "填<strong>源语言</strong>：<code>cn</code>（中文 / 中英混合，默认）或 <code>en</code>（英文）。",
      url: "留空即用官方默认 <code>wss://rtasr.xfyun.cn/v1/ws</code>。",
      use: "中文会议 / 直播字幕；企业已购买讯飞额度时。",
      note: "只做听写（不翻译）；控制台需开通「实时语音转写」并配置 <strong>IP 白名单</strong>（保存后约 5 分钟生效）；超过 15 秒不推音频会被服务端断开，插件已按官方 40ms/1280 字节分帧持续推流。"
    },
    {
      t: "glm",
      title: "④ 智谱 GLM-Realtime",
      badge: "国内合规",
      key: "bigmodel.cn 控制台的 API Key。",
      model: "<code>glm-realtime-flash</code>（更便宜）、<code>glm-realtime</code>、<code>glm-realtime-air</code>。",
      url: "<code>wss://open.bigmodel.cn/api/paas/v4/realtime</code>（选该服务时已自动填入）。",
      use: "国内合规要求较高、或已有智谱额度的场景；做字幕请勾选「实时字幕模式」。",
      note: "走 OpenAI 兼容协议；插件只显示「说话人转写」通道，不会把模型自己的回复当字幕。"
    },
    {
      t: "online",
      title: "⑤ OpenAI / 其它 OpenAI 兼容在线服务",
      badge: "多语种",
      key: "<code>sk-…</code>。",
      model: "对话/转写：<code>gpt-realtime</code>、<code>gpt-4o-realtime-preview</code>；<strong>纯听录</strong>：<code>gpt-live-transcribe</code>、<code>gpt-realtime-whisper</code>（插件会自动改用新版 GA 听录会话 <code>session.type=transcription</code>）。",
      url: "<code>wss://api.openai.com/v1/realtime</code>；第三方兼容网关按对方文档填。",
      use: "英文 / 多语种直播；要中文字幕时勾选「实时字幕模式」（开启输入音频转写通道）。",
      note: "需能直连 OpenAI（国内一般要中转/代理）；OpenAI 家族会按 24kHz 约定自动上采样，语音不会被拉快。"
    },
    {
      t: "azure",
      title: "⑥ Azure OpenAI Realtime",
      badge: "企业 / 合规",
      key: "Azure 资源的 Key（填到 API Key）。插件识别到 <code>*.openai.azure.com</code> 会自动改发 <code>api-key</code> 头。",
      model: "填你的<strong>部署名</strong>（deployment），例如 <code>gpt-realtime</code>、<code>gpt-live-transcribe</code>。",
      url: "<strong>整条粘贴</strong>：<code>wss://&lt;资源名&gt;.openai.azure.com/openai/v1/realtime?model=&lt;部署名&gt;</code>；旧版端点可带 <code>api-version=…&amp;deployment=…</code>（地址里已有 <code>?</code> 时插件不再追加参数）。",
      use: "企业已有 Azure 额度 / 数据出域合规要求；协议与 OpenAI 完全相同。",
      note: "不要用 <code>Authorization: Bearer</code>（会被拒，插件已自动换成 <code>api-key</code>）；听录模型同样支持 GA 会话。"
    },
    {
      t: "gemini",
      title: "⑦ Google Gemini Live API",
      badge: "含实时翻译",
      key: "Google AI Studio 的 API Key（插件用 <code>?key=</code> 传入）。",
      model: "转写：<code>gemini-2.5-flash-live</code>（推荐）、<code>gemini-2.0-flash-live-001</code>；<strong>实时翻译</strong>：<code>gemini-3.5-live-translate-preview</code>（字幕显示译文）。",
      url: "留空用官方 Live 端点；国内需自建中转（<strong>只换域名、保留路径</strong>）。",
      use: "多语种实时转写 / 实时翻译，自带增量输出、延迟低。",
      note: "需要能访问 Google；插件对翻译型模型取译文通道，其余取「说话人转写」通道，不会混入模型自己的话。"
    },
    {
      t: "deepgram",
      title: "⑧ Deepgram 实时转写",
      badge: "英文 · 便宜",
      key: "Deepgram 控制台 API Key（插件发 <code>Authorization: Token &lt;key&gt;</code>）。",
      model: "<code>nova-3</code>（多语种，默认）、<code>nova-2</code>、<code>enhanced</code>。",
      url: "<code>wss://api.deepgram.com/v1/listen</code>；要指定语言在地址后加 <code>?language=zh</code>（已写过的参数不会被覆盖）。",
      use: "英文直播配英文字幕；价格低、延迟低。",
      note: "<strong>只转写、不翻译</strong>；16kHz PCM、中间结果与断句参数插件已自动带上。"
    },
    {
      t: "assemblyai",
      title: "⑨ AssemblyAI 实时转写（Streaming v3）",
      badge: "英文 · 转写",
      key: "AssemblyAI 控制台 API Key（<strong>只填 key</strong>，插件按 v3 规范发裸 <code>Authorization: &lt;key&gt;</code>）。",
      model: "<code>universal-streaming-english</code>（默认）、<code>universal-3-5-pro</code>；可留空。",
      url: "<code>wss://streaming.assemblyai.com/v3/ws</code>。",
      use: "英文直播、按「轮次(turn)」出字幕。",
      note: "<strong>只转写、不翻译</strong>；主要面向英语，中文效果有限。"
    },
    {
      t: "funasr",
      title: "⑩ FunASR 本地流式识别（自部署）",
      badge: "免费 · 离线",
      key: "本地服务不需要鉴权，随便填一个非空值即可（例如 <code>local</code>）。",
      model: "服务端已加载的模型名，可留空：<code>SenseVoiceSmall</code>、<code>fun-asr-nano</code>、<code>paraformer-zh</code>。",
      url: "<code>ws://127.0.0.1:10095</code>（FunASR 官方 runtime Docker 默认端口）。",
      use: "中文直播要零成本 / 完全离线；显卡或 CPU 够用的机器上很划算。",
      note: "需要自己用 Docker 起 FunASR 实时服务；自带 VAD 断句，只返回说话内容。"
    },
    {
      t: "local",
      title: "⑪ 本机部署 API（OpenAI Realtime 兼容网关）",
      badge: "离线 / 隐私",
      key: "本地服务一般无需鉴权，填占位值即可。",
      model: "取决于你的网关（例如 huggingface/speech-to-speech 的模型名）。",
      url: "例如 <code>ws://127.0.0.1:8765/v1/realtime</code>（speech-to-speech）或 <code>ws://localhost:11434/v1/realtime</code>（Ollama 系）。",
      use: "完全离线、数据不出本机；也可把自建 ASR 套一个 Realtime 网关接进来。",
      note: "勾选「本机网关模式」后字幕直接取 <code>response.text.*</code>（网关通常直接把要显示的文字放这里）。"
    },
    {
      t: "mock",
      title: "⑫ 模拟模式（不消耗额度）",
      badge: "调试用",
      key: "随便填一个非空值（或勾掉校验前先填）。",
      model: "不用填。",
      url: "不用填。",
      use: "第一次配置时先验证「OBS 叠加层 → 字幕样式 → 位置」是否正常，不花一分钱。",
      note: "输出的是固定示例句，不是真实识别结果。"
    }
  ];

  /// 渲染「模型适配说明」弹窗：当前选中的服务高亮并滚动到可视区。
  function renderModelGuide() {
    const body = $("guide-body");
    if (!body) return;
    const cur = $("provider-type") ? $("provider-type").value : "";
    const sections = GUIDE_SECTIONS.map((s) => {
      const hint = PROVIDER_HINTS[s.t] || {};
      const isCur = s.t === cur;
      return `<section class="guide-sec${isCur ? " cur" : ""}" data-ptype="${s.t}">
        <h4>${s.title}${s.badge ? ` <span class="guide-tag">${s.badge}</span>` : ""}${isCur ? ' <span class="guide-now">当前使用</span>' : ""}</h4>
        <div class="guide-intro">${hint.boxHtml || ""}</div>
        <ul class="guide-points">
          <li><b>Key 怎么填</b>：${s.key}</li>
          <li><b>Model 怎么填</b>：${s.model}</li>
          <li><b>Base URL</b>：${s.url}</li>
          <li><b>推荐场景</b>：${s.use}</li>
          <li><b>注意</b>：${s.note}</li>
        </ul>
      </section>`;
    }).join("");
    body.innerHTML = `
      <p class="guide-lead">本插件只能使用<strong>能实时接收语音、边说边返回文字</strong>的<strong>语音（多模态）Realtime</strong>服务。下面按「怎么选 → 每家怎么填」逐一说明；你当前选的服务会高亮显示。</p>
      <section class="guide-sec guide-quick">
        <h4>30 秒选择指南</h4>
        <ul class="guide-points">
          <li><b>外语直播 → 中文字幕</b>：通义 <code>qwen3.8-livetranslate-flash-realtime</code>（首选）→ Gemini <code>gemini-3.5-live-translate-preview</code> → OpenAI 翻译/听录模型。</li>
          <li><b>中文直播 → 中文字幕</b>：火山豆包流式识别（便宜快）→ 通义 <code>qwen3-asr-flash-realtime</code> → 本地 FunASR（免费）。</li>
          <li><b>英文直播 → 英文字幕</b>：Deepgram <code>nova-3</code> / AssemblyAI，价格低、延迟低。</li>
          <li><b>完全离线 / 数据不出本机</b>：本地 FunASR，或自建 OpenAI-Realtime 兼容网关。</li>
          <li><b>首次配置先试水</b>：选「模拟模式」，确认叠加层与字幕样式没问题再换真模型。</li>
        </ul>
      </section>
      ${sections}
      <section class="guide-sec guide-no">
        <h4>暂不支持 / 不适用的服务</h4>
        <ul class="guide-points">
          <li><b>MiniMax、Kimi（Moonshot）、Claude</b>：目前没有开放的实时双向语音接口。</li>
          <li><b>腾讯云、百度</b>：协议较重（自定义签名 + 加密载荷），暂未适配，需要的话可以再补。</li>
          <li><b>纯文本 / 纯 TTS / HTTP 上传式 ASR</b>（如 whisper API、filetrans、paraformer 录音文件）：不是实时流，做不出「边说边出」字幕。</li>
          <li><b>可能后续加</b>：Soniox、Gladia、Speechmatics、ElevenLabs Scribe（协议简单，待实测）。</li>
        </ul>
      </section>
      <p class="guide-foot">提示：换服务后记得点「保存并重启」，管线会用新配置重连。</p>
    `;
    const curEl = body.querySelector(".guide-sec.cur");
    if (curEl) {
      // 等弹窗显示后再滚动，否则 scrollIntoView 无效。
      setTimeout(() => curEl.scrollIntoView({ block: "start" }), 0);
    }
  }

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
    if (cfg.llm.provider === "gemini-live") return "gemini";
    if (cfg.llm.provider === "deepgram") return "deepgram";
    if (cfg.llm.provider === "assemblyai") return "assemblyai";
    if (cfg.llm.provider === "volc-asr") return "volc";
    if (cfg.llm.provider === "xfyun-rtasr") return "xfyun";
    if (cfg.llm.provider === "openai-realtime") {
      const ep = cfg.llm.endpoint || "";
      if (ep.includes("bigmodel.cn")) return "glm";
      if (ep.includes(".azure.com")) return "azure";
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
    // OpenAI 兼容 realtime 家族（含 GLM / Azure）才有「实时字幕模式」。
    const openaiLike = ["glm", "online", "local", "azure"].includes(providerType);
    $("transcribe_row").style.display = openaiLike ? "" : "none";
    $("transcription_model_row").style.display =
      openaiLike && $("transcribe").checked ? "" : "none";
    $("gateway_row").style.display = providerType === "local" ? "" : "none";
    // 「低延迟模式」只对支持手动提交的 provider 有效（qwen / OpenAI 家族）；
    // Gemini、Deepgram、AssemblyAI 自带增量输出，不显示该开关。
    const lowLatencyOk = ["qwen", "glm", "online", "local", "azure"].includes(providerType);
    const lowLatLabel = $("low_latency") && $("low_latency").closest("label");
    if (lowLatLabel) lowLatLabel.style.display = lowLatencyOk ? "" : "none";
    $("low_latency_ms_row").style.display =
      lowLatencyOk && $("low_latency").checked ? "" : "none";
    // 「模型适配说明」开着时跟随切换高亮（换服务即可看到对应说明）。
    if ($("guide-modal") && !$("guide-modal").hidden) renderModelGuide();
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
      renderModelGuide();
      $("guide-modal").hidden = false;
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
      // 新增的云服务 / 流式转写厂商：地址必须是 WebSocket 形式。
      if (["azure", "gemini", "deepgram", "assemblyai", "volc", "xfyun"].includes(providerType)) {
        const ep = (patch.llm.endpoint || "").trim();
        if (ep && !/^wss?:/i.test(ep)) {
          toast("Base URL 必须是 WebSocket 地址（wss:// 开头）", "error");
          return;
        }
        if (providerType === "azure" && !ep) {
          toast("Azure 请整条粘贴 WebSocket 地址（含 api-version / deployment）", "error");
          return;
        }
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
