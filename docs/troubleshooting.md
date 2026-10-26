# Frontier Command Centre: Troubleshooting and FAQ

Fixes for the problems people most often hit when installing, signing in, connecting Claude, running and updating Command Centre.

The commands are for Docker Compose installations: run them from the `command-centre` folder. If your problem is not listed, ask in [Discussions](https://github.com/frontiercc/command-centre/discussions), or report a bug in [Issues](https://github.com/frontiercc/command-centre/issues).

## Installing and signing in

**The site cannot be reached.** Command Centre is still starting. Command Centre is ready when `docker compose ps` shows the hub as `healthy`.

**The hub never becomes `healthy` after you made a new `.env`.** The database keeps the password from the first `.env`, and the settings Command Centre saved can only be read with the first `.env`'s encryption key. Put the first `.env` back, or start again with `docker compose down -v`, which deletes all data.

**Lost the setup token.** Run `docker compose restart hub`, then the command from [quick start step 4](../README.md#steps), and use the last token shown. A new token is printed only if the last one is over ten minutes old; if the log says a token was already issued, wait and restart again.

**Forgotten admin password.** Run `docker compose exec hub node scripts/reset-admin-password.mjs` and follow the prompts.

**Claude API key refused.** Create it inside a workspace in the [Claude Console](https://platform.claude.com/settings/keys). After the test, select **Save settings**: the test does not save it.

## Sample data

**Taken to the sign-in page, not setup.** The sample data was loaded before the admin account was created, and setup closes once the sample data is in. Start again with the commands in [Need to start again?](../README.md#need-to-start-again), create your admin account, then load the sample data.

**Pages still empty.** They fill in a few minutes after loading, once the scheduled jobs run. Reload to see new items in the sidebar.

**Two demo views missing.** The FinOps Enterprise figures and Dev Framework Alignment scores are hidden by default. In `.env`, remove the `#` from `# CCC_FINOPS_ALLOW_MOCK=1` and `# CCC_DX_ALLOW_MOCK=1`, then run `docker compose up -d`. Do not do this on an installation with real data.

## Connecting Claude

**Nothing arrives.** Check the collector accepts your bearer token (address and token from **Admin → Ingestion**):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://otel.your-company.com/v1/logs -H "Content-Type: application/json" -H "Authorization: Bearer <your bearer token>" -d '{}'
```

On Windows, use `curl.exe` and `-o NUL`. `200` means the token is right, `401` means it is wrong. If it is right, check that people's computers can reach the collector, that Claude Code was restarted and the settings approved, and that Claude Cowork sessions started after you saved the Claude Cowork monitoring settings.

**Some Claude Cowork sessions are missing.** Sessions run on Anthropic's cloud don't currently send their activity reliably. In Organization settings, switch off **Cowork in the cloud** (under Claude Cowork) and **Chat and Cowork unified** (under Capabilities).

**Claude Cowork prompts show as `<REDACTED>`.** Set `otlpContentCapture` on the machine, then quit and reopen Claude Desktop.

Windows (PowerShell as administrator):

```powershell
New-Item -Path 'HKLM:\SOFTWARE\Policies' -Name 'Claude' -ErrorAction SilentlyContinue | Out-Null; Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Claude' -Name otlpContentCapture -Value '["userPrompts","toolDetails"]'
```

Mac:

```bash
sudo mkdir -p "/Library/Managed Preferences/$(whoami)" && sudo defaults write "/Library/Managed Preferences/$(whoami)/com.anthropic.claudefordesktop" otlpContentCapture -string '["userPrompts","toolDetails"]'
```

For many machines, deploy the same key with your device management tool.

**No grading yet.** Claude Cowork work is graded every five minutes, Claude Code sessions within an hour of going idle. Grading needs the Claude API key.

## Settings

**Where are my settings?** In `.env` in the `command-centre` folder (a hidden file). Open it with `notepad .env` on Windows, `open -e .env` on a Mac, or `nano .env` on Linux.

**Change the bearer token.**

1. Make one: `docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Put it after `OTEL_ENDPOINT_SECRET=` in `.env`, then run `docker compose up -d`.
3. Straight away, copy the new settings from **Admin → Ingestion** into claude.ai, and update the OTLP headers in the Claude Cowork monitoring settings. Telemetry sent with the old token is refused and lost.

On AWS or Azure, change `OTEL_ENDPOINT_SECRET` in your secret store and redeploy the collector, then update Claude's settings as in step 3.

**Change the collector address.** On **Admin → Ingestion**, select **Edit** beside the collector address, enter the new one and save. Then copy the new Claude Code settings into claude.ai and update the OTLP endpoint in the Claude Cowork monitoring settings.

## Running it

**Stop and start.** `docker compose stop` keeps your data; `docker compose up -d` starts again.

**Remove it.** See [Uninstall](uninstall.md).

## Updating

### Back up first

Back up the database, and keep a copy of `.env` with it: stored secrets, such as API keys, cannot be read without its `CCC_ENCRYPTION_KEY`.

```bash
docker compose exec -T postgres pg_dump -U ccc -d ccc > command-centre-backup.sql
```

### Update

Each release is tagged, for example `v1.0.1`, and the [releases page](https://github.com/frontiercc/command-centre/releases) says what changed. Replace `v1.0.1` with the release you want:

```bash
git fetch --tags
git checkout v1.0.1
docker compose up -d --build
```

Command Centre updates its database when it starts and keeps your data. Updates go forward only: to go back, restore the backup you took first.

### Restore a backup

Into an empty installation, with the `.env` you kept:

```bash
docker compose down -v
docker compose up -d postgres
docker compose exec -T postgres psql -U ccc -d ccc < command-centre-backup.sql
docker compose up -d --build
```

On AWS or Azure, restore from your managed database's backups instead, keeping the same `CCC_ENCRYPTION_KEY`.
