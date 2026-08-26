//! Local HTTP / WebSocket server.
//!
//! Endpoints:
//!   GET  /                      -> welcome
//!   GET  /admin                 -> SPA admin panel (HTML)
//!   GET  /overlay               -> browser source overlay (HTML)
//!   GET  /api/config            -> current config
//!   POST /api/config            -> save config (restarts pipeline if needed)
//!   GET  /api/devices           -> list audio devices
//!   GET  /api/status            -> { running, audio, llm, obs, last_error }
//!   GET  /api/subtitles         -> current + history
//!   POST /api/subtitles/clear   -> clear current line
//!   WS   /ws/subtitles          -> live subtitle event stream

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::{info, warn};

use crate::config::{Config, ServerConfig};
use crate::embedded;
use crate::AppState;

pub async fn serve(state: Arc<AppState>, cfg: ServerConfig) -> Result<()> {
    let static_dir: PathBuf = cfg.static_dir.clone();
    let app = build_router(state, static_dir);

    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port)
        .parse()
        .map_err(|e| anyhow::anyhow!("bad bind address: {e}"))?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;
    info!(addr = %bound, "server bound");
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_router(state: Arc<AppState>, static_dir: PathBuf) -> Router {
    // NOTE: these routes are nested under /api below, so the paths here
    // must NOT repeat the /api prefix.
    let api = Router::new()
        .route("/config", get(get_config).post(post_config))
        .route("/devices", get(get_devices))
        .route("/status", get(get_status))
        .route("/subtitles", get(get_subtitles))
        .route("/subtitles/clear", post(clear_subtitles))
        .route("/restart", post(restart_pipeline))
        .with_state(state.clone());

    // Disk directory for the optional bundled binaries (live-reload case).
    let bin_dir = static_dir.join("bin");

    // Panel/overlay static assets. The binary is self-contained: assets are
    // embedded at compile time. (We intentionally do NOT use ServeDir here:
    // pointing it at a nonexistent directory makes every request 404 without
    // ever reaching the fallback handler.)
    Router::new()
        .route("/", get(root_handler))
        .route("/admin", get(admin_handler))
        .route("/overlay", get(overlay_handler))
        .route("/ws/subtitles", get(ws_subtitles))
        .route("/admin-assets/*asset", get(embedded_admin_asset))
        .route("/overlay-assets/*asset", get(embedded_overlay_asset))
        .nest("/api", api)
        .nest_service("/bin", ServeDir::new(bin_dir))
        // axum 0.7 catch-all syntax is /*path (must be the final segment).
        .route("/_assets/*path", get(embedded_any_asset))
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
}

async fn root_handler() -> &'static str {
    "stream-live-translate is running. Visit /admin to configure, /overlay for the browser source."
}

async fn admin_handler() -> Response {
    serve_static("admin/index.html", "text/html; charset=utf-8").await
}

async fn overlay_handler() -> Response {
    serve_static("overlay/index.html", "text/html; charset=utf-8").await
}

fn detect_content_type(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") || lower.ends_with(".htm") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".wasm") {
        "application/wasm"
    } else if lower.ends_with(".txt") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

async fn serve_static(rel: &str, content_type: &'static str) -> Response {
    let candidates = [
        std::path::PathBuf::from(rel),
        std::path::PathBuf::from("dist").join(rel),
    ];
    for c in &candidates {
        if let Ok(data) = std::fs::read(c) {
            return (
                StatusCode::OK,
                [(header::CONTENT_TYPE, HeaderValue::from_static(content_type))],
                data,
            )
                .into_response();
        }
    }
    // Fall back to embedded asset.
    if let Some(bytes) = embedded::read(rel) {
        let ctype = HeaderValue::from_static(detect_content_type(rel));
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, ctype)],
            bytes.to_vec(),
        )
            .into_response();
    }
    (
        StatusCode::NOT_FOUND,
        format!("not found: {rel}"),
    )
        .into_response()
}

