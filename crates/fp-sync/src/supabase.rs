//! Real `store_catalog` uploader over Supabase REST (PostgREST), feature `supabase`.
//!
//! Auth: `apikey: <anon key>` + `Authorization: Bearer <shop owner's signed-in user JWT>`.
//! Never a service key, never the anon key as the bearer for writes: the shop database's
//! row-level security should let only the owning `authenticated` user write the catalog row.
//! No secrets live in code; URL, anon key and JWT are passed in by the caller.

use crate::publish::{CatalogRow, CatalogUploader, PublishError, CATALOG_ROW_ID};
use serde_json::{json, Value};
use std::cell::RefCell;

/// Gets a fresh owner token after the shop answered 401 (the app refreshes the saved session).
pub type TokenRefresher = Box<dyn Fn() -> Result<String, String>>;

/// Plain words for a failed shop request. The response body goes to the log only (capped,
/// never request headers or tokens), so the UI never shows raw server JSON.
pub fn shop_http_error(status: u16, body: &str) -> String {
    let snippet: String = body.chars().take(300).collect();
    eprintln!("[shop] HTTP {status}: {snippet}");
    match status {
        401 => crate::session::SIGN_IN_AGAIN_MESSAGE.to_string(),
        403 => "This shop account isn't allowed to do that. Sign in with the shop owner's account in Settings › Store.".into(),
        404 => "The shop is missing something FarmPrint needs (HTTP 404). Check the shop server address in Settings › Store.".into(),
        429 | 500..=599 => format!("The shop server is having trouble right now (HTTP {status}). Try again in a minute."),
        _ => format!("The shop turned down the request (HTTP {status})."),
    }
}

/// Sends with the current token; on 401, refreshes once (when a refresher is set) and resends.
fn send_with_refresh(
    token: &RefCell<String>,
    refresher: Option<&TokenRefresher>,
    build: impl Fn(&str) -> reqwest::blocking::RequestBuilder,
) -> Result<reqwest::blocking::Response, String> {
    let send = |t: &str| {
        build(t).send().map_err(|e| {
            eprintln!("[shop] request failed: {}", e.without_url());
            crate::session::OFFLINE_MESSAGE.to_string()
        })
    };
    let first = send(&token.borrow())?;
    if first.status().as_u16() != 401 {
        return Ok(first);
    }
    let Some(refresh) = refresher else {
        return Ok(first);
    };
    let fresh = refresh()?;
    if fresh.trim().is_empty() {
        return Ok(first);
    }
    *token.borrow_mut() = fresh;
    send(&token.borrow())
}

pub struct SupabaseUploader {
    base_url: String,
    anon_key: String,
    user_jwt: RefCell<String>,
    refresher: Option<TokenRefresher>,
    /// Owner's auth uid; written to `owner_id` when the column exists (see proposal). Optional.
    owner_id: Option<String>,
    client: reqwest::blocking::Client,
}

impl SupabaseUploader {
    pub fn new(
        supabase_url: &str,
        anon_key: &str,
        user_jwt: &str,
        owner_id: Option<String>,
    ) -> Result<Self, PublishError> {
        let base_url = supabase_url.trim().trim_end_matches('/').to_string();
        let (anon_key, user_jwt) = (anon_key.trim().to_string(), user_jwt.trim().to_string());
        if base_url.is_empty() || anon_key.is_empty() {
            return Err(PublishError::Uploader(
                "no shop connected (Supabase URL / anon key missing)".into(),
            ));
        }
        if user_jwt.is_empty() {
            return Err(PublishError::Uploader(
                "not signed in to the shop account".into(),
            ));
        }
        if !base_url.starts_with("https://") {
            return Err(PublishError::Uploader("Supabase URL must be https".into()));
        }
        if user_jwt == anon_key {
            return Err(PublishError::Uploader(
                "a signed-in user session is required, not the anon key".into(),
            ));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| PublishError::Uploader(e.to_string()))?;
        Ok(Self {
            base_url,
            anon_key,
            user_jwt: RefCell::new(user_jwt),
            refresher: None,
            owner_id,
            client,
        })
    }

    /// On a 401, get a fresh token from `f` and retry once.
    pub fn with_refresher(mut self, f: TokenRefresher) -> Self {
        self.refresher = Some(f);
        self
    }

    fn table_url(&self) -> String {
        format!("{}/rest/v1/store_catalog", self.base_url)
    }

