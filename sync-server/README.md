# gravitation-sync

The sync server of Gravitation. It is a single self-contained binary with
SQLite built in. You run it on your own Debian or Ubuntu box, and every copy
of Gravitation you connect keeps the same servers, credentials, scripts,
proxies and group order.

Sync is optional. Without a server, Gravitation works exactly as before, fully
local.

## Security model

- **End-to-end encryption.** Each unit is encrypted with AES-256-GCM before it
  leaves the device.
  - The key is derived from two secrets: your **passphrase** (Argon2id, 64 MiB)
    and a random 128-bit **secret key** made on the first device.
  - The server never receives either of them.
- **The server stores only:**
  - account ids;
  - Ed25519 *public* keys;
  - random-looking item ids (HMAC);
  - ciphertext blobs.

  So a stolen database, a hacked host or a curious admin learns nothing but
  sizes and timestamps. The database cannot be brute-forced offline either,
  because the secret key is not in it.
- **Login is challenge–response.**
  - A device signs a one-time challenge with an Ed25519 key derived from the
    same secrets.
  - No password is ever sent or stored.
  - Sessions are random bearer tokens, stored as SHA-256 and expiring after
    30 idle days.
- **Tampering is detected.**
  - Payloads are bound to their item id (AEAD associated data) and carry a
    version, so the server cannot swap, forge or roll back items.
  - Deletions are encrypted tombstones, so only your devices can delete
    anything.
- **Accounts are invite-only.** A new account needs a one-time invite code
  created on the server (`gravitation-sync invite`). Strangers cannot sign up
  on your server.
- **Hardening:**
  - per-IP rate limits on auth;
  - request size limits;
  - `Cache-Control: no-store`;
  - the database is `0600` in a `0700` directory;
  - the systemd unit runs as an unprivileged user under a strict sandbox.
- **Use HTTPS.** The app refuses plain `http://` except on localhost and
  private networks.

> Keep the passphrase. It cannot be reset: if every device forgets it, the
> data on the server cannot be read by anyone.

## Install on Debian / Ubuntu

### 1. Build the binary

Build it on the server:

```sh
sudo apt install -y build-essential curl
curl https://sh.rustup.rs -sSf | sh -s -- -y && . ~/.cargo/env
cd sync-server
cargo build --release      # → target/release/gravitation-sync
```

For a static binary that you can copy to any x86-64 Linux:

```sh
sudo apt install -y musl-tools && rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

### 2. Install the service

```sh
sudo sh deploy/install.sh ./gravitation-sync
```

This installs the binary to `/usr/local/bin`, creates the `gravitation-sync`
system user, sets up `/var/lib/gravitation-sync` and enables the systemd unit.
By default the service listens on `127.0.0.1:8443`. Settings are in
`/etc/gravitation-sync.env`.

### 3. HTTPS

Pick one of two options.

**Caddy (recommended).** Caddy gets and renews a Let's Encrypt certificate
automatically.

```sh
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # put your domain in it
sudo systemctl reload caddy
```

**Built-in TLS.** Set `GSYNC_LISTEN=0.0.0.0:8443`, `GSYNC_TLS_CERT` and
`GSYNC_TLS_KEY` in `/etc/gravitation-sync.env`, then run
`sudo systemctl restart gravitation-sync`.

### 4. Connect the first device

```sh
sudo -u gravitation-sync gravitation-sync --data /var/lib/gravitation-sync invite
```

In Gravitation, go to **Settings → Sync → First device — create account**
and enter:

- the server address (`https://sync.example.com`);
- the invite code;
- a passphrase.

### 5. Add other devices

1. On a connected device, open **Settings → Sync → Show setup code** and copy
   the code.
2. On the new device, open **Join with setup code**, paste the code and enter
   the passphrase.

No invite is needed for this. Treat the setup code like a key: it is half of
the secret.

## Lost device or leaked passphrase

On a device you still trust, open **Settings → Sync → Reset passphrase and
sign out other devices**. Enter the current passphrase and a new one.

- New keys are made on that device, and all data is re-encrypted with them and
  uploaded in one step.
- The server retires the old key and ends every session.
- Any device still holding the old keys gets "revoked" the next time it goes
  online, and removes the synced units it holds. Only a valid signature with
  a retired key gets that answer, so nobody else can trigger it.
- The data stays on the server and on the device that did the reset. Rejoin
  your other devices with the new setup code.

**Lock until confirmed.** While sync is on, a device opens nothing secret
until the server has confirmed it within the last 5 minutes. That covers
connecting to a server, showing a password and opening a key. A device whose
keys were reset elsewhere is therefore wiped before it can open anything.

When the server cannot be reached, the device unlocks only with the
passphrase, for that run of the app. Turning sync off also requires
confirmation or the passphrase, so it is not a way around the lock.

There is a limit to this. A device that never goes online again (or whose
disk was copied beforehand) keeps whatever it already had. The reset makes
sure it can get nothing new and cannot touch the server.

## Admin commands

```sh
gravitation-sync --data /var/lib/gravitation-sync invite [--hours 24]   # one-time invite code
gravitation-sync --data /var/lib/gravitation-sync accounts              # list accounts
gravitation-sync --data /var/lib/gravitation-sync revoke <id-prefix>    # sign all devices out
gravitation-sync --data /var/lib/gravitation-sync delete-account <id-prefix>
```

Run them as the `gravitation-sync` user (`sudo -u gravitation-sync …`) so that
the database keeps its owner.

**Backup:** copy `/var/lib/gravitation-sync/sync.db`. It contains ciphertext
only.

## What is synced

| Synced | Per device |
| --- | --- |
| Servers (including saved passwords and pinned host keys) | Logs |
| Credentials (private keys, passphrases) | Terminal settings |
| Scripts | Theme |
| Proxies | Which groups are collapsed |
| Groups and their order | |

If a unit is changed on two devices before they sync, the device that syncs
last keeps its version.

## API (v1, JSON)

| Method | Path | Auth | |
| --- | --- | --- | --- |
| GET | `/v1/health` | – | `{service, version, api}` |
| POST | `/v1/register` | invite | `{invite, account, public_key}` |
| POST | `/v1/auth/challenge` | – | `{account}` → `{challenge}` |
| POST | `/v1/auth/login` | signature | `{account, challenge, signature, device}` → `{token}` |
| POST | `/v1/auth/logout` | bearer | |
| GET | `/v1/account` | bearer | `{items, rev, created_at}` |
| DELETE | `/v1/account` | bearer | deletes the account and all items |
| GET | `/v1/items?since=REV` | bearer | items with a newer revision |
| POST | `/v1/items` | bearer | `{items:[{id, base_rev, blob}]}`, atomic; 409 if a `base_rev` is stale |
| POST | `/v1/account/rotate` | bearer + signature | `{challenge, signature, public_key, items:[{id, blob}]}`: key reset, all sessions end |

The login signature covers `"gravitation-sync/login/v1\0" || account || "\0" || challenge`.
