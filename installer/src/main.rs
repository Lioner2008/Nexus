//! Nexus installer: one exe that contains the app (a zip embedded at build time).
//!
//!   Nexus-Setup.exe                 interactive install (asks a few questions)
//!   Nexus-Setup.exe /S [--launch]   silent install/update (used by the in-app updater)
//!   Nexus-Setup.exe --uninstall     remove Nexus (also what "Uninstall Nexus.exe" does)
//!
//! Options: --dir <path> | /D=<path>   install folder (default %LOCALAPPDATA%\Programs\Nexus)
//!          --desktop                  also create a desktop shortcut (silent mode)
//!          --no-shortcuts --no-registry --no-stop   only copy the files (tests, portable use)
//!          --purge                    uninstall: also delete settings, account and artwork cache
//!
//! Installs per user, no administrator rights needed. Settings and data live in
//! %APPDATA%\app.nexus.launcher and survive updates.
#![windows_subsystem = "windows"]

use std::{
    fs,
    io::{Cursor, Read},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    thread::sleep,
    time::Duration,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNO,
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const PAYLOAD: &[u8] = include_bytes!("../payload/payload.zip");
const VERSION: &str = env!("CARGO_PKG_VERSION");
const TITLE: &str = "Nexus Setup";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Nexus";
const UNINSTALLER: &str = "Uninstall Nexus.exe";
const FILES: [&str; 3] = ["nexus.exe", "nexus-server.exe", "README.md"];
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct Args {
    silent: bool,
    uninstall: bool,
    launch: bool,
    desktop: bool,
    purge: bool,
    no_shortcuts: bool,
    no_registry: bool,
    no_stop: bool,
    dir: Option<PathBuf>,
}

fn parse_args() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "/S" | "/s" | "/silent" | "--silent" => a.silent = true,
            "--uninstall" | "/uninstall" => a.uninstall = true,
            "--launch" => a.launch = true,
            "--desktop" => a.desktop = true,
            "--purge" => a.purge = true,
            "--no-shortcuts" => a.no_shortcuts = true,
            "--no-registry" => a.no_registry = true,
            "--no-stop" => a.no_stop = true,
            "--dir" | "/D" => a.dir = it.next().map(PathBuf::from),
            other => {
                if let Some(d) = other.strip_prefix("/D=").or_else(|| other.strip_prefix("--dir=")) {
                    a.dir = Some(PathBuf::from(d.trim_matches('"')));
                }
            }
        }
    }
    a
}

// ───────────────────────────── message boxes ─────────────────────────────

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn message(text: &str, flags: u32) -> i32 {
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(TITLE).as_ptr(), flags) }
}

fn ask(text: &str) -> bool {
    message(text, MB_YESNO | MB_ICONQUESTION) == IDYES
}

fn info(text: &str) {
    message(text, MB_OK | MB_ICONINFORMATION);
}

fn error(text: &str) {
    message(text, MB_OK | MB_ICONERROR);
}

fn log(text: &str) {
    let p = std::env::temp_dir().join("nexus-setup.log");
    let _ = fs::write(p, format!("{VERSION}: {text}\n"));
}

// ───────────────────────────── helpers ─────────────────────────────

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

fn default_dir() -> PathBuf {
    env_path("LOCALAPPDATA").unwrap_or_else(|| PathBuf::from(r"C:\Nexus")).join("Programs").join("Nexus")
}

fn start_menu_link() -> Option<PathBuf> {
    Some(env_path("APPDATA")?.join(r"Microsoft\Windows\Start Menu\Programs").join("Nexus.lnk"))
}

fn desktop_link() -> Option<PathBuf> {
    Some(env_path("USERPROFILE")?.join("Desktop").join("Nexus.lnk"))
}

fn data_dir() -> Option<PathBuf> {
    Some(env_path("APPDATA")?.join("app.nexus.launcher"))
}

fn hidden(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

fn process_running(name: &str) -> bool {
    let out = hidden(Command::new("tasklist").args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])).output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains(&name.to_lowercase())).unwrap_or(false)
}

fn any_running() -> bool {
    process_running("nexus.exe") || process_running("nexus-server.exe")
}

/// Closes the app and its server so the files can be replaced.
fn stop_nexus() {
    // give an app that is quitting itself (in-app update) a moment first
    for _ in 0..16 {
        if !process_running("nexus.exe") {
            break;
        }
        sleep(Duration::from_millis(250));
    }
    for name in ["nexus.exe", "nexus-server.exe"] {
        let _ = hidden(Command::new("taskkill").args(["/F", "/T", "/IM", name])).output();
    }
    for _ in 0..20 {
        if !any_running() {
            return;
        }
        sleep(Duration::from_millis(200));
    }
}

/// Files can stay locked for a moment after a process ends (antivirus, shell): retry.
fn retry<T>(mut f: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut last = None;
    for _ in 0..30 {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = Some(e);
                sleep(Duration::from_millis(250));
            }
        }
    }
    Err(last.unwrap())
}

fn make_link(target: &Path, link: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut sl = mslnk::ShellLink::new(target).map_err(|e| e.to_string())?;
    if let Some(dir) = target.parent() {
        sl.set_working_dir(Some(dir.to_string_lossy().to_string()));
    }
    sl.set_icon_location(Some(target.to_string_lossy().to_string()));
    sl.set_name(Some("Nexus".to_string()));
    sl.create_lnk(link).map_err(|e| e.to_string())
}

fn dir_size(dir: &Path) -> u64 {
    FILES.iter().filter_map(|f| fs::metadata(dir.join(f)).ok()).map(|m| m.len()).sum()
}

