//! OBS WebSocket v5 client. Auto-connects to the local OBS Studio and
//! exposes:
//!   * status (connected / version / last error)
//!   * a command channel to update a Text Source ("Subtitles") with the
//!     latest line and to broadcast custom events to OBS.
//!   * automatic creation of a hidden `browser_source` named
//!     "StreamLiveTranslateAdmin" that hosts the admin panel, so the user
//!     can open it as an in-OBS panel via OpenInputInteract (no external
//!     browser window required after the very first launch).

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::config::ObsConfig;
use crate::AppState;

/// The OBS input (browser source) name we auto-create to host the admin
/// panel inside OBS. Users can find it under Sources and use the
/// "Interact" button to manage the plugin without leaving OBS.
pub const DOCK_INPUT_NAME: &str = "StreamLiveTranslateAdmin";

#[derive(Debug, Clone)]
pub struct ObsStatus {
    pub connected: bool,
    pub version: Option<String>,
    pub last_error: Option<String>,
}

pub struct ObsClient {
    cfg: ObsConfig,
    status: Arc<Mutex<ObsStatus>>,
    cmd_tx: Option<mpsc::Sender<ObsCommand>>,
    task: Option<tokio::task::JoinHandle<()>>,
    /// Last known admin URL (host:port). Used to rebuild the browser
    /// source after reconnects.
    admin_url: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Clone)]
pub enum ObsCommand {
    UpdateTextSource { name: String, text: String },
    BroadcastEvent { event: String, data: serde_json::Value },
    /// Open the admin panel as an interactive panel inside OBS.
    OpenAdminInObs,
    Shutdown,
}

impl ObsClient {
    pub fn new(cfg: ObsConfig) -> Self {
        Self {
            cfg,
            status: Arc::new(Mutex::new(ObsStatus {
                connected: false,
                version: None,
                last_error: None,
            })),
            cmd_tx: None,
            task: None,
            admin_url: Arc::new(Mutex::new(None)),
        }
    }

    pub fn status(&self) -> ObsStatus {
        self.status.lock().clone()
    }

    pub fn sender(&self) -> Option<mpsc::Sender<ObsCommand>> {
        self.cmd_tx.clone()
    }

    /// Record the URL the admin panel is being served from, so the OBS
    /// client can rebuild the in-OBS browser source after a reconnect.
    pub fn set_admin_url(&self, url: String) {
        *self.admin_url.lock() = Some(url);
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.try_send(ObsCommand::Shutdown);
        }
        self.status.lock().connected = false;
    }
}

pub fn spawn(state: Arc<AppState>) -> Arc<Mutex<ObsClient>> {
    let cfg = state.config.read().obs.clone();
    let client = Arc::new(Mutex::new(ObsClient::new(cfg)));
    let inner = client.clone();
    tokio::spawn(async move {
        run_loop(state, inner).await;
    });
    client
}

