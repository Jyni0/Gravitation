//! HTTP API (JSON, version 1).
//!
//! Auth: a device asks for a one-time challenge, signs it with the
//! account's Ed25519 key (derived on the device from passphrase + secret
//! key — the server stores only the public half) and gets a bearer token.
//! Tokens are random, stored as SHA-256, and expire after 30 idle days.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use serde_json::json;

use crate::limit::Limiter;
use crate::store::{PushResult, Store, SESSION_TTL};
use crate::{now, random};

/// Domain-separation prefix of the login signature (must match the client).
const LOGIN_CONTEXT: &[u8] = b"gravitation-sync/login/v1\0";
/// Domain-separation prefix of the key-reset signature (made by the OLD key
/// over the challenge and the NEW public key).
const ROTATE_CONTEXT: &[u8] = b"gravitation-sync/rotate/v1\0";
/// Biggest single encrypted item (base64 decoded).
const MAX_BLOB: usize = 1024 * 1024;
const MAX_PUSH: usize = 1000;
const MAX_BODY: usize = 24 * 1024 * 1024;
const CHALLENGE_TTL: i64 = 120;

struct App {
    store: Store,
    trust_proxy: bool,
    /// challenge → (account, expires_at). One use each.
    challenges: Mutex<HashMap<[u8; 32], (String, i64)>>,
    auth_limit: Limiter,
    api_limit: Limiter,
}

type Shared = Arc<App>;

pub async fn serve(
    store: Store,
    listen: SocketAddr,
    tls: Option<(PathBuf, PathBuf)>,
    trust_proxy: bool,
) -> Result<(), String> {
    let app = Arc::new(App {
        store,
        trust_proxy,
        challenges: Mutex::new(HashMap::new()),
        // Logins happen once per app start per device: 30 per 10 min per IP is generous.
        auth_limit: Limiter::new(30, 600),
        api_limit: Limiter::new(1200, 60),
    });

    let router = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/register", post(register))
        .route("/v1/auth/challenge", post(challenge))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/logout", post(logout))
        .route("/v1/account", get(account).delete(delete_account))
        .route("/v1/account/rotate", post(rotate))
        .route("/v1/items", get(pull).post(push))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .layer(axum::middleware::map_response(no_store))
        .with_state(app);

    let handle = axum_server::Handle::new();
    let h = handle.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        h.graceful_shutdown(Some(Duration::from_secs(10)));
    });

    let svc = router.into_make_service_with_connect_info::<SocketAddr>();
    match tls {
        Some((cert, key)) => {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let cfg = axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
                .await
                .map_err(|e| format!("cannot load TLS certificate/key: {e}"))?;
            eprintln!("gravitation-sync {} listening on https://{listen}", env!("CARGO_PKG_VERSION"));
            axum_server::bind_rustls(listen, cfg).handle(handle).serve(svc).await.map_err(|e| e.to_string())
        }
        None => {
            eprintln!(
                "gravitation-sync {} listening on http://{listen} (no TLS — put it behind an HTTPS reverse proxy)",
                env!("CARGO_PKG_VERSION")
            );
            axum_server::bind(listen).handle(handle).serve(svc).await.map_err(|e| e.to_string())
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

/// Responses carry account data: never cache them anywhere.
async fn no_store(mut res: Response) -> Response {
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut().insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    res
}

/* ---------- helpers ---------- */

struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

fn client_ip(app: &App, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if app.trust_proxy {
        // The proxy appends the address it saw: the LAST entry is the one we trust.
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .and_then(|s| s.trim().parse().ok())
        {
            return ip;
        }
    }
    peer.ip()
}

fn limited(lim: &Limiter, ip: IpAddr) -> Result<(), ApiError> {
    if lim.allow(ip) {
        Ok(())
    } else {
        Err(ApiError(StatusCode::TOO_MANY_REQUESTS, "too many requests, slow down"))
    }
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Account of the bearer token, or 401.
fn authed(app: &App, headers: &HeaderMap) -> Result<(String, String), ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.len() <= 128)
        .ok_or(ApiError(StatusCode::UNAUTHORIZED, "not signed in"))?;
    let account = app.store.session(token).ok_or(ApiError(StatusCode::UNAUTHORIZED, "session expired"))?;
    Ok((account, token.to_string()))
}

fn internal(e: String) -> ApiError {
    eprintln!("[api] {e}");
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, "server error")
}

