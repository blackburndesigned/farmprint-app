//! Shop owner's Supabase Auth session `{access_token, refresh_token, user_id, email, expires_at}`
//! (`expires_at` = unix seconds).
//!
//! Where it lives: Windows Credential Manager when the `keychain` feature is on, else
//! `<data_dir>/shop_session.json` (0600 on Mac/Linux). macOS is file-only for now: the
//! unsigned Mac app would prompt for Keychain access after every update, so the first-read
//! file-to-keychain migration does not run there. On Windows, the first read with a
//! keychain available moves an existing session file into Credential Manager and moves the
//! file aside as `shop_session.migrated.json` with its tokens blanked. If the store refuses
//! a write, the 0600 file is used instead.
//!
//! Tokens are never logged or returned to the UI; only `email`, `user_id` and status are.
//! HTTP lives behind [`AuthClient`] so the logic is testable without the network.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const SESSION_FILE: &str = "shop_session.json";
/// Where a session file goes after its tokens moved into the keychain (tokens blanked).
pub const MIGRATED_SESSION_FILE: &str = "shop_session.migrated.json";
/// Keychain service name; the account is the shop data folder, so two shops never share a session.
pub const KEYCHAIN_SERVICE: &str = "FarmPrint shop session";
/// Refresh this many seconds before the token actually expires.
pub const EXPIRY_SKEW_SECS: i64 = 60;

pub const SIGN_IN_AGAIN_MESSAGE: &str =
    "Your shop sign-in has expired. Sign in again in Settings › Store.";
pub const OFFLINE_MESSAGE: &str =
    "Can't reach the shop right now. Check the internet connection and try again.";

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct ShopSession {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// Debug without secrets.
impl std::fmt::Debug for ShopSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShopSession")
            .field("user_id", &self.user_id)
            .field("email", &self.email)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl ShopSession {
    pub fn is_expired(&self, now: i64) -> bool {
        matches!(self.expires_at, Some(t) if now >= t - EXPIRY_SKEW_SECS)
    }

    /// Parse a Supabase `/auth/v1/token` response.
    pub fn from_token_response(v: &Value, now: i64) -> Result<Self, String> {
        let access_token = v
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if access_token.is_empty() {
            return Err("Sign-in response had no session".into());
        }
        let expires_at = v
            .get("expires_at")
            .and_then(Value::as_i64)
            .or_else(|| v.get("expires_in").and_then(Value::as_i64).map(|s| now + s));
        let user = v.get("user");
        Ok(Self {
            access_token,
            refresh_token: v
                .get("refresh_token")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            user_id: user
                .and_then(|u| u.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            email: user
                .and_then(|u| u.get("email"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            expires_at,
        })
    }

    /// Status safe to show in the UI (no tokens).
    pub fn public_status(&self, now: i64) -> Value {
        json!({"signed_in": true, "email": self.email, "user_id": self.user_id,
               "expires_at": self.expires_at, "expired": self.is_expired(now)})
    }

    /// Same session with both tokens blanked (what a moved-aside file keeps).
    fn redacted(&self) -> Self {
        Self {
            access_token: String::new(),
            refresh_token: String::new(),
            ..self.clone()
        }
    }
}

// --- Storage ---------------------------------------------------------------------------

/// One secret slot (the OS keychain in the app, a fake in tests).
pub trait SecretStore {
    /// `Ok(None)` = nothing stored.
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, secret: &str) -> Result<(), String>;
    /// Deleting nothing is fine.
    fn delete(&self) -> Result<(), String>;
}

#[cfg(all(feature = "keychain", target_os = "windows"))]
mod os_keychain {
    pub struct OsKeychain(keyring::Entry);

    impl OsKeychain {
        pub fn new(account: &str) -> Option<Self> {
            keyring::Entry::new(super::KEYCHAIN_SERVICE, account)
                .ok()
                .map(Self)
        }
    }

    // Errors carry the keychain's own words only; never the secret.
    impl super::SecretStore for OsKeychain {
        fn get(&self) -> Result<Option<String>, String> {
            match self.0.get_secret() {
                Ok(b) => String::from_utf8(b)
                    .map(Some)
                    .map_err(|_| "keychain entry is not text".to_string()),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("keychain read failed: {e}")),
            }
        }
        fn set(&self, secret: &str) -> Result<(), String> {
            self.0
                .set_secret(secret.as_bytes())
                .map_err(|e| format!("keychain write failed: {e}"))
        }
        fn delete(&self) -> Result<(), String> {
            match self.0.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("keychain delete failed: {e}")),
            }
        }
    }
}

