//! LLM provider abstraction. Each provider turns PCM s16le mono audio into
//! a stream of `SubtitleEvent`s. The pipeline doesn't care which provider is
//! plugged in.
//!
//! Currently implemented:
//!   * `qwen-realtime` — Aliyun DashScope realtime API
//!     (wss://dashscope.aliyuncs.com/api-ws/v1/realtime). Auto-adapts:
//!     translation models (…livetranslate…) get a `translation.language`
//!     session; ASR/audio models (qwen3-asr-*, qwen-audio-*, …) get an
//!     `input_audio_transcription` session instead.
//!   * `openai-realtime` — any OpenAI-compatible realtime WebSocket
//!     endpoint: OpenAI itself (gpt-4o-realtime) or DashScope
//!     compatible-mode (wss://dashscope.aliyuncs.com/compatible-mode/v1/realtime)
//!     for qwen-audio / ASR models. `instructions` are only sent when the
//!     user configured a system prompt, so pure ASR models don't choke.
//!   * `mock` — emits canned Chinese sentences; useful for end-to-end
//!     UI/UX testing without burning API quota.

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http, Message};
use tracing::{debug, info, warn};

use crate::config::LlmConfig;
use crate::subtitle::{SubtitleEvent, SubtitleSink};

#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Provider identifier (e.g. `qwen-realtime`).
    fn name(&self) -> &'static str;

    /// Open the streaming session. `on_event` is invoked for every partial
    /// or final transcript the model produces.
    async fn run(
        self: Arc<Self>,
        audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
        sink: SubtitleSink,
    ) -> Result<()>;
}

pub fn build(cfg: &LlmConfig) -> Result<Arc<dyn LlmProvider>> {
    match cfg.provider.as_str() {
        "qwen-realtime" => Ok(Arc::new(qwen::QwenRealtime::new(cfg.clone())?)),
        "openai-realtime" => Ok(Arc::new(openai::OpenAiRealtime::new(cfg.clone())?)),
        "mock" => Ok(Arc::new(mock::MockProvider::new(cfg.clone())?) as Arc<dyn LlmProvider>),
        other => Err(anyhow!("unknown LLM provider `{other}`")),
    }
}

/// Unwrap a realtime WebSocket handshake failure into a human-readable
/// error. DashScope/OpenAI answer failed upgrades with an HTTP status +
/// JSON body (invalid key, unknown model, workspace endpoint required…);
/// the default Display swallows that detail.
fn ws_connect_error(e: tokio_tungstenite::tungstenite::Error, ctx: &str) -> anyhow::Error {
    use tokio_tungstenite::tungstenite::Error as WsErr;
    match e {
        WsErr::Http(resp) => {
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .unwrap_or_default();
            anyhow!(
                "{ctx}被服务器拒绝：HTTP {} {}（请检查 API Key、模型名；若 Key 属于百炼业务空间，请在 Base URL 填专属域名）",
                resp.status().as_u16(),
                body
            )
        }
        other => anyhow!(other).context(ctx.to_string()),
    }
}

// ---------- Qwen DashScope realtime ----------

pub mod qwen {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

    pub struct QwenRealtime {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl QwenRealtime {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.is_empty() {
                return Err(anyhow!("Qwen API key is empty; please fill it in the admin panel"));
            }
            // Fun-ASR 流式识别（qwen-audio-*-asr-flash-streaming 等）走的是另一套
            // WebSocket 协议，与本插件使用的 DashScope Realtime（/api-ws/v1/realtime）
            // 不兼容，直接给出明确提示，而不是连接后各种报错。
            if cfg.model.to_lowercase().contains("streaming") {
                return Err(anyhow!(
                    "模型 {} 属于 Fun-ASR 流式识别(Streaming)接口，与插件使用的 DashScope Realtime 协议不兼容，无法出字幕。请改用 Realtime 语音模型：qwen3.5-livetranslate-flash-realtime（同传翻译）、qwen3-asr-flash-realtime / qwen-audio-3.0-realtime-flash（实时识别）等。",
                    cfg.model
                ));
            }
            Ok(Self { cfg, endpoint })
        }
    }

