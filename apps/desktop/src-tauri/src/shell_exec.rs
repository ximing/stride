//! Desktop shell executor. The webview passes a command string; the interpreter,
//! argv, and environment are chosen here.

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, Runtime, State, Webview};

const SENTINEL: &str = "__STRIDE_PATH__";
const SESSION_ENDED: &str = "shell session ended";
const NO_SHELL: &str = "No shell is available";
const TOO_MANY: &str = "too many shell processes";
const MAX_COMMAND_BYTES: usize = 256 * 1024;
const MAX_SESSIONS: usize = 8;
const MAX_COLLECT_BYTES: usize = 1024 * 1024;
const READ_CHUNK: usize = 4 * 1024;
const MAX_EVENT_JSON: usize = 8192;
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[cfg(unix)]
const LOGIN_SHELLS: &[&str] = &["zsh", "bash", "sh"];
#[cfg(unix)]
const USER_SHELLS: &[&str] = &["bash", "zsh", "sh"];
#[cfg(windows)]
const LOGIN_SHELLS: &[&str] = &["zsh.exe", "bash.exe", "sh.exe"];
#[cfg(windows)]
const USER_SHELLS: &[&str] = &["bash.exe", "zsh.exe", "sh.exe"];
#[cfg(not(any(unix, windows)))]
const LOGIN_SHELLS: &[&str] = &[];
#[cfg(not(any(unix, windows)))]
const USER_SHELLS: &[&str] = &[];

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ShellExecEvent {
    Started {
        id: String,
    },
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    Exit {
        code: Option<i32>,
        truncated: bool,
        reason: String,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    Exit,
    Cap,
    Timeout,
    Cancel,
}

impl StopReason {
    fn as_str(self) -> &'static str {
        match self {
            StopReason::Exit => "exit",
            StopReason::Cap => "cap",
            StopReason::Timeout => "timeout",
            StopReason::Cancel => "cancel",
        }
    }

    fn rank(self) -> u8 {
        match self {
            StopReason::Exit => 0,
            StopReason::Cap => 1,
            StopReason::Timeout => 2,
            StopReason::Cancel => 3,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct StopState {
    reason: StopReason,
    truncated: bool,
}

fn raise_reason(current: &mut StopReason, next: StopReason) {
    if next.rank() > current.rank() {
        *current = next;
    }
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    fn event(self, data: &str) -> ShellExecEvent {
        match self {
            Stream::Stdout => ShellExecEvent::Stdout {
                data: data.to_string(),
            },
            Stream::Stderr => ShellExecEvent::Stderr {
                data: data.to_string(),
            },
        }
    }
}

fn probe_script() -> &'static str {
    // `\n` stays backslash + n. printf, not the shell quote, emits the newline.
    "printf '\\n__STRIDE_PATH__%s' \"$PATH\""
}

fn probe_argv() -> [&'static str; 2] {
    ["-lic", probe_script()]
}

fn user_argv(command: &str) -> Vec<String> {
    vec!["-c".to_string(), command.to_string()]
}

fn check_command(command: &str) -> Result<(), String> {
    if command.len() > MAX_COMMAND_BYTES {
        return Err("Command is too long".into());
    }
    if command.trim().is_empty() {
        return Err("Command is empty".into());
    }
    Ok(())
}

fn check_cwd(cwd: &str) -> Result<(), String> {
    if cwd.is_empty() {
        return Err("Working directory is empty".into());
    }
    if cwd.contains('\0') {
        return Err("Working directory contains NUL".into());
    }
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err("Working directory must be absolute".into());
    }
    let canonical =
        fs::canonicalize(path).map_err(|_| "Working directory is not a directory".to_string())?;
    if !canonical.is_dir() {
        return Err("Working directory is not a directory".into());
    }
    Ok(())
}

fn check_timeout(timeout_ms: Option<f64>) -> Result<Option<Duration>, String> {
    let Some(timeout_ms) = timeout_ms else {
        return Ok(None);
    };
    if !timeout_ms.is_finite() || timeout_ms < 0.0 {
        return Err("invalid timeout".into());
    }
    // `from_secs_f64` panics on overflow. Reject that before an id is issued.
    Duration::try_from_secs_f64(timeout_ms / 1000.0)
        .map(Some)
        .map_err(|_| "invalid timeout".to_string())
}

fn reject_if_full(open: usize) -> Result<(), String> {
    if open >= MAX_SESSIONS {
        Err(TOO_MANY.to_string())
    } else {
        Ok(())
    }
}

fn note_collected_bytes(total: &mut usize, chunk: usize) -> bool {
    *total = total.saturating_add(chunk);
    *total >= MAX_COLLECT_BYTES
}

fn is_runnable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|path| is_runnable(path)).cloned()
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path).filter(|dir| !dir.as_os_str().is_empty()));
    }
    #[cfg(unix)]
    {
        for extra in ["/bin", "/usr/bin", "/usr/local/bin"] {
            let path = PathBuf::from(extra);
            if !dirs.iter().any(|dir| dir == &path) {
                dirs.push(path);
            }
        }
    }
    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(var) {
                dirs.push(Path::new(&root).join("Git").join("bin"));
            }
        }
    }
    dirs
}

fn find_interpreters(names: &[&str]) -> Vec<PathBuf> {
    let dirs = search_dirs();
    let mut found = Vec::new();
    for name in names {
        for dir in &dirs {
            let path = dir.join(name);
            if is_runnable(&path) {
                found.push(path);
                break;
            }
        }
    }
    found
}

fn read_path(code: Option<i32>, stdout: &str, stderr: &str) -> Option<String> {
    if code != Some(0) {
        return None;
    }
    let text = format!("{stdout}\n{stderr}");
    let at = text.rfind(SENTINEL)?;
    let after = text[at + SENTINEL.len()..].trim();
    let first = first_line(after).trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

fn first_line(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            return &text[..index];
        }
        if bytes[index] == b'\r' && index + 1 < bytes.len() && bytes[index + 1] == b'\n' {
            return &text[..index];
        }
        index += 1;
    }
    text
}

struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    fn push(&mut self, input: &[u8], flush: bool) -> String {
        if !input.is_empty() {
            self.pending.extend_from_slice(input);
        }
        let mut out = String::new();
        loop {
            if self.pending.is_empty() {
                break;
            }
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    if valid > 0 {
                        let text = std::str::from_utf8(&self.pending[..valid])
                            .expect("from_utf8 valid prefix");
                        out.push_str(text);
                        self.pending.drain(..valid);
                        continue;
                    }
                    match err.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            let drop_len = len.min(self.pending.len());
                            self.pending.drain(..drop_len);
                        }
                        None if flush => {
                            out.push('\u{FFFD}');
                            self.pending.clear();
                            break;
                        }
                        None => break,
                    }
                }
            }
        }
        out
    }
}

fn event_json_len(event: &ShellExecEvent) -> usize {
    serde_json::to_string(event)
        .map(|json| json.len())
        .unwrap_or(usize::MAX)
}

fn longest_prefix(stream: Stream, text: &str) -> usize {
    let ends: Vec<usize> = text
        .char_indices()
        .map(|(index, ch)| index + ch.len_utf8())
        .collect();
    if ends.is_empty() {
        return 0;
    }
    let mut low = 0usize;
    let mut high = ends.len();
    while low < high {
        let mid = (low + high + 1) / 2;
        if event_json_len(&stream.event(&text[..ends[mid - 1]])) < MAX_EVENT_JSON {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    if low == 0 {
        ends[0]
    } else {
        ends[low - 1]
    }
}

fn fit_events(stream: Stream, text: &str) -> Vec<ShellExecEvent> {
    let mut events = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if event_json_len(&stream.event(rest)) < MAX_EVENT_JSON {
            events.push(stream.event(rest));
            break;
        }
        let size = longest_prefix(stream, rest);
        if size == 0 || size > rest.len() {
            break;
        }
        events.push(stream.event(&rest[..size]));
        rest = &rest[size..];
    }
    events
}

fn events_for_chunk(stream: Stream, bytes: &[u8]) -> Vec<ShellExecEvent> {
    let mut decoder = Decoder {
        pending: Vec::new(),
    };
    let text = decoder.push(bytes, true);
    fit_events(stream, &text)
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|err| err.to_string())?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    Ok(out)
}

#[cfg(unix)]
fn kill_group(pid: u32) -> std::io::Result<()> {
    if pid == 0 {
        return Err(std::io::Error::new(
            ErrorKind::InvalidInput,
            "refusing to signal process group 0",
        ));
    }
    loop {
        let rc = unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
        if rc == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(code) if code == libc::ESRCH => return Ok(()),
            Some(code) if code == libc::EINTR => continue,
            _ => return Err(err),
        }
    }
}

#[cfg(windows)]
struct WinJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for WinJob {}
#[cfg(windows)]
unsafe impl Sync for WinJob {}