async fn embedded_admin_asset(
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    let rel = format!("admin/{path}");
    respond_embedded(&rel)
}

async fn embedded_overlay_asset(
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    let rel = format!("overlay/{path}");
    respond_embedded(&rel)
}

async fn embedded_any_asset(
    axum::extract::Path(path): axum::extract::Path<String>,
) -> Response {
    respond_embedded(&path)
}

fn respond_embedded(rel: &str) -> Response {
    if let Some(bytes) = embedded::read(rel) {
        let ctype = HeaderValue::from_static(detect_content_type(rel));
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, ctype)],
            bytes.to_vec(),
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, format!("not found: {rel}")).into_response()
}

async fn get_config(State(state): State<Arc<AppState>>) -> Response {
    let cfg = state.config.read().clone();
    axum::Json(cfg).into_response()
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum ConfigPatch {
    Full(Config),
    Partial(serde_json::Value),
}

async fn post_config(
    State(state): State<Arc<AppState>>,
    axum::Json(payload): axum::Json<serde_json::Value>,
) -> Response {
    // Merge patch onto current config.
    let mut cfg = state.config.read().clone();
    if let Err(e) = merge_json(&mut cfg, &payload) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response();
    }
    // The OBS plugin launches the engine with --audio-mode obs_filter;
    // the audio feed comes from the plugin itself. Never let a panel
    // save silently switch the mode (that kills the pipeline).
    if let Some(forced) = &state.forced_audio_mode {
        if cfg.audio.mode != *forced {
            info!(
                from = %cfg.audio.mode,
                to = %forced,
                "audio mode locked by CLI override; ignoring patch value"
            );
            cfg.audio.mode = forced.clone();
        }
    }
    if let Err(e) = cfg.save(&crate::config_path()) {
        // Do NOT pretend success: the admin panel must surface disk-write
        // failures, otherwise users believe their settings were persisted.
        warn!(error = %e, "save config");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({
                "error": format!("config saved to memory but FAILED to write {}: {e}", crate::config_path().display())
            })),
        )
            .into_response();
    }
    // Write-verify: even a successful write can be silently reverted by
    // security/sync software, or land in a redirected location. Read the
    // file back and compare the critical fields so the panel can warn the
    // user that the value will NOT survive an OBS restart.
    let verified = std::fs::read_to_string(crate::config_path())
        .ok()
        .and_then(|raw| toml::from_str::<crate::config::Config>(&raw).ok())
        .map(|disk| {
            disk.llm.api_key == cfg.llm.api_key
                && disk.llm.model == cfg.llm.model
                && disk.llm.provider == cfg.llm.provider
                && disk.server.host == cfg.server.host
                && disk.server.port == cfg.server.port
        })
        .unwrap_or(false);
    if !verified {
        warn!(path = %crate::config_path().display(), "config write verification FAILED: disk content differs from what was just saved");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({
                "error": format!(
                    "配置已在内存中生效，但磁盘校验失败：{} 里的内容不是刚保存的值（可能被安全/同步软件拦截或回滚）。本次运行期间有效，重启 OBS 后会丢失，请检查该文件的读写权限与占用情况。",
                    crate::config_path().display()
                )
            })),
        )
            .into_response();
    }
    *state.config.write() = cfg;
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({"ok": true})),
    )
        .into_response()
}

fn merge_json(cfg: &mut Config, patch: &serde_json::Value) -> anyhow::Result<()> {
    let mut current = serde_json::to_value(cfg.clone())?;
    json_merge(&mut current, patch);
    *cfg = serde_json::from_value(current)?;
    Ok(())
}

use serde_json::Value;

