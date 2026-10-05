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

## Install

### 1. Build on Windows

Run this in the Gravitation folder:

```powershell
npm run build:sync-server
```

The result is `sync-server/dist/gravitation-sync`, one static Linux file that
runs on any x86-64 Debian or Ubuntu. Add `-- -Arm` to the command for an ARM64
server.

The first run sets up what the cross-build needs: the Rust musl target, Zig
(installed with `pip`) and `cargo-zigbuild`. Building on the server is not
needed.

### 2. Tailscale on the server (once)

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Install Tailscale on your computers as well, signed in to the same account.

### 3. Copy and install

Copy the file to the server (from Windows):

```powershell
scp sync-server\dist\gravitation-sync user@server:~/
```

Then install it (on the server):

```sh
chmod +x gravitation-sync && sudo ./gravitation-sync install
```

`install` does the following:

- puts the binary in `/usr/local/bin`;
- creates the unprivileged `gravitation-sync` user;
- writes a sandboxed systemd service;
- listens on the server's **Tailscale IP** (`100.x.y.z:8443`), so the server is
  not reachable from the internet at all;
- starts the service and prints the address and a first invite code.

To listen on another address, use
`sudo ./gravitation-sync install --listen 0.0.0.0:8443`.

**Update:** build again, copy the new file and run `sudo ./gravitation-sync install`
again. Settings and data are kept.

**Remove:** run `sudo gravitation-sync uninstall`. The data in
`/var/lib/gravitation-sync` stays.

### 4. Connect the first device

In Gravitation, go to **Settings → Sync → First device — create account** and
enter:

- the address `install` printed (`http://100.x.y.z:8443`);
- the invite code;
- a passphrase.

Use the IP, not the Tailscale host name. Plain http is fine here: the app
allows it for Tailscale and private addresses, and Tailscale encrypts the
traffic anyway.

### 5. Add other devices

1. On a connected device, open **Settings → Sync → Show setup code** and copy
   the code.
2. On the new device, open **Join with setup code**, paste the code and enter
   the passphrase.

### Public server instead of Tailscale

1. Install with `--listen 127.0.0.1:8443`.
2. Put Caddy in front of it for HTTPS: see `deploy/Caddyfile`.
3. Add `GSYNC_TRUST_PROXY=true` to `/etc/gravitation-sync.env`.

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

Run these on the server. With `sudo` they run as the service user.

```sh
sudo gravitation-sync invite [--hours 24]        # one-time invite code
sudo gravitation-sync accounts                   # list accounts
sudo gravitation-sync revoke <id-prefix>         # sign all devices out
sudo gravitation-sync delete-account <id-prefix>
journalctl -u gravitation-sync -f                # logs
```

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
