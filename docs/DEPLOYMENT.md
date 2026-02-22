# Dexter Daemon — Deployment Guide

**Version:** 1.0
**Updated:** 2026-02-22

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Bun | ≥ 1.1.0 | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | ≥ 20 (optional) | Only needed if running outside Bun |
| Git | any | For cloning the repository |
| systemd or PM2 | — | For process supervision |

### Required API keys

Set these in `.env` at the repository root before running:

```bash
# LLM provider (required)
DEXTER_DAEMON_MODEL=gpt-4o          # or claude-sonnet-4-6, etc.
OPENAI_API_KEY=sk-...               # if using OpenAI models
ANTHROPIC_API_KEY=sk-ant-...        # if using Claude models

# Financial data (required for earnings pipelines)
FINANCIAL_DATASETS_API_KEY=...

# Web search — at least one required for management agent
EXASEARCH_API_KEY=...
TAVILY_API_KEY=...

# Messaging — at least one required
TELEGRAM_BOT_TOKEN=...              # from @BotFather on Telegram
# WhatsApp uses the gateway (see whatsapp setup below)
```

---

## Quick Start (local)

```bash
# 1. Clone and install
git clone https://github.com/somasays/dexter.git
cd dexter
bun install

# 2. Create .env from template
cp .env.example .env
# Edit .env and fill in your API keys

# 3. Run the setup wizard (interactive)
bun run daemon:setup

# 4. Start the daemon
bun run daemon
```

---

## Data Directory

Dexter stores all state in `~/.dexter/` by default:

```
~/.dexter/
├── profile.json          # Financial profile (goals, holdings, delivery config)
├── profile.json.bak      # Previous profile (auto-created before every save)
├── pipelines/            # One JSON file per pipeline
│   └── AAPL-earnings-1234567890.json
├── scripts/              # Agent-generated collection scripts
│   └── AAPL-earnings-1234567890-collect.ts
├── collected/            # Raw data written by collection scripts
│   └── AAPL/earnings/2026-Q1/
│       └── results.json
├── memory/               # Thesis notes per ticker
│   └── AAPL.md
└── gateway-debug.log     # WhatsApp gateway debug log
```

### Override the data directory

Set `DEXTER_DIR` to use a non-default location (useful for multiple instances or testing):

```bash
DEXTER_DIR=/data/dexter bun run daemon
```

---

## Process Supervision

### Option A — systemd (recommended for Linux VPS)

Create `/etc/systemd/system/dexter.service`:

```ini
[Unit]
Description=Dexter Autonomous Wealth Agent Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/dexter
EnvironmentFile=/home/ubuntu/dexter/.env
ExecStart=/home/ubuntu/.bun/bin/bun run src/daemon/index.ts
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dexter
# Give the daemon time to finish an in-progress agent run before killing
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable dexter
sudo systemctl start dexter

# View logs
journalctl -u dexter -f
```

### Option B — PM2

```bash
# Install PM2 globally
bun add -g pm2

# Create ecosystem config
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'dexter',
    script: 'src/daemon/index.ts',
    interpreter: '/home/ubuntu/.bun/bin/bun',
    interpreter_args: 'run',
    cwd: '/home/ubuntu/dexter',
    env_file: '.env',
    restart_delay: 10000,
    max_restarts: 10,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file: '/home/ubuntu/.dexter/logs/daemon.log',
    error_file: '/home/ubuntu/.dexter/logs/daemon-error.log',
    merge_logs: true,
  }],
};
EOF

# Start
pm2 start ecosystem.config.js
pm2 save        # persist across reboots
pm2 startup     # configure startup script

# View logs
pm2 logs dexter
```

---

## VPS Recommendations

Dexter is lightweight. It spends most of its time sleeping in the wake-queue loop.

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512 MB | 1 GB |
| Storage | 10 GB | 20 GB |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| Network | 100 Mbps | 1 Gbps |