    #[async_trait]
    impl LlmProvider for QwenRealtime {
        fn name(&self) -> &'static str {
            "qwen-realtime"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let url = format!("{}?model={}", self.endpoint, self.cfg.model);
            let mut req = url
                .into_client_request()
                .with_context(|| "build qwen ws request")?;
            req.headers_mut()
                .insert("Authorization", http::HeaderValue::from_str(&format!("Bearer {}", self.cfg.api_key))?);

            let (ws, _resp) = match tokio_tungstenite::connect_async(req).await {
                Ok(pair) => pair,
                Err(e) => return Err(ws_connect_error(e, "连接 DashScope 实时服务")),
            };
            info!("connected to qwen realtime");
            let (mut write_half, mut read_half) = ws.split();

            // Configure session. The DashScope realtime API serves two
            // model families with different session schemas:
            //   * Translation models (…livetranslate…): need
            //     `translation.language` (default is "en", so mandatory).
            //     `input_audio_transcription` only accepts a dedicated ASR
            //     model name or null; we disable it because the overlay
            //     shows the translation stream only.
            //   * ASR / audio models (qwen3-asr-*, qwen-audio-*, …):
            //     `translation` is not in their schema (sending it fails
            //     the session); instead enable `input_audio_transcription`
            //     so we receive transcription delta/completed events.
            // Both use server VAD: the server detects speech end itself
            // and auto-commits, so we feed it a *continuous* audio stream.
            let asr_mode = !self.cfg.model.to_lowercase().contains("livetranslate");
            let session_cfg: serde_json::Value = if asr_mode {
                serde_json::json!({
                    "modalities": ["text"],
                    "sample_rate": 16000,
                    "input_audio_format": "pcm",
                    "input_audio_transcription": { "model": self.cfg.model },
                    "turn_detection": { "type": "server_vad" }
                })
            } else {
                serde_json::json!({
                    "modalities": ["text"],
                    "sample_rate": 16000,
                    "input_audio_format": "pcm",
                    "input_audio_transcription": null,
                    "turn_detection": { "type": "server_vad" },
                    "translation": { "language": self.cfg.target_lang }
                })
            };
            let session = serde_json::json!({ "type": "session.update", "session": session_cfg });
            write_half
                .send(Message::Text(session.to_string().into()))
                .await?;

            // Pump audio in one task, read events in another.
            let sink_for_read = sink.clone();
            let read = {
                let sink = sink_for_read.clone();
                async move {
                    // pending：当前这一轮/这一句服务端给到的「累计稳定文本」。
                    // 用来把累积类事件 diff 成「只推新增」，避免重复 append。
                    let mut pending = String::new();
                    // 通道隔离：livetranslate 走“译文”通道；其它（ASR / 语音识别 /
                    // 语音对话模型）只显示源语言转写通道，把模型自己的闲聊回应
                    // （response.text.* / audio_transcript.*）丢掉，避免字幕出现废话。
                    let transcribe_channel = asr_mode;
                    while let Some(msg) = read_half.next().await {
                        let msg = match msg {
                            Ok(m) => m,
                            Err(e) => {
                                warn!(error=%e, "qwen ws read error");
                                break;
                            }
                        };
                        match msg {
                            Message::Text(t) => {
                                if let Ok(ev) = serde_json::from_str::<QwenEvent>(&t) {
                                    apply_qwen_event(&ev, &sink, &mut pending, transcribe_channel);
                                } else {
                                    debug!(payload=%t, "unparsed qwen event");
                                }
                            }
                            Message::Close(c) => {
                                info!(?c, "qwen ws closed by server");
                                break;
                            }
                            Message::Ping(_)
                            | Message::Pong(_)
                            | Message::Binary(_)
                            | Message::Frame(_) => {}
                        }
                    }
                }
            };