#[cfg(windows)]
impl WinJob {
    fn terminate(&self) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if unsafe { TerminateJobObject(self.handle, 1) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for WinJob {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe { CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
fn resume_threads(pid: u32) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    let resumed = resume_snapshot(snapshot, pid);
    unsafe { CloseHandle(snapshot) };
    if resumed? == 0 {
        Err(std::io::Error::new(
            ErrorKind::Other,
            "suspended process had no threads",
        ))
    } else {
        Ok(())
    }
}

/// `std` closes the main thread handle after `CreateProcess`. Resume by snapshot.
#[cfg(windows)]
fn resume_snapshot(
    snapshot: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
) -> std::io::Result<u32> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        Thread32First, Thread32Next, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    if unsafe { Thread32First(snapshot, &mut entry) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let mut resumed = 0u32;
    loop {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let previous = unsafe { ResumeThread(thread) };
            unsafe { CloseHandle(thread) };
            if previous == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
            resumed += 1;
        }
        if unsafe { Thread32Next(snapshot, &mut entry) } == 0 {
            break;
        }
    }
    Ok(resumed)
}

#[cfg(windows)]
fn assign_job(child: &Child) -> std::io::Result<Arc<WinJob>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};

    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let job = Arc::new(WinJob { handle: raw });
    if unsafe { AssignProcessToJobObject(job.handle, child.as_raw_handle()) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if let Err(err) = resume_threads(child.id()) {
        return Err(err);
    }
    Ok(job)
}

#[derive(Clone)]
enum KillTarget {
    #[cfg(unix)]
    Group(u32),
    #[cfg(windows)]
    Job(Arc<WinJob>),
    #[cfg(not(any(unix, windows)))]
    None,
}

fn terminate(target: &KillTarget) -> std::io::Result<()> {
    match target {
        #[cfg(unix)]
        KillTarget::Group(pid) => kill_group(*pid),
        #[cfg(windows)]
        KillTarget::Job(job) => job.terminate(),
        #[cfg(not(any(unix, windows)))]
        KillTarget::None => Ok(()),
    }
}

fn kill_logged(id: &str, reason: &str, target: &KillTarget) {
    if let Err(err) = terminate(target) {
        eprintln!("shell session {id} kill failed reason={reason}: {err}");
    }
}

struct Spawned {
    child: Child,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    target: KillTarget,
}

fn spawn_grouped(
    program: &Path,
    args: &[String],
    cwd: Option<&str>,
    path_env: Option<&str>,
) -> std::io::Result<Spawned> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        // Original string, not the canonical path. Symlinked vault roots keep `pwd`.
        command.current_dir(cwd);
    }
    if let Some(path_env) = path_env {
        command.env("PATH", path_env);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::new(ErrorKind::Other, "stdout pipe missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::new(ErrorKind::Other, "stderr pipe missing"))?;

    #[cfg(unix)]
    let target = KillTarget::Group(child.id());
    #[cfg(windows)]
    let target = match assign_job(&child) {
        Ok(job) => KillTarget::Job(job),
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };
    #[cfg(not(any(unix, windows)))]
    let target = KillTarget::None;

    Ok(Spawned {
        child,
        stdout,
        stderr,
        target,
    })
}

enum Phase {
    Allocated,
    Probing,
    Running,
    Stopping,
}

struct Session {
    label: String,
    channel: Mutex<Channel<ShellExecEvent>>,
    ended: AtomicBool,
    detached: AtomicBool,
    cancel: AtomicBool,
    stop: Mutex<StopState>,
    kill: Mutex<Option<KillTarget>>,
}

impl Session {
    fn new(label: String, channel: Channel<ShellExecEvent>) -> Self {
        Self {
            label,
            channel: Mutex::new(channel),
            ended: AtomicBool::new(false),
            detached: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            stop: Mutex::new(StopState {
                reason: StopReason::Exit,
                truncated: false,
            }),
            kill: Mutex::new(None),
        }
    }

    fn lock_channel(&self) -> MutexGuard<'_, Channel<ShellExecEvent>> {
        self.channel.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn lock_stop(&self) -> MutexGuard<'_, StopState> {
        self.stop.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn lock_kill(&self) -> MutexGuard<'_, Option<KillTarget>> {
        self.kill.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn note(&self, reason: StopReason, truncate: bool) {
        let mut stop = self.lock_stop();
        raise_reason(&mut stop.reason, reason);
        if truncate {
            stop.truncated = true;
        }
    }

    fn snapshot(&self) -> StopState {
        *self.lock_stop()
    }

    fn mark_detached(&self) {
        let _guard = self.lock_channel();
        self.detached.store(true, Ordering::SeqCst);
    }

    fn send_event(&self, event: ShellExecEvent, terminal: bool) -> bool {
        let already_ended_message = matches!(
            &event,
            ShellExecEvent::Error { message } if message == SESSION_ENDED
        );
        let channel = self.lock_channel();
        if self.detached.load(Ordering::SeqCst) || self.ended.load(Ordering::SeqCst) {
            return false;
        }
        match channel.send(event) {
            Ok(()) => {
                if terminal {
                    self.ended.store(true, Ordering::SeqCst);
                }
                true
            }
            Err(_) => {
                if !self.ended.swap(true, Ordering::SeqCst) && !already_ended_message {
                    let _ = channel.send(ShellExecEvent::Error {
                        message: SESSION_ENDED.to_string(),
                    });
                }
                false
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.ended.swap(true, Ordering::SeqCst) {
            return;
        }
        let channel = self
            .channel
            .get_mut()
            .unwrap_or_else(|err| err.into_inner());
        let _ = channel.send(ShellExecEvent::Error {
            message: SESSION_ENDED.to_string(),
        });
    }
}

struct Entry {
    session: Arc<Session>,
    phase: Phase,
}

struct Table {
    sessions: HashMap<String, Entry>,
    path: Option<String>,
    interpreter: Option<PathBuf>,
}

struct HostInner {
    table: Mutex<Table>,
}

#[derive(Clone)]
pub struct ShellHost {
    inner: Arc<HostInner>,
}

impl ShellHost {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HostInner {
                table: Mutex::new(Table {
                    sessions: HashMap::new(),
                    path: None,
                    interpreter: None,
                }),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Table> {
        self.inner
            .table
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }

    fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.lock()
            .sessions
            .get(id)
            .map(|entry| Arc::clone(&entry.session))
    }

    fn alive(&self, id: &str) -> bool {
        self.lock().sessions.contains_key(id)
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.lock().sessions.get(id).is_some_and(|entry| {
            entry.session.cancel.load(Ordering::SeqCst)
                || entry.session.detached.load(Ordering::SeqCst)
        })
    }

    fn set_phase(&self, id: &str, phase: Phase) {
        if let Some(entry) = self.lock().sessions.get_mut(id) {
            entry.phase = phase;
        }
    }

    fn cached_path(&self) -> Option<String> {
        self.lock().path.clone()
    }

    fn store_path(&self, id: &str, path: String) -> bool {
        if path.is_empty() {
            return false;
        }
        let mut table = self.lock();
        let Some(entry) = table.sessions.get(id) else {
            return false;
        };
        if entry.session.cancel.load(Ordering::SeqCst)
            || entry.session.detached.load(Ordering::SeqCst)
        {
            return false;
        }
        if table.path.is_none() {
            table.path = Some(path);
        }
        true
    }

    fn cached_interpreter(&self) -> Option<PathBuf> {
        self.lock().interpreter.clone()
    }

    fn store_interpreter(&self, path: PathBuf) {
        self.lock().interpreter = Some(path);
    }

    fn clear_interpreter(&self) {
        self.lock().interpreter = None;
    }

    fn user_programs(&self) -> Vec<PathBuf> {
        if let Some(path) = self.cached_interpreter() {
            if is_runnable(&path) {
                return vec![path];
            }
            self.clear_interpreter();
        }
        find_interpreters(USER_SHELLS)
    }

    fn remove(&self, id: &str) {
        let removed = self.lock().sessions.remove(id);
        drop(removed);
    }

    fn emit(&self, id: &str, event: ShellExecEvent) -> bool {
        let Some(session) = self.session(id) else {
            return false;
        };
        let terminal = matches!(
            event,
            ShellExecEvent::Exit { .. } | ShellExecEvent::Error { .. }
        );
        session.send_event(event, terminal)
    }

    fn finish_event(&self, id: &str, event: ShellExecEvent) {
        let Some(session) = self.session(id) else {
            return;
        };
        if session.detached.load(Ordering::SeqCst) || session.ended.load(Ordering::SeqCst) {
            return;
        }
        let _ = session.send_event(event, true);
    }

    fn finish_exit(&self, id: &str, code: Option<i32>, truncated: bool, reason: StopReason) {
        self.finish_event(
            id,
            ShellExecEvent::Exit {
                code,
                truncated,
                reason: reason.as_str().to_string(),
            },
        );
    }

    fn finish_error(&self, id: &str, message: &str) {
        self.finish_event(
            id,
            ShellExecEvent::Error {
                message: message.to_string(),
            },
        );
    }

    fn finish_cancel(&self, id: &str) {
        let truncated = self
            .session(id)
            .map(|session| session.snapshot().truncated)
            .unwrap_or(false);
        self.finish_exit(id, None, truncated, StopReason::Cancel);
    }

    fn note(&self, id: &str, reason: StopReason, truncate: bool) {
        if let Some(session) = self.session(id) {
            session.note(reason, truncate);
        }
    }

    fn stop_of(&self, id: &str) -> Option<StopState> {
        self.session(id).map(|session| session.snapshot())
    }

    fn install_kill(&self, id: &str, target: KillTarget) -> Install {
        let table = self.lock();
        let Some(entry) = table.sessions.get(id) else {
            return Install::Gone;
        };
        *entry.session.lock_kill() = Some(target);
        if entry.session.detached.load(Ordering::SeqCst) {
            return Install::Gone;
        }
        if entry.session.cancel.load(Ordering::SeqCst) {
            return Install::Cancelled;
        }
        Install::Running
    }

    fn cancel_id(&self, id: &str) {
        let target = {
            let mut table = self.lock();
            let Some(entry) = table.sessions.get_mut(id) else {
                return;
            };
            entry.phase = Phase::Stopping;
            entry.session.cancel.store(true, Ordering::SeqCst);
            entry.session.note(StopReason::Cancel, false);
            let target = entry.session.lock_kill().clone();
            target
        };
        if let Some(target) = target {
            kill_logged(id, StopReason::Cancel.as_str(), &target);
        }
    }

    fn detach_ids(&self, ids: &[String]) {
        let mut doomed = Vec::new();
        {
            let mut table = self.lock();
            for id in ids {
                let Some(mut entry) = table.sessions.remove(id) else {
                    continue;
                };
                entry.phase = Phase::Stopping;
                entry.session.mark_detached();
                let target = entry.session.lock_kill().clone();
                doomed.push((id.clone(), target, entry.session));
            }
        }
        for (id, target, session) in doomed {
            if let Some(target) = target {
                kill_logged(&id, StopReason::Cancel.as_str(), &target);
            }
            drop(session);
        }
    }

    fn detach_label(&self, label: &str) {
        let ids: Vec<String> = {
            let table = self.lock();
            table
                .sessions
                .iter()
                .filter(|(_, entry)| entry.session.label == label)
                .map(|(id, _)| id.clone())
                .collect()
        };
        self.detach_ids(&ids);
    }

    fn detach_all(&self) {
        let ids: Vec<String> = self.lock().sessions.keys().cloned().collect();
        self.detach_ids(&ids);
    }
}

enum Install {
    Running,
    Cancelled,
    Gone,
}

struct RemoveGuard {
    host: ShellHost,
    id: String,
}

impl Drop for RemoveGuard {
    fn drop(&mut self) {
        self.host.remove(&self.id);
    }
}

struct Live {
    child: Child,
    target: KillTarget,
    reaped: bool,
}

impl Drop for Live {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        let _ = terminate(&self.target);
        let _ = self.child.wait();
    }
}

impl Live {
    fn wait(&mut self) -> Result<ExitStatus, String> {
        match self.child.wait() {
            Ok(status) => {
                self.reaped = true;
                Ok(status)
            }
            Err(err) => {
                self.reaped = true;
                Err(err.to_string())
            }
        }
    }
}

enum DriveResult {
    Finished {
        code: Option<i32>,
        reason: StopReason,
        truncated: bool,
        stdout: String,
        stderr: String,
    },
    NotFound,
    Failed(String),
    Silent,
}

struct Chunk {
    stream: Stream,
    bytes: Vec<u8>,
}

fn read_pipe(mut reader: impl Read, tx: mpsc::Sender<Chunk>, stream: Stream) {
    let mut buf = [0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if tx
                    .send(Chunk {
                        stream,
                        bytes: buf[..n].to_vec(),
                    })
                    .is_err()
                {
                    break;
                }
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

struct PumpOut {
    silent: bool,
    reason: StopReason,
    truncated: bool,
    stdout: String,
    stderr: String,
}

fn emit_text(host: &ShellHost, id: &str, stream: Stream, text: &str) -> bool {
    if text.is_empty() {
        return true;
    }
    for event in fit_events(stream, text) {
        if !host.emit(id, event) {
            return false;
        }
    }
    true
}

fn pump(
    host: &ShellHost,
    id: &str,
    live: &Live,
    rx: mpsc::Receiver<Chunk>,
    deadline: Option<Instant>,
    record_stop: bool,
    capture: bool,
) -> PumpOut {
    let mut stdout_dec = Decoder {
        pending: Vec::new(),
    };
    let mut stderr_dec = Decoder {
        pending: Vec::new(),
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut total = 0usize;
    let mut reason = StopReason::Exit;
    let mut truncated = false;
    let mut sealed = false;
    let mut silent = false;
    let mut killed = false;

    let kill_now = |reason: StopReason, killed: &mut bool| {
        if !*killed {
            kill_logged(id, reason.as_str(), &live.target);
            *killed = true;
        }
    };

    loop {
        if !killed && (host.is_cancelled(id) || reason == StopReason::Cancel) {
            reason = StopReason::Cancel;
            kill_now(StopReason::Cancel, &mut killed);
            sealed = true;
        }
        if !killed {
            if let Some(deadline) = deadline {
                if Instant::now() >= deadline {
                    if record_stop {
                        host.note(id, StopReason::Timeout, false);
                    }
                    raise_reason(&mut reason, StopReason::Timeout);
                    kill_now(reason, &mut killed);
                    sealed = true;
                }
            }
        }
        let slice = match deadline {
            Some(deadline) if !killed => deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(50)),
            _ => Duration::from_millis(50),
        };
        match rx.recv_timeout(slice) {
            Ok(chunk) => {
                if sealed {
                    continue;
                }
                let crossed = note_collected_bytes(&mut total, chunk.bytes.len());
                let (decoder, captured) = match chunk.stream {
                    Stream::Stdout => (&mut stdout_dec, &mut stdout),
                    Stream::Stderr => (&mut stderr_dec, &mut stderr),
                };
                let text = decoder.push(&chunk.bytes, false);
                if capture {
                    captured.push_str(&text);
                } else if !text.is_empty() && !emit_text(host, id, chunk.stream, &text) {
                    silent = true;
                    sealed = true;
                    kill_now(reason, &mut killed);
                    continue;
                }
                if crossed {
                    let out_tail = stdout_dec.push(&[], true);
                    let err_tail = stderr_dec.push(&[], true);
                    if capture {
                        stdout.push_str(&out_tail);
                        stderr.push_str(&err_tail);
                    } else if !emit_text(host, id, Stream::Stdout, &out_tail)
                        || !emit_text(host, id, Stream::Stderr, &err_tail)
                    {
                        silent = true;
                    }
                    truncated = true;
                    if record_stop {
                        host.note(id, StopReason::Cap, true);
                    }
                    raise_reason(&mut reason, StopReason::Cap);
                    sealed = true;
                    kill_now(reason, &mut killed);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if killed && rx.try_recv().is_err() {
                    // Readers may still be blocked in `read` until the process dies.
                    // Keep looping; `Disconnected` ends the drain. A stuck kill is
                    // still waited on by the caller after this scope joins.
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if killed {
            match rx.try_recv() {
                Ok(chunk) => {
                    // Discard bytes after the kill. The pipe threads must be able to exit.
                    drop(chunk);
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
    }

    if !sealed && !silent {
        let out_tail = stdout_dec.push(&[], true);
        let err_tail = stderr_dec.push(&[], true);
        if capture {
            stdout.push_str(&out_tail);
            stderr.push_str(&err_tail);
        } else if !emit_text(host, id, Stream::Stdout, &out_tail)
            || !emit_text(host, id, Stream::Stderr, &err_tail)
        {
            silent = true;
            kill_now(reason, &mut killed);
        }
    }

    PumpOut {
        silent,
        reason,
        truncated,
        stdout,
        stderr,
    }
}

fn drive(
    host: &ShellHost,
    id: &str,
    program: &Path,
    args: &[String],
    cwd: &str,
    path_env: Option<&str>,
    timeout: Option<Duration>,
    record_stop: bool,
    capture: bool,
) -> DriveResult {
    if !program.exists() {
        return DriveResult::NotFound;
    }
    let spawned = match spawn_grouped(program, args, Some(cwd), path_env) {
        Ok(spawned) => spawned,
        Err(err) if err.kind() == ErrorKind::NotFound => return DriveResult::NotFound,
        Err(err) => {
            eprintln!("shell session {id} spawn failed reason=error: {err}");
            return DriveResult::Failed(err.to_string());
        }
    };
    let stdout = spawned.stdout;
    let stderr = spawned.stderr;
    let mut live = Live {
        child: spawned.child,
        target: spawned.target,
        reaped: false,
    };
    match host.install_kill(id, live.target.clone()) {
        Install::Gone => {
            kill_logged(id, StopReason::Cancel.as_str(), &live.target);
            let _ = live.wait();
            return DriveResult::Silent;
        }
        Install::Cancelled => {
            kill_logged(id, StopReason::Cancel.as_str(), &live.target);
            return match live.wait() {
                Ok(status) => DriveResult::Finished {
                    code: status.code(),
                    reason: StopReason::Cancel,
                    truncated: false,
                    stdout: String::new(),
                    stderr: String::new(),
                },
                Err(message) => DriveResult::Failed(message),
            };
        }
        Install::Running => {}
    }

    let deadline = timeout.map(|limit| Instant::now() + limit);
    let pumped = thread::scope(|scope| {
        let (tx, rx) = mpsc::channel();
        let stderr_tx = tx.clone();
        scope.spawn(move || read_pipe(stdout, tx, Stream::Stdout));
        scope.spawn(move || read_pipe(stderr, stderr_tx, Stream::Stderr));
        pump(host, id, &live, rx, deadline, record_stop, capture)
    });

    let code = match live.wait() {
        Ok(status) => status.code(),
        Err(message) => {
            if pumped.silent {
                return DriveResult::Silent;
            }
            return DriveResult::Failed(message);
        }
    };
    if pumped.silent || !host.alive(id) {
        return DriveResult::Silent;
    }
    let mut reason = pumped.reason;
    let mut truncated = pumped.truncated;
    if host.is_cancelled(id) {
        reason = StopReason::Cancel;
    }
    if record_stop {
        if let Some(stop) = host.stop_of(id) {
            raise_reason(&mut reason, stop.reason);
            truncated = truncated || stop.truncated;
        }
    }
    DriveResult::Finished {
        code,
        reason,
        truncated,
        stdout: pumped.stdout,
        stderr: pumped.stderr,
    }
}

enum Probe {
    Found(String),
    Miss,
    Cancelled,
    Silent,
}

fn interpret_probe(host: &ShellHost, id: &str, result: DriveResult) -> Option<Probe> {
    if !host.alive(id) {
        return Some(Probe::Silent);
    }
    if host.is_cancelled(id) {
        return Some(Probe::Cancelled);
    }
    match result {
        DriveResult::Silent => Some(Probe::Silent),
        DriveResult::NotFound | DriveResult::Failed(_) => None,
        DriveResult::Finished {
            code,
            reason,
            stdout,
            stderr,
            ..
        } => {
            if reason == StopReason::Cancel {
                return Some(Probe::Cancelled);
            }
            if reason != StopReason::Exit {
                return None;
            }
            match read_path(code, &stdout, &stderr) {
                Some(path) => {
                    if host.store_path(id, path.clone()) {
                        Some(Probe::Found(host.cached_path().unwrap_or(path)))
                    } else if host.is_cancelled(id) {
                        Some(Probe::Cancelled)
                    } else if !host.alive(id) {
                        Some(Probe::Silent)
                    } else {
                        None
                    }
                }
                None => None,
            }
        }
    }
}

async fn probe_path(host: &ShellHost, id: &str, cwd: &str) -> Probe {
    if let Some(path) = host.cached_path() {
        return Probe::Found(path);
    }
    for program in find_interpreters(LOGIN_SHELLS) {
        if host.is_cancelled(id) {
            return Probe::Cancelled;
        }
        if !host.alive(id) {
            return Probe::Silent;
        }
        let host_task = host.clone();
        let id_task = id.to_string();
        let cwd_task = cwd.to_string();
        let joined = tauri::async_runtime::spawn_blocking(move || {
            let args = probe_argv()
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            drive(
                &host_task,
                &id_task,
                &program,
                &args,
                &cwd_task,
                None,
                Some(PROBE_TIMEOUT),
                false,
                true,
            )
        })
        .await;
        let result = match joined {
            Ok(result) => result,
            Err(_) => return Probe::Silent,
        };
        if let Some(probe) = interpret_probe(host, id, result) {
            return probe;
        }
    }
    if host.is_cancelled(id) {
        Probe::Cancelled
    } else if !host.alive(id) {
        Probe::Silent
    } else {
        Probe::Miss
    }
}

async fn run_user(
    host: &ShellHost,
    id: &str,
    command: &str,
    cwd: &str,
    path_env: Option<String>,
    timeout: Option<Duration>,
) {
    if host.is_cancelled(id) {
        host.finish_cancel(id);
        return;
    }
    if !host.alive(id) {
        return;
    }
    host.set_phase(id, Phase::Running);
    let mut retried = false;
    loop {
        let programs = host.user_programs();
        if programs.is_empty() {
            host.finish_error(id, NO_SHELL);
            return;
        }
        let mut missed = false;
        for program in programs {
            if host.is_cancelled(id) {
                host.finish_cancel(id);
                return;
            }
            if !host.alive(id) {
                return;
            }
            let host_task = host.clone();
            let id_task = id.to_string();
            let program_task = program.clone();
            let command_task = command.to_string();
            let cwd_task = cwd.to_string();
            let path_task = path_env.clone();
            let joined = tauri::async_runtime::spawn_blocking(move || {
                let args = user_argv(&command_task);
                drive(
                    &host_task,
                    &id_task,
                    &program_task,
                    &args,
                    &cwd_task,
                    path_task.as_deref(),
                    timeout,
                    true,
                    false,
                )
            })
            .await;
            let result = match joined {
                Ok(result) => result,
                Err(_) => return,
            };
            match result {
                DriveResult::NotFound => {
                    missed = true;
                    continue;
                }
                DriveResult::Silent => return,
                DriveResult::Failed(message) => {
                    host.finish_error(id, &message);
                    return;
                }
                DriveResult::Finished {
                    code,
                    reason,
                    truncated,
                    ..
                } => {
                    let Some(stop) = host.stop_of(id) else {
                        return;
                    };
                    let mut reason = reason;
                    raise_reason(&mut reason, stop.reason);
                    if host.is_cancelled(id) {
                        reason = StopReason::Cancel;
                    }
                    let truncated = truncated || stop.truncated;
                    if matches!(reason, StopReason::Exit | StopReason::Cap) {
                        host.store_interpreter(program);
                    }
                    host.finish_exit(id, code, truncated, reason);
                    return;
                }
            }
        }
        if missed && !retried {
            retried = true;
            host.clear_interpreter();
            continue;
        }
        host.finish_error(id, NO_SHELL);
        return;
    }
}

async fn run_session(
    host: ShellHost,
    id: String,
    command: String,
    cwd: String,
    timeout: Option<Duration>,
) {
    if !host.alive(&id) {
        return;
    }
    host.set_phase(&id, Phase::Probing);
    let path_env = match probe_path(&host, &id, &cwd).await {
        Probe::Silent => return,
        Probe::Cancelled => {
            host.finish_cancel(&id);
            return;
        }
        Probe::Found(path) => Some(path),
        Probe::Miss => None,
    };
    run_user(&host, &id, &command, &cwd, path_env, timeout).await;
}

fn fresh_id(table: &Table) -> Result<String, String> {
    for _ in 0..4 {
        let id = random_id()?;
        if !table.sessions.contains_key(&id) {
            return Ok(id);
        }
    }
    random_id()
}

#[tauri::command]
pub async fn shell_exec_spawn(
    webview: Webview,
    state: State<'_, ShellHost>,
    command: String,
    cwd: String,
    timeout_ms: Option<f64>,
    on_event: Channel<ShellExecEvent>,
) -> Result<String, String> {
    check_command(&command)?;
    check_cwd(&cwd)?;
    let timeout = check_timeout(timeout_ms)?;
    let host = state.inner().clone();
    let label = webview.label().to_string();
    let id = {
        let mut table = host.lock();
        reject_if_full(table.sessions.len())?;
        let id = fresh_id(&table)?;
        let session = Arc::new(Session::new(label, on_event));
        table.sessions.insert(
            id.clone(),
            Entry {
                session,
                phase: Phase::Allocated,
            },
        );
        id
    };
    if !host.emit(&id, ShellExecEvent::Started { id: id.clone() }) {
        host.remove(&id);
        return Err(SESSION_ENDED.to_string());
    }
    let task_host = host.clone();
    let task_id = id.clone();
    let _join = tauri::async_runtime::spawn(async move {
        let _guard = RemoveGuard {
            host: task_host.clone(),
            id: task_id.clone(),
        };
        run_session(task_host, task_id, command, cwd, timeout).await;
    });
    Ok(id)
}

#[tauri::command]
pub async fn shell_exec_cancel(id: String, state: State<'_, ShellHost>) -> Result<(), String> {
    state.cancel_id(&id);
    Ok(())
}

pub fn cancel_label<R: Runtime>(manager: &impl Manager<R>, label: &str) {
    let Some(host) = manager.try_state::<ShellHost>() else {
        return;
    };
    host.detach_label(label);
}

pub fn cancel_all<R: Runtime>(manager: &impl Manager<R>) {
    let Some(host) = manager.try_state::<ShellHost>() else {
        return;
    };
    host.detach_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_cwd() {
        assert!(check_cwd("notes").is_err());
        assert!(check_cwd("./notes").is_err());
        assert!(check_cwd("../notes").is_err());
    }

    #[test]
    fn rejects_empty_cwd() {
        assert!(check_cwd("").is_err());
    }

    #[test]
    fn rejects_nul_in_cwd() {
        assert!(check_cwd("/tmp/vault\0hidden").is_err());
    }

    #[test]
    fn rejects_command_longer_than_256kb() {
        assert!(check_command(&"x".repeat(MAX_COMMAND_BYTES)).is_ok());
        assert!(check_command(&"x".repeat(MAX_COMMAND_BYTES + 1)).is_err());
    }

    #[test]
    fn probe_argv_second_arg_is_backslash_n_not_newline() {
        let args = probe_argv();
        assert_eq!(args[0], "-lic");
        let bytes = args[1].as_bytes();
        let sentinel = SENTINEL.as_bytes();
        let at = bytes
            .windows(sentinel.len())
            .position(|window| window == sentinel)
            .expect("sentinel");
        assert!(at >= 2);
        assert_eq!(&bytes[at - 2..at], &[0x5c, 0x6e]);
        assert_ne!(bytes[at - 2], 0x0a);
        let mut expected = Vec::new();
        expected.extend_from_slice(b"printf '");
        expected.extend_from_slice(&[0x5c, 0x6e]);
        expected.extend_from_slice(b"__STRIDE_PATH__%s' \"$PATH\"");
        assert_eq!(bytes, expected.as_slice());
    }

    #[test]
    fn user_argv_is_dash_c_and_command() {
        let command = "printf '%s' \"$HOME\"";
        assert_eq!(
            user_argv(command),
            vec!["-c".to_string(), command.to_string()]
        );
        let quoted = r#"echo "a\b" && printf '\n'"#;
        assert_eq!(
            user_argv(quoted),
            vec!["-c".to_string(), quoted.to_string()]
        );
    }

    #[test]
    fn stdout_event_json_is_shorter_than_8192() {
        let mut raw = String::with_capacity(READ_CHUNK);
        while raw.len() < READ_CHUNK {
            raw.push('"');
            if raw.len() < READ_CHUNK {
                raw.push('\\');
            }
        }
        assert_eq!(raw.len(), READ_CHUNK);
        let events = events_for_chunk(Stream::Stdout, raw.as_bytes());
        assert!(
            events.len() > 1,
            "escaped 4KB chunk must be split below 8192"
        );
        let mut joined = String::new();
        for event in &events {
            let json = serde_json::to_string(event).unwrap();
            assert!(
                json.len() < MAX_EVENT_JSON,
                "event json len {} is not < 8192: {json}",
                json.len()
            );
            assert!(json.contains("\"event\":\"stdout\""));
            match event {
                ShellExecEvent::Stdout { data } => joined.push_str(data),
                other => panic!("unexpected event {other:?}"),
            }
        }
        assert_eq!(joined, raw);

        let plain = "a".repeat(READ_CHUNK);
        let plain_events = events_for_chunk(Stream::Stdout, plain.as_bytes());
        assert_eq!(plain_events.len(), 1);
        let plain_json = serde_json::to_string(&plain_events[0]).unwrap();
        assert!(plain_json.len() < MAX_EVENT_JSON);
    }

    #[test]
    fn read_path_uses_last_sentinel() {
        assert_eq!(
            read_path(Some(1), "__STRIDE_PATH__/usr/bin", ""),
            None,
            "non-zero exit"
        );
        assert_eq!(read_path(None, "__STRIDE_PATH__/usr/bin", ""), None);
        assert_eq!(
            read_path(
                Some(0),
                "__STRIDE_PATH__/bad\n__STRIDE_PATH__  /usr/bin \r\nignored",
                "tail"
            )
            .as_deref(),
            Some("/usr/bin")
        );
        assert_eq!(
            read_path(Some(0), "hello", "pre __STRIDE_PATH__ /bin ").as_deref(),
            Some("/bin")
        );
        assert_eq!(read_path(Some(0), "__STRIDE_PATH__   \n", ""), None);
        assert_eq!(read_path(Some(0), "__STRIDE_PATH__", ""), None);
        assert_eq!(read_path(Some(0), "/usr/bin", "no marker"), None);
        assert_eq!(
            read_path(Some(0), "__STRIDE_PATH__/bin\r/still", "").as_deref(),
            Some("/bin\r/still")
        );
    }

    #[test]
    fn first_existing_interpreter_is_used() {
        let dir = std::env::temp_dir().join(format!(
            "stride-shell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing-shell");
        let found = dir.join("found-shell");
        let later = dir.join("later-shell");
        fs::write(&found, b"#!/bin/sh\n").unwrap();
        fs::write(&later, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&found, &later] {
                let mut permissions = fs::metadata(path).unwrap().permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(path, permissions).unwrap();
            }
        }
        let picked = first_existing(&[missing, found.clone(), later]);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(picked.unwrap(), found);
    }

    #[test]
    fn output_byte_count_sets_truncated_at_one_megabyte() {
        let mut total = 0usize;
        assert!(!note_collected_bytes(&mut total, MAX_COLLECT_BYTES - 1));
        assert!(note_collected_bytes(&mut total, 1));
        let mut total = 0usize;
        assert!(note_collected_bytes(&mut total, MAX_COLLECT_BYTES));
        assert!(note_collected_bytes(&mut total, 1));
    }

    #[test]
    fn reason_priority_keeps_cancel() {
        let mut reason = StopReason::Exit;
        raise_reason(&mut reason, StopReason::Cap);
        assert_eq!(reason, StopReason::Cap);
        raise_reason(&mut reason, StopReason::Timeout);
        assert_eq!(reason, StopReason::Timeout);
        raise_reason(&mut reason, StopReason::Cancel);
        assert_eq!(reason, StopReason::Cancel);
        raise_reason(&mut reason, StopReason::Cap);
        raise_reason(&mut reason, StopReason::Timeout);
        raise_reason(&mut reason, StopReason::Exit);
        assert_eq!(reason, StopReason::Cancel);
    }

    #[test]
    fn utf8_decoder_holds_incomplete_sequences() {
        let mut decoder = Decoder {
            pending: Vec::new(),
        };
        let bytes = "é".as_bytes();
        assert_eq!(decoder.push(&bytes[..1], false), "");
        assert_eq!(decoder.push(&bytes[1..], false), "é");
        let mut decoder = Decoder {
            pending: Vec::new(),
        };
        assert_eq!(decoder.push(&[0xff], false), "\u{FFFD}");
    }

    #[cfg(unix)]
    fn test_shell() -> PathBuf {
        for candidate in ["/bin/bash", "/bin/sh", "/usr/bin/bash", "/usr/bin/sh"] {
            let path = PathBuf::from(candidate);
            if is_runnable(&path) {
                return path;
            }
        }
        find_interpreters(&["bash", "sh"])
            .into_iter()
            .next()
            .expect("a login shell")
    }

    #[cfg(unix)]
    #[test]
    fn unix_echo_or_bash_returns_stdout() {
        let (program, args) = if is_runnable(Path::new("/bin/echo")) {
            (
                PathBuf::from("/bin/echo"),
                vec!["stride-shell-ok".to_string()],
            )
        } else {
            (test_shell(), user_argv("printf '%s' stride-shell-ok"))
        };
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_str().expect("temp dir utf-8");
        let mut spawned = spawn_grouped(&program, &args, Some(cwd), None).expect("spawn");
        let mut stdout_pipe = spawned.stdout;
        drop(spawned.stderr);
        let mut stdout = String::new();
        use std::io::Read;
        stdout_pipe
            .read_to_string(&mut stdout)
            .expect("read stdout");
        let status = spawned.child.wait().expect("wait");
        assert!(status.success(), "status {status}");
        assert!(stdout.contains("stride-shell-ok"), "stdout was {stdout:?}");
    }

    #[cfg(unix)]
    fn process_alive(pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        let rc = unsafe { libc::kill(pid, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[cfg(unix)]
    struct Reap {
        target: KillTarget,
        child: Option<Child>,
    }

    #[cfg(unix)]
    impl Drop for Reap {
        fn drop(&mut self) {
            let _ = terminate(&self.target);
            if let Some(mut child) = self.child.take() {
                let _ = child.wait();
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_killpg_reaps_sleep_descendants() {
        let shell = test_shell();
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_str().expect("temp dir utf-8");
        let args = user_argv("/bin/sleep 30 & echo $!; wait");
        let spawned = spawn_grouped(&shell, &args, Some(cwd), None).expect("spawn");
        let target = spawned.target.clone();
        let leader = spawned.child.id();
        let stdout = spawned.stdout;
        drop(spawned.stderr);
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut line = Vec::new();
            let mut byte = [0u8; 1];
            let mut pipe = stdout;
            loop {
                match pipe.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => {
                        if byte[0] == b'\n' {
                            break;
                        }
                        line.push(byte[0]);
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&line).trim().to_string());
        });
        let mut reap = Reap {
            target: target.clone(),
            child: Some(spawned.child),
        };
        let line = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("grandchild pid");
        let grand: i32 = line.parse().expect("pid integer");
        assert_ne!(grand as u32, leader);
        assert!(process_alive(grand), "sleep descendant was not running");
        terminate(&target).expect("killpg");
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_alive(grand) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let alive = process_alive(grand);
        let _ = reader.join();
        assert!(!alive, "sleep descendant still running after killpg");
        if let Some(mut child) = reap.child.take() {
            let _ = child.wait();
        }
    }

    #[cfg(windows)]
    fn process_exit_code(pid: u32) -> Option<u32> {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let _ = STILL_ACTIVE;
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            if ok == 0 {
                None
            } else {
                Some(code)
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_kills_grandchild() {
        let Some(bash) = find_interpreters(&["bash.exe"]).into_iter().next() else {
            eprintln!(
                "windows_job_kills_grandchild skipped: bash.exe not found on PATH or Git\\bin"
            );
            return;
        };
        let cwd = std::env::temp_dir();
        let Some(cwd) = cwd.to_str() else {
            eprintln!("windows_job_kills_grandchild skipped: temp dir is not utf-8");
            return;
        };
        let script = "sleep 30 &\nchild=$!\nif [ -r \"/proc/$child/winpid\" ]; then cat \"/proc/$child/winpid\"; else echo \"$child\"; fi\nwait\n";
        let args = user_argv(script);
        let mut spawned = match spawn_grouped(Path::new(&bash), &args, Some(cwd), None) {
            Ok(spawned) => spawned,
            Err(err) => panic!("spawn bash: {err}"),
        };
        let stdout = spawned.stdout;
        drop(spawned.stderr);
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut line = Vec::new();
            let mut byte = [0u8; 1];
            let mut pipe = stdout;
            loop {
                match pipe.read(&mut byte) {
                    Ok(0) => break,
                    Ok(_) => {
                        if byte[0] == b'\n' || byte[0] == b'\r' {
                            break;
                        }
                        line.push(byte[0]);
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&line).trim().to_string());
        });
        let target = spawned.target.clone();
        let mut child = spawned.child;
        let line = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => line,
            Err(_) => {
                kill_logged("test", "cancel", &target);
                let _ = child.wait();
                let _ = reader.join();
                panic!("grandchild pid was not printed");
            }
        };
        let grand: u32 = match line.parse() {
            Ok(pid) => pid,
            Err(_) => {
                kill_logged("test", "cancel", &target);
                let _ = child.wait();
                let _ = reader.join();
                panic!("grandchild pid {line:?} was not an integer");
            }
        };
        let still_active = 259u32;
        assert_eq!(
            process_exit_code(grand),
            Some(still_active),
            "grandchild was not running before TerminateJobObject"
        );
        terminate(&target).expect("TerminateJobObject");
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_exit_code(grand) == Some(still_active) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(30));
        }
        let code = process_exit_code(grand);
        let _ = child.wait();
        let _ = reader.join();
        assert_ne!(
            code,
            Some(still_active),
            "grandchild still running after TerminateJobObject"
        );
    }
}