/// The OS keychain for this shop folder, when this build and platform have one.
#[allow(unused_variables)]
pub fn os_keychain(data_dir: &Path) -> Option<Box<dyn SecretStore>> {
    #[cfg(all(feature = "keychain", target_os = "windows"))]
    {
        if let Some(k) = os_keychain::OsKeychain::new(&data_dir.to_string_lossy()) {
            return Some(Box::new(k));
        }
    }
    None
}

/// Session storage for one shop folder: keychain first, 0600 file as the fallback.
pub struct SessionStore {
    dir: PathBuf,
    keychain: Option<Box<dyn SecretStore>>,
}

impl SessionStore {
    /// Keychain when available (see [`os_keychain`]), else file only.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.to_path_buf(),
            keychain: os_keychain(data_dir),
        }
    }
    pub fn file_only(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.to_path_buf(),
            keychain: None,
        }
    }
    pub fn with_keychain(data_dir: &Path, keychain: Box<dyn SecretStore>) -> Self {
        Self {
            dir: data_dir.to_path_buf(),
            keychain: Some(keychain),
        }
    }
    pub fn uses_keychain(&self) -> bool {
        self.keychain.is_some()
    }

    fn file_path(&self) -> PathBuf {
        session_path(&self.dir)
    }

    fn parse(s: &str) -> Option<ShopSession> {
        let sess: ShopSession = serde_json::from_str(s).ok()?;
        if sess.access_token.trim().is_empty() {
            None
        } else {
            Some(sess)
        }
    }

    fn read_file(&self) -> Option<ShopSession> {
        Self::parse(&std::fs::read_to_string(self.file_path()).ok()?)
    }

    fn write_file(&self, s: &ShopSession) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let path = self.file_path();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    /// Moves the plaintext file aside (never deleted) and blanks the tokens in the moved copy.
    fn move_file_aside(&self, s: &ShopSession) {
        let dest = self.dir.join(MIGRATED_SESSION_FILE);
        if std::fs::rename(self.file_path(), &dest).is_ok() {
            if let Ok(body) = serde_json::to_vec_pretty(&s.redacted()) {
                let _ = std::fs::write(&dest, body);
            }
        }
    }

    /// Stores `s` in the keychain and confirms it reads back the same.
    fn keychain_put(&self, s: &ShopSession) -> Result<(), String> {
        let k = self.keychain.as_ref().ok_or("no keychain")?;
        let body = serde_json::to_string(s).map_err(|e| e.to_string())?;
        k.set(&body)?;
        match k.get()? {
            Some(b) if b == body => Ok(()),
            _ => Err("keychain did not keep the session".into()),
        }
    }

    /// Missing, unreadable or token-less = not signed in. Migrates a session file on first read.
    pub fn read(&self) -> Option<ShopSession> {
        if let Some(k) = &self.keychain {
            if let Ok(Some(body)) = k.get() {
                if let Some(s) = Self::parse(&body) {
                    return Some(s);
                }
            }
        }
        let s = self.read_file()?;
        if self.keychain.is_some() && self.keychain_put(&s).is_ok() {
            self.move_file_aside(&s);
        }
        Some(s)
    }

    pub fn write(&self, s: &ShopSession) -> Result<(), String> {
        if self.keychain.is_some() {
            match self.keychain_put(s) {
                Ok(()) => {
                    if self.file_path().exists() {
                        self.move_file_aside(s);
                    }
                    return Ok(());
                }
                Err(e) => eprintln!("[shop session] {e}; using the local session file instead"),
            }
        }
        self.write_file(s)
    }

    /// Sign out: clears the keychain entry and the session file.
    pub fn delete(&self) -> Result<(), String> {
        if let Some(k) = &self.keychain {
            k.delete()?;
        }
        match std::fs::remove_file(self.file_path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub fn session_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SESSION_FILE)
}