**Recommended providers (cheapest tier that meets minimums):**
- Hetzner CX11 ($3.29/mo) — best value for EU
- DigitalOcean Basic ($4/mo) — easy setup
- Vultr Regular ($3.50/mo) — good US coverage

**Latency note:** Dexter does not serve web traffic and is not latency-sensitive. Any region works.

---

## Health Monitoring

### Check if daemon is running

```bash
systemctl status dexter        # systemd
pm2 status dexter             # PM2
```

### Manual status check

```bash
bun run daemon:status
```

Output includes:
- Active pipelines with next scheduled run time
- Thesis coverage per holding
- Telegram connection status
- Last management run timestamp

### Key log patterns to watch

```bash
# Successful management run
journalctl -u dexter | grep "Management agent complete"

# Pipeline fired successfully
journalctl -u dexter | grep "Data collected at"

# Alert delivered
journalctl -u dexter | grep "[alert] Delivered"

# Errors worth investigating
journalctl -u dexter | grep -E "ERROR|failed|stuck"
```

---

## WhatsApp Setup

WhatsApp delivery requires the Dexter gateway running alongside the daemon.
The gateway maintains a persistent WhatsApp Web session via Baileys.

```bash
# 1. Start the gateway (first run shows a QR code to scan)
bun run gateway run

# 2. Scan the QR code with your WhatsApp mobile app
#    Settings → Linked Devices → Link a Device

# 3. Once connected, the gateway runs in the background
#    The daemon will use sendMessageWhatsApp() to deliver alerts

# For production, run the gateway under systemd alongside the daemon:
```

Add to `/etc/systemd/system/dexter-gateway.service`:

```ini
[Unit]
Description=Dexter WhatsApp Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/dexter
EnvironmentFile=/home/ubuntu/dexter/.env
ExecStart=/home/ubuntu/.bun/bin/bun run src/gateway/index.ts run
Restart=on-failure
RestartSec=30s
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

---

## Upgrading

```bash
# Pull latest changes
git pull origin main

# Install any new dependencies
bun install

# Restart the daemon
sudo systemctl restart dexter
```

**Breaking changes:** Check `CHANGELOG.md` (if present) before upgrading.
The profile schema is forwards-compatible — new optional fields are added, never removed.

---

## Backup and Recovery

### Back up your data

```bash
# Full backup of Dexter state
tar -czf dexter-backup-$(date +%Y%m%d).tar.gz ~/.dexter/

# Or rsync to a remote host
rsync -avz ~/.dexter/ user@backup-host:/backups/dexter/
```

### Recover from corrupt profile

If `profile.json` is corrupt, a backup is at `profile.json.bak`:

```bash
cp ~/.dexter/profile.json.bak ~/.dexter/profile.json
```

### Reset stuck pipelines manually

If a pipeline is permanently stuck in `running` state:

```bash
# List all pipelines
ls ~/.dexter/pipelines/

# Edit the pipeline JSON directly
nano ~/.dexter/pipelines/AAPL-earnings-1234567890.json
# Change "status": "running" to "status": "scheduled"

# Restart the daemon to pick up the change
sudo systemctl restart dexter
```

Alternatively, the daemon automatically resets any pipeline stuck in `running` for > 10 minutes on every startup.

---

## Security Notes

- **No inbound ports:** The daemon never listens on a network port. All communication is outbound (Telegram long-polling, HTTPS to APIs).
- **Credential storage:** API keys are in `.env`. Never commit `.env` to git. Set file permissions: `chmod 600 .env`
- **Telegram auth:** Only messages from the configured `chatId` are processed. All others are silently dropped.
- **Script sandbox:** Collection scripts run in a child process with an explicit environment allowlist (`HOME`, `PATH`, read-only data API keys, `DEXTER_*` path variables). LLM API keys, bot tokens, and other credentials are never injected into the subprocess.
- **File access:** The `read_collected_data` tool is restricted to `~/.dexter/collected/` — no arbitrary filesystem reads.
