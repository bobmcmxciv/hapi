# Deployment

Run the hub and runner as persistent background services, and configure remote access tunnels.

## Relay tunnel details

The default public relay (`hapi hub --relay`) works out of the box. This section covers how relay authentication works and how to tune it.

The hub automatically stores an individually revocable relay key in `settings.json` (`relayAuthKey`). If that persisted key is revoked or the relay rotates its signing secret, HAPI discards it after HTTP 403, requests one replacement, and restarts the tunnel. Relay issuance is limited per public IP; HTTP 429 is reported explicitly, which can affect users sharing a CGNAT or corporate egress address. Set `HAPI_RELAY_AUTH` only when an operator has provided a key manually; rejected environment keys are never overwritten automatically.

> **Tip:** The relay uses UDP by default. If you experience connectivity issues, set `HAPI_RELAY_FORCE_TCP=true` to force TCP mode.

Other relay-related environment variables:

- `HAPI_RELAY_API` - Relay API domain (default: `relay.hapi.run`)
- `HAPI_OFFICIAL_WEB_URL` - Official web app origin allowed via CORS when the relay is enabled (default: `https://app.hapi.run`)

## Self-hosted tunnels

If you prefer not to use the public relay (e.g., for lower latency or self-managed infrastructure), you can use these alternatives:

<details>
<summary>Cloudflare Tunnel</summary>

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

> **Note:** Cloudflare Quick Tunnels (TryCloudflare) are not supported because they [do not support SSE](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), which HAPI uses for real-time updates. Use a Named Tunnel instead.

**Named tunnel setup:**

```bash
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Create and configure a named tunnel
cloudflared tunnel create hapi
cloudflared tunnel route dns hapi hapi.yourdomain.com

# Run the tunnel
cloudflared tunnel --protocol http2 run hapi
```

> **Tip:** Use `--protocol http2` instead of QUIC (the default) to avoid potential timeout issues with long-lived connections.

</details>

<details>
<summary>Tailscale</summary>

https://tailscale.com/download

```bash
sudo tailscale up
hapi hub
```

Access via your Tailscale IP:

```
http://100.x.x.x:3006
```
</details>

<details>
<summary>Public IP / Reverse Proxy</summary>

If the hub has a public IP, access directly via `http://your-hub-ip:3006`.

Use HTTPS (via Nginx, Caddy, etc.) for production.

**Self-signed certificates (HTTPS)**

If `HAPI_API_URL` is set to an `https://...` URL with a self-signed (or otherwise untrusted) certificate, the CLI may fail with:

```
Error: self signed certificate
```

Recommended fixes (in order):