/// [`SessionStore::new`]`(data_dir).read()`.
pub fn read_session(data_dir: &Path) -> Option<ShopSession> {
    SessionStore::new(data_dir).read()
}
pub fn write_session(data_dir: &Path, s: &ShopSession) -> Result<(), String> {
    SessionStore::new(data_dir).write(s)
}
pub fn delete_session(data_dir: &Path) -> Result<(), String> {
    SessionStore::new(data_dir).delete()
}

// --- Auth --------------------------------------------------------------------------------

/// Why a token request failed.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthError {
    /// No answer (offline, DNS, timeout).
    Unreachable(String),
    /// The server answered with an error status; `message` is the server's own short text.
    Rejected { status: u16, message: String },
}

impl AuthError {
    /// Worth retrying later rather than signing in again (offline, rate limit, server trouble).
    pub fn is_temporary(&self) -> bool {
        match self {
            AuthError::Unreachable(_) => true,
            AuthError::Rejected { status, .. } => *status == 429 || *status >= 500,
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::Unreachable(e) => write!(f, "could not reach the shop ({e})"),
            AuthError::Rejected { status, message } => write!(f, "HTTP {status}: {message}"),
        }
    }
}

/// POST `{url}/auth/v1/token?grant_type=<grant>` with `apikey`; returns the JSON body.
pub trait AuthClient {
    fn token(&self, grant_type: &str, body: &Value) -> Result<Value, AuthError>;
}

/// Why there is no usable session right now.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionError {
    /// Refresh could not reach the shop (or the shop had trouble). Keep the session; retry later.
    Offline(String),
    /// The shop turned the refresh down. The user has to sign in again.
    SignInAgain(String),
    /// Saving the refreshed session failed.
    Storage(String),
}

impl SessionError {
    pub fn is_offline(&self) -> bool {
        matches!(self, SessionError::Offline(_))
    }
    pub fn needs_sign_in(&self) -> bool {
        matches!(self, SessionError::SignInAgain(_))
    }
    pub fn message(&self) -> &str {
        match self {
            SessionError::Offline(m) | SessionError::SignInAgain(m) | SessionError::Storage(m) => m,
        }
    }
    fn from_refresh(e: &AuthError) -> Self {
        eprintln!("[shop session] refresh failed: {e}");
        if e.is_temporary() {
            SessionError::Offline(OFFLINE_MESSAGE.into())
        } else {
            SessionError::SignInAgain(SIGN_IN_AGAIN_MESSAGE.into())
        }
    }
    /// `{connected, signed_in, offline, imported: 0, message}` for an import that could not start.
    pub fn import_result(&self) -> Value {
        json!({"connected": true, "signed_in": !self.needs_sign_in(), "offline": self.is_offline(),
               "imported": 0, "message": self.message()})
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}
impl From<SessionError> for String {
    fn from(e: SessionError) -> String {
        e.message().to_string()
    }
}

pub fn sign_in(
    client: &dyn AuthClient,
    store: &SessionStore,
    email: &str,
    password: &str,
    now: i64,
) -> Result<ShopSession, String> {
    let email = email.trim();
    if email.is_empty() || password.is_empty() {
        return Err("Enter your shop account email and password.".into());
    }
    let v = client
        .token("password", &json!({"email": email, "password": password}))
        .map_err(|e| match e {
            AuthError::Unreachable(_) => OFFLINE_MESSAGE.to_string(),
            AuthError::Rejected { status: 400, .. } | AuthError::Rejected { status: 401, .. } => {
                "That email and password didn't work. Check them and try again.".to_string()
            }
            AuthError::Rejected { status, message } => {
                format!("Sign-in failed (HTTP {status}): {message}")
            }
        })?;
    let mut s = ShopSession::from_token_response(&v, now)?;
    if s.email.is_none() {
        s.email = Some(email.to_string());
    }
    store.write(&s)?;
    Ok(s)
}

/// Swaps the refresh token for a new session and saves it. `old` fills fields the reply omits.
fn refresh_with(
    client: &dyn AuthClient,
    store: &SessionStore,
    old: &ShopSession,
    now: i64,
) -> Result<ShopSession, SessionError> {
    if old.refresh_token.trim().is_empty() {
        return Err(SessionError::SignInAgain(SIGN_IN_AGAIN_MESSAGE.into()));
    }
    let v = client
        .token(
            "refresh_token",
            &json!({"refresh_token": old.refresh_token}),
        )
        .map_err(|e| SessionError::from_refresh(&e))?;
    let mut n = ShopSession::from_token_response(&v, now)
        .map_err(|_| SessionError::SignInAgain(SIGN_IN_AGAIN_MESSAGE.into()))?;
    if n.refresh_token.is_empty() {
        n.refresh_token = old.refresh_token.clone();
    }
    if n.user_id.is_none() {
        n.user_id = old.user_id.clone();
    }
    if n.email.is_none() {
        n.email = old.email.clone();
    }
    store.write(&n).map_err(SessionError::Storage)?;
    Ok(n)
}

/// Current session, refreshed (and re-saved) if expired. A failed refresh leaves the stored
/// session alone: offline -> [`SessionError::Offline`], turned down -> [`SessionError::SignInAgain`].
pub fn valid_session(
    client: &dyn AuthClient,
    store: &SessionStore,
    now: i64,
) -> Result<Option<ShopSession>, SessionError> {
    let Some(s) = store.read() else {
        return Ok(None);
    };
    if !s.is_expired(now) {
        return Ok(Some(s));
    }
    refresh_with(client, store, &s, now).map(Some)
}

/// Refresh now, even if the stored token has not expired yet (the shop answered 401).
pub fn force_refresh(
    client: &dyn AuthClient,
    store: &SessionStore,
    now: i64,
) -> Result<ShopSession, SessionError> {
    let s = store
        .read()
        .ok_or_else(|| SessionError::SignInAgain(SIGN_IN_AGAIN_MESSAGE.into()))?;
    refresh_with(client, store, &s, now)
}

#[cfg(feature = "supabase")]
pub struct SupabaseAuth {
    base_url: String,
    anon_key: String,
    client: reqwest::blocking::Client,
}

#[cfg(feature = "supabase")]
impl SupabaseAuth {
    pub fn new(supabase_url: &str, anon_key: &str) -> Result<Self, String> {
        let base_url = supabase_url.trim().trim_end_matches('/').to_string();
        let anon_key = anon_key.trim().to_string();
        if base_url.is_empty() || anon_key.is_empty() {
            return Err("No shop connected.".into());
        }
        if !base_url.starts_with("https://") {
            return Err("The shop server address must start with https://".into());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            base_url,
            anon_key,
            client,
        })
    }
}