async fn run_loop(state: Arc<AppState>, client: Arc<Mutex<ObsClient>>) {
    let mut backoff = Duration::from_secs(2);
    loop {
        let cfg = state.config.read().obs.clone();
        if !cfg.auto_connect {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        if let Err(e) = try_connect(&state, &cfg, &client).await {
            warn!(error = %e, "OBS WebSocket connect failed");
            {
                let mut s = state.status.write();
                s.obs_connected = false;
                s.obs_error = Some(e.to_string());
            }
            client.lock().status.lock().connected = false;
            client.lock().status.lock().last_error = Some(e.to_string());
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        } else {
            backoff = Duration::from_secs(2);
        }
    }
}

async fn try_connect(
    state: &Arc<AppState>,
    cfg: &ObsConfig,
    client: &Arc<Mutex<ObsClient>>,
) -> Result<()> {
    let url = format!("ws://{}:{}", cfg.host, cfg.port);
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .with_context(|| format!("connect to OBS at {url}"))?;

    let hello = read_json(&mut ws).await?;
    if hello.get("op").and_then(|v| v.as_i64()) != Some(0) {
        return Err(anyhow!("unexpected OBS hello op"));
    }
    let d = hello.get("d").cloned().unwrap_or_default();
    let rpc_version = d.get("rpcVersion").and_then(|v| v.as_i64()).unwrap_or(1) as u32;
    let auth = d.get("authentication").cloned();

    let identify_d = if let Some(auth) = auth {
        let challenge = auth
            .get("challenge")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("OBS auth challenge missing"))?
            .to_string();
        let salt = auth
            .get("salt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("OBS auth salt missing"))?
            .to_string();
        let secret = compute_auth(&cfg.password, &salt, &challenge);
        serde_json::json!({
            "rpcVersion": rpc_version,
            "authentication": secret,
            "eventSubscriptions": 33,
        })
    } else {
        serde_json::json!({
            "rpcVersion": rpc_version,
            "eventSubscriptions": 33,
        })
    };
    ws.send(Message::Text(
        serde_json::json!({"op": 1, "d": identify_d}).to_string().into(),
    ))
    .await?;

    let identified = read_json(&mut ws).await?;
    if identified.get("op").and_then(|v| v.as_i64()) != Some(2) {
        return Err(anyhow!("OBS did not confirm identify"));
    }
    info!(rpc = rpc_version, "OBS WebSocket identified");

    {
        let mut s = state.status.write();
        s.obs_connected = true;
        s.obs_error = None;
    }
    {
        let c = client.lock();
        c.status.lock().connected = true;
        c.status.lock().version = Some(format!("rpc {rpc_version}"));
        c.status.lock().last_error = None;
    }

    let (mut write_half, mut read_half) = ws.split();
    let (cmd_tx, cmd_rx) = mpsc::channel::<ObsCommand>(32);
    client.lock().cmd_tx = Some(cmd_tx);

    if cfg.register_dock {
        let admin_url = client.lock().admin_url.lock().clone();
        if let Some(url) = admin_url {
            if let Err(e) =
                ws_create_admin_browser_source(&mut write_half, &url).await
            {
                warn!(error = %e, "failed to auto-create admin browser source");
            } else {
                info!(input = DOCK_INPUT_NAME, "admin panel registered as in-OBS browser source");
            }
        }
    }

    let read_state = state.clone();
    let read_client = client.clone();
    let read_handle = tokio::spawn(async move {
        while let Some(msg) = read_half.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                        if v.get("op").and_then(|v| v.as_i64()) == Some(5) {
                            if let Some(es) = v
                                .get("d")
                                .and_then(|d| d.get("eventType"))
                                .and_then(|s| s.as_str())
                            {
                                tracing::debug!(event = %es, "OBS event");
                            }
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    tracing::debug!(error = %e, "OBS ws read error");
                    break;
                }
                _ => {}
            }
        }
        let mut s = read_state.status.write();
        s.obs_connected = false;
        read_client.lock().status.lock().connected = false;
    });

    let write_client = client.clone();
    let write_handle = tokio::spawn(async move {
        let mut cmd_rx = cmd_rx;
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                ObsCommand::UpdateTextSource { name, text } => {
                    if let Err(e) = ws_set_text(&mut write_half, &name, &text, "Subtitles").await {
                        let mut c = write_client.lock();
                        c.status.lock().last_error = Some(e.to_string());
                    }
                }
                ObsCommand::BroadcastEvent { event, data } => {
                    let req = serde_json::json!({
                        "op": 6,
                        "d": {
                            "requestType": "BroadcastCustomEvent",
                            "requestId": uuid::Uuid::new_v4().to_string(),
                            "requestData": {
                                "eventData": { "event": event, "data": data }
                            }
                        }
                    });
                    let _ = write_half.send(Message::Text(req.to_string().into())).await;
                }
                ObsCommand::OpenAdminInObs => {
                    if let Err(e) = ws_open_admin_interact(&mut write_half).await {
                        let mut c = write_client.lock();
                        c.status.lock().last_error = Some(e.to_string());
                    }
                }
                ObsCommand::Shutdown => break,
            }
        }
    });

    let _ = tokio::join!(read_handle, write_handle);
    Ok(())
}