            // Audio pump with optional low-latency segmentation.
            //
            //   * segment_ms == 0（默认）：只 append。服务端 server_vad 在
            //     「一句话说完、静音达标」后自行 commit，整句返回 —— 句子最
            //     完整，但字幕要等整句话说完（延迟≈整句话时长）。
            //   * segment_ms > 0（低延迟模式）：本机累计「正在说的语音」，
            //     每满该毫秒就主动发一次 input_audio_buffer.commit，把当前
            //     已说的这一小段提前识别/翻译出来，字幕按段推进，延迟可压到
            //     ~1–2 秒（代价：长句被切成短段）。静音超 ~400ms 也 commit
            //     一次收尾，避免句子结尾空等。
            let segment_ms = self.cfg.segment_ms;
            let write = async move {
                let commit_enabled = segment_ms > 0;
                let mut voiced_ms: u64 = 0; // 自上次 commit 起累计的有声时长(ms)
                let mut tail_ms: u64 = 0; // 有声结束后跟随的静音时长(ms)
                let mut has_voiced = false; // 上次 commit 后是否出现过语音

                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let msg = serde_json::json!({
                        "type": "input_audio_buffer.append",
                        "audio": b64,
                    });
                    if write_half.send(Message::Text(msg.to_string().into())).await.is_err() {
                        break;
                    }
                    if !commit_enabled {
                        continue;
                    }

                    let ms = (chunk.len() as u64) * 1000 / 16_000;
                    if crate::vad::rms(&chunk) >= 0.008 {
                        // 语音：累计到 segment_ms 就提前 commit 一小段。
                        voiced_ms = voiced_ms.saturating_add(ms);
                        has_voiced = true;
                        tail_ms = 0;
                        if voiced_ms >= segment_ms {
                            let cm = serde_json::json!({ "type": "input_audio_buffer.commit" });
                            if write_half
                                .send(Message::Text(cm.to_string().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            voiced_ms = 0;
                            tail_ms = 0;
                        }
                    } else if has_voiced {
                        // 语音结束后的尾静音：够长就收尾提交，别让结尾空等。
                        tail_ms = tail_ms.saturating_add(ms);
                        if tail_ms >= 400 {
                            let cm = serde_json::json!({ "type": "input_audio_buffer.commit" });
                            if write_half
                                .send(Message::Text(cm.to_string().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            voiced_ms = 0;
                            tail_ms = 0;
                            has_voiced = false;
                        }
                    }
                }
                // 会话结束前把没提交完的尾巴交出去。
                if commit_enabled && (has_voiced || voiced_ms > 0) {
                    let cm = serde_json::json!({ "type": "input_audio_buffer.commit" });
                    let _ = write_half
                        .send(Message::Text(cm.to_string().into()))
                        .await;
                }
                // Flush the tail of the session, then close gracefully.
                let _ = write_half
                    .send(Message::Text(
                        serde_json::json!({"type": "session.finish"}).to_string().into(),
                    ))
                    .await;
                let _ = write_half.close().await;
            };

            tokio::select! {
                _ = read => {}
                _ = write => {}
            }
            Ok(())
        }
    }

    #[derive(Debug, Deserialize)]
    #[serde(tag = "type")]
    enum QwenEvent {
        #[serde(rename = "session.created")]
        SessionCreated {
            session: serde_json::Value,
        },
        #[serde(rename = "session.updated")]
        SessionUpdated {
            session: serde_json::Value,
        },
        /// 逐 token 增量（OpenAI 风格）。
        #[serde(rename = "response.text.delta")]
        ResponseTextDelta {
            #[serde(default)]
            delta: Option<String>,
        },
        /// Streaming translation increment. `text` is the confirmed text
        /// *for this event*; `stash` is a speculative tail. Both are
        /// cumulative ("stable prefix" of the current response), so we only
        /// push the part that is new relative to what we already showed.
        #[serde(rename = "response.text.text")]
        ResponseTextText {
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            stash: Option<String>,
        },
        /// Final complete translation of one utterance.
        #[serde(rename = "response.text.done")]
        ResponseTextDone {
            #[serde(default)]
            text: Option<String>,
        },
        /// DashScope realtime (audio_transcript channel): cumulative
        /// translation text. `text` is confirmed, `stash` is the tail.
        #[serde(rename = "response.audio_transcript.text")]
        AudioTranscriptText {
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            stash: Option<String>,
        },
        #[serde(rename = "response.audio_transcript.delta")]
        AudioTranscriptDelta {
            #[serde(default)]
            delta: Option<String>,
        },
        #[serde(rename = "response.audio_transcript.done")]
        AudioTranscriptDone {
            #[serde(default)]
            text: Option<String>,
        },
        /// Streaming ASR increment.
        #[serde(rename = "conversation.item.input_audio_transcription.delta")]
        TranscriptionDelta {
            #[serde(default)]
            text: Option<String>,
        },
        /// ASR cumulative "stable so far" text (stash).
        #[serde(rename = "conversation.item.input_audio_transcription.text")]
        TranscriptionText {
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            stash: Option<String>,
        },
        /// Source-language ASR stream final (only when transcription enabled).
        #[serde(rename = "conversation.item.input_audio_transcription.completed")]
        Completed {
            #[serde(default)]
            transcript: Option<String>,
        },
        #[serde(rename = "error")]
        Error { error: serde_json::Value },
        #[serde(other)]
        Other,
    }

  /// 把一个服务端事件应用成字幕更新。
  /// `pending` 记录当前这一句服务端给出的「累计稳定文本」，累积类事件
  /// （text / stash / transcript）据此只推送新增部分，避免重复。
  ///
  /// `transcribe == true`（非 livetranslate 的 ASR / 语音识别 / 语音对话类
  /// 模型）：只监听源语言转写事件 input_audio_transcription.*，丢弃模型的
  /// response.text.* / audio_transcript.*（那是模型自己的闲聊回应，不是
  /// 说话人内容，显示出来就是“废话”）。
  /// `transcribe == false`（livetranslate 同传模型）：只监听译文事件
  /// response.text.* / audio_transcript.*，转写通道本就未开启。
  fn apply_qwen_event(
    ev: &QwenEvent,
    sink: &SubtitleSink,
    pending: &mut String,
    transcribe: bool,
  ) {
    if transcribe {
        // ---- 转写通道：ASR / 语音识别类模型 ----
        match ev {
            QwenEvent::TranscriptionDelta { text } => {
                if let Some(t) = text {
                    if !t.is_empty() {
                        sink.push(SubtitleEvent::Partial(t.clone()));
                        pending.push_str(t);
                    }
                }
            }
            QwenEvent::TranscriptionText { text, stash } => {
                if let Some(s) = text.as_deref().or(stash.as_deref()) {
                    accumulate(s, sink, pending);
                }
            }
            QwenEvent::Completed { transcript } => {
                finalize_sentence(transcript.as_deref().unwrap_or("").trim(), sink, pending);
            }
            QwenEvent::Error { error } => {
                warn!(?error, "qwen error event");
            }
            _ => {}
        }
    } else {
        // ---- 译文通道：livetranslate 同传翻译 ----
        match ev {
            QwenEvent::ResponseTextDelta { delta } | QwenEvent::AudioTranscriptDelta { delta } => {
                if let Some(d) = delta {
                    if !d.is_empty() {
                        sink.push(SubtitleEvent::Partial(d.clone()));
                        pending.push_str(d);
                    }
                }
            }
            QwenEvent::ResponseTextText { text, stash }
            | QwenEvent::AudioTranscriptText { text, stash } => {
                if let Some(s) = text.as_deref().or(stash.as_deref()) {
                    accumulate(s, sink, pending);
                }
            }
            QwenEvent::ResponseTextDone { text } | QwenEvent::AudioTranscriptDone { text } => {
                finalize_sentence(text.as_deref().unwrap_or("").trim(), sink, pending);
            }
            QwenEvent::Error { error } => {
                warn!(?error, "qwen error event");
            }
            _ => {}
        }
    }
  }

  /// 服务端发来的文本 s 是「到目前为稳定的累积内容」。若它是在我们已显示
  /// 文本上的增长就只推新增；若服务器重开一轮（新的 commit / 修正）就把
  /// 上一句收尾，再用 s 新起一行。
  fn accumulate(s: &str, sink: &SubtitleSink, pending: &mut String) {
    if s.starts_with(pending.as_str()) {
        let pc = pending.chars().count();
        let suffix: String = s.chars().skip(pc).collect();
        if !suffix.is_empty() {
            sink.push(SubtitleEvent::Partial(suffix));
            *pending = s.to_string();
        }
    } else if pending.is_empty() {
        // 新一句的起点。
        sink.push(SubtitleEvent::Partial(s.to_string()));
        *pending = s.to_string();
    } else {
        // 服务器切换到了新的一轮：先收尾上一句，再开新行显示 s。
        sink.push(SubtitleEvent::Final(pending.clone()));
        *pending = s.to_string();
        sink.push(SubtitleEvent::Partial(s.to_string()));
    }
  }

  /// 一轮结果收尾：优先用服务端给的完整文本（可能修正/补全 partial），
  /// 否则用我们累积的文本。收尾后清空 pending。
  fn finalize_sentence(s: &str, sink: &SubtitleSink, pending: &mut String) {
    if !s.is_empty() {
        sink.push(SubtitleEvent::Final(s.to_string()));
    } else if !pending.is_empty() {
        sink.push(SubtitleEvent::Final(pending.clone()));
    }
    pending.clear();
  }
}

// ---------- OpenAI realtime ----------

pub mod openai {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://api.openai.com/v1/realtime";

