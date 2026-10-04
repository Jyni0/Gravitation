//! Safety checks of the SSH client.
//!
//! * `redact`         — strips secrets from text before it is stored (the SSH
//!   audit log keeps commands verbatim otherwise).
//! * `validate_host` / `validate_username` — server fields are checked
//!   before they reach the database.
use regex::Regex;
use std::sync::LazyLock;

static SECRETS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", "[private key]"),
        (r"(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)('[^']*'|\x22[^\x22]*\x22|\S+)", "$1$2***"),
        (r"(?i)\bsshpass\s+-p\s*\S+", "sshpass -p ***"),
        (r"(?i)\b(mysql|mariadb|mysqldump)\b([^\n]*?)\s-p\S+", "$1$2 -p***"),
        (r"(?i)\bbearer\s+[a-z0-9._~+/=-]{12,}", "Bearer ***"),
        (r"\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}", "***"),
        (r"\bsk-[A-Za-z0-9_-]{20,}", "***"),
        (r"\bAKIA[0-9A-Z]{16}\b", "***"),
        (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", "***"),
        (r"(?i)(https?://[^:/\s]+:)[^@/\s]+@", "$1***@"),
    ]
    .into_iter()
    .map(|(p, r)| (Regex::new(p).expect("static secret regex"), r))
    .collect()
});

/// Text with passwords, tokens and private keys masked.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for (re, with) in SECRETS.iter() {
        out = re.replace_all(&out, *with).into_owned();
    }
    out
}

/// Hostname / IPv4 / IPv6 of a server, without scheme, spaces or options.
pub fn validate_host(host: &str) -> Result<(), String> {
    let h = host.trim();
    if h.is_empty() || h.len() > 253 {
        return Err("Host must be 1–253 characters.".into());
    }
    if h.starts_with('-') {
        return Err("Host cannot start with '-'.".into());
    }
    if h.contains("://") {
        return Err("Host is a name or an IP address — drop the scheme (ssh://…).".into());
    }
    let ok = h
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']' | '%'));
    if !ok {
        return Err("Host may contain only letters, digits, '.', '-', '_' and ':' (IPv6).".into());
    }
    Ok(())
}

/// POSIX-ish login name (Windows OpenSSH also allows DOMAIN\user and '@').
pub fn validate_username(user: &str) -> Result<(), String> {
    let u = user.trim();
    if u.is_empty() || u.len() > 64 {
        return Err("Username must be 1–64 characters.".into());
    }
    if u.starts_with('-') {
        return Err("Username cannot start with '-'.".into());
    }
    let ok = u
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | '@' | '\\' | '$'));
    if !ok {
        return Err("Username has characters SSH will not accept.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_secrets() {
        let r = redact("mysql -u root -pHunter2 db && export API_KEY=abc123 ; curl -H 'Authorization: Bearer abcdefghijklmnop123'");
        assert!(!r.contains("Hunter2"), "{r}");
        assert!(!r.contains("abc123"), "{r}");
        assert!(!r.contains("abcdefghijklmnop123"), "{r}");
        assert_eq!(redact("ls -la"), "ls -la");
    }

    #[test]
    fn validates_hosts() {
        assert!(validate_host("10.0.0.5").is_ok());
        assert!(validate_host("example.com").is_ok());
        assert!(validate_host("fe80::1").is_ok());
        assert!(validate_host("-oProxyCommand=x").is_err());
        assert!(validate_host("ssh://host").is_err());
        assert!(validate_host("a b").is_err());
    }
}