/* ---------- handlers ---------- */

async fn health() -> Response {
    Json(json!({ "ok": true, "service": "gravitation-sync", "version": env!("CARGO_PKG_VERSION"), "api": 1 })).into_response()
}

#[derive(Deserialize)]
struct RegisterReq {
    invite: String,
    account: String,
    public_key: String,
}

async fn register(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RegisterReq>,
) -> ApiResult {
    let ip = client_ip(&app, peer, &headers);
    limited(&app.auth_limit, ip)?;
    if !is_hex(&req.account, 32) || req.invite.len() > 64 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "malformed request"));
    }
    let pk: [u8; 32] = B64
        .decode(&req.public_key)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "malformed public key"))?;
    let vk = VerifyingKey::from_bytes(&pk).map_err(|_| ApiError(StatusCode::BAD_REQUEST, "malformed public key"))?;
    if vk.is_weak() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "malformed public key"));
    }
    match app.store.register(&req.invite, &req.account, &pk) {
        Ok(()) => {
            eprintln!("[api] account {} created from {ip}", &req.account[..8]);
            Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
        }
        Err("invalid or expired invite") => {
            eprintln!("[api] bad invite from {ip}");
            Err(ApiError(StatusCode::FORBIDDEN, "invalid or expired invite"))
        }
        Err("account already exists") => Err(ApiError(StatusCode::CONFLICT, "account already exists")),
        Err(e) => Err(internal(e.to_string())),
    }
}

#[derive(Deserialize)]
struct ChallengeReq {
    account: String,
}

async fn challenge(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<ChallengeReq>,
) -> ApiResult {
    limited(&app.auth_limit, client_ip(&app, peer, &headers))?;
    if !is_hex(&req.account, 32) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "malformed account"));
    }
    // Issued for unknown accounts too — the answer does not reveal which exist.
    let c = random::<32>();
    let t = now();
    let mut map = app.challenges.lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, (_, exp)| *exp > t);
    if map.len() > 10_000 {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy, try again"));
    }
    map.insert(c, (req.account, t + CHALLENGE_TTL));
    Ok(Json(json!({ "challenge": B64.encode(c) })).into_response())
}

#[derive(Deserialize)]
struct LoginReq {
    account: String,
    challenge: String,
    signature: String,
    #[serde(default)]
    device: String,
}

async fn login(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<LoginReq>,
) -> ApiResult {
    let ip = client_ip(&app, peer, &headers);
    limited(&app.auth_limit, ip)?;
    let denied = ApiError(StatusCode::UNAUTHORIZED, "wrong passphrase or setup code");
    let c: [u8; 32] = B64
        .decode(&req.challenge)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "malformed challenge"))?;
    // Single use: taken out before anything else can fail.
    let issued = app.challenges.lock().unwrap_or_else(|p| p.into_inner()).remove(&c);
    match issued {
        Some((acc, exp)) if acc == req.account && exp > now() => {}
        _ => return Err(ApiError(StatusCode::UNAUTHORIZED, "challenge expired, try again")),
    }
    let sig: [u8; 64] = B64
        .decode(&req.signature)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "malformed signature"))?;
    let Some(pk) = app.store.public_key(&req.account) else {
        eprintln!("[api] login to unknown account from {ip}");
        return Err(denied);
    };
    let key = VerifyingKey::from_bytes(&pk).map_err(|_| internal("stored key invalid".into()))?;
    let mut msg = LOGIN_CONTEXT.to_vec();
    msg.extend_from_slice(req.account.as_bytes());
    msg.push(0);
    msg.extend_from_slice(&c);
    let sig = Signature::from_bytes(&sig);
    if key.verify_strict(&msg, &sig).is_err() {
        // A device still holding keys from before a key reset: tell it so
        // (it then removes its synced data). Only a valid signature by a
        // retired key gets this answer, so nobody else can trigger it.
        let retired = app.store.retired_keys(&req.account).into_iter().any(|pk| {
            VerifyingKey::from_bytes(&pk).is_ok_and(|k| k.verify_strict(&msg, &sig).is_ok())
        });
        if retired {
            eprintln!("[api] revoked device of {} tried to log in from {ip}", &req.account[..8]);
            return Ok((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "keys were reset on another device", "code": "revoked" })),
            )
                .into_response());
        }
        eprintln!("[api] failed login to {} from {ip}", &req.account[..8]);
        return Err(denied);
    }
    let device: String = req.device.chars().filter(|c| !c.is_control()).take(64).collect();
    let token = app.store.create_session(&req.account, &device).map_err(internal)?;
    Ok(Json(json!({ "token": token, "expires_in": SESSION_TTL })).into_response())
}