    pub struct OpenAiRealtime {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl OpenAiRealtime {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.is_empty() {
                return Err(anyhow!("API key 为空，请先在管理面板填写"));
            }
            if endpoint.starts_with("http:") || endpoint.starts_with("https:") {
                return Err(anyhow!(
                    "Base URL 必须是 WebSocket 地址（wss://...），当前填的是 HTTP 接口：{endpoint}"
                ));
            }
            Ok(Self { cfg, endpoint })
        }
    }

    #[async_trait]
    impl LlmProvider for OpenAiRealtime {
        fn name(&self) -> &'static str {
            "openai-realtime"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let url = format!("{}?model={}", self.endpoint, self.cfg.model);
            let mut req = url.into_client_request()?;
            req.headers_mut().insert(
                "Authorization",
                http::HeaderValue::from_str(&format!("Bearer {}", self.cfg.api_key))?,
            );
            req.headers_mut()
                .insert("OpenAI-Beta", http::HeaderValue::from_static("realtime=v1"));

            let (ws, _) = tokio_tungstenite::connect_async(req)
                .await
                .map_err(|e| ws_connect_error(e, "连接 OpenAI 兼容实时服务"))?;
            let (mut write_half, mut read_half) = ws.split();
            // Build the session config carefully:
            //   * `turn_detection: server_vad` — with null the server never
            //     auto-commits the audio buffer, so no transcript ever comes
            //     out unless the client sends manual commits (we don't).
            //   * `instructions` only when the user configured a system
            //     prompt: pure ASR models (qwen-audio-*, qwen3-asr-* on the
            //     DashScope compatible-mode endpoint) reject or ignore it,
            //     and forcing an interpreter prompt there breaks the session.
            let mut session_cfg = serde_json::json!({
                "modalities": ["text"],
                "input_audio_format": "pcm16",
                "turn_detection": { "type": "server_vad" }
            });
            if let Some(prompt) = self.cfg.system_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
                session_cfg["instructions"] = serde_json::Value::String(prompt.to_string());
            }
            // 实时字幕模式：开启「用户语音转写」通道（OpenAI / GLM 等 OpenAI
            // 兼容 realtime）。OpenAI 官方端点默认用 gpt-4o-mini-transcribe；
            // 其它厂商（如 GLM）没有明确子模型名时先用会话主模型名试探。
            let transcribe_mode = self.cfg.transcribe;
            if transcribe_mode {
                let default_tm = if self.endpoint.to_lowercase().contains("api.openai.com") {
                    "gpt-4o-mini-transcribe".to_string()
                } else {
                    self.cfg.model.clone()
                };
                let tm = {
                    let m = self.cfg.transcription_model.trim().to_string();
                    if m.is_empty() { default_tm } else { m }
                };
                session_cfg["input_audio_transcription"] = serde_json::json!({ "model": tm });
            }
            write_half.send(Message::Text(
                serde_json::json!({ "type": "session.update", "session": session_cfg })
                    .to_string()
                    .into(),
            ))
            .await?;

