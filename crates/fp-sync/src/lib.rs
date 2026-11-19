pub mod catalog;
pub mod contracts;
pub mod economics;
pub mod publish;
pub mod session;
pub mod shipping;
pub mod store_ingest;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncStatus {
    pub connected: bool,
    pub endpoint: String,
    pub last_synced_at: String,
    pub pending_changes: usize,
}

#[cfg(feature = "supabase")]
pub mod supabase;