// ───────────────────────────── install ─────────────────────────────

fn extract_payload(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    let mut zip = zip::ZipArchive::new(Cursor::new(PAYLOAD)).map_err(|e| format!("The installer is damaged: {e}"))?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        // only plain file names directly in the install folder
        let Some(name) = f.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_owned())) else { continue };
        let mut data = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut data).map_err(|e| e.to_string())?;
        let target = dir.join(&name);
        let tmp = dir.join(format!("{}.new", name.to_string_lossy()));
        retry(|| fs::write(&tmp, &data)).map_err(|e| format!("Cannot write {}: {e}", target.display()))?;
        retry(|| {
            let _ = fs::remove_file(&target);
            fs::rename(&tmp, &target)
        })
        .map_err(|e| format!("Cannot replace {}: {e}", target.display()))?;
    }
    Ok(())
}

fn install(a: &Args) -> Result<PathBuf, String> {
    let dir = a.dir.clone().unwrap_or_else(default_dir);

    if !a.silent {
        let running = if any_running() { "\n\nNexus is running and will be closed for the installation." } else { "" };
        if !ask(&format!("Install Nexus {VERSION} to\n{}?{running}", dir.display())) {
            return Err(String::new());
        }
    }
    if !a.no_stop {
        stop_nexus();
    }
    extract_payload(&dir)?;

    // the uninstaller is a copy of this exe
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let un = dir.join(UNINSTALLER);
    if me != un {
        retry(|| fs::copy(&me, &un).map(|_| ())).map_err(|e| format!("Cannot write the uninstaller: {e}"))?;
    }
    let exe = dir.join("nexus.exe");

    if !a.no_shortcuts {
        if let Some(l) = start_menu_link() {
            let _ = make_link(&exe, &l);
        }
        if let Some(l) = desktop_link() {
            let want = a.desktop || l.exists() || (!a.silent && ask("Create a desktop shortcut?"));
            if want {
                let _ = make_link(&exe, &l);
            }
        }
    }

    if !a.no_registry {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(UNINSTALL_KEY).map_err(|e| e.to_string())?;
        let set = |n: &str, v: &str| key.set_value(n, &v.to_string());
        let _ = set("DisplayName", "Nexus");
        let _ = set("DisplayVersion", VERSION);
        let _ = set("Publisher", "Nexus");
        let _ = set("InstallLocation", &dir.to_string_lossy());
        let _ = set("DisplayIcon", &exe.to_string_lossy());
        let _ = set("UninstallString", &format!("\"{}\" --uninstall", un.to_string_lossy()));
        let _ = set("QuietUninstallString", &format!("\"{}\" --uninstall /S", un.to_string_lossy()));
        let _ = key.set_value("NoModify", &1u32);
        let _ = key.set_value("NoRepair", &1u32);
        let _ = key.set_value("EstimatedSize", &((dir_size(&dir) / 1024) as u32));
    }
    Ok(dir)
}

fn launch(dir: &Path) {
    let _ = Command::new(dir.join("nexus.exe")).current_dir(dir).spawn();
}

// ───────────────────────────── uninstall ─────────────────────────────

fn uninstall(a: &Args) -> Result<(), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    // the install folder: given, or the folder this uninstaller lives in
    let dir = a.dir.clone().or_else(|| me.parent().map(|p| p.to_path_buf())).unwrap_or_else(default_dir);

    let mut purge = a.purge;
    if !a.silent {
        if !ask(&format!("Remove Nexus from\n{}?", dir.display())) {
            return Err(String::new());
        }
        purge = ask("Also delete your Nexus settings, account login and cached artwork?\n\n(Choose No to keep them for a later reinstall.)");
    }
    if !a.no_stop {
        stop_nexus();
    }

    for f in FILES {
        let _ = retry(|| match fs::remove_file(dir.join(f)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        });
    }
    for l in [start_menu_link(), desktop_link()].into_iter().flatten() {
        let _ = fs::remove_file(l);
    }
    if !a.no_registry {
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(UNINSTALL_KEY);
    }
    if purge {
        if let Some(d) = data_dir() {
            let _ = fs::remove_dir_all(d);
        }
    }

    // this exe cannot delete itself while it runs: a detached helper does it a moment later
    let script = format!(
        "ping -n 3 127.0.0.1 >nul & del /f /q \"{}\" & rmdir \"{}\"",
        dir.join(UNINSTALLER).display(),
        dir.display()
    );
    // raw_arg: cmd.exe needs the whole command wrapped in quotes, Rust would escape them differently
    let _ = hidden(Command::new("cmd").raw_arg("/C").raw_arg(format!("\"{script}\""))).spawn();
    Ok(())
}

fn main() {
    let a = parse_args();
    if a.uninstall {
        match uninstall(&a) {
            Ok(()) => {
                if !a.silent {
                    info("Nexus was removed.");
                }
            }
            Err(e) if e.is_empty() => {}
            Err(e) => {
                log(&e);
                if !a.silent {
                    error(&format!("Could not remove Nexus:\n{e}"));
                }
                std::process::exit(1);
            }
        }
        return;
    }

    match install(&a) {
        Ok(dir) => {
            if a.silent {
                if a.launch {
                    launch(&dir);
                }
            } else if ask(&format!("Nexus {VERSION} was installed.\n\nStart it now?")) {
                launch(&dir);
            }
        }
        Err(e) if e.is_empty() => {}
        Err(e) => {
            log(&e);
            if !a.silent {
                error(&format!("The installation failed:\n{e}"));
            }
            std::process::exit(1);
        }
    }
}