            let read = {
                let sink = sink.clone();
                async move {
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        if let Message::Text(t) = msg {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                                match v.get("type").and_then(|s| s.as_str()).unwrap_or("") {
                                    "conversation.item.input_audio_transcription.delta" => {
                                        if let Some(d) = v.get("delta").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Partial(d.to_string()));
                                        }
                                    }
                                    "conversation.item.input_audio_transcription.completed" => {
                                        if let Some(d) = v.get("transcript").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Final(d.to_string()));
                                        }
                                    }
                                    // 字幕模式：忽略模型自己的回复文本，只显示说话人转写。
                                    "response.text.delta" if !transcribe_mode => {
                                        if let Some(d) = v.get("delta").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Partial(d.to_string()));
                                        }
                                    }
                                    "response.text.done" if !transcribe_mode => {
                                        if let Some(d) = v.get("text").and_then(|s| s.as_str()) {
                                            sink.push(SubtitleEvent::Final(d.to_string()));
                                        }
                                    }
                                    "error" => {
                                        warn!(payload=%t, "openai error event");
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            };

            let write = async move {
                while let Some(chunk) = audio_rx.recv().await {
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let msg = serde_json::json!({
                        "type": "input_audio_buffer.append",
                        "audio": b64,
                    });
                    if write_half.send(Message::Text(msg.to_string().into())).await.is_err() {
                        break;
                    }
                }
            };