    fn send(
        &self,
        m: reqwest::Method,
        url: &str,
        body: Option<&Value>,
    ) -> Result<reqwest::blocking::Response, PublishError> {
        let resp = send_with_refresh(&self.user_jwt, self.refresher.as_ref(), |jwt| {
            let r = self
                .client
                .request(m.clone(), url)
                .header("apikey", &self.anon_key)
                .header("Authorization", format!("Bearer {jwt}"));
            match body {
                Some(b) => r
                    .header("Content-Type", "application/json")
                    .header("Prefer", "resolution=merge-duplicates,return=minimal")
                    .json(b),
                None => r,
            }
        })
        .map_err(PublishError::Uploader)?;
        let st = resp.status();
        if st.is_success() {
            return Ok(resp);
        }
        Err(PublishError::Uploader(shop_http_error(
            st.as_u16(),
            &resp.text().unwrap_or_default(),
        )))
    }
}

impl CatalogUploader for SupabaseUploader {
    fn fetch_current(&self) -> Result<Option<Value>, PublishError> {
        let url = format!(
            "{}?id=eq.{}&select=snapshot",
            self.table_url(),
            CATALOG_ROW_ID
        );
        let resp = self.send(reqwest::Method::GET, &url, None)?;
        let rows: Vec<Value> = resp
            .json()
            .map_err(|e| PublishError::Uploader(format!("unexpected shop response ({e})")))?;
        Ok(rows
            .into_iter()
            .next()
            .and_then(|r| r.get("snapshot").cloned()))
    }

    fn upload(&mut self, row: &CatalogRow) -> Result<(), PublishError> {
        let mut body = json!({"id": row.id, "published_at": row.published_at,
                              "access_token": row.access_token, "snapshot": row.snapshot});
        if let Some(o) = &self.owner_id {
            body["owner_id"] = json!(o);
        }
        let url = format!("{}?on_conflict=id", self.table_url());
        self.send(reqwest::Method::POST, &url, Some(&json!([body])))
            .map(|_| ())
    }
}

// --- Website order ingest -------------------------------------------------------------

/// `store_orders` client for [`crate::store_ingest::StoreOrderSource`].
/// Auth: `apikey: <anon key>` (Supabase gateway header) + `Authorization: Bearer <signed-in
/// shop owner's JWT>`. The owner token is REQUIRED for every request, reads included; the
/// anon key is never used as the bearer (deviation from the Swift app, which used anon).
/// Never a service key. Errors carry status + a short body, never headers or keys.
pub struct SupabaseStoreOrderReader {
    base_url: String,
    anon_key: String,
    owner_jwt: RefCell<String>,
    refresher: Option<TokenRefresher>,
    client: reqwest::blocking::Client,
}

/// Pending orders: paid, not imported, not dismissed (matches `store_orders_pending_idx`), oldest first.
pub const STORE_ORDERS_PENDING_QUERY: &str =
    "select=*&payment_status=eq.paid&imported_at=is.null&dismissed_at=is.null&order=created_at.asc&limit=500";

impl SupabaseStoreOrderReader {
    pub fn new(supabase_url: &str, anon_key: &str, owner_jwt: &str) -> Result<Self, String> {
        let base_url = supabase_url.trim().trim_end_matches('/').to_string();
        let (anon_key, owner_jwt) = (anon_key.trim().to_string(), owner_jwt.trim().to_string());
        if base_url.is_empty() || anon_key.is_empty() {
            return Err("no shop connected (Supabase URL / anon key missing)".into());
        }
        if !base_url.starts_with("https://") {
            return Err("Supabase URL must be https".into());
        }
        if owner_jwt.is_empty() || owner_jwt == anon_key {
            return Err(crate::store_ingest::NOT_SIGNED_IN_MESSAGE.into());
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            base_url,
            anon_key,
            owner_jwt: RefCell::new(owner_jwt),
            refresher: None,
            client,
        })
    }

    /// On a 401, get a fresh token from `f` and retry once.
    pub fn with_refresher(mut self, f: TokenRefresher) -> Self {
        self.refresher = Some(f);
        self
    }

    pub fn pending_url(&self) -> String {
        format!(
            "{}/rest/v1/store_orders?{}",
            self.base_url, STORE_ORDERS_PENDING_QUERY
        )
    }

    /// Atomic claim URL for one row: `store_orders?id=eq.<id>&imported_at=is.null`
    /// (id percent-encoded). The `imported_at=is.null` filter makes the PATCH conditional.
    pub fn claim_url(&self, row_id: &str) -> String {
        let enc: String = format!("eq.{row_id}")
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect();
        format!(
            "{}/rest/v1/store_orders?id={}&imported_at=is.null",
            self.base_url, enc
        )
    }

    /// Claim body: when, and which device (`claimed_by` records which device imported the row).
    pub fn claim_body(imported_at: &str, claimed_by: &str) -> Value {
        json!({"imported_at": imported_at, "claimed_by": claimed_by})
    }

    /// `Prefer: return=representation` response: a non-empty array = we won the claim.
    pub fn claim_won(body: &Value) -> Result<bool, String> {
        match body {
            Value::Array(rows) => Ok(!rows.is_empty()),
            _ => Err("unexpected claim response (not a list)".into()),
        }
    }

    fn send(
        &self,
        m: reqwest::Method,
        url: &str,
        body: Option<&Value>,
        prefer: Option<&str>,
    ) -> Result<reqwest::blocking::Response, String> {
        send_with_refresh(&self.owner_jwt, self.refresher.as_ref(), |jwt| {
            let mut r = self
                .client
                .request(m.clone(), url)
                .header("apikey", &self.anon_key)
                .header("Authorization", format!("Bearer {jwt}"))
                .header("Content-Type", "application/json")
                .header("Accept", "application/json");
            if let Some(p) = prefer {
                r = r.header("Prefer", p);
            }
            match body {
                Some(b) => r.json(b),
                None => r,
            }
        })
    }

    fn get_json(&self, url: &str) -> Result<Value, String> {
        let resp = self.send(reqwest::Method::GET, url, None, None)?;
        let st = resp.status();
        if !st.is_success() {
            return Err(shop_http_error(
                st.as_u16(),
                &resp.text().unwrap_or_default(),
            ));
        }
        resp.json()
            .map_err(|e| format!("unexpected shop response ({e})"))
    }
}

