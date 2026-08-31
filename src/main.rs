pub mod audio;
pub mod config;
pub mod embedded;
pub mod ingest;
pub mod lang;
pub mod llm;
pub mod obs;
pub mod pipeline;
pub mod server;
pub mod subtitle;
pub mod vad;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use clap::Parser;
use parking_lot::RwLock;
use tracing::{info, warn};

use crate::config::Config;

static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn config_path() -> PathBuf {
    CONFIG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("config.toml"))
}

#[derive(Parser, Debug)]
#[command(
    name = "stream-live-translate",
    version,
    about = "Real-time AI subtitle overlay for OBS Studio"
)]
struct Cli {
    #[arg(long, short = 'c', global = true)]
    config: Option<PathBuf>,
    #[arg(long, global = true)]
    host: Option<String>,
    #[arg(long, short = 'p', global = true)]
    port: Option<u16>,
    #[arg(long)]
    open: bool,
    #[arg(long)]
    headless: bool,
    /// Override `audio.mode` (e.g. the OBS plugin passes `obs_filter`).
    /// The value is persisted into config.toml.
    #[arg(long, global = true)]
    audio_mode: Option<String>,
}

pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    /// Notifies connected overlays that the overlay style config changed so
    /// they can restyle themselves live — the user no longer has to copy a
    /// fresh browser-source URL after tweaking the background settings.
    /// The payload is empty on purpose: receivers re-read `state.config`,
    /// which guarantees they always get the newest value.
    pub config_tx: tokio::sync::broadcast::Sender<()>,
    pub subtitle: Arc<subtitle::SubtitleHub>,
    pub pipeline: Arc<pipeline::PipelineHandle>,
    pub status: Arc<RwLock<AppStatus>>,
    pub obs_cmd_tx:
        parking_lot::Mutex<Option<tokio::sync::mpsc::Sender<crate::obs::ObsCommand>>>,
    /// Audio mode forced via `--audio-mode` (the OBS plugin passes
    /// `obs_filter`). While set, admin-panel config patches can never
    /// change `audio.mode`, so saving other settings can't break the
    /// audio feed.
    pub forced_audio_mode: Option<String>,
}

#[derive(Default, Clone, Debug)]
pub struct AppStatus {
    pub audio_active: bool,
    pub llm_connected: bool,
    pub obs_connected: bool,
    pub last_error: Option<String>,
    /// Latest OBS WebSocket connection failure (surfaced in the admin
    /// panel so users know why the OBS dot is red).
    pub obs_error: Option<String>,
    pub last_subtitle_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub fn exe_dir() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("locate current executable")?;
    Ok(exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("executable has no parent directory"))?
        .to_path_buf())
}

pub fn resolve_config_path(cli_path: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = cli_path {
        return Ok(p);
    }
    let dir = exe_dir()?;
    let portable = dir.join("config.toml");
    let probe = dir.join(".stream-live-translate-write-probe");
    let writable = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map(|_| {
            let _ = std::fs::remove_file(&probe);
            true
        })
        .unwrap_or(false);
    if writable {
        return Ok(portable);
    }
    if let Some(mut user_dir) = dirs::config_dir() {
        user_dir.push("stream-live-translate");
        return Ok(user_dir.join("config.toml"));
    }
    Ok(portable)
}

pub fn resolve_static_dir() -> Result<PathBuf> {
    let dir = exe_dir()?;
    Ok(dir.join("dist"))
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();

    let cfg_path = resolve_config_path(cli.config.clone())
        .context("resolve config path")?;
    let _ = CONFIG_PATH.set(cfg_path.clone());
    info!(
        path = %cfg_path.display(),
        exe_dir = %exe_dir().map(|p| p.display().to_string()).unwrap_or_default(),
        "loading config (portable mode: config lives next to the executable)"
    );
    let mut cfg = Config::load_or_create(&cfg_path)
        .with_context(|| format!("load config {}", cfg_path.display()))?;

    if let Ok(dir) = resolve_static_dir() {
        cfg.server.static_dir = dir;
    }

    if let Some(host) = &cli.host {
        cfg.server.host = host.clone();
    }
    if let Some(port) = cli.port {
        cfg.server.port = port;
    }
    if let Some(mode) = &cli.audio_mode {
        cfg.audio.mode = mode.clone();
        if let Err(e) = cfg.save(&cfg_path) {
            warn!(error = %e, "failed to persist audio mode override");
        } else {
            info!(mode = %mode, "audio mode overridden by CLI");
        }
    }

    let subtitle = Arc::new(subtitle::SubtitleHub::default());
    let pipeline = Arc::new(pipeline::PipelineHandle::new());
    let status = Arc::new(RwLock::new(AppStatus::default()));

    let (config_tx, _config_rx) = tokio::sync::broadcast::channel::<()>(16);

    let state = Arc::new(AppState {
        config: Arc::new(RwLock::new(cfg.clone())),
        config_tx,
        subtitle: subtitle.clone(),
        pipeline: pipeline.clone(),
        status: status.clone(),
        obs_cmd_tx: parking_lot::Mutex::new(None),
        forced_audio_mode: cli.audio_mode.clone(),
    });

    pipeline::spawn(state.clone(), cfg_path.clone());

    let ingest_state = state.clone();
    tokio::spawn(async move {
        ingest::serve(ingest_state).await;
    });

    let obs_client = obs::spawn(state.clone());
    *state.obs_cmd_tx.lock() = obs_client.lock().sender();

    let admin_url = format!(
        "http://{}:{}/admin?obsDock=1",
        cfg.server.host, cfg.server.port
    );
    obs_client.lock().set_admin_url(admin_url);

    let server_cfg = cfg.server.clone();
    let server_state = state.clone();
    let server_task = tokio::spawn(async move {
        if let Err(e) = server::serve(server_state, server_cfg).await {
            warn!(error = %e, "server exited");
        }
    });

    if cli.open {
        let url = format!("http://{}:{}/admin", cfg.server.host, cfg.server.port);
        if let Err(e) = open_in_browser(&url) {
            warn!(error = %e, "failed to open admin page");
        }
    }

    info!(
        host = %cfg.server.host,
        port = cfg.server.port,
        "stream-live-translate running"
    );

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("ctrl-c received, shutting down");
        }
        _ = server_task => {
            warn!("server task ended unexpectedly");
        }
    }

    pipeline.shutdown().await;
    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,stream_live_translate=info"));
    fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

fn open_in_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()?;
    }
    Ok(())
}
