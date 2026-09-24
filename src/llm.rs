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
        "qwen-realtime" => {
            // asr-flash-message / asr-flash-streaming / fun-asr-realtime 走
            // DashScope 双工协议（/api-ws/v1/inference），其余走 /realtime。
            if qwen::is_duplex_model(&cfg.model) {
                Ok(Arc::new(qwen_duplex::QwenDuplex::new(cfg.clone())?))
            } else {
                Ok(Arc::new(qwen::QwenRealtime::new(cfg.clone())?))
            }
        }
        "openai-realtime" => Ok(Arc::new(openai::OpenAiRealtime::new(cfg.clone())?)),
        "fun-asr-realtime" => Ok(Arc::new(funasr::FunAsr::new(cfg.clone())?)),
        // 第三方实时语音服务
        "gemini-live" => Ok(Arc::new(gemini::GeminiLive::new(cfg.clone())?)),
        "deepgram" => Ok(Arc::new(deepgram::DeepgramLive::new(cfg.clone())?)),
        "assemblyai" => Ok(Arc::new(assemblyai::AssemblyAiLive::new(cfg.clone())?)),
        // 国内厂商
        "volc-asr" => Ok(Arc::new(volc::VolcAsr::new(cfg.clone())?)),
        "xfyun-rtasr" => Ok(Arc::new(xfyun::XfRtasr::new(cfg.clone())?)),
        "mock" => Ok(Arc::new(mock::MockProvider::new(cfg.clone())?) as Arc<dyn LlmProvider>),
        other => Err(anyhow!("unknown LLM provider `{other}`")),
    }
}

/// 把「累积型」文本（服务端每次都发到目前为稳定的全文）diff 成字幕增量：
/// 是上一段的延长就只推新增部分；服务器换了一轮就先收尾上一句、再新起一行。
fn push_cumulative(s: &str, sink: &SubtitleSink, pending: &mut String) {
    let s = s.trim_end();
    if s.is_empty() {
        return;
    }
    if s.starts_with(pending.as_str()) {
        let pc = pending.chars().count();
        let suffix: String = s.chars().skip(pc).collect();
        if !suffix.is_empty() {
            sink.push(SubtitleEvent::Partial(suffix));
            *pending = s.to_string();
        }
    } else if pending.is_empty() {
        sink.push(SubtitleEvent::Partial(s.to_string()));
        *pending = s.to_string();
    } else {
        sink.push(SubtitleEvent::Final(pending.clone()));
        *pending = s.to_string();
        sink.push(SubtitleEvent::Partial(s.to_string()));
    }
}