1. Use a publicly trusted certificate (e.g., Let's Encrypt)
2. Trust your private CA (recommended for private networks)
3. Dev-only workaround: disable TLS verification (insecure)

```bash
# Preferred: trust your own CA
export NODE_EXTRA_CA_CERTS="/path/to/your-ca.pem"

# Dev-only workaround: disable TLS verification (INSECURE)
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

If you use the dev-only workaround, assume MITM risk; do not use on public networks.

</details>

## Generated-file downloads returning 507

Generated files and inline media are cached under `HAPI_BLOB_DIR` (default: `~/.hapi/blobs`). New uploads and uncached downloads return `507` when storing the file would leave less than `HAPI_BLOB_MIN_FREE_BYTES` available on that volume. The default reserve is 2 GiB; deployments may set a larger reserve. Check the actual container mounts and configuration, not just the free space on the CLI machine.

Use `df -h <blob-directory>` and inspect other consumers of the same volume, especially database snapshots. Do not disable the free-space reserve or delete live databases to restore downloads.

### ECS offsite SQLite backups

ECS keeps the five live databases only: `hapi.db`, `multi-user-gateway.sqlite`, `session-digests.sqlite`, `work-overview.sqlite`, and `subscription-snapshots.sqlite`, including their live SQLite sidecars. Preserve all live blobs, runtime data, and downloads under `/root/.hapi`; none are backup-pruning targets. Backups use consistent online snapshots and do not require a production restart.

- **Desktop-owned scheduling:** the `HapiEcsOffsiteBackup` Windows task on `DESKTOP-HT3P09U` runs daily at **04:30 desktop local time** (China Standard Time). It launches WSL Ubuntu 22.04 as root and runs `python3 /mnt/d/Backups/ECS/hapi/bin/ecs-offsite-backup.py daily`, with output appended to `D:/Backups/ECS/hapi/daily.log`. The desktop must be powered on; missed schedules use Task Scheduler's StartWhenAvailable setting. Register the desktop task and remove the former ECS maintenance cron only after an actual end-to-end smoke transfer succeeds; never leave both schedulers active.
- **Direct offsite destination:** WSL Ubuntu 22.04 uses SSH and rsync directly to `root@101.133.153.229`, with the existing pinned SSH host key and credentials, never a third-machine relay. Retained copies live under `D:/Backups/ECS/hapi`: `archive/migration-<UTCid>/<original absolute path without the leading slash>` for migrated snapshots, and `daily/<UTCrunid>/<database>.gz` for new runs. There is no automatic desktop retention deletion.
- **Transient source staging:** install the maintained `scripts/ecs-offsite-source.py` and `scripts/hapi-db-maint.sh` alongside `scripts/snapshot-db.js` and the existing `/root/bin/compress-hapi-backups.sh` in `/root/bin`; install `scripts/ecs-offsite-backup.py` in the desktop backup root's `bin` directory. The source helper invokes maintenance with `HAPI_DB_BACKUP_ROOT=/data/hapi-backups/offsite-staging` and a UTC `HAPI_BACKUP_RUN_ID` in `YYYYmmddTHHMMSSZ` format. Each run writes only to `<root>/<run-id>`; all run IDs share the root's maintenance lock. The script keeps `VACUUM INTO`, snapshot `quick_check`, partial-file guards, compression, a 5 GiB free-space reserve before snapshot/analysis writes, and Sunday (or `FORCE_ANALYZE=1`) copy-based ANALYZE with live planner-stat injection. Missing any of the five source databases fails the run. It performs no old-backup retention or source backup pruning.
- **Verify before ECS deletion:** the desktop worker verifies source and destination SHA256, decompresses each SQLite snapshot to a separate restore file, and requires SQLite `quick_check` to return `ok`. It records source/target hashes and restore-check results in JSON receipts before asking the guarded source helper to delete the exact verified closed files. Never delete live database files, their sidecars or inode aliases, blobs, runtime data, or downloads. Failed generation, transfer, verification, or removal leaves source staging available for recovery; a failed run is not permission to prune other backups.
- **Bandwidth reuse and serialization:** rsync uses 4 KiB SQLite page blocks against matching retained bases and verifies the resulting bytes against the source. When a retained raw or compressed basis is available, compressed backups can stage a temporary raw copy under `/data/hapi-backups/.raw-delta` (preserving the 5 GiB blob reserve), transfer only changed pages, rebuild `gzip -1` with the original header timestamp, and verify exact SHA-256 parity before source deletion; any mismatch falls back to direct transfer. Temporary raw bases are removed after completion. Migration and daily workers share a desktop lock; a nightly run waits for an active migration instead of skipping that day's backup.
- **Compression and restore:** the existing `compress-hapi-backups.sh <backup-file> ...` accepts closed snapshots under `/data/hapi-backups`, including offsite staging. It stages compression on the system disk, compares it byte-for-byte with the source, then publishes before removing the uncompressed staging copy; insufficient publication space leaves the original intact. Restore with `gzip -dc backup.db.gz > restored.db` and validate that separate file before any deliberate database replacement. Never redirect over a running database.

## Background service deployment

Keep HAPI running persistently so it survives terminal closes, system restarts, and continues running in the background.

<details>
<summary>Quick: nohup</summary>

Simple one-liner for quick background runs:

```bash
# Hub
nohup hapi hub --relay > ~/.hapi/logs/hub.log 2>&1 &

# Runner
nohup hapi runner start-sync > ~/.hapi/logs/runner.log 2>&1 &
```

View logs:

```bash
tail -f ~/.hapi/logs/hub.log
tail -f ~/.hapi/logs/runner.log
```

Stop processes:

```bash
pkill -f "hapi hub"
pkill -f "hapi runner"
```
</details>

<details>
<summary>pm2 (recommended for Node.js users)</summary>

pm2 provides process management with auto-restart on crashes and system reboot.

```bash
# Install pm2
npm install -g pm2

# Start hub and runner
pm2 start "hapi hub --relay" --name hapi-hub
pm2 start "hapi runner start-sync" --name hapi-runner

# View status and logs
pm2 status
pm2 logs hapi-hub
pm2 logs hapi-runner

# Auto-restart on system reboot
pm2 startup    # Follow the printed instructions
pm2 save       # Save current process list
```
</details>

<details>
<summary>macOS: launchd</summary>

Create plist files for automatic startup on macOS.

**Hub** (`~/Library/LaunchAgents/com.hapi.hub.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string>
        <string>hub</string>
        <string>--relay</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
</dict>
</plist>
```

**Runner** (`~/Library/LaunchAgents/com.hapi.runner.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string>
        <string>runner</string>
        <string>start-sync</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
</dict>
</plist>
```

Load/unload services:

```bash
# Load (start)
launchctl load ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl load ~/Library/LaunchAgents/com.hapi.runner.plist

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl unload ~/Library/LaunchAgents/com.hapi.runner.plist
```

> **macOS sleep note:** macOS may suspend background processes when the display sleeps. Use `caffeinate` to prevent this:
> ```bash
> caffeinate -dimsu hapi hub --relay
> ```
> Or run `caffeinate -dimsu` in a separate terminal while HAPI is running.
</details>

<details>
<summary>Linux: systemd</summary>

Create user-level systemd services for automatic startup.

**Hub** (`~/.config/systemd/user/hapi-hub.service`):

```ini
[Unit]
Description=HAPI Hub
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hapi hub --relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

**Runner** (`~/.config/systemd/user/hapi-runner.service`):

```ini
[Unit]
Description=HAPI Runner
After=network.target hapi-hub.service

[Service]
Type=simple
KillMode=process
ExecStart=/usr/local/bin/hapi runner start-sync
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

> **Why `KillMode=process`?** The runner spawns each agent session as a detached child process (`detached: true` in `cli/src/runner/run.ts`) so that sessions stay alive when the runner exits. Without `KillMode=process`, systemd's default `KillMode=control-group` sends SIGTERM to every PID in the runner's cgroup when the unit stops, defeating the detach and forcibly archiving every running session. `KillMode=process` preserves the contract: stopping or restarting the runner only signals the runner itself; agent sessions stay alive, and a fresh runner re-establishes control via the existing socket.io reconnect path. This applies to runner upgrades, manual restarts, and any reboot in which the runner unit is stopped before agents have finished.

Enable and start:

```bash
# Reload systemd
systemctl --user daemon-reload

# Enable (auto-start on login)
systemctl --user enable hapi-hub
systemctl --user enable hapi-runner

# Start now
systemctl --user start hapi-hub
systemctl --user start hapi-runner

# View status/logs
systemctl --user status hapi-hub
journalctl --user -u hapi-hub -f
```

> **Persist after logout:** To keep services running even when not logged in:
> ```bash
> loginctl enable-linger $USER
> ```
</details>

## Subscription quota collection stalls

Subscription quota cards use `GET /api/subscription/summary`, separately from the
message-token usage totals. Only successful snapshots no older than 15 minutes
are displayed as current quota. The page checks age every minute independently
of query refresh, so a stalled request cannot keep an old number on screen.
Expired reports remain stored for diagnosis; the panel reports how many results
are hidden while waiting for fresh data. A valid zero balance is still displayed.

Keep the collection routes separate:

- **GPT/cx2cc:** the Hub polls `HAPI_CX2CC_USAGE_URL` and its account-pool endpoint
  using `HAPI_CX2CC_API_KEY`. Check the gateway and its configured upstream; this
  path does not depend on the Windows subscription collector.
- **Antigravity:** the Windows collector invokes the installed `agy -p /usage`
  command. It keeps the CLI's own authentication and network/proxy configuration.
- **Devin/DeepSeek:** the Windows collector queries the provider endpoints with
  its local credentials. Do not redirect these requests through the GPT gateway
  or force Antigravity's proxy settings onto them.

If all Windows-collected providers share an old timestamp while GPT still
updates, inspect `HapiSubscriptionCollector` and
`~/.hapi/logs/subscription-collector.log` on the **collector host** first. Runner
connectivity alone does not prove that the separate collector task is running.
The Windows wrapper redirects output directly to a file to avoid console
QuickEdit blocking its event loop.

`HAPI_SUB_HUB_TOKEN` must contain a valid, independently revocable **admin API
token**. Retiring an old shared Hub key does not update this separate environment
file or an already-running collector process. Persistent HTTP 401 requires
updating that credential on the collector host, not restoring the retired key.
Keep the environment file ACL-restricted and never print its values in logs.

Hub authentication and report deadlines cover response-body consumption as well
as response headers. The collector watchdog runs independently of the polling
callback; after prolonged failed delivery it exits only the collector process,
allowing its scheduled-task restart policy to take effect. GPT polling schedules
the next round even after a failed response or snapshot write.

Updating source files does not change a running compiled Hub. Coordinate its
release window separately from updating the collector host. Do not restart the
Hub or runners, kill agent sessions, or launch duplicate collectors merely to
refresh quota cards during session recovery. Leave unreachable hosts' snapshots
stale rather than publishing another host's data under their identity.

Before compiling a production replacement, retain its exact source revision,
tracked patch, required untracked sources and assets, and binary SHA-256. A build
from a dirty worktree cannot be reproduced from the revision alone. Do not use a
bare-commit rebuild that could undo already-deployed authentication changes.

Formal quota releases must preserve the deployed gateway authentication and
shared runtime API, not pull in unrelated unfinished Beta work. Retain the
existing embedded formal UI and `HAPI_BETA_WEB_DIR` directory/mount when neither
UI is part of the release; compare their served entrypoint hashes in preflight.

Run the compiled candidate against isolated database copies first. Exercise
scheduled GPT recovery after a malformed response, retired shared credentials
(plain and namespace-suffixed) on Web/CLI/Socket.IO, independent credentials,
revoked JWTs and runtime streams, and admin reads of foreign unbound resources.
Admin visibility must not change password hashes or resource ownership.

For an authorized Hub-only cutover, retain the previous executable and consistent
online database backups. Atomically replace the verified executable on the host
and restart only the `hapi-hub` container; do not upgrade or restart runners or
terminate their agents. Verify the live binary hash, real GPT gateway snapshots,
existing session reconnection, preserved formal/Beta entrypoints, and gateway
security again after activation. Collector deployment remains a separate host
operation, not proof supplied by a successful Hub rollout.

### Moving the Windows collector to another machine

On 2026-11-08, collection moved to the ThinkPad T14s Gen 2i
(`DESKTOP-26GU3SD`), with `HAPI_SUB_MACHINE=T14s`. The old local task had
been reporting as `vircs`; its separate Hub credential returned HTTP 401 after
the shared-key retirement. Do not infer the physical source of an old snapshot
from its configured machine label.

For a host migration:

1. Verify the physical host and provider credentials with real read-only quota
   requests before reporting. Preserve each provider's existing network route.
2. Back up the existing task XML and collector environment under an
   ACL-restricted directory. Disable only `HapiSubscriptionCollector` while
   replacing it; inspect for orphan collector processes before starting another.
3. Deploy the reviewed collector independently of active development worktrees.
   The T14s installation is
   `D:/services/hapi-subscription-collector/releases/34a2a7b3`, containing the
   PowerShell wrapper, TypeScript entrypoint, subscription domain types, and four
   collector modules. Source and installed file SHA-256 values were compared.
4. Issue a dedicated admin API token through `/api/tokens`, store it only in the
   ACL-restricted `~/.hapi/subscription-collector.env`, and use a distinct machine
   label. Never copy or rotate an active Runner's credential for this purpose.
5. Replace the existing task, not its name: hidden PowerShell window, login and
   startup triggers, `IgnoreNew`, no execution time limit, one-minute failure
   retries, and permission to continue on battery. The T14s task retains its
   existing interactive user principal: it runs while that user is logged in;
   disconnecting RDP is not logging out. It does not guarantee collection while
   the laptop is asleep/offline or the user is logged out.
6. Observe at least two naturally scheduled successful reports on the production
   summary endpoint and the real `/usage` page. Check that original machine
   snapshots remain unchanged, only one collector process exists, and Runner
   process identity and existing sessions are preserved. Keep the private backup
   for recovery; do not restore its retired credential.

T14s reuses its existing AGY login, locally discovered Devin credentials, and
configured DeepSeek/GLM keys. This migration does not supply absent Anthropic or
Kimi credentials, nor does it require restarting the Hub or Runner. Historical
`vircs` snapshots are retained rather than overwritten by T14s, but no longer
appear as current quota after the 15-minute freshness window.
## Isolated event-driven Beta UI

The Hub serves an optional second SPA at `/beta/` from
`HAPI_BETA_WEB_DIR` (default: `<HAPI_HOME>/web-beta`). It uses the existing
same-origin authenticated API, databases, machine identities and runners.
Do not start a second Hub against the same SQLite files, and do not start
another OMP process against a running session's journal.

Build the Beta web app with `VITE_HAPI_BETA=1`, `VITE_BASE_URL=/beta/`, and a
separate Vite `--outDir`. Retain the original production `web/dist` as a backup.
For a frontend-only event trial, keep embedding those unchanged production assets.
For the full-input cutover, also stage a companion build with `VITE_HAPI_BETA=0`
and `VITE_BASE_URL=/`: it retains the traditional layout while understanding
terminal input resolutions and cancellation responses. Pass its absolute directory
as the optional positional argument to `hub/scripts/generate-embedded-web-assets.ts`
before compiling the Hub. The old JavaScript cannot safely interpret every new
receipt state merely because the wire schema is additive.

Changelog metadata follows the selected output directory. The Beta service worker
is scoped to `/beta/` and does not cache authenticated API responses in origin-wide
CacheStorage. Coordinate the companion asset change with the backend cutover;
preserving the `/` entry does not mean keeping an incompatible client bundle.

Roll out the additive Hub/CLI runtime protocol before opening the Beta UI.
New or deliberately resumed OMP sessions on upgraded runners publish native
events. Already-running sessions are not restarted by this deployment and
remain usable in history-compatible mode. Ordinary session controls, file
services and business pages keep the same authorization and backend owners.

The full-turn and durable-input Beta additionally needs the turn-page Hub API,
generation-aware Runner cleanup, and both native OMP `capabilities.inputReceipts`
and `capabilities.nativeOrder`.
Stage the capable native executable before the dependent HAPI CLI; version text
alone is insufficient. The Hub must understand the generation and terminal-input
protocol before trial sessions use them. Keep the production entry and active
session processes intact; coordinate Hub restarts and Runner handoffs explicitly.

Turn boundaries and terminal input resolutions use sparse auxiliary tables.
Native ordering adds nullable message-position columns and one global metadata
index, without decoding or rewriting transcript payloads or changing core schema
version 20. That index is built at first startup and can dominate downtime on a
large database; measure its construction on a consistent isolated backup before
scheduling the cutover. Do not run a second Hub on the production database to
prewarm it. Turn-boundary indexes are separate and remain lazy per authorized
session, so the first turn-based read may cost more than subsequent reads.

If the running Hub already exposes `/api/sessions/:id/runtime` and reports
missing Beta assets at `/beta/`, install a verified web bundle in a versioned
directory and atomically create or replace only the `web-beta` link. Assets
are resolved per request; neither the Hub nor a production runner needs a
restart. Check that `/` still serves the same production assets.

During recovery, a staged CLI can run one separate verification session with
`hapi omp --hapi-starting-mode remote`; it must use a new session identity or
an inactive session owned by that verification. This does not upgrade the
production runner. Require `available: true` and `source: connected` from
that session's runtime endpoint before calling it a native-event trial.
Other sessions can legitimately remain history-compatible. Coordinate any
subsequent runner upgrade; do not replace its watched executable during
recovery merely to change the Beta label.

For frontend-only rollback, return to `/` and move the Beta asset link out of
the mounted path; leave all running services alone. Binary rollback after the
full-input cutover requires a resolution-aware build: an arbitrary older Hub
does not understand handled/cancelled sidecar records and can replay terminal
inputs incorrectly. Do not downgrade native receipt handling while journal-owned
inputs remain unresolved. Retain database, native journals and blob files;
restoring an old database would discard intervening messages, grants and token
revocations. Never terminate every process named `hapi` or kill unrelated
session-owned OMP processes.
