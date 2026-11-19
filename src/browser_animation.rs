//! A temporary KWin effect for the helper's ordinary, decorated GTK windows.
//! Layer-shell namespaces cannot control animations on xdg-toplevel windows.

use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::config::{PanelAnimation, MAX_FADE_DURATION_MS};

pub fn application_id(mode: PanelAnimation, duration_ms: u32) -> String {
    match mode {
        PanelAnimation::DesktopDefault => "overlay-browser".into(),
        PanelAnimation::Instant => "overlay-browser-instant".into(),
        PanelAnimation::FadeIn => {
            format!(
                "overlay-browser-fade-{}",
                duration_ms.min(MAX_FADE_DURATION_MS)
            )
        }
    }
}

fn name(pid: u32) -> String {
    format!("overlay-browser-animation-{pid}")
}

fn directory(pid: u32) -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
        })?;
    Some(data.join("kwin/effects").join(name(pid)))
}

fn connection() -> zbus::Result<zbus::blocking::Connection> {
    zbus::blocking::connection::Builder::session()?
        .method_timeout(std::time::Duration::from_secs(2))
        .build()
}

fn proxy(connection: &zbus::blocking::Connection) -> zbus::Result<zbus::blocking::Proxy<'_>> {
    zbus::blocking::Proxy::new(
        connection,
        "org.kde.KWin",
        "/Effects",
        "org.kde.kwin.Effects",
    )
}

pub struct Effect {
    connection: zbus::blocking::Connection,
    directory: PathBuf,
    name: String,
    loaded: bool,
    next_attempt: Instant,
    deadline: Instant,
}

impl Effect {
    pub fn start() -> anyhow::Result<Self> {
        let pid = std::process::id();
        let connection = connection()?;
        let directory = directory(pid).ok_or_else(|| anyhow::anyhow!("no user data directory"))?;
        std::fs::create_dir_all(directory.parent().unwrap())?;
        std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let mut effect = Self {
            connection,
            directory,
            name: name(pid),
            loaded: false,
            next_attempt: Instant::now(),
            deadline: Instant::now() + Duration::from_secs(25),
        };
        let code = effect.directory.join("contents/code");
        std::fs::create_dir_all(&code)?;
        let metadata = serde_json::json!({
            "KPackageStructure": "KWin/Effect",
            "KPlugin": {
                "Id": effect.name,
                "Name": "Overlay browser opening",
                "EnabledByDefault": false,
                "License": "MIT"
            },
            "X-Plasma-API": "javascript",
            "X-KDE-Ordering": 0
        });
        for (path, contents) in [
            (effect.directory.join("metadata.json"), metadata.to_string()),
            (
                code.join("main.js"),
                include_str!("browser_animation.js").replace("__PID__", &pid.to_string()),
            ),
        ] {
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)?
                .write_all(contents.as_bytes())?;
        }
        effect.loaded = proxy(&effect.connection)?.call("loadEffect", &(effect.name.as_str(),))?;
        if !effect.loaded {
            // KPackage caches the installed package list for KWin's first
            // twenty seconds. Keep our package and retry without blocking GTK.
            let supported: bool =
                proxy(&effect.connection)?.call("isEffectSupported", &("scale",))?;
            anyhow::ensure!(supported, "KWin does not support window animation effects");
        }
        Ok(effect)
    }

    /// Wait only for startup discovery; a permanently unavailable effect falls
    /// back to the desktop rather than preventing the browser from opening.
    pub fn ready(&mut self) -> bool {
        if self.loaded {
            return true;
        }
        let now = Instant::now();
        if now >= self.deadline {
            return true;
        }
        if now < self.next_attempt {
            return false;
        }
        self.next_attempt = now + Duration::from_millis(500);
        self.loaded = proxy(&self.connection)
            .and_then(|proxy| proxy.call("loadEffect", &(self.name.as_str(),)))
            .unwrap_or(false);
        if !self.loaded && self.next_attempt >= self.deadline {
            log::warn!("browser opening control unavailable: KWin rejected the effect");
        }
        self.loaded
    }
}

impl Drop for Effect {
    fn drop(&mut self) {
        if let Ok(proxy) = proxy(&self.connection) {
            let _ = proxy.call::<_, _, ()>("unloadEffect", &(self.name.as_str(),));
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

/// Parent-side fallback after a helper crash, when its destructor cannot run.
pub fn cleanup(pid: u32) {
    if let Ok(connection) = connection() {
        if let Ok(proxy) = proxy(&connection) {
            let _ = proxy.call::<_, _, ()>("unloadEffect", &(name(pid).as_str(),));
        }
    }
    if let Some(directory) = directory(pid) {
        let _ = std::fs::remove_dir_all(directory);
    }
}
