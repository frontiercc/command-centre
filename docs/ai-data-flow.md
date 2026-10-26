# Frontier Command Centre: AI Data Flow and Sub-processors

Command Centre uses Anthropic's Claude models for some of its features, such as grading how deeply people delegate work, writing briefings and drafting skills. This document explains exactly what those features send to Claude, where the data goes, what comes back, how replies are checked and how you switch each feature off.

It also covers the Claude Chat data Command Centre reads from Anthropic's Compliance API, the other services it can call, how people stay in control of AI output, and how Command Centre sits against the EU AI Act and ISO/IEC 42001.

It lists the sub-processors involved. Everything here applies however you run Command Centre, on your own server or on AWS or Azure.

**Contents:** [Summary](#summary) · [Measured and AI-judged](#measured-and-ai-judged) · [The Claude API key and applicable terms](#the-claude-api-key-and-applicable-terms) · [Data residency and network path](#data-residency-and-network-path) · [Inventory of AI features](#inventory-of-ai-features) · [Feature detail](#feature-detail) · [The Compliance API pull](#the-compliance-api-pull) · [The Analytics and Admin API pulls](#the-analytics-and-admin-api-pulls) · [Prompt injection and output control](#prompt-injection-and-output-control) · [Human oversight](#human-oversight) · [Positioning against the EU AI Act and ISO/IEC 42001](#positioning-against-the-eu-ai-act-and-isoiec-42001) · [Running with AI features off](#running-with-ai-features-off) · [Sub-processors and external services](#sub-processors-and-external-services)

## Summary

Command Centre calculates its measured figures in code from Claude's activity data, with no AI involved. Only a defined set of features uses Anthropic's Claude models: grading the depth and kind of work in prompts, writing briefings and summaries, assessing flagged messages, matching sessions to use cases, finding recurring processes and drafting skills.

Each of these calls goes from the Hub, on infrastructure you control, directly to `api.anthropic.com`, using a Claude API key your organisation supplies. No service run by the Command Centre project sits in the data path. Anthropic is the only model provider, and Command Centre does no training or fine-tuning and keeps no embeddings or vector store.

Command Centre only sees prompts after they have reached Claude, so it cannot block them.

## Measured and AI-judged

**Measured** figures are counted from Claude Code, Claude Cowork and Claude Chat activity. **AI-judged** figures are Claude's assessment of that work. Anything not measured is shown as "not measured", never as zero. For example:

| Measured from telemetry | Judged by AI |
|---|---|
| Prompts, sessions, active time, tokens, models used | How deeply work was delegated (Tiers 1 to 3), and the kind of work |
| Spend, from Claude Code's token counts and Claude Cowork's reported cost | How long the work would take by hand (an estimate) |
| Lines of code, commits, pull requests, edits accepted | Which use case a session belongs to, and suggested new use cases |
| Session Output Rate, chargeback and FinOps totals | Briefings, recommendations, the risk score and the written parts of reports |
| Personal data and intent detection (pattern and phrase matching) | Whether a possible personal-data match is genuine, and how serious a risky intent is |

Some figures are worked out in code from AI judgements, such as the four delegation signals and the Delegation View, so they carry the judgement's limits.

### How AI output is checked

- **Numbers in briefings:** every number the AI writes must appear in the figures it was given. A sentence that fails is removed, and a briefing that cannot be repaired is not shown. The risk score is the one number the AI sets itself.
- **Fixed answers:** grading, use case matching and suggestions must reply in a fixed format. Code rejects or sets aside anything outside it, such as a tier or label that does not exist.
- **People decide:** suggested use cases, capabilities and skill drafts only count once a person accepts them.
- **Monthly tier audit:** each month, an admin can grade 50 Claude Cowork prompts without seeing the AI's grade, and Command Centre reports how often they agree (Admin → Work Pulse → Audit).
- **Human-time spot checks:** each month, an admin can check 20 of the AI's by-hand estimates per product.

A benchmark kit, so you can run Command Centre's grading against your own labelled examples and a model of your choice, is on the roadmap.

## The Claude API key and applicable terms

Command Centre uses up to four Anthropic credentials, all supplied by your organisation. Only the Claude API key is used for model calls; the other three are used only for read-only pulls and are optional.

| Credential | Used for | Where it is set | Access it needs |
|---|---|---|---|
| Claude API key | Every model call in this document | Admin → Access & Keys (stored encrypted in the database), or optionally the `ANTHROPIC_AI_API_KEY` environment variable, which can come from your secret store | Standard Messages API access |
| Compliance Access Key | Read-only pull of Claude Chat history and, optionally, the organisation activity feed | Admin → Access & Keys (stored encrypted), or the `COMPLIANCE_ACCESS_KEY` environment variable | `read:compliance_activities` and `read:compliance_user_data` only |
| Analytics API key (on the roadmap) | Read-only daily pull of per-person usage counts from the Claude Enterprise Analytics API | Admin → Access & Keys (stored encrypted), or the `ANTHROPIC_ANALYTICS_API_KEY` environment variable | `read:analytics` |
| Admin API key (on the roadmap) | Read-only pull of the organisation's cost report and of members' spend limits and pending requests for more usage | Admin → Access & Keys (stored encrypted), or the `ANTHROPIC_ADMIN_API_KEY` environment variable | Cost report: a Claude Console Admin API key. Spend limits: a Claude Enterprise key with `read:spend_limits` |

A key saved in the admin pages takes precedence over the environment variable. Saved keys are encrypted at rest, masked when read back and removable only through an audit-logged Remove action. The Command Centre project does not supply, hold or proxy any of these keys. Because the key is yours, the calls are made under your organisation's agreement with Anthropic, and the commercial, data retention and data processing terms that apply are those of that agreement.

Anthropic's Commercial Terms of Service state that Anthropic may not train models on customer content from its services, and they incorporate Anthropic's Data Processing Addendum by reference. Zero data retention is a separate arrangement that Anthropic enables for an organisation on request; under it, Anthropic does not store prompts or responses at rest once the API response is returned. Your organisation should confirm with Anthropic which terms and arrangements apply to its own account.

Anthropic lists the API capabilities that Command Centre uses beyond plain messages (structured outputs, PDF input and web search) as eligible for zero data retention. Structured outputs are eligible with one qualification: prompts and outputs are not stored, but the JSON schema itself is cached for up to 24 hours after its last use. Command Centre's schemas are fixed in code and contain no prompt text or personal data. Web search is eligible except when it uses dynamic filtering, in which the tool runs code to filter its results. Command Centre uses `web_search_20260209`, which uses dynamic filtering by default. Skills discovery sends no organisation data, so this affects only its fixed prompt and the public search results. Anthropic also designates certain models as requiring 30-day retention, which places them outside zero data retention, so if you rely on it, check each model you select in the admin pages against Anthropic's list.

We recommend a dedicated Anthropic workspace and key for Command Centre, so that its usage is attributable and can be limited separately.

## Data residency and network path

The Hub runs where you run it: with Docker Compose, on a machine you choose; on a cloud, in the region you choose. Model calls are HTTPS requests from the Hub to `api.anthropic.com`, through whatever outbound route your network gives it.

Command Centre's AI features call the Anthropic API with your organisation's key, so where Anthropic processes those calls follows your organisation's agreement with Anthropic and the settings of the Anthropic workspace that holds the key.

Model calls are the main path by which prompt-derived text leaves your infrastructure; Slack, described under Sub-processors, is the other. The optional archive taken before retention deletes data writes expiring records, including stored prompts, to an Amazon S3 bucket you name.

The application makes no call to Anthropic beyond those listed in this document and none to the Command Centre project. The destinations the Hub calls, depending on which features you use, are these.

| Destination | Purpose | Data leaving your infrastructure |
|---|---|---|
| `api.anthropic.com` | Model calls, model list, key tests, and the Compliance, Analytics and Admin API pulls | As described in this document |
| Your Slack incoming-webhook URLs | Weekly Digest, high-priority alerts, Weekly Highlights | Described under Sub-processors |
| Your SMTP relay | Weekly Digest email, password reset email | Described under Sub-processors |
| `api.github.com` | Developer Pulse GitHub overlay | Access token and repository names |
| Your Amazon S3 archive bucket | Optional archive before retention deletes data | Expiring records, including stored prompts |
| Your identity provider | Single sign-on (OpenID Connect) | Standard OIDC exchange |
| Your cloud provider's services, if you run on a cloud | For example on AWS: ECR, CloudWatch Logs, Secrets Manager and KMS | Images, logs and secrets, within your own cloud account |

![AI data flow and trust boundaries](diagrams/AI%20data%20flow%20and%20trust%20boundaries.png)

*Figure 1. Where prompt-derived data travels. No service run by the Command Centre project is in any path.*

## Inventory of AI features

The table lists every model call in the application. Defaults are the values a fresh installation uses; most model settings are chosen in the admin pages from the list of models your key can reach. "Masked" and "cleaned" describe the text preparation set out after the table. "Always on" marks a call that is part of a core function rather than a separately switchable feature; every call stops when the API key is removed.

| Feature | Trigger | Model setting (default) | Data sent | Switch off |
|---|---|---|---|---|
| Cowork work classifier | Every 5 minutes, batches of 25 prompts | Cowork classifier model (Haiku) | Claude Cowork prompts, masked, up to 4,000 characters; tool, skill and connector names; pseudonymous ids | Work Pulse off |
| Claude Code session classifier | Every 30 minutes | Code classifier model (Haiku) | Session metadata; first prompt masked, up to 200 characters | Classifier or Developer Pulse off; prompts off sends metadata only |
| Session descriptions | Hourly, up to 400 sessions | Core AI model (Haiku) | Up to 8 prompts per session, masked, 600 characters each | Session descriptions off |
| Human time estimates | Hourly (Claude Cowork); with the classifier (Claude Code) | Core AI model; Code classifier model | Up to 8 masked prompts, output file names, connector names, department name | Human time off, per surface |
| Briefings | Weekly, monthly, or on request | Briefing models (Sonnet; personal follows Core AI) | Computed figures, kinds of work, department names; the personal briefing also the person's display name | Work Pulse or Developer Pulse off (scheduled runs) |
| Dashboard briefing | On opening the Dashboard, cached up to 10 minutes | Core AI model (Haiku) | Organisation figures, recent alert titles, use case titles, acceptable use policy | Always on |
| Intent severity assessment | When a prompt matches an intent phrase | Core AI model (Haiku) | The matched prompt as written, matched phrases, acceptable use policy | Always on |
| Personal-data confirmation | When one of seven shape-only patterns matches | Core AI model (Haiku) | The matched prompt as written, pattern name, masked value | Always on |
| Governance reports | On request | Core AI model (Haiku) | Chosen report sections, usage snapshots, 20 most recent alerts with their evidence, which can include up to 200 characters of a prompt | Do not generate |
| Anomaly and adoption analysis | On request | Core AI model (Haiku) | Event metadata, flag reasons, per-person activity counts; no prompt text | Do not request |
| Use case session judging | Hourly, up to 400 sessions, 10 per call | Session judging model (Sonnet) | Up to 6 cleaned prompts per session, 400 characters each; use case definitions | Use Cases content off |
| Process mining | Every 7 days | Department process model (Sonnet) | Samples of up to 120 cleaned prompts, 600 characters each | Use Cases content off |
| Transcript extraction | On request | Extraction model (Haiku) | The transcript or document an administrator or manager uploads | Do not use |
| Ideation | On request | Ideation model (Sonnet) | Organisation aggregates and the user's own messages | Do not use |
| Workflow impact summary | On request | Organisation briefing model (Sonnet) | A use case's title, measured counts and tool names | Do not use |
| Skill drafting | On request | Drafting model (Sonnet) | Up to 60 cleaned excerpts, 600 characters each, labelled by letter | Use Cases content off |
| Weekly Highlights | On request, admin only | Highlights model (Sonnet) | Up to 18 masked Tier 3 Claude Cowork prompts, up to 4,000 characters each | Highlights off |
| Skills discovery | Weekly, or on request | Organisation briefing model (Sonnet), with web search | A fixed prompt; no organisation data | Always on |
| Model list and key test | Admin pages | None | The key only | Not applicable |

**Where each prompt is written.** Every prompt is built in the source code, so you can read what is sent; the two classifiers also include the tier definitions an admin sets on the tiers tabs: Cowork work classifier, `lib/pulse/tier-config.ts` and `lib/pulse/classifier.ts`; Claude Code session classifier, `lib/pulse/code/classifier-prompt.ts`; session descriptions, `lib/pulse/session-descriptions.ts`; human time estimates, `lib/pulse/session-estimates.ts` and `lib/pulse/human-time.ts`; briefings, `lib/pulse/briefings/` and `lib/pulse/code/briefing.ts`; dashboard briefing, `app/api/ai/briefing/route.ts`; intent severity, `lib/intent/assess.ts`; personal-data confirmation, `lib/pii/confirm.ts`; governance reports and anomaly analysis, `lib/anthropic/ai.ts`; use case session judging, `lib/usecases/session-judge.ts`; process mining, `lib/usecases/process-mining.ts`; transcript extraction, `lib/usecases/extract.ts`; ideation, `lib/usecases/ideate.ts`; workflow impact summary, `lib/usecases/impact-summary.ts`; skill drafting, `lib/usecases/skill-draft.ts`; Weekly Highlights, `lib/highlights/compose.ts`; skills discovery, `lib/pulse/skills-discover.ts`.

Features with no model call include FinOps chargeback and its insight card, Spend Review, the Weekly Digest, the Metrics Connector, the Skills and Connectors Board, the use case governance rollup and all alert delivery.

### How text is prepared before it is sent

Two preparation steps recur in the paragraphs that follow.

**Masking** replaces structured personal data and secrets with masked forms using the same twenty patterns Command Centre uses to flag messages: email addresses, UK, US and Brazilian phone numbers, National Insurance numbers, US Social Security numbers, payment card numbers (Luhn-checked), IBANs, IP addresses, dates of birth with a label, passport numbers with a label, Brazilian CPF (checksum-validated) and RG, and secrets such as API keys, cloud access keys, GitHub tokens, JWTs, private keys, connection strings and labelled passwords.

**Cleaning** goes further for the Use Cases features. It keeps only the person's own words, removing system-inserted wrappers such as uploaded-file lists and scheduled-task preambles, replaces web links with `[link]` and file paths with `[path]`, and then applies masking. Weekly Highlights applies the same link and path replacement and masking to its work items.

### Pseudonymous identifiers

Where a call needs to distinguish people or sessions, it uses internal identifiers, never a name or an email address. The Cowork classifier and the anomaly analysis send person and session identifiers; the Claude Code classifier sends a session identifier only. The skill drafter labels people A, B, C. Where a feature sends a person's display name, its description below says so; where a person has no display name, their email address is sent in its place.

## Feature detail

### Cowork work classifier

Each Claude Cowork prompt is classified once for its tier of delegation and its kind of work. A batch carries each prompt's stored text (stored prompts are capped at 4,000 characters at ingest) after masking, the session's connector, skill and tool names and counts, and for each person their previously observed tiers and kinds of work, keyed by pseudonymous identifier. Stored tiers are limited to 1, 2 and 3, and the kind of work must come from the configured taxonomy: any other kind of work is recorded as a failed classification and retried, never coerced into a plausible value. Confidence is clamped to the range 0 to 1. From a successful reply, only the labels, the capability flags and the confidence are stored. Switching off Work Pulse stops the classifier.

### Claude Code session classifier

Each Claude Code session is classified for kind of work and tier once it has been idle for 30 minutes; a session still running after two hours receives a provisional classification, replaced when it ends. The call carries a metadata digest (a pseudonymous session identifier, repository and branch where captured, duration, prompt and model-call counts, tool actions and failures, commits, skill, connector and model names) and, unless the prompt option is switched off, the session's first prompt, masked and truncated to 200 characters. Assistant text is never sent. A work type outside the configured taxonomy is recorded as "other". When Human time is on for Code, the same call also receives lines added and removed, pull requests and up to five later prompts (masked, at most 250 characters each as stored), and returns a by-hand time estimate for Tier 2 and 3 sessions; a separate estimate-only call fills that estimate for already-classified sessions without reclassifying them.

### Session descriptions

For Claude Cowork sessions that the frontier views can show (Tier 3 work or a capability in the last 30 days), a background job writes one sentence describing what the work was. The call carries up to eight of the session's prompts, each masked and truncated to 600 characters, with the classifier's kind of work and the connector names. A reply is accepted only if it is a single sentence of at most 220 characters with no line breaks and every number in it appears in the prompts; one repair attempt is allowed, and a session is abandoned after three refused attempts. The accepted sentence is masked again, labelled "AI summary", shown only to administrators, managers and the person concerned, and deleted when the Cowork retention window for its session passes. Switching descriptions off stops new ones and hides existing ones.

### Human time estimates

For each Tier 2 or 3 Claude Cowork session in the last 30 days that has measured active time, a separate call estimates how long the same result would take by hand. It carries up to eight masked prompts of 600 characters, up to ten names of files the session produced (file names only, masked, never content), the session's connector names, the person's department name and the kind of work. The reply must be three whole numbers of minutes in order; anything else is refused, with one repair attempt and three attempts in all. Only the three numbers are stored, always presented as estimates beside measured Claude time.

### Briefings

Four briefings are written by a model: a personal weekly briefing for each person with Claude Cowork work classified in the past week (Sunday evening), a monthly executive briefing (first of the month), department briefings (on request by an administrator or manager) and a weekly Claude Code briefing. They receive figures computed in code: tier counts, kinds of work, measured deep-work facts, department names, spend and shipping figures, with every percentage and week-on-week change worked out before the call. Department and executive briefings never receive names; the personal briefing receives the person's display name and their own figures. No prompt text, AI summary or file name is included.

Every briefing is number-checked: each number in the reply must appear in the data sent (rounded forms allowed). A refused reply gets one retry naming the offending numbers. If the retry is also refused, sentences carrying unchecked numbers are removed provided at least half the text survives; failing that, the exchange is repeated once more from the start, and if it still fails nothing is stored and the previous briefing remains on screen. Briefings are stored in the Hub database. Scheduled briefings run only while Work Pulse (or, for the Claude Code briefing, Developer Pulse) is on; administrators and managers can also request a briefing.

### Dashboard briefing

Opening the Dashboard produces a short narrative, a risk score and up to six recommendations, cached in memory for up to ten minutes (a refresh makes a new call). The call carries organisation-level figures (active users, alert counts by severity, session and commit counts, tier mix, spend), the titles, types and statuses of the ten most recent alerts, the titles of up to five adopted and five at-risk use cases, per-department counts of open process opportunities, and your acceptable use policy if one is configured. The dashboard briefing is number-checked like the briefings, except for the model's own risk score, but gets only the one retry, not the repeat from the start; if that also fails, the Dashboard shows the last narrative it produced while one is still held in memory. The dashboard briefing is not written to the database. Reads are recorded in the access audit log.

### Intent severity assessment

When a Claude Cowork, Claude Code or Claude Chat prompt matches one of the intent categories (for example bulk export of records or bypassing authentication), one call assesses how serious it is in context. The assessment's purpose is to judge the request itself, so it must see the prompt as written: it receives the full prompt as received from telemetry or the Compliance API, fenced as untrusted user text, together with the matched categories and phrases and your acceptable use policy. The reply's severity must be one of four levels; any other value becomes "medium". The severity is added to the message's flag reason, and the model's short reasoning and recommended action are stored on the alert. Without a key, the alert takes the category's default severity; if the call fails, the alert is raised at medium severity for manual review. Detection itself never depends on the model. Each built-in and custom intent category can be switched off individually on the Intent Detection page.

### Personal-data confirmation

Seven personal-data patterns identify a value by its shape alone: UK National Insurance numbers, UK, US and Brazilian phone numbers, IBANs, IP addresses and US Social Security numbers. Before an alert is raised for one of these on a Claude Cowork or Claude Code prompt, one call asks whether the match is genuinely that identifier in context. The call must see the context to judge, so it carries the prompt as written, the pattern name and the masked value, with the reply constrained to a JSON schema of a verdict and a one-sentence reason. The call runs after the message is stored, never inside the ingest request, and only where the 24-hour per-person deduplication would otherwise raise an alert.

Every failure path counts as "confirmed", so the check can reduce false alarms but cannot silence a real one by breaking. A dismissal suppresses the alert but leaves the message flagged, with "(dismissed)" recorded against the pattern in the Audit Log and the reason, masked, stored alongside. Retention's strip mode clears the reason with the content it describes.

### Governance reports

A report is generated on request by an administrator, manager or viewer, who chooses its sections. Compliance and analytics sections are built in code and passed to the model with an instruction to include them unchanged. The model writes the executive summary, usage, adoption, alerts and recommendations from the data supplied. The call carries the chosen sections, up to 50 stored daily usage snapshots and the twenty most recent alerts in the report's scope (the selected department, where one is chosen), each alert with its title, explanation, the person's display name (or email address where no name is set) and the evidence recorded with it. For a personal-data alert that evidence includes up to 200 characters of the prompt as received, unmasked; for an intent alert it includes the model's assessment, which can quote the prompt. The Spend Review section, available to administrators and managers only, names the ten largest spenders with their department, spend, main kind of work and suggested better routes, and the people who work most efficiently against colleagues on the same kind of work; for the current month, where the Admin API key can read spend limits, it also names (or gives the email address of, where no name is set) the people at or near their Anthropic spend limit, with their spend against it, and those with a pending request for more usage.

The finished report is stored in the Hub and its generation is recorded in the access audit log.

### Anomaly and adoption analysis

On request by an administrator, manager or viewer, an analysis makes two calls: one asks a model to identify unusual usage patterns, the other to suggest adoption nudges. It sends event metadata, such as pseudonymous user and session identifiers, event types, tool names, timings and flag reasons (which name the pattern or intent category and carry no content), and per-person daily activity counts. No prompt text is sent. Alerts it proposes are filtered to the alert types you have enabled before they are stored; the adoption suggestions are returned to the caller and not stored.

### Use case session judging

Each finished Claude Cowork or Claude Code session (idle 30 minutes, within the last 13 weeks) belonging to a department with live use cases is judged to decide which, if any, of that department's use cases it is an instance of, and judged again when the session gains new activity or those use cases change. A call covers up to ten sessions and carries the department name; each use case's title, description and phrases under short labels (U1, U2); and, per session, its surface, prompt count, up to six cleaned prompts of 400 characters (the first two, middle two and last two), its skill and connector names and, where captured, up to three names of files uploaded, three names of files made and six connector actions. Assistant text, identities and session identifiers are not sent.

The reply is constrained to a JSON schema with extended thinking off (on models that cannot turn it off, such as the newest Opus, at low effort), and only labels from the supplied list are accepted, so the model cannot attribute a session to anything else. A short reason is stored after cleaning, up to 200 characters, and follows each surface's retention window. Matches feed the use case's weekly counts automatically. When the Use Cases content switch is off, no call is made and only sessions running a use case's own codified skill count.

### Process mining

Every seven days, Command Centre reads each department's recent prompts to suggest specific, recurring processes. Each read sends up to 120 cleaned prompts of 600 characters, sampled across the window with a limit per person, and up to six reads per department per surface (Claude Cowork and Claude Code) depending on volume. A cross-department pass makes four further reads of up to 120 prompts, each labelled with its department name, never a person. Each session's first excerpt may carry the same file-name and connector-action clues as session judging. Previously proposed titles are included so that dismissed work is not proposed again.

Replies are schema-constrained with thinking off (on models that cannot turn it off, such as the newest Opus, at low effort). A proposal is discarded if its title, story or value statement contains any digit, if it cites an excerpt that does not exist, if the cited work does not span at least two days and two people (and, for the cross-department pass, two departments), or if its title is on the excluded list or describes an excluded kind of work. Suggested keywords that do not appear in the cited text are dropped. Survivors are masked again before storage as open suggestions, which a person must add or dismiss. Every count shown on a suggestion is computed in code from the sessions the suggestion cites. When the content switch is off, no call is made and existing department suggestions are hidden and kept.

### Transcript extraction and ideation

An administrator or manager can upload a workshop transcript (text, Markdown or VTT, or a Word or PDF file of up to 15 MB) to extract candidate use cases. Text and Word files are sent as text inside tags marked as data; a PDF is sent to the model as a document. The reply's candidates are returned for review and nothing is stored until a person adds one.

The ideation assistant is a brainstorming conversation grounded only in organisation aggregates: the ten most-used skill names, ten under-used connector names, the ten most common Claude Cowork and Claude Code kinds of work, and department names, plus the administrator's or manager's own messages in that conversation. No prompt text from any person is sent. The conversation is not stored on the server, and suggested use cases are added only by a person.

### Workflow impact summary

On a use case's page, an administrator or manager can generate a short summary of its measured usage. The call carries a facts object only: the title, weeks measured, session count, measured and estimated hours, and the names of the top three skills, top three connectors and top model. Any number not in the facts rejects the whole summary. The accepted text is masked and cached on the use case.

### Skill drafting

From a confirmed use case, an administrator or manager can draft an Agent Skill. The call carries the use case's title, description and departments; the story, rhythm and delegation depth from its mined suggestion, where there is one; the skill and connector names observed in its sessions; the digit sequences that appear in the excerpts; and up to 60 cleaned excerpts of 600 characters (at most ten per person) from sessions already matched to the use case, each dated to the day, labelled by person as A, B, C and marked if it is a follow-up. Measured usage counts are not sent; the message states only how many excerpts it carries.

The reply is constrained to a JSON schema with thinking off (on models that cannot turn it off, such as the newest Opus, at low effort). Before anything is stored, code checks that every required section is present, that the steps and quality rules cite real excerpts, that every number and unit appears in the excerpts, that every system the organisation is known to use that the draft names appears in the evidence, that no passage of twelve or more words copies a prompt, and that the text contains no email address, link, file path or maskable personal data. Up to two automatic repairs are attempted. Minor problems are passed to the owner as notes; serious ones discard the draft. The owner can review and edit the draft before downloading it. Drafting is unavailable when the content switch is off.

### Weekly Highlights

An administrator can generate a draft post describing what the past week's work produced. The call sends up to eighteen of the week's Tier 3 Claude Cowork prompts, with links and file paths replaced and personal data masked, up to 4,000 characters each, together with each prompt's kind of work. Scheduled-task prompts are excluded, and no name field is sent. The reply may contain no digits, each sentence must cite a supplied item, and the text is masked on the way out. The draft is shown for editing, is never stored, and is sent to Slack only when the administrator chooses to send the edited text.

### Skills discovery

Once a week, and when a user of the Work Pulse skills page asks for a refresh, a fixed prompt asks a model to search the web for recently published Claude Code skills and MCP connectors. This is the only feature that gives a model a tool: Anthropic's server-side web search, executed by Anthropic. The search tool may also run code on Anthropic's servers to filter its results. The prompt contains no organisation data, and the resulting list of public items is cached in the Hub. Your Anthropic organisation must permit web search for this feature to return results.

## The Compliance API pull

For Claude for Enterprise organisations, Command Centre reads Claude Chat activity back from Anthropic's Compliance API with your Compliance Access Key. The pull involves no model call. Every request is an HTTPS GET to `api.anthropic.com` carrying only the key, pagination cursors, chat identifiers, page sizes, sort order and a date bound; no prompt text, personal data or other content is sent. The sync runs every two minutes by default and asks Anthropic only for messages within the shorter of your Chat retention window and the configured backfill window. The client makes no deletion call.

What comes back is handled under one rule: store what a person sent, describe what Claude did, never store what Claude said. User prompts are stored as text, with the number of files attached, and go through the same personal-data and intent detection as other surfaces. Assistant replies are reduced to metadata: the model, the number of artifacts and generated files, and the names of any connectors it called. Their text is never written to the database. Claude Chat prompts are stored in full rather than truncated to the 4,000-character limit applied to telemetry. The organisation activity feed is a separate, optional sync, off by default, which stores audit-event metadata only.

Within Command Centre, Claude Chat prompt text is sent to a model directly only by the intent severity assessment described above. A governance report can also carry that assessment's reasoning, which may quote the prompt. Claude Chat prompts are not classified, judged or mined.

## The Analytics and Admin API pulls

These two integrations are on the [roadmap](../README.md#roadmap). The code is in place but has not been checked against a live organisation, so leave their keys unset for now. This section describes what they do when switched on.

Two further read-only pulls are available, each making no call until its key is set. Neither involves a model call. Every request is an HTTPS GET to `api.anthropic.com` carrying only the key and query parameters (a date or month, page sizes, pagination cursors and a status filter); no prompt text or other content is sent.

**Analytics API.** With the Analytics API key, the Hub reads `GET /v1/organizations/analytics/users` for each day: on first use for the most recent week of available days, then for each new day about three days after it ends. For each person, Anthropic returns their Anthropic user identifier and email address with the day's activity counts: Chat messages, conversations, projects, files uploaded, artifacts, skills and connectors used; Claude Code sessions, commits, pull requests and lines changed; and Cowork messages. The Hub stores the counts as one daily usage snapshot per person, matched to an existing person record by email or creating one where none exists. Snapshots are kept for 365 days by default, are included in a person's export and are removed by erasure. Governance reports and the anomaly and adoption analysis include them, as described above.

**Admin API.** The Admin API key serves two reads. While FinOps is switched on, the Hub reads the organisation's cost report from the start of the current month (`GET /v1/organizations/cost_report`) on each scheduler cycle, grouped by model, cost type, context window, token type and service tier, and compares Anthropic's reported total with Command Centre's own figure. The cost report carries no per-person data and is not stored; when the two totals differ by at least a threshold you set, an alert records the period and the percentage difference. When Spend Review is opened, or a report with the Spend Review section is generated for the current month, the Hub reads each member's effective spend limit (`GET /v1/organizations/spend_limits/effective`) and pending requests for more usage (`GET /v1/organizations/spend_limit_increase_requests`). For each member these carry their Anthropic user identifier, name and email address, the limit, spend so far in the period and where the limit is set. The results are matched to people by email, held in memory for up to five minutes and not written to the database; they appear in Spend Review and in a report's Spend Review section as described above. The Hub makes no call that sets or removes a limit or approves or denies a request.

## Prompt injection and output control

Captured prompts are written by your people, and some will contain instructions. Command Centre's design is that no model output can act on anything.

- **No agency.** Models are called through the Messages API only. Apart from Anthropic's web search in skills discovery, which receives no organisation data and, with dynamic filtering, runs its filtering code in Anthropic's own sandbox, no model is given a tool. No model can query the database, call a Command Centre function, reach a connector, send a message or change configuration or access control.
- **Fencing.** The calls that judge a person's text (both classifiers, the intent assessment and the personal-data confirmation) wrap it in a dedicated tag, remove any copy of that tag from inside the text so it cannot close the block early, and instruct the model that requests inside the block about how to rate or format the answer are material to assess and never instructions. Transcript extraction, session descriptions and human time estimates carry a comparable instruction.
- **Constrained replies.** The personal-data confirmation, session judging, process mining and skill drafting use JSON-schema structured output. Every judged value is checked in code: tiers, kinds of work, severities, verdicts and use case labels must come from fixed or configured lists, confidence is clamped, and anything else is a failure or a safe default.
- **Numbers.** Briefings, the dashboard briefing, session descriptions and the workflow impact summary may only repeat numbers present in the data sent; process mining and Highlights may contain no digits at all; skill drafts may use only numbers found in the excerpts. Judgements a model expresses as figures, such as a tier, a confidence, a by-hand time estimate and the dashboard risk score, are labelled as AI-judged or estimated.
- **Detection is deterministic.** Pattern and phrase matching flags a message in the Audit Log, with the pattern or intent category recorded, before any model is involved. Within that detection, a model judgement sets only the severity of an intent alert and whether a match on one of the seven shape-only personal-data patterns raises an alert; the flag on the message stays either way.

## Human oversight

- **Labelling.** AI-judged figures and AI-written summaries carry their own colour and label, and estimates are shown beside measured time and cost, never combined with them.
- **Confirmation by a person.** Capability candidates identified by the classifier are confirmed or dismissed by a person before they count as confirmed capabilities. Use cases mined from prompts, extracted from transcripts or proposed in ideation exist only as suggestions until a person adds them. Skill drafts can be reviewed and edited by an owner before download. Highlights drafts are sent only when an administrator chooses to send them.
- **Quality checks.** A monthly sample of classifier decisions is drawn for administrators to review and score, and the Classifier Health page shows queue depth, failures, tier distribution and confidence. Administrators can also spot-check human time estimates.
- **No automated decisions about people.** Alerts and judgements are advisory. Nothing in Command Centre changes a person's access, blocks their use of Claude or takes any action against them.

## Positioning against the EU AI Act and ISO/IEC 42001

The following is offered to support your own assessment and is not legal advice.

Under the EU AI Act, Command Centre uses general-purpose AI models supplied by Anthropic to classify and summarise employees' work with Claude, and your organisation is the deployer. The relevant provision is Annex III, point 4, which treats as high-risk AI systems intended to make decisions affecting work-related relationships or to monitor and evaluate the performance and behaviour of persons in such relationships. Command Centre's design points away from that category: its judgements describe pieces of work rather than rate people, its outputs are advisory and labelled, and it takes no decision about anyone. It does, however, give administrators and managers per-person views, including individual delegation profiles and Spend Review, which names people. Whether a deployment falls within Annex III therefore depends on use: if those views inform the evaluation of individual employees, treat the deployment as potentially high-risk and assess it accordingly.

Under GDPR, the processing involves employee personal data and, through prompts, potentially any personal data employees typed. A data protection impact assessment is appropriate, as is consultation with employee representatives where your jurisdiction requires it. Command Centre makes no solely automated decision with legal or similarly significant effect within the meaning of Article 22.

Command Centre's design aligns with several ISO/IEC 42001 control objectives: an inventory of AI uses and their data (this document), administrator control of the model used for most features, data minimisation through masking and cleaning, human oversight and confirmation steps, monitoring of classifier quality, and an access audit log that records report generation, Highlights drafts, skill drafting and dashboard briefing reads. These statements describe alignment only; certification applies to an organisation's management system.

## Running with AI features off

Every model call depends on the Claude API key. Without a key, no model call is made. For a clean configuration, also switch off the AI-dependent features so that scheduled jobs do not attempt calls; where each switch lives in the admin pages is set out under [Content and AI switches](configure-command-centre.md#content-and-ai-switches) in Configure Command Centre. The main switches are these.

| Switch | Effect |
|---|---|
| Claude API key removed | No model call of any kind |
| Use Cases content switch off | No session judging, process mining or skill drafting; no prompt text sent to Anthropic by any Use Cases feature |
| Code classifier prompt option off | Claude Code classifier sends metadata only |
| Session descriptions off | No descriptions written; existing ones hidden |
| Human time off (Cowork, Code) | No estimates |
| Work Pulse off | No Cowork work classifier, session descriptions, Claude Cowork human time estimates or scheduled Work Pulse briefings |
| Highlights off | No Highlights drafts |

With no key, the following continue to work in full: telemetry capture and the Audit Log; personal-data detection and its alerts, without the confirmation step; intent detection, with alerts at each category's default severity; measured Claude Cowork and Claude Code figures (sessions, active time, commits, pull requests, lines, spend, session output); FinOps chargeback and Spend Review cost figures; the Skills and Connectors Board; the Weekly Digest; the Metrics Connector; use case tracking through codified skills; alerts to Slack; and retention, export and erasure.

Everything in the inventory stops, including governance reports, which are model-written. Figures that depend on the AI-judged kind of work, such as Spend Review's comparison with colleagues on the same work, lose that breakdown.

## Sub-processors and external services

Because Command Centre runs on infrastructure you control, under your keys, each external service it can call is one your organisation chooses and contracts with directly. The Command Centre project does not route any of this data through its own systems.

| Service | Role | Personal data involved | Contracted by |
|---|---|---|---|
| Anthropic (Claude API) | Model inference for the features in this document | Prompt excerpts as described per feature, display names where stated, pseudonymous ids | Your organisation |
| Anthropic (Compliance API) | Source of Claude Chat history | Inbound only: Claude Chat prompts and metadata; outbound key and cursors | Your organisation |
| Anthropic (Analytics API, on the roadmap) | Source of daily per-person usage counts | Inbound only: each person's Anthropic user identifier, email address and daily activity counts; outbound key, date and cursors | Your organisation, optional |
| Anthropic (Admin API, on the roadmap) | Source of the organisation cost report and members' spend limits | Inbound only: organisation cost by model and type; each member's name, email address, spend limit, spend so far and any pending request for more usage; outbound key and query parameters | Your organisation, optional |
| Your hosting provider, if any | Hosting, for example AWS or Azure | All Command Centre data at rest | Your organisation |
| Slack | Weekly Digest, high-priority alerts, Highlights | Alert titles and explanations, which may name a person and, for intent alerts, can quote the prompt; administrator-edited Highlights text | Your organisation, optional |
| Email (your SMTP relay) | Weekly Digest, password reset | Recipient addresses; digest content | Your organisation, optional |
| GitHub | Developer Pulse shipping overlay | Commit author emails and logins received; stored as per-person daily commit counts, with unmatched authors listed for an administrator to map | Your organisation, optional |
| Identity provider | Single sign-on | Standard OIDC identity claims | Your organisation, optional |

High-priority alerts sent to Slack carry the alert's title, its explanation (up to 500 characters), type, category, severity and time; the evidence field stored with an alert is removed before sending. For an intent alert, the explanation is the model's reasoning about the prompt and can quote it. The Weekly Digest carries organisation-level figures, per-department counts, use case titles (with the owner identifier for any that have gone quiet), the title and severity of the most significant open alert, and the first 400 characters of the latest Claude Code briefing. Weekly Highlights carry names only if an administrator turns on the option to credit people, and only after the administrator has reviewed the draft.

There is no other model provider, no third-party AI service and no analytics or monitoring service that receives data from the running application. Operational logs, including the first 400 characters of any briefing reply refused by the number check, go to the Hub's own log: with Docker Compose, `docker compose logs hub`; on a cloud, your cloud's log service, such as CloudWatch Logs on AWS.