fn json_merge(dst: &mut serde_json::Value, patch: &serde_json::Value) {
    use serde_json::Value::Object;
    if let (Object(d), Object(p)) = (&mut *dst, patch) {
        for (k, v) in p {
            if v.is_null() {
                d.remove(k);
            } else {
                json_merge(d.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
    } else if !patch.is_null() {
        *dst = patch.clone();
    }
}


async fn get_devices() -> Response {
    match crate::audio::list_devices() {
        Ok(devs) => axum::Json(devs).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

#[derive(serde::Serialize)]
struct StatusView {
    running: bool,
    audio_active: bool,
    llm_connected: bool,
    obs_connected: bool,
    last_error: Option<String>,
    /// Why the OBS WebSocket is not connected (e.g. OBS not running or
    /// the WebSocket server not enabled / wrong password).
    obs_error: Option<String>,
    last_subtitle_at: Option<chrono::DateTime<chrono::Utc>>,
    bind_url: String,
    obs_dock_url: Option<String>,
    /// Where the config is persisted; shown in the admin panel so users can
    /// verify their settings were actually saved.
    config_path: String,
    /// Set when the engine was launched with --audio-mode (plugin mode);
    /// the panel then locks the audio mode selector.
    audio_mode_forced: Option<String>,
}

async fn get_status(State(state): State<Arc<AppState>>) -> Response {
    let cfg = state.config.read().clone();
    let s = state.status.read().clone();
    let view = StatusView {
        running: state.pipeline.is_running(),
        audio_active: s.audio_active,
        llm_connected: s.llm_connected,
        obs_connected: s.obs_connected,
        last_error: s.last_error,
        obs_error: s.obs_error,
        last_subtitle_at: s.last_subtitle_at,
        bind_url: format!("http://{}:{}", cfg.server.host, cfg.server.port),
        obs_dock_url: if cfg.obs.register_dock {
            Some(format!("http://{}:{}/admin?obsDock=1", cfg.server.host, cfg.server.port))
        } else {
            None
        },
        config_path: crate::config_path().display().to_string(),
        audio_mode_forced: state.forced_audio_mode.clone(),
    };
    axum::Json(view).into_response()
}

#[derive(serde::Serialize)]
struct SubtitlesView {
    current: Option<crate::subtitle::SubtitleLine>,
    history: Vec<crate::subtitle::SubtitleLine>,
}

async fn get_subtitles(State(state): State<Arc<AppState>>) -> Response {
    let view = SubtitlesView {
        current: state.subtitle.current(),
        history: state.subtitle.history(),
    };
    axum::Json(view).into_response()
}

async fn clear_subtitles(State(state): State<Arc<AppState>>) -> Response {
    state.subtitle.clear();
    axum::Json(serde_json::json!({"ok": true})).into_response()
}

async fn restart_pipeline(State(state): State<Arc<AppState>>) -> Response {
    // restart() (NOT shutdown()): the pipeline run-loop must stay alive and
    // spin up a fresh pipeline with the current config. shutdown() is
    // permanent and reserved for process exit.
    state.pipeline.restart().await;
    axum::Json(serde_json::json!({"ok": true})).into_response()
}

async fn ws_subtitles(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    ws.on_upgrade(move |socket| ws_loop(socket, state))
}

#[derive(serde::Deserialize, Default)]
struct WsQuery {
    #[serde(default)]
    since: Option<String>,
}

async fn ws_loop(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.subtitle.subscribe();
    // Send the current state immediately.
    if let Some(cur) = state.subtitle.current() {
        let payload = serde_json::json!({
            "type": "current",
            "line": cur,
        });
        if socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }
    loop {
        tokio::select! {
            ev = rx.recv() => {
                let ev = match ev {
                    Ok(ev) => ev,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return,
                };
                // Serialize by hand (see subtitle::ws_payload): serde_json
                // cannot serialize the tagged enum directly, and the old
                // `to_string(&ev).unwrap_or_default()` silently shipped an
                // empty message, so overlay/admin never got any text.
                let payload = crate::subtitle::ws_payload(&ev);
                if socket
                    .send(Message::Text(payload.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Ok(Message::Ping(p))) => {
                        if socket.send(Message::Pong(p)).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Text(_))) => {
                        // Reserved for future client commands.
                    }
                    _ => {}
                }
            }
        }
    }
}