#[cfg(feature = "supabase")]
impl AuthClient for SupabaseAuth {
    fn token(&self, grant_type: &str, body: &Value) -> Result<Value, AuthError> {
        let url = format!("{}/auth/v1/token?grant_type={grant_type}", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("apikey", &self.anon_key)
            .json(body)
            .send()
            .map_err(|e| AuthError::Unreachable(e.without_url().to_string()))?;
        let st = resp.status();
        let v: Value = resp.json().unwrap_or(Value::Null);
        if st.is_success() {
            return Ok(v);
        }
        // Only the server's message, never the request body.
        let msg = v
            .get("error_description")
            .or_else(|| v.get("msg"))
            .or_else(|| v.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("request failed");
        Err(AuthError::Rejected {
            status: st.as_u16(),
            message: msg.chars().take(200).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    struct Fake {
        reply: Result<Value, AuthError>,
        calls: RefCell<Vec<(String, Value)>>,
    }
    impl AuthClient for Fake {
        fn token(&self, g: &str, b: &Value) -> Result<Value, AuthError> {
            self.calls.borrow_mut().push((g.into(), b.clone()));
            self.reply.clone()
        }
    }
    fn fake(r: Result<Value, AuthError>) -> Fake {
        Fake {
            reply: r,
            calls: RefCell::new(vec![]),
        }
    }
    fn offline() -> AuthError {
        AuthError::Unreachable("dns".into())
    }
    fn rejected(status: u16) -> AuthError {
        AuthError::Rejected {
            status,
            message: "nope".into(),
        }
    }
    fn dir(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fp-session-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
    fn file(d: &Path) -> SessionStore {
        SessionStore::file_only(d)
    }
    fn resp(tok: &str, refresh: &str, exp_in: i64) -> Value {
        json!({"access_token": tok, "refresh_token": refresh, "expires_in": exp_in,
               "user": {"id": "u1", "email": "a@b.c"}})
    }

    /// In-memory keychain; `fail_writes` simulates a locked or refusing keychain.
    #[derive(Clone, Default)]
    struct FakeKeychain {
        slot: Rc<RefCell<Option<String>>>,
        fail_writes: bool,
    }
    impl SecretStore for FakeKeychain {
        fn get(&self) -> Result<Option<String>, String> {
            Ok(self.slot.borrow().clone())
        }
        fn set(&self, v: &str) -> Result<(), String> {
            if self.fail_writes {
                return Err("locked".into());
            }
            *self.slot.borrow_mut() = Some(v.into());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            *self.slot.borrow_mut() = None;
            Ok(())
        }
    }

    #[test]
    fn write_read_delete_roundtrip() {
        let d = dir("rt");
        let st = file(&d);
        assert!(st.read().is_none());
        let s = ShopSession {
            access_token: "t".into(),
            refresh_token: "r".into(),
            user_id: Some("u".into()),
            email: None,
            expires_at: Some(100),
        };
        st.write(&s).unwrap();
        assert_eq!(st.read(), Some(s));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(session_path(&d))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        st.delete().unwrap();
        assert!(st.read().is_none());
        st.delete().unwrap(); // idempotent
    }

    #[test]
    fn empty_or_bad_file_is_signed_out() {
        let d = dir("bad");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(session_path(&d), "{\"access_token\":\" \"}").unwrap();
        assert!(file(&d).read().is_none());
        std::fs::write(session_path(&d), "not json").unwrap();
        assert!(file(&d).read().is_none());
        // Old file shape (access_token + user_id only) still reads.
        std::fs::write(
            session_path(&d),
            "{\"access_token\":\"t\",\"user_id\":\"u\"}",
        )
        .unwrap();
        assert_eq!(file(&d).read().unwrap().expires_at, None);
    }

    #[test]
    fn keychain_store_keeps_tokens_out_of_files() {
        let d = dir("kc");
        let kc = FakeKeychain::default();
        let st = SessionStore::with_keychain(&d, Box::new(kc.clone()));
        let s = ShopSession::from_token_response(&resp("SECRET", "RSECRET", 10), 0).unwrap();
        st.write(&s).unwrap();
        assert!(!session_path(&d).exists());
        assert!(kc.slot.borrow().as_deref().unwrap().contains("SECRET"));
        assert_eq!(st.read(), Some(s));
        st.delete().unwrap();
        assert!(kc.slot.borrow().is_none());
        assert!(st.read().is_none());
    }

    #[test]
    fn existing_session_file_moves_into_keychain_on_first_read() {
        let d = dir("mig");
        let s = ShopSession::from_token_response(&resp("SECRET", "RSECRET", 10), 0).unwrap();
        file(&d).write(&s).unwrap();
        let kc = FakeKeychain::default();
        let st = SessionStore::with_keychain(&d, Box::new(kc.clone()));
        assert_eq!(st.read(), Some(s.clone()));
        assert!(kc.slot.borrow().is_some());
        // The file is moved aside, not deleted, and the moved copy has no tokens.
        assert!(!session_path(&d).exists());
        let moved = std::fs::read_to_string(d.join(MIGRATED_SESSION_FILE)).unwrap();
        assert!(!moved.contains("SECRET"));
        assert!(moved.contains("a@b.c"));
        // Later reads come from the keychain.
        assert_eq!(st.read(), Some(s));
    }

    #[test]
    fn refusing_keychain_falls_back_to_the_file() {
        let d = dir("kcfail");
        let st = SessionStore::with_keychain(
            &d,
            Box::new(FakeKeychain {
                fail_writes: true,
                ..Default::default()
            }),
        );
        let s = ShopSession::from_token_response(&resp("t", "r", 10), 0).unwrap();
        st.write(&s).unwrap();
        assert!(session_path(&d).exists());
        assert_eq!(st.read(), Some(s)); // read from file; migration fails quietly and keeps the file
        assert!(session_path(&d).exists());
    }

    #[test]
    fn sign_in_saves_session_and_uses_password_grant() {
        let d = dir("si");
        let f = fake(Ok(resp("t1", "r1", 3600)));
        let s = sign_in(&f, &file(&d), " a@b.c ", "pw", 1000).unwrap();
        assert_eq!(s.expires_at, Some(4600));
        assert_eq!(s.user_id.as_deref(), Some("u1"));
        assert_eq!(f.calls.borrow()[0].0, "password");
        assert_eq!(f.calls.borrow()[0].1["email"], "a@b.c");
        assert_eq!(file(&d).read().unwrap().access_token, "t1");
    }

    #[test]
    fn failed_sign_in_writes_nothing_and_explains() {
        let d = dir("sf");
        let st = file(&d);
        assert_eq!(
            sign_in(&fake(Err(rejected(400))), &st, "a@b.c", "pw", 0).unwrap_err(),
            "That email and password didn't work. Check them and try again."
        );
        assert_eq!(
            sign_in(&fake(Err(offline())), &st, "a@b.c", "pw", 0).unwrap_err(),
            OFFLINE_MESSAGE
        );
        assert!(sign_in(&fake(Ok(json!({}))), &st, "a@b.c", "pw", 0).is_err());
        assert!(sign_in(&fake(Ok(resp("t", "r", 1))), &st, "", "pw", 0).is_err());
        assert!(st.read().is_none());
    }

    #[test]
    fn fresh_session_is_not_refreshed() {
        let d = dir("fresh");
        file(&d)
            .write(&ShopSession::from_token_response(&resp("t", "r", 3600), 0).unwrap())
            .unwrap();
        let f = fake(Ok(resp("new", "r2", 3600)));
        assert_eq!(
            valid_session(&f, &file(&d), 100)
                .unwrap()
                .unwrap()
                .access_token,
            "t"
        );
        assert!(f.calls.borrow().is_empty());
    }

    #[test]
    fn expired_session_refreshes_and_saves() {
        let d = dir("exp");
        file(&d)
            .write(&ShopSession::from_token_response(&resp("t", "r", 3600), 0).unwrap())
            .unwrap();
        let f = fake(Ok(json!({"access_token": "new", "expires_in": 3600})));
        let now = 3600 - EXPIRY_SKEW_SECS; // inside the skew window
        let s = valid_session(&f, &file(&d), now).unwrap().unwrap();
        assert_eq!(
            f.calls.borrow()[0],
            ("refresh_token".to_string(), json!({"refresh_token": "r"}))
        );
        assert_eq!(s.access_token, "new");
        assert_eq!(s.refresh_token, "r"); // kept when not rotated
        assert_eq!(s.user_id.as_deref(), Some("u1"));
        assert_eq!(file(&d).read().unwrap().access_token, "new");
    }

    #[test]
    fn failed_refresh_keeps_session_and_says_why() {
        let d = dir("ff");
        file(&d)
            .write(&ShopSession::from_token_response(&resp("t", "r", 10), 0).unwrap())
            .unwrap();
        // Offline is not "sign in again".
        let e = valid_session(&fake(Err(offline())), &file(&d), 1000).unwrap_err();
        assert!(e.is_offline() && !e.needs_sign_in());
        assert_eq!(e.import_result()["signed_in"], json!(true));
        assert_eq!(e.import_result()["offline"], json!(true));
        assert!(valid_session(&fake(Err(rejected(503))), &file(&d), 1000)
            .unwrap_err()
            .is_offline());
        // A turned-down refresh token is.
        let e = valid_session(&fake(Err(rejected(400))), &file(&d), 1000).unwrap_err();
        assert!(e.needs_sign_in());
        assert_eq!(e.import_result()["signed_in"], json!(false));
        assert_eq!(file(&d).read().unwrap().access_token, "t");
        assert!(valid_session(&fake(Ok(json!({}))), &file(&dir("none")), 0)
            .unwrap()
            .is_none());
    }

    #[test]
    fn force_refresh_ignores_expiry() {
        let d = dir("force");
        file(&d)
            .write(&ShopSession::from_token_response(&resp("t", "r", 3600), 0).unwrap())
            .unwrap();
        let f = fake(Ok(json!({"access_token": "new", "expires_in": 3600})));
        assert_eq!(
            force_refresh(&f, &file(&d), 10).unwrap().access_token,
            "new"
        );
        assert_eq!(f.calls.borrow().len(), 1);
        assert!(force_refresh(&f, &file(&dir("force-none")), 10)
            .unwrap_err()
            .needs_sign_in());
    }

    #[test]
    fn debug_and_status_hide_tokens() {
        let s = ShopSession::from_token_response(&resp("SECRET", "RSECRET", 10), 0).unwrap();
        assert!(!format!("{s:?}").contains("SECRET"));
        assert!(!s.public_status(0).to_string().contains("SECRET"));
    }
}
