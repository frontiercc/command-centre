# Frontier Command Centre: Connect Claude

How to send Claude Code and Claude Cowork telemetry to Command Centre, for any installation: Docker on one machine, or a deployment on AWS or Azure. Claude Chat needs no client settings: on Claude for Enterprise, Command Centre reads its conversations from Anthropic's Compliance API, using the Compliance Access Key entered under **Admin → Access & Keys**.

**The quickest way:** open **Admin → Ingestion** in Command Centre. The page's **Connect Claude** panel shows the collector address and, with Docker, the bearer token, and copies the Claude Code settings for you, filled in. The rest of this guide explains each setting and the other ways to distribute them.

You need two values:

| Value | Where it comes from |
|---|---|
| The collector address | With Docker on your own machine, `http://localhost:4318`. For an organisation, the HTTPS address you serve the collector on, such as `https://otel.your-company.com`. Enter it with **Edit** on Admin → Ingestion |
| The bearer token (`OTEL_ENDPOINT_SECRET`) | With Docker, shown on **Admin → Ingestion**, printed by the setup command and kept in `.env`. On AWS or Azure, Admin → Ingestion does not show it: use `OTEL_ENDPOINT_SECRET` from your secret store, such as Secrets Manager on AWS or Key Vault on Azure. Claude sends it as `Authorization=Bearer <token>`. |

People's machines send telemetry to the collector, so for an organisation the collector must be reachable from them over HTTPS, for example through a reverse proxy such as Caddy in front of port 4318.

To change the bearer token, or check that the collector accepts it, see [Troubleshooting and FAQ](troubleshooting.md#settings).

## Claude Code settings

These settings turn on Claude Code's telemetry and point it at your collector:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://otel.your-company.com",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <your bearer token>",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "delta",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_SERVICE_NAME": "claude-code"
  }
}
```

| Variable | Value | Why Command Centre needs it |
|---|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` | Turns telemetry export on |
| `OTEL_LOGS_EXPORTER` | `otlp` | Prompts, model requests, tool results, skills used |
| `OTEL_METRICS_EXPORTER` | `otlp` | Engaged time, lines changed, commits, pull requests, edit decisions |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | `delta` | Command Centre adds metric points together; cumulative values would be counted many times over |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | The collector listens for OTLP over HTTP only |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Your collector | Destination |
| `OTEL_EXPORTER_OTLP_HEADERS` | Bearer token | The collector rejects requests without it |
| `OTEL_LOG_USER_PROMPTS` | `1` | Prompt text for the Audit Log, PII and intent detection, the classifiers and use case judging |
| `OTEL_LOG_TOOL_DETAILS` | `1` | Connector and skill names, and AI-assisted commit counts |
| `OTEL_SERVICE_NAME` | `claude-code` | Names the client, so Command Centre files its events under Claude Code |

Set delta explicitly, even where it is already the client's default, so that no local setting can change it. With cumulative temporality, Developer Pulse's measured figures are inflated and cannot be corrected after the fact. Command Centre needs no change to the clients' default export intervals.

## Optional and privacy-relevant settings

`OTEL_LOG_USER_PROMPTS` is the single most consequential choice. Without it, prompts arrive redacted: Command Centre still counts them, but the Audit Log, PII and intent detection, use case judging and process suggestions cannot work on them, and the Code session classifier works from metadata alone. Decide it with your data protection officer, alongside the retention periods and the switches that control which features read prompt text.

`OTEL_LOG_TOOL_DETAILS` sends tool parameters and the names of your organisation's own skills. Command Centre keeps from the parameters only a connector's name and the name of the connector tool used, and the fact of a commit (never its identifier); it never stores the content of tool inputs. You can leave it unset at the cost of connector and organisation skill names in Claude Code and AI-assisted commit counts.

Command Centre stores none of Claude's reply text: it skips reply events at ingest. Do not turn on tool-content logging or tracing; Command Centre has no trace pipeline.

Command Centre reads a `department` attribute when a Claude Code client sends one, which is an alternative to loading departments by CSV. Add it to the same `env` block with the `OTEL_RESOURCE_ATTRIBUTES` variable, for example `"OTEL_RESOURCE_ATTRIBUTES": "department=Finance"`; Claude Code attaches the value to every event and metric it exports. The variable takes comma-separated `key=value` pairs, and a value may not contain spaces, commas, semicolons, double quotes or backslashes. Anthropic's guidance is to percent-encode such characters (a space as `%20`), so for a department name with a space, check on one machine that the name appears in Command Centre as intended before rollout. Command Centre takes the value when it first sees a person and never overwrites a department already recorded for them. Because the value differs by group, deliver it through a managed settings file or MDM profile per group: the managed settings in Claude's Organization settings apply identically to everyone in the organisation. Claude Cowork's telemetry settings carry no custom attributes, so load departments by CSV for people who use only Claude Cowork: under **Admin → Ingestion → Pre-populate OTel users**, one line per person in the form `email,display_name,department`.

## Distributing the settings centrally

Distribute the settings centrally, so that a token change reaches everyone. Claude Code offers the following mechanisms; all three sit in the highest-precedence tier of its settings, where no user or project setting can override them.