/// 往 WebSocket URL 追加查询参数，但**已经出现过的键不重复添加** ——
/// 高级用户可以在 Base URL 里手工写 `?language=zh&model=xxx` 覆盖默认值。
fn with_query_params(url: &str, params: &[(&str, &str)]) -> String {
    let mut out = url.trim_end_matches(['?', '&']).to_string();
    for (k, v) in params {
        if v.is_empty() || out.contains(&format!("{k}=")) {
            continue;
        }
        out.push(if out.contains('?') { '&' } else { '?' });
        out.push_str(k);
        out.push('=');
        out.push_str(v);
    }
    out
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
            // 用户可能在两条通道之间切换模型而沿用了另一条的地址：自动纠正。
            let endpoint = endpoint.replace("/inference", "/realtime");
            if cfg.api_key.is_empty() {
                return Err(anyhow!("Qwen API key is empty; please fill it in the admin panel"));
            }
            // 离线「录音文件识别(filetrans)」是 HTTP 批处理接口，不是实时流，
            // 不能用于直播字幕，直接给出明确提示。
            if cfg.model.to_lowercase().contains("filetrans") {
                return Err(anyhow!(
                    "模型 {} 是离线「录音文件识别(Filetrans)」HTTP 接口，不能用于实时字幕。实时请用：qwen3.8-livetranslate-flash-realtime（同传翻译）、qwen-audio-3.1-realtime-plus / qwen3.8-omni-flash-realtime（实时语音）、qwen3-asr-flash-realtime 或 qwen-audio-3.1-asr-flash-message（实时识别）。",
                    cfg.model
                ));
            }
            // 名字里没有 realtime 的多半是 HTTP 接口（如 qwen-audio-3.1-asr-flash），
            // 不能走 WebSocket 实时流。
            if !cfg.model.to_lowercase().contains("realtime") {
                return Err(anyhow!(
                    "模型 {} 不是 Realtime 实时模型（可能是 HTTP 接口），无法用于实时字幕。请选择名字里带 realtime 的实时语音模型。",
                    cfg.model
                ));
            }
            Ok(Self { cfg, endpoint })
        }
    }

    /// 判断模型是否走 DashScope「双工实时识别」协议（/api-ws/v1/inference），
    /// 例如 qwen-audio-3.1-asr-flash-message / -streaming / fun-asr-realtime。
    /// 这类模型由 `qwen_duplex` provider 处理，而不是 /realtime。
    pub fn is_duplex_model(model: &str) -> bool {
        let m = model.to_lowercase();
        m.contains("asr-flash-message")
            || m.contains("asr-flash-streaming")
            || m.contains("fun-asr-realtime")
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
            let model_lc = self.cfg.model.to_lowercase();
            // 模型家族：新版 Qwen 语音模型的会话 schema 有差异，按家族分别配置。
            //   * livetranslate：同传翻译，译文走 response.*，需要 translation.language
            //   * omni：全模态实时，用 audio.input.format 新字段，转写需显式开启
            //   * realtime-plus / audio 对话模型：转写事件无条件下发，不能乱发
            //     input_audio_transcription
            //   * asr-*-realtime：纯识别模型，需要 input_audio_transcription 指到自己
            let is_translation = model_lc.contains("livetranslate");
            let is_omni = model_lc.contains("omni");
            let is_audio_chat = !is_translation
                && !is_omni
                && (model_lc.contains("realtime-plus")
                    || (model_lc.contains("audio") && model_lc.contains("realtime")));
            let needs_asr_cfg = !is_translation
                && !is_omni
                && !is_audio_chat
                && model_lc.contains("asr");
            // 通道隔离用：非翻译模型只看「说话人转写」通道。
            let asr_mode = !is_translation;

            let segment_ms = self.cfg.segment_ms;
            // 低延迟模式（segment_ms > 0）= 手动模式：关掉服务端 VAD，由本机按段提交。
            // 文档确认：turn_detection 置 null 即 push-to-talk 手动模式
            // （仅首次音频之前可改）。
            let manual_mode = segment_ms > 0;
            let turn_detection = if manual_mode {
                serde_json::Value::Null
            } else {
                serde_json::json!({ "type": "server_vad" })
            };

            // qwen3.8 同传的会话 schema 与 3.5 不同（依据官方「客户端事件」文档）：
            //   * 输出模态用顶层 output_modalities（3.5 才是 modalities）
            //   * 语音检测在 audio.input.turn_detection（3.5 是顶层 turn_detection）
            //   * 顶层 input_audio_format / sample_rate / modalities 未标注适用于 3.8
            // 因此 3.8 单独走一个最小会话，避免下发它不认识的字段导致会话直接失败。
            let is_lt38 = is_translation && model_lc.contains("qwen3.8");
            let session = if is_lt38 {
                serde_json::json!({
                    "type": "session.update",
                    "session": {
                        "output_modalities": ["text"],
                        "translation": { "language": self.cfg.target_lang },
                        "audio": {
                            "input": {
                                "turn_detection": { "type": "server_vad" }
                            }
                        }
                    }
                })
            } else {
                let mut session_cfg = serde_json::Map::new();
                session_cfg.insert("modalities".into(), serde_json::json!(["text"]));
                session_cfg.insert("turn_detection".into(), turn_detection);
                if is_omni {
                    // 3.5/3.8 Omni 推荐的新字段（旧字段仍兼容，但 3.8 要求首段音频前配置）。
                    session_cfg.insert(
                        "audio".into(),
                        serde_json::json!({
                            "input":  { "format": { "type": "pcm", "sample_rate": 16000 } },
                            "output": { "format": { "type": "pcm", "sample_rate": 24000 } }
                        }),
                    );
                } else {
                    session_cfg.insert("input_audio_format".into(), serde_json::json!("pcm"));
                    session_cfg.insert("sample_rate".into(), serde_json::json!(16000));
                }
                if is_translation {
                    session_cfg.insert(
                        "translation".into(),
                        serde_json::json!({ "language": self.cfg.target_lang }),
                    );
                    // 沿用 3.5 的行为：显式关闭输入转写，只保留译文流。
                    session_cfg
                        .insert("input_audio_transcription".into(), serde_json::Value::Null);
                } else if is_omni {
                    // Omni 的「说话人转写」需要显式开启，子模型用标准实时 ASR。
                    session_cfg.insert(
                        "input_audio_transcription".into(),
                        serde_json::json!({ "model": "qwen3-asr-flash-realtime" }),
                    );
                } else if needs_asr_cfg {
                    session_cfg.insert(
                        "input_audio_transcription".into(),
                        serde_json::json!({ "model": self.cfg.model }),
                    );
                }
                serde_json::json!({
                    "type": "session.update",
                    "session": serde_json::Value::Object(session_cfg)
                })
            };
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
            //   * segment_ms > 0（低延迟模式）：切到手动模式（会话里关掉服务端
            //     VAD），本机按段收集「正在说的语音」并 input_audio_buffer.commit，
            //     由客户端 commit 触发识别/翻译，字幕按段推进。
            //     手动模式下**只把说话的音频**放进缓冲区：段与段之间的静音不塞
            //     进去，否则下次提交会变成一大段空白音频（延迟暴涨、还容易幻觉）。
            //
            // 手动模式下两个通道的差别：
            //   * ASR/转写通道：commit 即出识别结果，不需要触发模型生成；
            //   * 同传翻译通道：译文属于模型的 response，提交后补一个
            //     response.create 确保产出（若服务端已自动产出，overlay 的
            //     重复句检测会兜掉多余的一句）。
            let translation_channel = !asr_mode;
            let write = async move {
                // 3.8 同传没有文档化的手动模式（会话走 server_vad + 自带增量输出），
                // 此时忽略低延迟分段，避免往 server_vad 会话里乱发 commit。
                let commit_enabled = segment_ms > 0 && !is_lt38;
                let mut voiced_ms: u64 = 0; // 当前这段里已累计的有声时长(ms)
                let mut tail_ms: u64 = 0; // 有声之后跟随的静音时长(ms)
                let mut in_segment = false; // 是否正在收集一段语音（手动模式用）

                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let ms = (chunk.len() as u64) * 1000 / 16_000;
                    let voiced = crate::vad::rms(&chunk) >= 0.008;

                    if commit_enabled {
                        if voiced {
                            if !in_segment {
                                in_segment = true;
                                voiced_ms = 0;
                                tail_ms = 0;
                            }
                            voiced_ms = voiced_ms.saturating_add(ms);
                            tail_ms = 0;
                        } else if in_segment {
                            tail_ms = tail_ms.saturating_add(ms);
                        }
                        // 非说话期间（两段之间）不往缓冲区里塞音频。
                        if !in_segment {
                            continue;
                        }
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

                    if voiced && voiced_ms >= segment_ms {
                        // 说满一段就提交（人还在说，段内继续累计下一段）。
                        let cm = serde_json::json!({ "type": "input_audio_buffer.commit" });
                        if write_half
                            .send(Message::Text(cm.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if translation_channel {
                            let rc = serde_json::json!({ "type": "response.create" });
                            if write_half
                                .send(Message::Text(rc.to_string().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        voiced_ms = 0;
                        tail_ms = 0;
                    } else if tail_ms >= 400 {
                        // 说完（尾静音够长）收尾提交这段，然后停止收集等下一段。
                        let cm = serde_json::json!({ "type": "input_audio_buffer.commit" });
                        if write_half
                            .send(Message::Text(cm.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        if translation_channel {
                            let rc = serde_json::json!({ "type": "response.create" });
                            if write_half
                                .send(Message::Text(rc.to_string().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                        voiced_ms = 0;
                        tail_ms = 0;
                        in_segment = false;
                    }
                }
                // 会话结束前把没提交完的尾巴交出去。
                if commit_enabled && in_segment {
                    let cm = serde_json::json!({ "type": "input_audio_buffer.commit" });
                    let _ = write_half
                        .send(Message::Text(cm.to_string().into()))
                        .await;
                    if translation_channel {
                        let rc = serde_json::json!({ "type": "response.create" });
                        let _ = write_half
                            .send(Message::Text(rc.to_string().into()))
                            .await;
                    }
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
        /// 旧版模型：`text` 是新增片段；新版（Omni 等）：`text` 是「已确认前缀」、
        /// `stash` 是「待确认后缀」，需要做前缀差分而不是直接追加。
        #[serde(rename = "conversation.item.input_audio_transcription.delta")]
        TranscriptionDelta {
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            stash: Option<String>,
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
            QwenEvent::TranscriptionDelta { text, stash } => {
                if let Some(t) = text {
                    if !t.is_empty() {
                        if stash.is_some() {
                            // 新版语义：text 是「已确认前缀」→ 只推新增部分。
                            accumulate(t, sink, pending);
                        } else {
                            // 旧版语义：text 就是新增片段 → 直接追加。
                            sink.push(SubtitleEvent::Partial(t.clone()));
                            pending.push_str(t);
                        }
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

// ---------- DashScope 双工实时识别（/api-ws/v1/inference） ----------
// 承载：qwen-audio-3.1-asr-flash-message / qwen-audio-3.x-asr-flash-streaming /
// fun-asr-realtime。协议与 /realtime 不同：
//   1) 发送 run-task（header.action=run-task，payload 带 task_group/task/function/
//      model/parameters/input）
//   2) 持续发送 16k 单声道 s16le PCM 二进制帧
//   3) 发 finish-task 收尾
// 服务端回 result-generated（payload.output.sentence.text / sentence_end）等事件。

pub mod qwen_duplex {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

    pub struct QwenDuplex {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl QwenDuplex {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            // 双工识别通道：若沿用了 /realtime 地址则自动换成 /inference。
            let endpoint = endpoint.replace("/realtime", "/inference");
            if cfg.api_key.is_empty() {
                return Err(anyhow!(
                    "Qwen API key is empty; please fill it in the admin panel"
                ));
            }
            Ok(Self { cfg, endpoint })
        }
    }

    #[async_trait]
    impl LlmProvider for QwenDuplex {
        fn name(&self) -> &'static str {
            "qwen-duplex"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let mut req = self
                .endpoint
                .clone()
                .into_client_request()
                .with_context(|| "build dashscope duplex ws request")?;
            req.headers_mut().insert(
                "Authorization",
                http::HeaderValue::from_str(&format!("Bearer {}", self.cfg.api_key))?,
            );
            req.headers_mut().insert(
                "X-DashScope-DataInspection",
                http::HeaderValue::from_static("disable"),
            );
            let (ws, _resp) = tokio_tungstenite::connect_async(req)
                .await
                .map_err(|e| ws_connect_error(e, "连接 DashScope 实时识别服务"))?;
            let (mut write_half, mut read_half) = ws.split();

            let task_id = uuid::Uuid::new_v4().to_string();
            let mut params = serde_json::json!({ "format": "pcm", "sample_rate": 16000 });
            // 该模型独有的「中间结果」开关：打开才有边说边出的 partial。
            if self.cfg.model.to_lowercase().contains("asr-flash-message") {
                params["intermediate_result_enabled"] = serde_json::json!(true);
            }
            let run_task = serde_json::json!({
                "header": {
                    "action": "run-task",
                    "task_id": task_id.clone(),
                    "streaming": "duplex"
                },
                "payload": {
                    "task_group": "audio",
                    "task": "asr",
                    "function": "recognition",
                    "model": self.cfg.model,
                    "parameters": params,
                    "input": {}
                }
            });
            write_half
                .send(Message::Text(run_task.to_string().into()))
                .await
                .map_err(|e| anyhow!("发送 run-task 失败：{e}"))?;

            let read = {
                let sink = sink.clone();
                async move {
                    // 当前句已显示的文本（用于把中间结果做前缀差分）。
                    let mut seg = String::new();
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        let Message::Text(t) = msg else { continue };
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                            continue;
                        };
                        let event = v
                            .get("header")
                            .and_then(|h| h.get("event"))
                            .and_then(|e| e.as_str())
                            .unwrap_or("");
                        match event {
                            "result-generated" => {
                                let sentence = v
                                    .get("payload")
                                    .and_then(|p| p.get("output"))
                                    .and_then(|o| o.get("sentence"));
                                let text = sentence
                                    .and_then(|s| s.get("text"))
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("");
                                if text.trim().is_empty() {
                                    continue;
                                }
                                let end = sentence
                                    .and_then(|s| s.get("sentence_end"))
                                    .and_then(|b| b.as_bool())
                                    .unwrap_or(false);
                                if end {
                                    sink.push(SubtitleEvent::Final(text.trim().to_string()));
                                    seg.clear();
                                } else if text.starts_with(seg.as_str()) {
                                    let pc = seg.chars().count();
                                    let suffix: String = text.chars().skip(pc).collect();
                                    if !suffix.is_empty() {
                                        sink.push(SubtitleEvent::Partial(suffix));
                                        seg = text.to_string();
                                    }
                                } else {
                                    if !seg.is_empty() {
                                        sink.push(SubtitleEvent::Final(seg.clone()));
                                    }
                                    seg = text.to_string();
                                    sink.push(SubtitleEvent::Partial(text.to_string()));
                                }
                            }
                            "task-finished" => {
                                info!("dashscope duplex task finished");
                            }
                            "task-failed" => {
                                let msg = v
                                    .get("header")
                                    .and_then(|h| h.get("error_message"))
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("");
                                warn!(error=%msg, "dashscope duplex task failed");
                            }
                            _ => {}
                        }
                    }
                }
            };

            let task_id_write = task_id.clone();
            let write = async move {
                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    if write_half
                        .send(Message::Binary(bytes.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                let finish = serde_json::json!({
                    "header": { "action": "finish-task", "task_id": task_id_write },
                    "payload": { "input": {} }
                });
                let _ = write_half
                    .send(Message::Text(finish.to_string().into()))
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
}

// ---------- OpenAI realtime ----------

pub mod openai {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://api.openai.com/v1/realtime";

    pub struct OpenAiRealtime {
        cfg: LlmConfig,
        endpoint: String,
        /// Azure OpenAI：鉴权用 `api-key` 头，且 URL 自带 api-version /
        /// deployment 查询参数（不能再追加 `?model=`）。
        is_azure: bool,
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
            let lower = endpoint.to_lowercase();
            let is_azure = lower.contains("openai.azure.com") || lower.contains(".azure.com");
            Ok(Self {
                cfg,
                endpoint,
                is_azure,
            })
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
            // Azure 的地址由用户整条粘贴（含 api-version / deployment），
            // 已经带查询串就不再加 `?model=`；OpenAI 等其它端点按惯例追加模型名。
            let url = if self.endpoint.contains('?') {
                self.endpoint.clone()
            } else {
                format!("{}?model={}", self.endpoint, self.cfg.model)
            };
            let mut req = url.into_client_request()?;
            if self.is_azure {
                // Azure：api-key 头；Authorization: Bearer <key> 会被拒。
                req.headers_mut().insert(
                    "api-key",
                    http::HeaderValue::from_str(self.cfg.api_key.trim())?,
                );
            } else {
                req.headers_mut().insert(
                    "Authorization",
                    http::HeaderValue::from_str(&format!("Bearer {}", self.cfg.api_key))?,
                );
                req.headers_mut()
                    .insert("OpenAI-Beta", http::HeaderValue::from_static("realtime=v1"));
            }

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
            // 低延迟模式 = 手动模式：关掉服务端 VAD，改由本机按段 commit 触发识别。
            // 否则服务端只按自己的判定提交（等一句话说完），客户端 commit 会被忽略。
            if self.cfg.segment_ms > 0 {
                session_cfg["turn_detection"] = serde_json::Value::Null;
            }
            // 实时字幕模式：开启「用户语音转写」通道（OpenAI / GLM 等 OpenAI
            // 兼容 realtime）。OpenAI 官方端点默认用 gpt-4o-mini-transcribe；
            // 其它厂商（如 GLM）没有明确子模型名时先用会话主模型名试探。
            // 实时字幕模式：仅当非「本机网关模式」时生效——网关（如
            // huggingface/speech-to-speech 这类本地 OpenAI Realtime 兼容服务）
            // 直接把要显示的字幕文字经 response.text.* 返回，不需要再等
            // input_audio_transcription 事件。
            let transcribe_mode = self.cfg.transcribe && !self.cfg.gateway_text;
            let segment_ms = self.cfg.segment_ms;
            let gateway_text = self.cfg.gateway_text;
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
            // GA「听录会话」：gpt-live-transcribe / gpt-realtime-whisper 这类
            // 新模型只在 GA 事件模型下可用 —— session.type = transcription，
            // 音频配置放在嵌套的 audio.input.*，采样率 24kHz。旧模型
            // （gpt-realtime / gpt-4o-realtime…）保持上面的 legacy 结构，互不影响。
            let model_lc = self.cfg.model.to_lowercase();
            let ga_transcribe = model_lc.contains("live-transcribe")
                || model_lc.contains("realtime-whisper")
                || (model_lc.starts_with("gpt-") && model_lc.contains("transcribe"));
            let session = if ga_transcribe {
                let tm = if self.cfg.transcription_model.trim().is_empty() {
                    self.cfg.model.clone()
                } else {
                    self.cfg.transcription_model.trim().to_string()
                };
                let turn = if segment_ms > 0 {
                    // 低延迟：手动提交（none），由本机按段 commit。
                    serde_json::json!({ "type": "none" })
                } else {
                    serde_json::json!({ "type": "server_vad" })
                };
                serde_json::json!({
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {
                            "input": {
                                "format": { "type": "audio/pcm", "rate": 24000 },
                                "transcription": { "model": tm },
                                "turn_detection": turn
                            }
                        }
                    }
                })
            } else {
                serde_json::json!({ "type": "session.update", "session": session_cfg })
            };
            write_half
                .send(Message::Text(session.to_string().into()))
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
                                    // 只显示「说话人的转写」（input_audio_transcription.*）。
                                    // response.text.* 是模型自己的回复（AI 自言自语），
                                    // 不是讲述人讲的话，一律不作为字幕显示。
                                    "response.text.delta" | "response.text.done" => {
                                        debug!(payload=%t, "ignored assistant text (not speaker speech)");
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
                // OpenAI / Azure realtime 的 pcm16 约定为 24kHz，而本机管线交给
                // provider 的是 16kHz；不上采样会被服务端按 24k 解释（语速×1.5、
                // 识别率明显下降）。这里对 OpenAI 家族做一次 16k→24k 上采样。
                let upsample = self.is_azure
                    || self.endpoint.to_lowercase().contains("api.openai.com");
                // 分段 commit（低延迟用）。只提交音频缓冲区：字幕走的是「说话人转写」
                // 通道，不发送 response.create —— 那会触发模型生成 AI 回复，
                // 字幕就会变成 AI 的自言自语。
                macro_rules! do_commit {
                    () => {{
                        let c = serde_json::json!({ "type": "input_audio_buffer.commit" });
                        if write_half.send(Message::Text(c.to_string().into())).await.is_err() {
                            break;
                        }
                    }};
                }

                let commit_enabled = segment_ms > 0;
                let mut voiced_ms: u64 = 0; // 当前这段里已累计的有声时长(ms)
                let mut tail_ms: u64 = 0; // 有声之后跟随的静音时长(ms)
                let mut in_segment = false; // 是否正在收集一段语音（手动模式用）

                while let Some(chunk) = audio_rx.recv().await {
                    let ms = (chunk.len() as u64) * 1000 / 16_000;
                    let voiced = crate::vad::rms(&chunk) >= 0.008;

                    if commit_enabled {
                        if voiced {
                            if !in_segment {
                                in_segment = true;
                                voiced_ms = 0;
                                tail_ms = 0;
                            }
                            voiced_ms = voiced_ms.saturating_add(ms);
                            tail_ms = 0;
                        } else if in_segment {
                            tail_ms = tail_ms.saturating_add(ms);
                        }
                        // 非说话期间（两段之间）不往缓冲区里塞音频。
                        if !in_segment {
                            continue;
                        }
                    }

                    // 需要时先上采样到 24kHz 再编码（上面算毫秒用的是原始 16k 数据）。
                    let pcm: Vec<i16> = if upsample {
                        crate::audio::resample_mono(&chunk, 16_000, 24_000)
                    } else {
                        chunk.clone()
                    };
                    let mut bytes = Vec::with_capacity(pcm.len() * 2);
                    for s in &pcm {
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

                    if voiced && voiced_ms >= segment_ms {
                        do_commit!();
                        voiced_ms = 0;
                        tail_ms = 0;
                    } else if tail_ms >= 400 {
                        do_commit!();
                        voiced_ms = 0;
                        tail_ms = 0;
                        in_segment = false;
                    }
                }
                // 会话结束前把尾巴交出去。
                if commit_enabled && in_segment {
                    let c = serde_json::json!({ "type": "input_audio_buffer.commit" });
                    let _ = write_half.send(Message::Text(c.to_string().into())).await;
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

// ---------- FunASR 本地流式识别 ----------
// 适配阿里 FunASR 私有化部署的实时识别 WebSocket 服务（funasr-wss 风格的
// Docker 一键部署：启动后默认 ws://127.0.0.1:10095，服务端已加载 SenseVoice /
// Fun-ASR-Nano / Paraformer 等流式模型）。协议与 OpenAI Realtime 不同：
//   1) 先发一段 JSON 起始消息（mode=2pass、chunk_size、is_speaking=true…）
//   2) 之后持续发送 16k 单声道 s16le PCM 二进制帧
//   3) 说话结束：发 {"is_speaking": false} 触发服务端出该句最终文本
// 服务端回 JSON：mode 含 online/2pass 的中间结果（text）、offline 的最终结果
// （text / is_final）。本 provider 把中间结果按增量显示为字幕、最终结果收尾。

pub mod funasr {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "ws://127.0.0.1:10095";

    pub struct FunAsr {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl FunAsr {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if !endpoint.starts_with("ws://") && !endpoint.starts_with("wss://") {
                return Err(anyhow!(
                    "FunASR 端点必须是 WebSocket 地址，例如 ws://127.0.0.1:10095"
                ));
            }
            Ok(Self { cfg, endpoint })
        }
    }

    #[async_trait]
    impl LlmProvider for FunAsr {
        fn name(&self) -> &'static str {
            "fun-asr-realtime"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let url = self.endpoint.clone();
            let (ws, _resp) = tokio_tungstenite::connect_async(url)
                .await
                .map_err(|e| anyhow!("连接 FunASR 服务失败：{e}"))?;
            let (mut write_half, mut read_half) = ws.split();

            // 起始配置：2pass 模式 = 说话过程中实时给中间结果，语音段结束给最终结果。
            // chunk_size=[5,10,5] 是常见实时配置（5*10ms 前/后文+10*10ms 主块）。
            let start = serde_json::json!({
                "mode": "2pass",
                "chunk_size": [5, 10, 5],
                "wav_name": "stream-live-translate",
                "is_speaking": true,
                "itn": true
            });
            write_half
                .send(Message::Text(start.to_string().into()))
                .await
                .map_err(|e| anyhow!("发送 FunASR 起始消息失败：{e}"))?;

            let sink_read = sink.clone();
            let read = async move {
                let mut seg_partial = String::new(); // 当前句已显示的累计文本
                while let Some(msg) = read_half.next().await {
                    let msg = match msg {
                        Ok(m) => m,
                        Err(e) => {
                            warn!(error=%e, "funasr ws read error");
                            break;
                        }
                    };
                    let Message::Text(t) = msg else { continue };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                        continue;
                    };
                    let mtype = v.get("mode").and_then(|s| s.as_str()).unwrap_or("");
                    let text = v
                        .get("text")
                        .and_then(|s| s.as_str())
                        .or_else(|| {
                            v.get("sentence")
                                .and_then(|s| s.get("text"))
                                .and_then(|s| s.as_str())
                        })
                        .unwrap_or("");
                    if text.trim().is_empty() {
                        continue;
                    }
                    let is_final = mtype.to_lowercase().contains("offline")
                        || mtype.to_lowercase().contains("final")
                        || v.get("is_final").and_then(|b| b.as_bool()).unwrap_or(false);
                    if is_final {
                        // 一句话的最终识别：收尾并进历史。
                        let t = text.trim().to_string();
                        sink_read.push(SubtitleEvent::Final(t));
                        seg_partial.clear();
                    } else {
                        // 中间（在线）结果：只推送相对已显示文本的新增部分。
                        if text.starts_with(seg_partial.as_str()) {
                            let pc = seg_partial.chars().count();
                            let suffix: String = text.chars().skip(pc).collect();
                            if !suffix.is_empty() {
                                sink_read.push(SubtitleEvent::Partial(suffix));
                                seg_partial = text.to_string();
                            }
                        } else {
                            // 服务端另起一段/修正：把上一段收尾，再开新行。
                            if !seg_partial.is_empty() {
                                sink_read.push(SubtitleEvent::Final(seg_partial.clone()));
                            }
                            seg_partial = text.to_string();
                            sink_read.push(SubtitleEvent::Partial(text.to_string()));
                        }
                    }
                }
            };

            let write = async move {
                // 本地能量检测：说话停顿约 450ms 就通知服务端结束一段
                // （{"is_speaking": false}），让 2pass 模式出该句最终文本；再出声就
                // 翻转回 true 开新段。FunASR 服务端先收一段 JSON 起始消息、随后只收
                // 二进制 PCM，期间允许随时插入这种 JSON 控制帧。
                macro_rules! seg_flag {
                    ($sp:expr) => {{
                        let m = serde_json::json!({ "is_speaking": $sp });
                        if write_half
                            .send(Message::Text(m.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }};
                }

                let mut speaking = true;
                let mut silent_ms: u64 = 0;

                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    // 根据语音/静音决定是否需要先翻转 is_speaking。
                    let ms = (chunk.len() as u64) * 1000 / 16_000;
                    let voiced = crate::vad::rms(&chunk) >= 0.008;
                    if voiced {
                        if !speaking {
                            seg_flag!(true);
                            speaking = true;
                        }
                        silent_ms = 0;
                    } else {
                        silent_ms = silent_ms.saturating_add(ms);
                        if speaking && silent_ms >= 450 {
                            seg_flag!(false);
                            speaking = false;
                            silent_ms = 0;
                        }
                    }
                    if write_half
                        .send(Message::Binary(bytes.into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                // 收尾：让服务端出最后一句话的最终文本（循环已结束，忽略发送结果）。
                if speaking {
                    let m = serde_json::json!({ "is_speaking": false });
                    let _ = write_half.send(Message::Text(m.to_string().into())).await;
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

// ---------- Google Gemini Live API ----------

pub mod gemini {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
    const DEFAULT_MODEL: &str = "gemini-2.5-flash-live";

    pub struct GeminiLive {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl GeminiLive {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.trim().is_empty() {
                return Err(anyhow!(
                    "Gemini API Key 为空：请在管理面板填入 Google AI Studio 的 API Key"
                ));
            }
            Ok(Self { cfg, endpoint })
        }

        /// 模型名必须是 Live 系列；用户可能沿用了别的 provider 的模型名。
        fn resolved_model(&self) -> String {
            let m = self.cfg.model.trim();
            if m.to_lowercase().starts_with("gemini") {
                if m.starts_with("models/") {
                    m.to_string()
                } else {
                    format!("models/{m}")
                }
            } else {
                warn!(model = %m, "not a gemini live model; falling back to {DEFAULT_MODEL}");
                format!("models/{DEFAULT_MODEL}")
            }
        }
    }

    #[async_trait]
    impl LlmProvider for GeminiLive {
        fn name(&self) -> &'static str {
            "gemini-live"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            // Live API 用 ?key=<api_key> 鉴权（Google AI Studio）。
            let url = with_query_params(&self.endpoint, &[("key", self.cfg.api_key.trim())]);
            let req = url.into_client_request()?;
            let (ws, _) = tokio_tungstenite::connect_async(req)
                .await
                .map_err(|e| ws_connect_error(e, "连接 Gemini Live API"))?;
            let (mut write_half, mut read_half) = ws.split();

            // setup：只要文本输出（本插件只做字幕，不需要 TTS 音频），
            // 并打开「说话人转写」通道。
            let mut setup = serde_json::json!({
                "model": self.resolved_model(),
                "generationConfig": { "responseModalities": ["TEXT"] },
                "inputAudioTranscription": {},
            });
            if let Some(p) = self
                .cfg
                .system_prompt
                .as_deref()
                .filter(|p| !p.trim().is_empty())
            {
                setup["systemInstruction"] = serde_json::json!({ "parts": [{ "text": p }] });
            }
            write_half
                .send(Message::Text(
                    serde_json::json!({ "setup": setup }).to_string().into(),
                ))
                .await?;
            info!(model = %self.cfg.model, "gemini live session opened");

            // 翻译型 Live 模型（…live-translate…）的译文走 outputTranscription；
            // 其余模型只做「说话人转写」，两者互斥以免字幕混入模型自己的话。
            let show_output = self.cfg.model.to_lowercase().contains("translate");

            let read = {
                let sink = sink.clone();
                async move {
                    let mut pending = String::new();
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        let text = match msg {
                            Message::Text(t) => t.to_string(),
                            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
                            _ => continue,
                        };
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
                            debug!(payload = %text, "unparsed gemini event");
                            continue;
                        };
                        if let Some(sc) = v.get("serverContent") {
                            if show_output {
                                if let Some(t) = sc
                                    .pointer("/outputTranscription/text")
                                    .and_then(|s| s.as_str())
                                {
                                    push_cumulative(t, &sink, &mut pending);
                                }
                            } else if let Some(t) = sc
                                .pointer("/inputTranscription/text")
                                .and_then(|s| s.as_str())
                            {
                                // Gemini 的输入转写是「增量片段」。
                                if !t.trim().is_empty() {
                                    sink.push(SubtitleEvent::Partial(t.to_string()));
                                    pending.push_str(t);
                                }
                            }
                            if sc.get("interrupted").and_then(|b| b.as_bool()) == Some(true) {
                                pending.clear();
                            }
                            if sc.get("turnComplete").and_then(|b| b.as_bool()) == Some(true) {
                                if !pending.trim().is_empty() {
                                    sink.push(SubtitleEvent::Final(pending.trim().to_string()));
                                }
                                pending.clear();
                            }
                        } else if v.get("goAway").is_some() {
                            warn!("gemini 会话即将被服务端关闭（goAway）");
                        } else if v.get("error").is_some() {
                            warn!(payload = %text, "gemini error event");
                        }
                    }
                }
            };

            let write = async move {
                let mut bytes: Vec<u8> = Vec::new();
                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    bytes.clear();
                    bytes.reserve(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let msg = serde_json::json!({
                        "realtimeInput": {
                            "audio": { "mimeType": "audio/pcm;rate=16000", "data": b64 }
                        }
                    });
                    if write_half
                        .send(Message::Text(msg.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                let _ = write_half
                    .send(Message::Text(
                        serde_json::json!({ "realtimeInput": { "audioStreamEnd": true } })
                            .to_string()
                            .into(),
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
}

// ---------- Deepgram（实时流式转写） ----------

pub mod deepgram {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://api.deepgram.com/v1/listen";

    pub struct DeepgramLive {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl DeepgramLive {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.trim().is_empty() {
                return Err(anyhow!("Deepgram API Key 为空：请在管理面板填写"));
            }
            Ok(Self { cfg, endpoint })
        }

        /// 只接受 Deepgram 的模型名，避免沿用其它 provider 的模型导致 400。
        fn resolved_model(&self) -> String {
            let m = self.cfg.model.trim();
            let lc = m.to_lowercase();
            if lc.starts_with("nova") || lc.contains("whisper") || lc.contains("flux") {
                m.to_string()
            } else {
                "nova-3".to_string()
            }
        }
    }

    #[async_trait]
    impl LlmProvider for DeepgramLive {
        fn name(&self) -> &'static str {
            "deepgram"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            // 16kHz 单声道 PCM。语言交给 Deepgram 自动识别；想指定语言
            // 可以直接在 Base URL 里写 `?language=zh`（已存在的键不再覆盖）。
            let model = self.resolved_model();
            let url = with_query_params(
                &self.endpoint,
                &[
                    ("model", model.as_str()),
                    ("encoding", "linear16"),
                    ("sample_rate", "16000"),
                    ("channels", "1"),
                    ("interim_results", "true"),
                    ("punctuate", "true"),
                    ("smart_format", "true"),
                    ("endpointing", "300"),
                ],
            );
            let mut req = url.into_client_request()?;
            // Deepgram 用 `Token <key>`（不是 Bearer）。
            req.headers_mut().insert(
                "Authorization",
                http::HeaderValue::from_str(&format!("Token {}", self.cfg.api_key.trim()))?,
            );
            let (ws, _) = tokio_tungstenite::connect_async(req)
                .await
                .map_err(|e| ws_connect_error(e, "连接 Deepgram 实时转写"))?;
            let (mut write_half, mut read_half) = ws.split();
            info!("deepgram live session opened");

            let read = {
                let sink = sink.clone();
                async move {
                    let mut pending = String::new();
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        let Message::Text(t) = msg else { continue };
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                            debug!(payload = %t, "unparsed deepgram event");
                            continue;
                        };
                        match v.get("type").and_then(|s| s.as_str()).unwrap_or("") {
                            "Results" => {
                                let transcript = v
                                    .pointer("/channel/alternatives/0/transcript")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("");
                                let is_final = v
                                    .get("is_final")
                                    .and_then(|b| b.as_bool())
                                    .unwrap_or(false);
                                if is_final {
                                    // 该分句定型：收尾进历史，清空当前行。
                                    if !transcript.trim().is_empty() {
                                        sink.push(SubtitleEvent::Final(
                                            transcript.trim().to_string(),
                                        ));
                                    }
                                    pending.clear();
                                } else {
                                    // 中间结果是「本分句到目前为止」的全文 → 取增量。
                                    push_cumulative(transcript, &sink, &mut pending);
                                }
                            }
                            "UtteranceEnd" => {
                                if !pending.trim().is_empty() {
                                    sink.push(SubtitleEvent::Final(pending.trim().to_string()));
                                }
                                pending.clear();
                            }
                            "Close" => break,
                            "error" => warn!(payload = %t, "deepgram error event"),
                            _ => {}
                        }
                    }
                }
            };

            let write = async move {
                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    if write_half.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                let _ = write_half
                    .send(Message::Text(
                        serde_json::json!({ "type": "CloseStream" })
                            .to_string()
                            .into(),
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
}

// ---------- AssemblyAI（实时流式转写 v3） ----------

pub mod assemblyai {
    use super::*;

    const DEFAULT_ENDPOINT: &str = "wss://streaming.assemblyai.com/v3/ws";

    pub struct AssemblyAiLive {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl AssemblyAiLive {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.trim().is_empty() {
                return Err(anyhow!("AssemblyAI API Key 为空：请在管理面板填写"));
            }
            Ok(Self { cfg, endpoint })
        }

        /// assemblyai 的 speech_model 形如 universal-streaming-english /
        /// universal-3-5-pro；沿用别的 provider 的模型名会被拒，故做白名单。
        fn resolved_model(&self) -> Option<String> {
            let m = self.cfg.model.trim();
            let lc = m.to_lowercase();
            if lc.contains("universal") || lc.contains("slam") {
                Some(m.to_string())
            } else {
                None
            }
        }
    }

    #[async_trait]
    impl LlmProvider for AssemblyAiLive {
        fn name(&self) -> &'static str {
            "assemblyai"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let mut params: Vec<(&str, &str)> = vec![
                ("sample_rate", "16000"),
                ("format_turns", "true"),
            ];
            let model = self.resolved_model();
            if let Some(m) = model.as_deref() {
                params.push(("speech_model", m));
            }
            let url = with_query_params(&self.endpoint, &params);
            let mut req = url.into_client_request()?;
            // v3 用**裸 key**（没有 Bearer 前缀）。
            req.headers_mut().insert(
                "Authorization",
                http::HeaderValue::from_str(self.cfg.api_key.trim())?,
            );
            let (ws, _) = tokio_tungstenite::connect_async(req)
                .await
                .map_err(|e| ws_connect_error(e, "连接 AssemblyAI 实时转写"))?;
            let (mut write_half, mut read_half) = ws.split();
            info!("assemblyai live session opened");

            let read = {
                let sink = sink.clone();
                async move {
                    let mut pending = String::new();
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        let Message::Text(t) = msg else { continue };
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                            debug!(payload = %t, "unparsed assemblyai event");
                            continue;
                        };
                        match v.get("type").and_then(|s| s.as_str()).unwrap_or("") {
                            "Turn" => {
                                let transcript = v
                                    .get("transcript")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("");
                                let end_of_turn = v
                                    .get("end_of_turn")
                                    .and_then(|b| b.as_bool())
                                    .unwrap_or(false);
                                if end_of_turn {
                                    if !transcript.trim().is_empty() {
                                        sink.push(SubtitleEvent::Final(
                                            transcript.trim().to_string(),
                                        ));
                                    }
                                    pending.clear();
                                } else {
                                    // 一个 turn 内的文字是累积的 → 取增量。
                                    push_cumulative(transcript, &sink, &mut pending);
                                }
                            }
                            "Termination" => break,
                            "error" => warn!(payload = %t, "assemblyai error event"),
                            _ => {}
                        }
                    }
                }
            };

            let write = async move {
                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    if write_half.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                let _ = write_half
                    .send(Message::Text(
                        serde_json::json!({ "type": "Terminate" }).to_string().into(),
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
}

// ---------- 火山引擎 · 豆包流式语音识别（自有二进制协议） ----------

pub mod volc {
    use super::*;
    use std::io::{Read, Write};

    const DEFAULT_ENDPOINT: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
    /// 2.0 小时版（推荐）。Model 字段填 `volc.` 开头的资源 ID 可覆盖，
    /// 例如 volc.seedasr.sauc.concurrent（并发版）/ volc.bigasr.sauc.duration（1.0）。
    const DEFAULT_RESOURCE_ID: &str = "volc.seedasr.sauc.duration";

    // 4 字节头：版本+头长 / 类型+flags / 序列化+压缩 / 保留
    const PROTO: u8 = 0x11;
    const MSG_FULL_CLIENT: u8 = 0x1;
    const MSG_AUDIO_ONLY: u8 = 0x2;
    const MSG_FULL_SERVER: u8 = 0x9;
    const MSG_ERROR: u8 = 0xF;
    const FLAG_NONE: u8 = 0x0;
    const FLAG_LAST: u8 = 0x2; // 最后一包（无序号）
    const SER_JSON_GZIP: u8 = 0x11;
    const SER_RAW_NONE: u8 = 0x00;
    const COMP_GZIP: u8 = 0x1;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        if enc.write_all(data).is_err() {
            return data.to_vec();
        }
        enc.finish().unwrap_or_else(|_| data.to_vec())
    }

    fn gunzip(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut dec = flate2::read::GzDecoder::new(data);
        if dec.read_to_end(&mut out).is_err() {
            return data.to_vec();
        }
        out
    }

    /// 组一帧：`[0x11, 类型<<4|flags, 序列化<<4|压缩, 0x00, 长度(大端 u32), payload]`
    fn frame(msg_type: u8, flags: u8, ser_comp: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + payload.len());
        out.extend_from_slice(&[PROTO, (msg_type << 4) | flags, ser_comp, 0x00]);
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// 解析服务端帧 → (消息类型, 压缩方式, payload)
    fn parse_frame(buf: &[u8]) -> Option<(u8, u8, Vec<u8>)> {
        if buf.len() < 8 {
            return None;
        }
        let msg_type = buf[1] >> 4;
        let compression = buf[2] & 0x0F;
        let size = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
        let payload = buf.get(8..8 + size)?.to_vec();
        Some((msg_type, compression, payload))
    }

    pub struct VolcAsr {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl VolcAsr {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            if cfg.api_key.trim().is_empty() {
                return Err(anyhow!(
                    "火山引擎 API Key 为空：请在管理面板填写豆包语音控制台的 API Key"
                ));
            }
            Ok(Self { cfg, endpoint })
        }

        fn resource_id(&self) -> String {
            let m = self.cfg.model.trim();
            if m.starts_with("volc.") {
                m.to_string()
            } else {
                DEFAULT_RESOURCE_ID.to_string()
            }
        }
    }

    #[async_trait]
    impl LlmProvider for VolcAsr {
        fn name(&self) -> &'static str {
            "volc-asr"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let mut req = self.endpoint.clone().into_client_request()?;
            let rid = uuid::Uuid::new_v4().to_string();
            let cid = uuid::Uuid::new_v4().to_string();
            {
                let h = req.headers_mut();
                h.insert(
                    "X-Api-Key",
                    http::HeaderValue::from_str(self.cfg.api_key.trim())?,
                );
                h.insert(
                    "X-Api-Resource-Id",
                    http::HeaderValue::from_str(&self.resource_id())?,
                );
                h.insert("X-Api-Request-Id", http::HeaderValue::from_str(&rid)?);
                h.insert("X-Api-Connect-Id", http::HeaderValue::from_str(&cid)?);
            }
            let (ws, _) = tokio_tungstenite::connect_async(req)
                .await
                .map_err(|e| ws_connect_error(e, "连接火山引擎豆包 ASR"))?;
            let (mut write_half, mut read_half) = ws.split();

            // 首包：完整请求（gzip 的 JSON 配置）。
            let cfg_json = serde_json::json!({
                "user": { "uid": "stream-live-translate" },
                "audio": { "format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1 },
                "request": {
                    "model_name": "bigmodel",
                    "enable_itn": true,
                    "enable_punc": true,
                    "show_utterances": true,
                    "result_type": "single"
                }
            });
            let first = frame(
                MSG_FULL_CLIENT,
                FLAG_NONE,
                SER_JSON_GZIP,
                &gzip(cfg_json.to_string().as_bytes()),
            );
            write_half.send(Message::Binary(first.into())).await?;
            info!(endpoint = %self.endpoint, "volcengine 豆包 ASR 会话已建立");

            let read = {
                let sink = sink.clone();
                async move {
                    let mut pending = String::new();
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        let Message::Binary(b) = msg else { continue };
                        let Some((mt, comp, payload)) = parse_frame(&b) else {
                            continue;
                        };
                        if mt == MSG_ERROR {
                            warn!(
                                payload = %String::from_utf8_lossy(&payload),
                                "volcengine error frame"
                            );
                            continue;
                        }
                        if mt != MSG_FULL_SERVER {
                            continue;
                        }
                        let raw = if comp == COMP_GZIP {
                            gunzip(&payload)
                        } else {
                            payload
                        };
                        let text = String::from_utf8_lossy(&raw).to_string();
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
                            debug!(payload = %text, "unparsed volcengine payload");
                            continue;
                        };
                        apply_volc(&v, &sink, &mut pending);
                        if v.get("is_last_package").and_then(|b| b.as_bool()) == Some(true) {
                            break;
                        }
                    }
                }
            };

            let write = async move {
                while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    let mut bytes = Vec::with_capacity(chunk.len() * 2);
                    for s in &chunk {
                        bytes.extend_from_slice(&s.to_le_bytes());
                    }
                    // 音频帧用「不做序列化、不压缩」，避免每包都 gzip 的 CPU 开销。
                    let f = frame(MSG_AUDIO_ONLY, FLAG_NONE, SER_RAW_NONE, &bytes);
                    if write_half.send(Message::Binary(f.into())).await.is_err() {
                        break;
                    }
                }
                // 最后一包：flags=0b0010 表示音频结束。
                let last = frame(MSG_AUDIO_ONLY, FLAG_LAST, SER_RAW_NONE, &[]);
                let _ = write_half.send(Message::Binary(last.into())).await;
                let _ = write_half.close().await;
            };

            tokio::select! {
                _ = read => {}
                _ = write => {}
            }
            Ok(())
        }
    }

    /// 解析识别结果：优先用分句 `utterances`（`definite` 标记定稿），
    /// 没有分句信息时退回整段 `result.text` 做前缀差分。
    fn apply_volc(v: &serde_json::Value, sink: &SubtitleSink, pending: &mut String) {
        let result = v.get("payload_msg").unwrap_or(v).get("result");
        if let Some(uts) = result
            .and_then(|r| r.get("utterances"))
            .and_then(|u| u.as_array())
        {
            for u in uts {
                let text = u.get("text").and_then(|s| s.as_str()).unwrap_or("");
                if text.trim().is_empty() {
                    continue;
                }
                let definite = match u.get("definite") {
                    Some(serde_json::Value::Bool(b)) => *b,
                    Some(serde_json::Value::String(s)) => s == "true",
                    _ => false,
                };
                if definite {
                    sink.push(SubtitleEvent::Final(text.trim().to_string()));
                    pending.clear();
                } else {
                    push_cumulative(text, sink, pending);
                }
            }
            return;
        }
        if let Some(t) = result
            .and_then(|r| r.get("text"))
            .and_then(|s| s.as_str())
        {
            push_cumulative(t, sink, pending);
        }
    }
}

// ---------- 讯飞 · 实时语音转写（RTASR） ----------

pub mod xfyun {
    use super::*;
    use hmac::{Hmac, Mac};
    use md5::{Digest, Md5};
    use sha1::Sha1;

    const DEFAULT_ENDPOINT: &str = "wss://rtasr.xfyun.cn/v1/ws";

    fn url_encode(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 8);
        for b in s.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char)
                }
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }

    pub struct XfRtasr {
        cfg: LlmConfig,
        endpoint: String,
    }

    impl XfRtasr {
        pub fn new(cfg: LlmConfig) -> Result<Self> {
            let endpoint = cfg
                .endpoint
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
            let key = cfg.api_key.trim();
            if key.is_empty() {
                return Err(anyhow!("讯飞 API Key 为空：请在管理面板填写"));
            }
            if !key.contains(':') {
                return Err(anyhow!(
                    "讯飞实时语音转写需要「appid + apiKey」两段，请把 API Key 填成 `appid:apiKey` 的形式（在讯飞控制台应用里取）"
                ));
            }
            Ok(Self { cfg, endpoint })
        }

        /// Model 字段当「源语言」用：`en` = 英文，其余按 `cn`（中文/中英混合）。
        fn lang(&self) -> &'static str {
            if self.cfg.model.trim().eq_ignore_ascii_case("en") {
                "en"
            } else {
                "cn"
            }
        }
    }

    #[async_trait]
    impl LlmProvider for XfRtasr {
        fn name(&self) -> &'static str {
            "xfyun-rtasr"
        }

        async fn run(
            self: Arc<Self>,
            mut audio_rx: tokio::sync::mpsc::Receiver<Vec<i16>>,
            sink: SubtitleSink,
        ) -> Result<()> {
            let Some((appid, api_key)) = self.cfg.api_key.trim().split_once(':') else {
                return Err(anyhow!("讯飞 API Key 需要 `appid:apiKey` 形式"));
            };
            let ts = chrono::Utc::now().timestamp().to_string();
            // signa = Base64( HmacSHA1( MD5(appid + ts), apiKey ) )
            let mut md5 = Md5::new();
            md5.update(format!("{appid}{ts}").as_bytes());
            let md5_hex = hex::encode(md5.finalize());
            let mut mac = Hmac::<Sha1>::new_from_slice(api_key.as_bytes())
                .map_err(|e| anyhow!("HMAC 初始化失败：{e}"))?;
            mac.update(md5_hex.as_bytes());
            let signa =
                base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

            let lang = self.lang();
            let signa_enc = url_encode(&signa);
            let url = with_query_params(
                &self.endpoint,
                &[
                    ("appid", appid),
                    ("ts", ts.as_str()),
                    ("signa", signa_enc.as_str()),
                    ("lang", lang),
                ],
            );
            let req = url.into_client_request()?;
            let (ws, _) = tokio_tungstenite::connect_async(req)
                .await
                .map_err(|e| ws_connect_error(e, "连接讯飞实时语音转写"))?;
            let (mut write_half, mut read_half) = ws.split();
            info!(lang = lang, "讯飞 RTASR 会话已建立");

            let read = {
                let sink = sink.clone();
                async move {
                    let mut pending = String::new();
                    while let Some(msg) = read_half.next().await {
                        let Ok(msg) = msg else { break };
                        let Message::Text(t) = msg else { continue };
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
                            continue;
                        };
                        match v.get("action").and_then(|s| s.as_str()).unwrap_or("") {
                            "result" => {
                                if let Some(data) = v.get("data").and_then(|s| s.as_str()) {
                                    apply_xfyun(data.trim(), &sink, &mut pending);
                                }
                            }
                            "error" => warn!(payload = %t, "讯飞 error 事件"),
                            "started" => info!("讯飞 RTASR 握手成功"),
                            _ => {}
                        }
                    }
                }
            };

            let write = async move {
                // 讯飞要求 40ms/1280 字节一组（16k 单声道 = 640 个采样）。
                const SAMPLES_PER_FRAME: usize = 640;
                'pump: while let Some(chunk) = audio_rx.recv().await {
                    if chunk.is_empty() {
                        continue;
                    }
                    for part in chunk.chunks(SAMPLES_PER_FRAME) {
                        let mut bytes = Vec::with_capacity(part.len() * 2);
                        for s in part {
                            bytes.extend_from_slice(&s.to_le_bytes());
                        }
                        if write_half.send(Message::Binary(bytes.into())).await.is_err() {
                            break 'pump;
                        }
                    }
                }
                // 结束标志：一个承载 `{"end": true}` 的二进制帧。
                let _ = write_half
                    .send(Message::Binary(br#"{"end": true}"#.to_vec().into()))
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

    /// 解析讯飞结果：`data` 是二次编码的 JSON 字符串。
    ///   * 听写：`{ "cn": { "st": { "type": "0|1", "rt": [ { "ws": [ { "cw": [ {"w": "字"} ] } ] } ] } } }`
    ///   * 翻译：`{ "biz": "trans", "dst": "译文", "type": 0|1 }`
    fn apply_xfyun(data: &str, sink: &SubtitleSink, pending: &mut String) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        let ty = match v.get("type") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => String::new(),
        };
        // 翻译结果（开启 transType / targetLang 时使用）。
        if v.get("biz").and_then(|s| s.as_str()) == Some("trans") {
            let text = v.get("dst").and_then(|s| s.as_str()).unwrap_or("");
            if text.trim().is_empty() {
                return;
            }
            if ty == "0" {
                sink.push(SubtitleEvent::Final(text.trim().to_string()));
                pending.clear();
            } else {
                push_cumulative(text, sink, pending);
            }
            return;
        }
        // 听写结果：把词序列拼成整句。
        let Some(st) = v.get("cn").and_then(|c| c.get("st")) else {
            return;
        };
        let mut text = String::new();
        if let Some(rt) = st.get("rt").and_then(|r| r.as_array()) {
            for seg in rt {
                if let Some(ws) = seg.get("ws").and_then(|w| w.as_array()) {
                    for w in ws {
                        if let Some(cw) = w.get("cw").and_then(|c| c.as_array()) {
                            if let Some(t) =
                                cw.first().and_then(|c| c.get("w")).and_then(|s| s.as_str())
                            {
                                text.push_str(t);
                            }
                        }
                    }
                }
            }
        }
        if text.trim().is_empty() {
            return;
        }
        if ty == "0" {
            sink.push(SubtitleEvent::Final(text.trim().to_string()));
            pending.clear();
        } else {
            push_cumulative(&text, sink, pending);
        }
    }
}

// ---------- Helpers shared by providers ----------

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ProviderCapabilities {
    pub supports_streaming_transcript: bool,
    pub sample_rate: u32,
}