async fn ws_set_text<W>(
    write_half: &mut W,
    name: &str,
    text: &str,
    fallback: &str,
) -> Result<()>
where
    W: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let update = serde_json::json!({
        "op": 6,
        "d": {
            "requestType": "SetInputSettings",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "requestData": { "inputName": name, "settings": { "text": text } }
        }
    });
    write_half.send(Message::Text(update.to_string().into())).await?;
    let create = serde_json::json!({
        "op": 6,
        "d": {
            "requestType": "CreateInput",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "requestData": {
                "sceneName": "Current Scene",
                "inputName": fallback,
                "inputKind": "text_gdiplus_v2",
                "inputSettings": {
                    "text": text,
                    "font": { "face": "Microsoft YaHei", "size": 48 },
                    "color": 0xFFFFFFFFu32,
                    "outline": true,
                    "outline_color": 0xFF000000u32,
                    "outline_size": 2
                }
            }
        }
    });
    write_half.send(Message::Text(create.to_string().into())).await?;
    Ok(())
}

async fn ws_create_admin_browser_source<W>(write_half: &mut W, url: &str) -> Result<()>
where
    W: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let create = serde_json::json!({
        "op": 6,
        "d": {
            "requestType": "CreateInput",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "requestData": {
                "sceneName": "Current Scene",
                "inputName": DOCK_INPUT_NAME,
                "inputKind": "browser_source",
                "inputSettings": {
                    "url": url,
                    "width": 480,
                    "height": 640,
                    "is_local_file": false,
                    "restart_when_active": true,
                    "css": "body{background:transparent;}"
                },
                "sceneItemEnabled": false
            }
        }
    });
    let _ = write_half.send(Message::Text(create.to_string().into())).await;

    let update = serde_json::json!({
        "op": 6,
        "d": {
            "requestType": "SetInputSettings",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "requestData": {
                "inputName": DOCK_INPUT_NAME,
                "settings": {
                    "url": url,
                    "width": 480,
                    "height": 640,
                    "is_local_file": false,
                    "restart_when_active": true,
                    "css": "body{background:transparent;}"
                }
            }
        }
    });
    write_half.send(Message::Text(update.to_string().into())).await?;
    Ok(())
}

async fn ws_open_admin_interact<W>(write_half: &mut W) -> Result<()>
where
    W: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let req = serde_json::json!({
        "op": 6,
        "d": {
            "requestType": "OpenInputInteract",
            "requestId": uuid::Uuid::new_v4().to_string(),
            "requestData": { "inputName": DOCK_INPUT_NAME }
        }
    });
    write_half.send(Message::Text(req.to_string().into())).await?;
    Ok(())
}

async fn read_json<S>(read_half: &mut S) -> Result<serde_json::Value>
where
    S: futures::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(msg) = read_half.next().await {
        match msg? {
            Message::Text(t) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                    return Ok(v);
                }
            }
            Message::Close(_) => return Err(anyhow!("OBS closed during handshake")),
            _ => {}
        }
    }
    Err(anyhow!("OBS connection closed"))
}

fn compute_auth(password: &str, salt: &str, challenge: &str) -> String {
    let mut h1 = Sha256::new();
    h1.update(password.as_bytes());
    h1.update(salt.as_bytes());
    let step1 = h1.finalize();
    let step2_b64 = base64::engine::general_purpose::STANDARD.encode(step1);
    let mut h3 = Sha256::new();
    h3.update(step2_b64.as_bytes());
    h3.update(challenge.as_bytes());
    let step3 = h3.finalize();
    base64::engine::general_purpose::STANDARD.encode(step3)
}