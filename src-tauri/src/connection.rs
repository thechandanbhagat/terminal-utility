use serde::Serialize;
use ssh2::Session;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

pub enum SessionInput {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

#[derive(Serialize, Clone)]
pub struct SshOutputPayload {
    pub session_id: String,
    pub data: String,
}

pub struct SshConnection {
    pub session: Arc<Mutex<Session>>,
    pub tcp: TcpStream,
    pub write_tx: tokio::sync::mpsc::Sender<SessionInput>,
    pub should_exit: Arc<AtomicBool>,
}

impl SshConnection {
    pub fn disconnect(&self) {
        self.should_exit.store(true, Ordering::Relaxed);
        let _ = self.tcp.shutdown(std::net::Shutdown::Both);
    }
}