async fn logout(State(app): State<Shared>, headers: HeaderMap) -> ApiResult {
    let (_, token) = authed(&app, &headers)?;
    app.store.end_session(&token);
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn account(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult {
    limited(&app.api_limit, client_ip(&app, peer, &headers))?;
    let (acc, _) = authed(&app, &headers)?;
    let (items, rev, created) = app.store.account_info(&acc).map_err(internal)?;
    Ok(Json(json!({ "items": items, "rev": rev, "created_at": created })).into_response())
}

async fn delete_account(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult {
    limited(&app.auth_limit, client_ip(&app, peer, &headers))?;
    let (acc, _) = authed(&app, &headers)?;
    app.store.delete_account(&acc).map_err(internal)?;
    eprintln!("[api] account {} deleted by its owner", &acc[..8]);
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
struct PullQuery {
    #[serde(default)]
    since: i64,
    #[serde(default)]
    limit: Option<i64>,
}

async fn pull(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<PullQuery>,
) -> ApiResult {
    limited(&app.api_limit, client_ip(&app, peer, &headers))?;
    let (acc, _) = authed(&app, &headers)?;
    let limit = q.limit.unwrap_or(500).clamp(1, 1000);
    let (items, more) = app.store.pull(&acc, q.since.max(0), limit).map_err(internal)?;
    let list: Vec<_> = items
        .iter()
        .map(|i| json!({ "id": i.id, "rev": i.rev, "blob": B64.encode(&i.blob) }))
        .collect();
    Ok(Json(json!({ "items": list, "more": more })).into_response())
}

#[derive(Deserialize)]
struct PushItem {
    id: String,
    base_rev: i64,
    blob: String,
}

#[derive(Deserialize)]
struct PushReq {
    items: Vec<PushItem>,
}

async fn push(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<PushReq>,
) -> ApiResult {
    limited(&app.api_limit, client_ip(&app, peer, &headers))?;
    let (acc, _) = authed(&app, &headers)?;
    if req.items.is_empty() || req.items.len() > MAX_PUSH {
        return Err(ApiError(StatusCode::BAD_REQUEST, "push 1..1000 items at a time"));
    }
    let mut items = Vec::with_capacity(req.items.len());
    for it in req.items {
        if !is_hex(&it.id, 64) || it.base_rev < 0 {
            return Err(ApiError(StatusCode::BAD_REQUEST, "malformed item"));
        }
        let blob = B64.decode(&it.blob).map_err(|_| ApiError(StatusCode::BAD_REQUEST, "malformed item"))?;
        // nonce (12) + tag (16) at least
        if blob.len() < 28 || blob.len() > MAX_BLOB {
            return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "item too large"));
        }
        items.push((it.id, it.base_rev, blob));
    }
    match app.store.push(&acc, &items) {
        Ok(PushResult::Ok(revs)) => {
            let list: Vec<_> = revs.iter().map(|(id, rev)| json!({ "id": id, "rev": rev })).collect();
            Ok(Json(json!({ "items": list })).into_response())
        }
        Ok(PushResult::Conflict(ids)) => {
            Ok((StatusCode::CONFLICT, Json(json!({ "error": "stale revision, pull first", "conflicts": ids }))).into_response())
        }
        Err(e) if e == "item limit reached" => Err(ApiError(StatusCode::INSUFFICIENT_STORAGE, "item limit reached")),
        Err(e) => Err(internal(e)),
    }
}

/// Takes a one-time challenge issued for `account` (base64), or 401.
fn take_challenge(app: &App, account: &str, b64: &str) -> Result<[u8; 32], ApiError> {
    let c: [u8; 32] = B64
        .decode(b64)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "malformed challenge"))?;
    match app.challenges.lock().unwrap_or_else(|p| p.into_inner()).remove(&c) {
        Some((acc, exp)) if acc == account && exp > now() => Ok(c),
        _ => Err(ApiError(StatusCode::UNAUTHORIZED, "challenge expired, try again")),
    }
}