impl crate::store_ingest::StoreOrderSource for SupabaseStoreOrderReader {
    fn fetch_pending_orders(&self) -> Result<Vec<Value>, String> {
        match self.get_json(&self.pending_url())? {
            Value::Array(rows) => Ok(rows),
            _ => Err("unexpected shop response (not a list)".into()),
        }
    }

    /// Same read as `SupabaseUploader::fetch_current`: `store_catalog?id=eq.current&select=snapshot`.
    fn fetch_catalog_snapshot(&self) -> Result<Option<Value>, String> {
        let url = format!(
            "{}/rest/v1/store_catalog?id=eq.{}&select=snapshot",
            self.base_url, CATALOG_ROW_ID
        );
        let rows = self.get_json(&url)?;
        Ok(rows
            .as_array()
            .and_then(|a| a.first())
            .and_then(|r| r.get("snapshot"))
            .cloned())
    }

    /// Atomic claim of one row:
    /// `PATCH /rest/v1/store_orders?id=eq.<id>&imported_at=is.null`,
    /// body `{"imported_at": "<ISO UTC ms>", "claimed_by": "<device id>"}`,
    /// `Prefer: return=representation`, owner JWT bearer. Row returned = ours.
    fn claim_order(
        &self,
        row_id: &str,
        imported_at: &str,
        claimed_by: &str,
    ) -> Result<bool, String> {
        if row_id.trim().is_empty() {
            return Err("empty store order id".into());
        }
        let resp = self.send(
            reqwest::Method::PATCH,
            &self.claim_url(row_id),
            Some(&Self::claim_body(imported_at, claimed_by)),
            Some("return=representation"),
        )?;
        let st = resp.status();
        if !st.is_success() {
            return Err(shop_http_error(
                st.as_u16(),
                &resp.text().unwrap_or_default(),
            ));
        }
        let body: Value = resp
            .json()
            .map_err(|e| format!("unexpected claim response ({e})"))?;
        Self::claim_won(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_missing_or_anon_only_auth() {
        assert!(SupabaseUploader::new("", "anon", "jwt", None).is_err());
        assert!(SupabaseUploader::new("https://x.supabase.co", "anon", "", None).is_err());
        assert!(SupabaseUploader::new("https://x.supabase.co", "anon", "anon", None).is_err());
        assert!(SupabaseUploader::new("http://x.supabase.co", "anon", "jwt", None).is_err());
        assert!(SupabaseUploader::new("https://x.supabase.co/", "anon", "jwt", None).is_ok());
    }

    #[test]
    fn order_reader_needs_owner_token_and_builds_claim_requests() {
        assert!(SupabaseStoreOrderReader::new("", "anon", "jwt").is_err());
        assert!(SupabaseStoreOrderReader::new("http://x.supabase.co", "anon", "jwt").is_err());
        // No anon fallback: missing token or the anon key itself is "not signed in".
        assert_eq!(
            SupabaseStoreOrderReader::new("https://x.supabase.co", "anon", "")
                .err()
                .as_deref(),
            Some("Sign in to the shop to import orders")
        );
        assert!(SupabaseStoreOrderReader::new("https://x.supabase.co", "anon", "anon").is_err());
        let r = SupabaseStoreOrderReader::new("https://x.supabase.co/", "anon", "jwt").unwrap();
        assert_eq!(*r.owner_jwt.borrow(), "jwt");
        assert_eq!(r.pending_url(), "https://x.supabase.co/rest/v1/store_orders?select=*&payment_status=eq.paid&imported_at=is.null&dismissed_at=is.null&order=created_at.asc&limit=500");
        assert_eq!(
            r.claim_url("cs_test_a1"),
            "https://x.supabase.co/rest/v1/store_orders?id=eq.cs_test_a1&imported_at=is.null"
        );
        assert_eq!(
            r.claim_url("a&b c"),
            "https://x.supabase.co/rest/v1/store_orders?id=eq.a%26b%20c&imported_at=is.null"
        );
        assert_eq!(
            SupabaseStoreOrderReader::claim_body("2026-11-18T12:00:00.000Z", "fprust-1"),
            json!({"imported_at": "2026-11-18T12:00:00.000Z", "claimed_by": "fprust-1"})
        );
        assert_eq!(
            SupabaseStoreOrderReader::claim_won(&json!([{"id": "cs_1"}])),
            Ok(true)
        );
        assert_eq!(SupabaseStoreOrderReader::claim_won(&json!([])), Ok(false));
        assert!(SupabaseStoreOrderReader::claim_won(&json!({"message": "x"})).is_err());
    }

    #[test]
    fn http_errors_are_plain_words_without_the_body() {
        let body = r#"{"message":"JWT expired","code":"PGRST301"}"#;
        assert_eq!(
            shop_http_error(401, body),
            crate::session::SIGN_IN_AGAIN_MESSAGE
        );
        for st in [400, 403, 404, 409, 429, 500, 503] {
            let m = shop_http_error(st, body);
            assert!(
                !m.contains("PGRST") && !m.contains("JWT") && !m.contains('{'),
                "{st}: {m}"
            );
        }
        assert!(shop_http_error(503, "").contains("Try again"));
    }

    /// Local one-shot HTTP server: answers each connection with the next canned status and
    /// records the Authorization header it got.
    fn serve(statuses: Vec<u16>) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{BufRead, BufReader, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for st in statuses {
                let (mut c, _) = l.accept().unwrap();
                let mut r = BufReader::new(c.try_clone().unwrap());
                let mut auth = String::new();
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    if line.to_ascii_lowercase().starts_with("authorization:") {
                        auth = line[14..].trim().to_string();
                    }
                }
                tx.send(auth).unwrap();
                let body = if st == 200 {
                    "[]"
                } else {
                    "{\"message\":\"JWT expired\"}"
                };
                write!(c, "HTTP/1.1 {st} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (url, rx)
    }

    #[test]
    fn a_401_refreshes_once_and_retries() {
        let (url, rx) = serve(vec![401, 200]);
        let token = RefCell::new("old".to_string());
        let refresher: TokenRefresher = Box::new(|| Ok("new".to_string()));
        let client = reqwest::blocking::Client::new();
        let resp = send_with_refresh(&token, Some(&refresher), |t| {
            client
                .get(&url)
                .header("Authorization", format!("Bearer {t}"))
        })
        .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(rx.recv().unwrap(), "Bearer old");
        assert_eq!(rx.recv().unwrap(), "Bearer new");
        assert_eq!(*token.borrow(), "new");
    }

    #[test]
    fn a_401_without_refresher_or_with_failed_refresh_is_not_retried() {
        let (url, rx) = serve(vec![401]);
        let token = RefCell::new("old".to_string());
        let client = reqwest::blocking::Client::new();
        let resp = send_with_refresh(&token, None, |t| {
            client
                .get(&url)
                .header("Authorization", format!("Bearer {t}"))
        })
        .unwrap();
        assert_eq!(resp.status().as_u16(), 401);
        assert_eq!(rx.recv().unwrap(), "Bearer old");

        let (url, _rx) = serve(vec![401]);
        let refresher: TokenRefresher =
            Box::new(|| Err(crate::session::SIGN_IN_AGAIN_MESSAGE.to_string()));
        let err = send_with_refresh(&token, Some(&refresher), |t| {
            client
                .get(&url)
                .header("Authorization", format!("Bearer {t}"))
        })
        .unwrap_err();
        assert_eq!(err, crate::session::SIGN_IN_AGAIN_MESSAGE);
    }
}