- **Server-managed settings in Claude's Organization settings.** On Claude for Teams and Claude for Enterprise, an Owner or Primary Owner pastes the JSON above into **Organization settings → Claude Code → Managed settings** on claude.ai. Clients signed in with the organisation's Claude for Teams or Claude for Enterprise login fetch the settings at startup and check for changes hourly; telemetry exporter settings take effect when Claude Code next starts. Because the block sets a collector endpoint, each person is asked to approve the managed settings in an interactive Claude Code session when they first arrive, and again when settings that need approval change.
- **Managed settings file.** Write the JSON above to `managed-settings.json` in the system directory on each machine with your endpoint management tooling: `C:\Program Files\ClaudeCode\managed-settings.json` on Windows, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, and `/etc/claude-code/managed-settings.json` on Linux and WSL. Claude Code does not read the older Windows location under `C:\ProgramData\ClaudeCode`.
- **MDM or Group Policy.** Deliver the same keys as a macOS configuration profile in the `com.anthropic.claudecode` managed preferences domain, or on Windows as a `REG_SZ` value named `Settings`, holding the JSON, under `HKLM\SOFTWARE\Policies\ClaudeCode`.

## Claude Code inside the Claude desktop app

Code tab sessions that run on the person's computer read the same managed settings as the terminal client. Put `CLAUDE_CODE_ENABLE_TELEMETRY` and the `OTEL_*` variables in the `env` block of the managed settings file shown above; a local Code tab session applies the file deployed to the machine, and settings pushed from Claude's Organization settings also reach it when the person signs in with an eligible account. Code tab sessions in Anthropic's cloud receive only the Organization settings' managed settings, and SSH sessions read the managed settings file on the remote host. No separate per-machine step is needed for local Code tab sessions.

## Claude Cowork

Claude Cowork telemetry is configured once, for the whole organisation, in Claude's Organization settings, under **Data and Privacy → Monitoring**, on Claude for Teams and Claude for Enterprise, with no per-machine step. Fill in the three monitoring fields and save.

| Field | Value |
|---|---|
| **OTLP endpoint** | `https://otel.your-company.com` |
| **OTLP protocol** | `http/json` |
| **OTLP headers** | `Authorization=Bearer <your bearer token>` |

Claude Cowork loads these settings when a session starts, so sessions already open do not pick them up. The settings apply to Claude Cowork sessions that run on people's computers.

**Turn off Cowork in the cloud.** Claude Cowork sessions that run on Anthropic's cloud do not currently send their activity reliably, so Command Centre would miss them. In Organization settings, switch off both:

- **Cowork in the cloud** (beta), under **Claude Cowork**.
- **Chat and Cowork unified**, under **Capabilities**. It runs Cowork tasks in the cloud even when Cowork in the cloud is off.

On Anthropic's standard deployment of Claude desktop, Claude Cowork events carry prompt text and tool details unless the device setting `otlpContentCapture` says otherwise. Command Centre needs both, so if your device management sets that key, include `userPrompts` and `toolDetails` in it. If Claude Cowork prompts show as `<REDACTED>`, see [Troubleshooting and FAQ](troubleshooting.md#connecting-claude). Events that carry prompt text also carry Claude's reply text; Command Centre discards reply events at ingest and stores none of their text. Claude Cowork events are told apart from Claude Code events by the service name each client reports, and both travel through the same collector.

**Check:** **Admin → Ingestion → Collector status** reads "Collector active, OTel events flowing", with the time of the last event.

## Claude Chat

Claude Chat sends no telemetry. On Claude for Enterprise, Command Centre reads every conversation from Anthropic's Compliance API.

1. In claude.ai, open [Organization settings → API](https://claude.ai/admin-settings/api-access). The Primary Owner turns the Compliance API on there.
2. Create a Compliance Access Key with the scopes `read:compliance_user_data` and `read:compliance_activities`. Scopes cannot be changed after a key is created, so include both now; the second is needed for the organisation activity feed, which is off by default. Command Centre never needs `delete:compliance_user_data`.
3. Copy the key straight away: Anthropic shows it only once.
4. In Command Centre, open **Admin → Access & Keys**, enter it in the **Compliance Access Key** field, use its test button, then select **Save settings**.

Command Centre checks for new Claude Chat prompts every two minutes, and its first check brings in the last 30 days. Command Centre stores people's prompts in full, the model and the connectors used, and how many files were attached and how many artifacts and files Claude made. It never stores the text of Claude's replies.

## Why OpenTelemetry for Claude Cowork and Claude Code, and the Compliance API for Claude Chat

Claude Cowork and Claude Code send their activity through OpenTelemetry to a collector you run. OpenTelemetry is the only route that carries what each session cost and which models it used, and the engineering measures: lines of code, commits, pull requests and edits accepted. OpenTelemetry has no Anthropic rate limit, and it works on Claude for Teams and Claude for Enterprise.

Claude Chat does not send OpenTelemetry, so Command Centre reads Claude Chat prompts through Anthropic's Compliance API, on Claude for Enterprise.

Anthropic's Compliance API can also return Claude Cowork and Claude Code sessions for Claude for Enterprise organisations. Command Centre could be developed to use it, so that nothing needs setting up on people's machines. Using it in place of OpenTelemetry loses:

- what each session cost, and the split by model;
- lines of code, commits, pull requests and edits accepted;
- Claude Code used through Amazon Bedrock, Google Cloud or a Console API key, which the Compliance API does not cover.

Spend per person per day could come from Anthropic's Analytics API instead, but its figures arrive about a day late, and costs can be revised for up to 30 days. The Compliance API also only allows 600 requests per minute, shared with every other tool the organisation connects to it.

If you would like to build this, see [CONTRIBUTING.md](../CONTRIBUTING.md).
