//! Fixed-window rate limits per client IP, in memory. Enough for a personal
//! server: it caps online guessing at the auth endpoints and bulk abuse of
//! the rest.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;

pub struct Limiter {
    window: i64,
    max: u32,
    hits: Mutex<HashMap<IpAddr, (i64, u32)>>,
}

impl Limiter {
    pub fn new(max: u32, window_secs: i64) -> Self {
        Limiter { window: window_secs, max, hits: Mutex::new(HashMap::new()) }
    }

    /// Counts a hit; false = over the limit for this window.
    pub fn allow(&self, ip: IpAddr) -> bool {
        let t = crate::now();
        let mut map = self.hits.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() > 50_000 {
            map.retain(|_, (start, _)| t - *start < self.window);
        }
        let e = map.entry(ip).or_insert((t, 0));
        if t - e.0 >= self.window {
            *e = (t, 0);
        }
        e.1 += 1;
        e.1 <= self.max
    }
}