#[derive(Deserialize)]
struct RotateItem {
    id: String,
    blob: String,
}

#[derive(Deserialize)]
struct RotateReq {
    challenge: String,
    signature: String,
    public_key: String,
    items: Vec<RotateItem>,
}

/// Key reset (passphrase change / lost device): needs the session AND a
/// fresh signature by the current key, so a stolen token alone cannot do it.
async fn rotate(
    State(app): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<RotateReq>,
) -> ApiResult {
    let ip = client_ip(&app, peer, &headers);
    limited(&app.auth_limit, ip)?;
    let (acc, _) = authed(&app, &headers)?;
    let c = take_challenge(&app, &acc, &req.challenge)?;
    let new_pk: [u8; 32] = B64
        .decode(&req.public_key)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "malformed public key"))?;
    let new_key = VerifyingKey::from_bytes(&new_pk).map_err(|_| ApiError(StatusCode::BAD_REQUEST, "malformed public key"))?;
    if new_key.is_weak() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "malformed public key"));
    }
    let sig: [u8; 64] = B64
        .decode(&req.signature)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "malformed signature"))?;
    let cur = app.store.public_key(&acc).ok_or(ApiError(StatusCode::UNAUTHORIZED, "not signed in"))?;
    if cur == new_pk {
        return Err(ApiError(StatusCode::BAD_REQUEST, "the new key equals the current one"));
    }
    let key = VerifyingKey::from_bytes(&cur).map_err(|_| internal("stored key invalid".into()))?;
    let mut msg = ROTATE_CONTEXT.to_vec();
    msg.extend_from_slice(acc.as_bytes());
    msg.push(0);
    msg.extend_from_slice(&c);
    msg.extend_from_slice(&new_pk);
    if key.verify_strict(&msg, &Signature::from_bytes(&sig)).is_err() {
        eprintln!("[api] bad key-reset signature for {} from {ip}", &acc[..8]);
        return Err(ApiError(StatusCode::UNAUTHORIZED, "signature does not match"));
    }
    let mut items = Vec::with_capacity(req.items.len());
    let mut seen = std::collections::HashSet::new();
    for it in req.items {
        if !is_hex(&it.id, 64) || !seen.insert(it.id.clone()) {
            return Err(ApiError(StatusCode::BAD_REQUEST, "malformed item"));
        }
        let blob = B64.decode(&it.blob).map_err(|_| ApiError(StatusCode::BAD_REQUEST, "malformed item"))?;
        if blob.len() < 28 || blob.len() > MAX_BLOB {
            return Err(ApiError(StatusCode::PAYLOAD_TOO_LARGE, "item too large"));
        }
        items.push((it.id, blob));
    }
    match app.store.rotate(&acc, &new_pk, &items) {
        Ok(revs) => {
            eprintln!("[api] keys of {} reset from {ip}: {} items, all sessions ended", &acc[..8], revs.len());
            let list: Vec<_> = revs.iter().map(|(id, rev)| json!({ "id": id, "rev": rev })).collect();
            Ok(Json(json!({ "items": list })).into_response())
        }
        Err(e) if e == "item limit reached" => Err(ApiError(StatusCode::INSUFFICIENT_STORAGE, "item limit reached")),
        Err(e) => Err(internal(e)),
    }
}
