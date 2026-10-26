# Frontier Command Centre: Security and Data Protection

This document explains how Command Centre protects the data it holds on infrastructure you control: who can sign in and what each person can see, how data is encrypted, what is captured and what is never stored, how long data is kept, how activity is audited, and how the product is built and maintained. Each control described has been checked against the application's source code.

Everything here applies however Command Centre is run. AI data flows are covered in [AI Data Flow and Sub-processors](ai-data-flow.md).

**Contents:** [Security model](#security-model) · [Identity and access](#identity-and-access) · [Authorisation](#authorisation) · [Application protections](#application-protections) · [Service authentication](#service-authentication) · [Data protection](#data-protection) · [PII and secret detection](#pii-and-secret-detection) · [Retention and deletion](#retention-and-deletion) · [Audit logging](#audit-logging) · [Logging, monitoring and alerting](#logging-monitoring-and-alerting) · [Vulnerability management and secure development](#vulnerability-management-and-secure-development) · [Threat model summary](#threat-model-summary) · [Incident response](#incident-response) · [Standards alignment](#standards-alignment)

## Security model

Command Centre consists of a web application (the Hub), an OpenTelemetry Collector and a PostgreSQL database. With the supported Docker Compose installation, all three run as containers on a machine you control; the Hub can instead use a managed PostgreSQL database. Claude clients on your organisation's machines (Claude Code and Claude Cowork) export telemetry to the collector, which forwards it to the Hub. On Claude for Enterprise, the Hub also pulls Claude Chat conversations from Anthropic's Compliance API using a read-only key that you create.

Command Centre is a downstream observer. Telemetry reaches it only after a prompt has gone to Claude, so it cannot block, alter or delay anything a person sends. Command Centre can flag, alert on, restrict access to and delete what it stores. Controls that must act before content reaches Claude belong in Claude's own administrative settings, your identity provider and your endpoint controls.

All data Command Centre stores remains on infrastructure you control. The Command Centre project operates no service in the data path and receives no telemetry from your deployment. The Hub makes outbound calls only to services you configure: the Anthropic API (AI features and the read-only Compliance, Analytics and Admin API pulls; the Analytics and Admin pulls are on the roadmap), your identity provider, your SMTP relay, Slack webhooks you supply, the GitHub API and, if you enable archiving, your own Amazon S3 bucket.

![Trust boundaries](diagrams/Trust%20boundaries.png)

*Figure 1. Trust boundaries TB1 to TB6. Arrows show which side starts each connection.*

### Shared responsibility

| Area | Your organisation | Command Centre application | Anthropic |
|---|---|---|---|
| Network and edge | Network exposure and firewall, the HTTPS reverse proxy or load balancer, any web application firewall, DNS, egress control | Origin checks, body size limits, security headers, ingest rate limits | Not involved |
| Identity | Identity provider, MFA policy for SSO users, joiners and leavers, role assignment | Local accounts, password hashing, TOTP MFA, sessions, role checks on every route | Claude identity reported in telemetry |
| Data at rest | Disk or database encryption and its keys, backups and access to them | Encryption of stored secrets and MFA seeds, hashing of sign-in, reset and connector tokens | Data in Claude services under your Anthropic agreement |
| Data in transit | Certificates and TLS at your proxy, TLS on a managed database, SMTP relay TLS | Verified TLS to a managed database, HTTPS to outbound services | TLS on the Anthropic API |
| Logging and monitoring | Keeping, alerting on and forwarding the containers' logs, SIEM | Access audit log, authentication events, System health, alerts | Compliance API activity records |
| Content capture | Claude client telemetry settings, which decide what is sent | Detection, retention, access control and deletion of what arrives | Running the Claude clients and APIs |
| Patching | Applying Command Centre releases, patching the host and its container runtime | Dependency management and fixes in each release | Claude clients and API |
| Legal basis | Lawful basis, employee notices, DPIA, works council consultation | Retention, erasure, export and access controls that support them | Its own processing under your agreement |

## Identity and access

### Sign-in methods

People sign in with a local Command Centre account (email and password) or through single sign-on.

Single sign-on uses OpenID Connect with the authorisation code flow, PKCE (S256), `state` and `nonce`, implemented with the OpenID-certified `openid-client` library, and works with identity providers that implement OpenID Connect. Single sign-on has been tested with Google Workspace and Microsoft Entra ID. SAML is not supported; it is on the roadmap. The library validates the ID token's issuer, audience, expiry and nonce.

The identity provider is trusted only to prove identity. Before any account lookup the ID token must show that the provider has verified the email: `email_verified: true`, or, for Microsoft Entra ID, which does not send that claim, the optional claim `xms_edov: true`. For Entra, add the optional ID token claims `email` and `xms_edov` to the app registration. The verified email must then match an existing Command Centre account with SSO enabled; an unknown email is refused and no account is created. Every SSO sign-in and refusal is written to the access audit log with its reason. The temporary PKCE, state and nonce values travel in a ten-minute encrypted cookie and are never stored on the server.

### Passwords and multi-factor authentication

Local passwords are hashed with scrypt (N=32768, r=8, p=2, 64-byte output, 16-byte random salt) and compared in constant time. Every route that sets a password, and the server-side recovery tool, enforces a minimum of 12 characters.

Local accounts can enrol in TOTP multi-factor authentication (RFC 6238, compatible with standard authenticator apps), which issues ten single-use recovery codes stored only as SHA-256 hashes. After a correct password the user holds a five-minute encrypted pending cookie, and a session is issued only once a valid code is entered. Each code is usable once: the consumed time step is claimed in the database in a single conditional write, so a captured code cannot be replayed against any Hub instance. Disabling one's own MFA requires the account password, an administrator can reset MFA for another account, and each TOTP seed is encrypted at rest.

MFA is enrolled per user. SSO users authenticate under your identity provider's MFA policy.

### Sessions

A successful sign-in issues a 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie, marked `Secure` in production. The database stores only the token's SHA-256 hash, so a copy of the database cannot be used to sign in. A normal session ends after 8 hours unused or 24 hours after sign-in; a "remember me" session lasts 7 days with no idle timeout. Every request is checked against the database, and expired sessions are removed daily. Administrators can list active sessions (user, IP address, user agent, sign-in time) and revoke one or all of a user's sessions; a password change or reset ends all of that user's sessions.

### Brute-force protection

Sign-in and MFA verification are each limited to 5 attempts per minute per client address on each Hub instance. Independently, 10 consecutive failed attempts, counting wrong passwords and wrong MFA codes alike, lock an account for 15 minutes; the lock is held in the database, so it applies across all Hub instances. The count resets on a completed sign-in: a correct password when no MFA step follows, or a correct MFA code.

### Password reset and recovery

Self-service reset requires SMTP to be configured. The token is 256 bits, stored only as a SHA-256 hash, valid for one hour, single use, and replaces any earlier unused token. The link is built only from the Hub's configured public URL, never from request headers; without one, no email is sent and the reason is recorded. The response is identical whether or not an account exists, and requests are limited to 5 per 15 minutes per client address on each Hub instance.

A locked-out administrator is recovered with a tool run inside the Hub container (with Docker Compose, `docker compose exec hub node scripts/reset-admin-password.mjs`), which sets a new password, clears the lockout and ends that account's sessions. Running it needs access to the host, so it is limited to whoever administers the machine.

### How accounts come to exist

1. **First administrator.** On first start the Hub prints a one-time setup token in its log and stores only its hash. Claiming it deletes it in a single statement, so exactly one request can create the first administrator.
2. **Created by an administrator**, with a role and department.
3. **Auto-enrolled from telemetry.** When a person first appears in Claude telemetry or the Compliance API, an account is created with the `pulse` role, no usable password and SSO disabled. Observation alone never grants sign-in.

An auto-enrolled account becomes usable when an administrator sets a password or enables SSO for it, or when the person completes a self-service password reset, which also enables SSO for the account. Self-service activation is allowed only when another account on the same email domain already has a real password or SSO enabled.

## Authorisation

### Roles

Every account has one of six roles. Signing in establishes identity only; each page and API route makes its own role decision on the server.

| Role | Intended for | Can see | Cannot see |
|---|---|---|---|
| `admin` | Platform owners | Everything, including settings, security, the access audit log and all prompt text | Nothing withheld |
| `manager` | Department and AI programme leads | Dashboards, alerts, reports, Cowork and Developer Pulse, Pulse administration, FinOps and Spend Review, Use Cases, prompt text for their own department (none until a department is set on their account) | System settings, security, the access audit log |
| `viewer` | Executives and analysts | Dashboards, alerts, reports, Cowork and Developer Pulse pages (including every person's Claude Code spend, in all departments, in Developer Pulse), their own Spend Review | The Audit Log, FinOps, administration |
| `pulse` | Individual contributors | Their own figures; Cowork and Developer Pulse for their department | Other departments, other people's prompt text, administration |
| `cowork` | Individual contributors | As `pulse`, Work Pulse only | As `pulse` |
| `code` | Individual contributors | As `pulse`, Developer Pulse only | As `pulse` |

The contributor roles are scoped to the department on their account, which the server reads with the session on every request; a department supplied in a request cannot override it. Contributors can see per-person figures, such as delegation depth, activity and Claude Code spend, for colleagues in their own department, but not other people's prompt text. Only administrators can create accounts, change roles or departments, manage secrets, revoke sessions, issue Metrics Connector tokens or erase a person's data.

### A role decision on every API route

Because every Claude user can hold a session, a valid session is never treated as permission. Each API route handler calls an explicit role check, and a test in the build pipeline fails the build if any handler lacks one and is not on a short list of exceptions, each recorded with its reason: token-authenticated machine endpoints, the sign-in, setup and reset flows, the health check, a write-only client error report, development-only routes that are disabled in production, and a few routes that act only on the caller's own account or let any signed-in user submit or upvote a Skills and Connectors Board entry.

### Who can read prompt text

Prompt text is shown in full in the Audit Log and in Spend Review's session view, both restricted to administrators (all departments) and managers (their own department; none until a department is set on their account). Every read of prompt content there, allowed or refused, is written to the access audit log.

Four other views show short prompt extracts beside other data: the capability log on the Work Pulse Overview page, a person's pending capability candidates, the Pulse administration view of an individual, and the evidence on personal-data alerts. On these the server applies the same rule: administrators see every extract, managers those for their own department, and a person sees their own candidates; everyone else receives the row with the text removed, so text a caller may not see never reaches the browser. Reads of another person's prompt text on these views are access-logged. AI-written session descriptions and the names of files people produced go to administrators and managers, and to each person for their own work; other roles receive counts only.

## Application protections

| Control | What it does |
|---|---|
| Authentication gate | Middleware refuses any request without a session cookie, except the sign-in, setup, reset and SSO flows, the session-status and sign-out endpoints, a write-only client error report, the health check and token-authenticated machine endpoints. Each handler then validates the session against the database. |
| Cross-site request check | A state-changing API request whose `Origin` names another host, or is `null`, is refused (403) before any other processing, including on sign-in and setup. Machine endpoints and the SSO flow are exempt. |
| Request size limits | 1 MB on the sign-in, setup, reset, MFA and SSO routes and the client error report; 50 MB on telemetry ingest. A declared size over the limit is refused (413) before the body is read. |
| Start-up checks | In production the Hub refuses to start if `CCC_ENCRYPTION_KEY` is missing or a known default, or if `Secure` cookies have been switched off without a second explicit override intended only for local development. |
| Security headers | HSTS (one year, `includeSubDomains`, `preload`); Content Security Policy with a per-request script nonce and `strict-dynamic`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`; `X-Frame-Options: DENY`; `nosniff`; `strict-origin-when-cross-origin` referrer policy; camera, microphone and geolocation disabled; `X-Powered-By` suppressed. |
| Error responses | Routes return fixed error text and log exception detail on the server, so stack traces and database errors are not returned to the caller. A build-pipeline test flags routes that return exception text. |
| Database queries | All queries go through a parameterised query builder; identifiers chosen at run time come from fixed allowlists, so no SQL text is built from request input. |
| Ingest rate limit | 600 requests per minute per Claude organisation from the collector on each Hub instance; the collector batches events before sending. |
| Health endpoint | Unauthenticated callers receive only a status value; version and database detail require a signed-in session. |
| Web application firewall | Not included. If you put one in front of Command Centre, exempt the Collector's telemetry path from rules that inspect request bodies: prompt text often resembles injection patterns, and a blocked batch is lost. |

The Hub container runs as a non-root user on a Node.js 22 Alpine image that carries the standalone production build rather than the full dependency tree.

## Service authentication

| Credential | Used by | How it is held | Notes |
|---|---|---|---|
| Bearer token (`OTEL_ENDPOINT_SECRET`) | Claude clients sending to the collector | `.env` with Docker Compose, or your secret store; distributed through Claude managed settings (Claude Code) and the monitoring settings in Claude's Organization settings (Claude Cowork). With Docker Compose the Hub also holds a copy for display only, shown to administrators on Admin → Ingestion, and never accepts it as a credential; each read is recorded in the access audit log | Rotate by replacing it where it is held, running `docker compose up -d` (a plain restart keeps the old value), and updating both client settings |
| Collector token (`CCC_COLLECTOR_TOKEN`) | Collector sending to the Hub | `.env` or your secret store, given to both services | Constant-time comparison; ingest fails closed in production when no credential is configured |
| Metrics Connector tokens | BI tools and MCP clients | 256-bit random, stored as a SHA-256 hash, shown once | Organisation-level aggregates only, never per-person data or prompt text; revocable by an administrator |
| Compliance Access Key | Hub pulling Claude.ai chats | Encrypted in the database | Created by you with read scopes only; Command Centre makes only read requests |
| Claude API key | Hub AI features | Encrypted in the database, or from an environment variable | Removing it stops all model calls |
| Analytics API key and Admin API key (on the roadmap) | Hub reading usage counts, the cost report and spend limits | Encrypted in the database | Created by you; Command Centre makes only read requests |
| GitHub token | Hub reading repository activity | Encrypted in the database | Read scope is sufficient |

The bearer token and the collector token authorise ingest only; they cannot call any other route and grant no sign-in. Identity in telemetry is reported by the client: a person's email and Claude organisation come from their Claude sign-in, and a department can be added as a resource attribute through your managed settings.

## Data protection

### Data inventory

Command Centre processes personal data about your employees to measure how teams work with Claude. Your organisation is the controller of that data.

| Category | Examples | Default retention | Can it be switched off |
|---|---|---|---|
| People and accounts | Email, display name, department, role, Claude user identifier | Until erased | No |
| Claude Cowork and Claude Code prompts | Text a person typed: first 4,000 characters plus a 250-character preview | 90 days per surface, then content removed | Claude Code only, in its telemetry settings |
| Claude Chat prompts (Enterprise plan) | Text typed in Claude.ai, in full | 90 days, then content removed | Yes, by not configuring the Compliance Access Key |
| Claude Chat reply metadata | Model, counts of artifacts and generated files | 90 days, then deleted | Yes, with Claude Chat capture |
| Activity metadata | Session timing, active time, model, tokens, cost, tool names and outcomes, connector and skill names, uploaded and produced file names | Message rows for the same period as prompts; Claude Cowork session summaries until erased | Claude Code tool detail depends on client settings |
| Code metrics | Lines added and removed, commits, pull requests, edit decisions | 90 days; weekly aggregates 400 days | Yes, client metrics setting |
| AI-judged results | Delegation tier and kind of work, session descriptions, use case matches, hand-work time estimates, briefings, drafted skills | Mostly for the same period as the prompts they came from; briefings, Claude Cowork session estimates, use cases and skill drafts until deleted | Yes, per AI feature |
| Alerts | PII, intent, cost and system alerts | Resolved and dismissed 90 days; open kept | Per alert type |
| GitHub overlay | Daily commit and merged pull request counts per repository; daily commit counts per person | Same period as Claude Code data | Yes, no GitHub token |
| Audit and authentication logs | Who read or changed what, sign-ins, lockouts, role changes | Kept indefinitely | No |
| Operational errors | Error messages and stack traces | 90 days, then stack traces removed | No |
| Telemetry in transit | Batches awaiting delivery, in the Collector's disk queue | Until delivered | No |
| Archive copies | Rows due for removal, in your Amazon S3 bucket | Your bucket's lifecycle | Yes, off by default |
| Secrets and settings | API keys, webhooks, SSO client secret, feature settings | Until removed | Per secret |

Everything except the collector queue and archive copies is held in the PostgreSQL database.

What Command Centre receives is decided by Claude's own telemetry settings: for Claude Code, the settings you distribute through Claude managed settings; for Claude Cowork, the monitoring settings in Claude's Organization settings. Claude Code sends prompt text only when prompt logging is enabled; without it the Hub receives a redaction marker, and the Audit Log, PII detection and the AI features that read prompts lose their input. With detailed tool telemetry enabled, Claude Code sends tool parameters that can include file content Claude writes and exact shell commands. Claude Cowork always includes prompt text and tool parameters in its telemetry. That data travels over TLS to your Collector, waits in its disk queue until delivered, and is read in memory by the Hub, which keeps from those logs and metrics only the tool, connector and skill names, whether each call succeeded and how long it took, whether a commit was made, and an output's file name, and discards the rest. If you prefer that Claude Code's tool parameters never leave the client, leave its detailed tool telemetry off; Command Centre then loses per-prompt commit counts and connector tool names for Claude Code.

### What Command Centre never stores

- Claude's replies, from any surface. For Claude.ai chats only the model and counts of artifacts and generated files are kept.
- The content of tool calls: file contents, shell commands, tool inputs and outputs. The Collector supplied with Command Centre forwards logs and metrics only, never traces. The Hub does not accept traces.
- Commit identifiers, commit messages or code from GitHub.
- Plain passwords, session tokens, reset tokens, setup tokens, recovery codes or Metrics Connector tokens; each is stored only as a one-way hash.
- Secrets in plaintext.
- Anything in the project's own systems: no telemetry, usage data or heartbeat is sent to the project's maintainers.

### Encryption in transit

| Path | Protection |
|---|---|
| Browser to Hub | HTTPS at the reverse proxy or load balancer you put in front of the Hub; the Hub sends HSTS. Plain HTTP is for local use only and needs two explicit cookie settings |
| Claude client to Collector | HTTPS at your proxy or load balancer, bearer token |
| Collector to Hub | Over your private network (with Docker Compose, the containers' own network); separate bearer token. Use HTTPS if they run on different hosts |
| Hub to database | Chosen automatically: any database other than the bundled one gets TLS with the certificate verified; the bundled database, inside the containers' own network, gets none. `CCC_PG_SSL` overrides this (`require`, `disable` or `no-verify`) |
| Hub to the Anthropic API, GitHub API, Slack and Amazon S3 | HTTPS with certificate validation; Slack webhook URLs must be HTTPS |
| Hub to identity provider | HTTPS when the issuer URL you configure uses HTTPS |
| Hub to SMTP relay | Implicit TLS on port 465; STARTTLS on other ports when the relay offers it |

### Encryption at rest

Command Centre does not encrypt the database files or the Collector's queue itself. Use disk encryption on the host, or a managed database that encrypts at rest, and encrypt backups the same way.

The application additionally encrypts two kinds of data before they reach the database, so a dump or snapshot alone does not expose them: every secret entered in the administration pages (Anthropic keys, the Compliance Access Key, GitHub token, SSO client secret, SMTP password, Slack webhooks, archive credentials), and each user's TOTP seed. Both use AES-256-GCM with a key derived from `CCC_ENCRYPTION_KEY`, and any value found unencrypted at start-up is encrypted then. Secret values are masked whenever settings are read, so a stored secret is never returned to the browser in full.

`CCC_ENCRYPTION_KEY` is held in `.env` with Docker Compose, or in your secret store, apart from the database, and also seals the short-lived MFA and SSO sign-in cookies. `CCC_ENCRYPTION_KEY` must not change once data is stored, because stored secrets and MFA seeds can be read only with the key they were saved under. An undecryptable secret is recorded as an error and shown on the System health page.

### AI processing

Command Centre's measured figures are computed without AI. A defined set of features sends selected data to the Anthropic API under your organisation's Claude API key, including briefings, reports, delegation classification, session descriptions, use case judging and mining, skill drafting, intent assessment and the PII confirmation check. [AI Data Flow and Sub-processors](ai-data-flow.md) lists every feature, what it sends and stores, and how to switch it off.

## PII and secret detection

Every prompt is checked at ingest, in full before any truncation, against 20 patterns:

- **Personal data:** email addresses; UK, US and Brazilian phone numbers; UK National Insurance numbers; US Social Security numbers; Brazilian CPF and RG numbers; payment card numbers; IBANs; IP addresses; dates of birth; passport numbers.
- **Secrets:** API keys, AWS access keys, GitHub tokens, JSON Web Tokens, private key headers, database connection strings and labelled passwords or secrets.

The number and identifier patterns carry token boundaries so that identifiers inside longer strings (record identifiers, hashes, timestamps) do not match. Card numbers must pass the Luhn checksum and CPF numbers their check digits.

A match flags the message in the Audit Log and raises an alert; on Claude Cowork and Claude Code prompts, a repeat of the same identifier type for the same person within 24 hours is flagged without a further alert. Seven patterns identify a value by shape alone (National Insurance number, UK, US and Brazilian phone numbers, IBAN, IP address and US Social Security number); for these, on Claude Cowork and Claude Code prompts, a Claude call first asks whether the match is genuinely that identifier in context. A dismissed match raises no alert but stays flagged, with the dismissal and a one-sentence reason recorded. Every failure of the check (no key, an error, a timeout, an unexpected answer) raises the alert as normal, so the check can reduce false alerts but never silence a real one. The other thirteen patterns are identified by a checksum, a distinctive prefix, a required label or, for email addresses, an unambiguous format.

Detection also covers twelve intent categories, among them data exfiltration, credential harvesting, access escalation, policy evasion and destructive actions, with an AI severity assessment that takes account of your acceptable use policy where one is configured. Like PII detection, it flags and alerts; it cannot stop a prompt.

High-priority alerts sent to Slack carry the alert's title, explanation, type, category and time, with a link back to the Alerts page; the stored evidence is removed before sending. For an intent alert, the explanation is the model's assessment of the prompt and can quote it. Weekly Highlights drafts are built from work items with URLs, file paths and detected personal data masked, and an administrator reviews each draft before it is sent.

## Retention and deletion

### Retention windows

A retention job runs daily in a single database transaction, so a run either completes across all tables or changes nothing. Administrators set each window except the weekly history, with a minimum of seven days.

| Data | Default window |
|---|---|
| Claude Cowork prompts and activity messages | 90 days |
| Claude Code prompts, metadata and metrics | 90 days |
| Claude.ai chat prompts and reply metadata | 90 days |
| Raw telemetry events | 30 days |
| Compliance API activity events | 365 days |
| Operational errors | 90 days |
| Resolved and dismissed alerts | 90 days |
| Daily analytics snapshots | 365 days |
| Weekly metrics and use case history | 400 days |

In **strip** mode, the default, rows keep their metadata but lose their content: prompt text is replaced with a fixed marker, and full text, tool previews, PII dismissal reasons and output file names are cleared. In **purge** mode the rows are deleted. In both modes, AI-derived records tied to expired messages (classifications, capability events, session descriptions, use case judgements) and metadata-only tables such as chat reply metadata are deleted.

People and accounts, Claude Cowork session summaries (including uploaded file names), the use case register, drafted skills, coaching acknowledgements, Skills and Connectors Board entries and both logs are not time-limited. Records tied to a person among them are removed by erasure; the register, drafted skills and Board entries are removed by an administrator or manager; the two logs are kept. The chat pull never imports messages older than the chat retention window, so content removed by retention is not re-imported.

### Archive before purge

Archiving to your Amazon S3 bucket is off by default; Azure Blob Storage and Google Cloud Storage are not yet supported. When enabled, rows due for removal from the message, raw telemetry, Compliance activity, chat and error tables are written as compressed JSON Lines with a manifest before anything is deleted, and a failed archive stops that day's run. The archive authenticates with credentials that you create, stored encrypted. Apply your own encryption, access policy and lifecycle to the bucket.

### Erasure and export of a person's data

An administrator can export a monitored person's record, Claude Cowork and Claude Code prompts and activity messages, Claude Chat prompts and the metadata kept for Claude's replies, telemetry events, Compliance activity, analytics snapshots and alerts as JSON, and erase that person. Erasure deletes the person's monitoring record and every record keyed to them in one transaction; if any step fails, nothing is deleted and the failure is recorded. A build-pipeline test fails when a new table carrying a person identifier is not covered. The access audit log keeps a record of the erasure (who, when, and the erased person's identifier and email) as evidence.

Erasure removes stored data; a person's Claude client continues to send telemetry until it is stopped at the client or in Claude's administrative settings. A person's sign-in account is removed separately, by deleting the account in user administration.

## Audit logging

The **access audit log** records reads and changes of sensitive data, allowed and refused: prompt content reads in the Audit Log and Spend Review, event and alert lists, dashboards and briefings, report generation, settings reads and writes (setting names only, never values), secret removal, user lists, erasure, FinOps and Spend Review, cost centres, Weekly Highlights, skill drafting, Board deletions and SSO sign-ins. Each entry holds the actor's identifier and email, client address, resource, action, outcome, detail and time. Database triggers reject any update or delete, so entries cannot be altered or removed through the application. Only administrators can read it, filtered by actor, resource, action and date, and export it to CSV.

The **authentication event log** records sign-ins and failures, lockouts, MFA failures and changes, password reset requests, password and role changes, SSO changes, session revocations, account deletions and ingest authentication failures. Administrators can view recent entries in the administration area.

## Logging, monitoring and alerting

The Hub and Collector write their logs to standard output and standard error; with Docker Compose, `docker compose logs` shows them. Keeping those logs, alerting on them and forwarding them to your monitoring or SIEM are yours to set up.

Within the application, failures of scheduled jobs and ingest, rejected integration keys and unreadable secrets are recorded and shown on the System health page. Optional alerts cover job failures, unreadable secrets and telemetry silence (no Claude Cowork, Claude Code or Claude Code metrics data for three working hours by default). Any high or critical alert can be forwarded to a Slack channel you nominate within the hour.

## Vulnerability management and secure development

Every change pushed to the main branch or proposed in a pull request runs through a build pipeline that scans the repository for secrets, failing on a finding, and through CodeQL static analysis; every change to the application is also linted, tested with the full automated suite against PostgreSQL 16 and built for production. The suite includes the security tests described above: a role check on every API route, no exception text in responses, erasure coverage of every person identifier, the secrets registry, the password policy and the PII confirmation list.

Dependabot security alerts are on for this repository; dependency updates are made by hand and tested before release. Advisories that do not affect Command Centre are recorded, each with its reason, in `osv-scanner.toml`. The OpenSSF Scorecard checks the repository's practices on every change to the main branch and weekly. The licences of the libraries Command Centre uses are listed in THIRD-PARTY-NOTICES.md.

## Threat model summary

The table summarises the principal threats at each trust boundary and the controls that address them.

| Boundary | Principal threats | Main mitigations |
|---|---|---|
| Browser to Hub | Credential stuffing, session theft, cross-site requests, privilege escalation, prompt-text disclosure | scrypt, account lockout, TOTP or IdP MFA, hashed `HttpOnly` sessions with idle and absolute expiry, Origin check, nonce-based CSP, role check on every route, department scoping, logged prompt reads |
| Claude client to Collector | Forged or flooded telemetry, misreported identity | Bearer token, TLS at your proxy, ingest rate and size limits |
| Collector to Hub | Interception, replay, oversized payloads | Separate bearer token, the containers' private network (HTTPS if they run on different hosts), fail-closed ingest, duplicate events ignored |
| Hub to Anthropic and others | Key leakage, exposure of content sent to AI | Keys encrypted and masked, HTTPS, request timeouts, per-feature switches |
| Hub to database | Backup or credential theft, audit tampering | Disk encryption you provide, verified TLS to a managed database, the bundled database not exposed outside the containers' private network, encrypted secrets and MFA seeds, append-only audit triggers |

## Incident response

Detection draws on the access audit log, authentication events, active sessions, alerts and System health. Your team holds these containment levers:

| Situation | Action |
|---|---|
| Suspicious session or account | Revoke sessions; reset the password, change the role or delete the account; review the actor's access audit entries and check for new administrators and changed settings |
| Locked-out administrator | Run the recovery tool in the Hub container |
| Bearer token exposed | Set a new `OTEL_ENDPOINT_SECRET`, run `docker compose up -d`, and update Claude managed settings and the Claude Cowork monitoring settings (see [Troubleshooting and FAQ](troubleshooting.md#settings)) |
| Collector token exposed | Replace `CCC_COLLECTOR_TOKEN` for both services and run `docker compose up -d` |
| Connector or third-party key exposed | Revoke it at source (Anthropic, Claude.ai, GitHub, Slack) or in the administration area, then remove it from Command Centre, which also resets that integration's sync state |
| Stop AI processing | Remove the Claude API key, or switch off individual features |
| Stop telemetry intake or restrict access | Stop the collector (`docker compose stop otel-collector`), or restrict who can reach it at your firewall or proxy |
| Preserve evidence | Export the access audit log, save the containers' logs and back up the database before remediation |

Regulatory notification decisions, including GDPR breach notification and any DORA obligations, rest with your organisation as controller.

## Standards alignment

The table describes how Command Centre's controls support your own compliance with each framework.

| Framework | How Command Centre supports it |
|---|---|
| GDPR and UK GDPR | Data held on infrastructure you control, in the location you choose; configurable retention; per-person export and erasure with an audit record; role and department access control with access logging; PII detection; a page to record your DPO and DPIA. Lawful basis, employee transparency and the DPIA remain yours. |
| ISO/IEC 27001:2022 | Supports Annex A controls on access and authentication, privileged access, logging and monitoring, cryptography, data masking, information deletion, secure development and vulnerability management. |
| ISO/IEC 42001:2023 | AI-judged figures labelled apart from measured ones; AI outputs validated (numbers checked against source data, fixed reply formats, refused replies not stored); removing the Claude API key stops all AI processing; your AI governance declarations recorded for reporting. |
| EU AI Act | Records and reports your risk classification and transparency notice for your Claude deployment. Command Centre's own AI judges the depth of work individuals delegate to Claude, so your organisation should assess with legal advice whether its use of per-person figures falls within the Act's provisions on AI used to monitor or evaluate workers. |
| DORA (EU 2022/2554) | Supports ICT risk management through audit logging, monitoring and alerting. Resilience and backups depend on how you run Command Centre; a managed cloud database adds failover and point-in-time recovery. |

Command Centre can generate report sections for GDPR, the EU AI Act, ISO/IEC 27001 and ISO/IEC 42001 from your recorded declarations and its own data, including PII detection counts, retention settings and open gaps.