            tokio::select! {
                _ = read => {}
                _ = write => {}
            }
            Ok(())
        }
    }
}

// ---------- Mock ----------

pub mod mock {
    use super::*;
    use tokio::time::{sleep, Duration};

    pub struct MockProvider {
        cfg: LlmConfig,
    }
    impl MockProvider {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            Ok(Self { cfg })
        }
    }
    #[async_trait]
    impl LlmProvider for MockProvider {
        fn name(&self) -> &'static str {
            "mock"
        }
        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let phrases = [
                ("Hello everyone, welcome to the stream.", "大家好，欢迎来到直播间。"),
                ("Today we are testing the real-time subtitle plugin.", "今天我们正在测试实时字幕插件。"),
                ("If you can see this, everything is working.", "如果你能看到这行字，说明一切正常工作。"),
                ("Now switching to English. Please listen carefully.", "现在切换到英文，请仔细听。"),
                ("本句是中文，应当原样输出。", "本句是中文，应当原样输出。"),
            ];
            let mut i = 0;
            while audio_rx.recv().await.is_some() {
                let (src, zh) = &phrases[i % phrases.len()];
                let output = if self.cfg.translate_chinese { zh } else { src };
                sink.push(SubtitleEvent::Partial(output.to_string()));
                sleep(Duration::from_millis(900)).await;
                sink.push(SubtitleEvent::Final(output.to_string()));
                i += 1;
            }
            Ok(())
        }
    }
}

// ---------- Helpers shared by providers ----------

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ProviderCapabilities {
    pub supports_streaming_transcript: bool,
    pub sample_rate: u32,
}