# Changelog

## 1.3.0 (2026-11-11)

### Added

- ChatGPT and Codex beside Claude, in preview: we are looking for organisations on ChatGPT Enterprise or Edu to test it (say hello in [Discussions](https://github.com/frontiercc/command-centre/discussions)). Command Centre reads OpenAI's Compliance API (ChatGPT Enterprise or Edu) with an OpenAI Admin API key: ChatGPT Chat and Work prompts, Codex prompts, turns and tool calls, and OpenAI's hourly cost records. Enter the key under **Admin → Access & Keys → OpenAI (ChatGPT and Codex)**: see [Connect ChatGPT and Codex](docs/configure-command-centre.md#connect-chatgpt-and-codex). The sync does nothing until a key and workspace ID are saved, and an admin can pause it or hide ChatGPT and Codex from the analytics pages.
- A switch to show all products, Claude alone, or OpenAI alone, reading All / Claude / ChatGPT on the dashboard, Work Pulse and Developer Pulse alike (on Developer Pulse its ChatGPT view shows Codex, which the page names). In the All view each dashboard box splits into Claude and its own OpenAI product: ChatGPT for Chat and Work, Codex for Code, ChatGPT and Codex for active users. Work Pulse grades ChatGPT prompts against the same tiers as Cowork, Developer Pulse shows Claude Code and Codex side by side, and each view keeps its own weekly history.
- ChatGPT and Codex spend on FinOps and Spend Review, priced from tokens at OpenAI's published USD rates and kept apart from Claude's, with a Claude / ChatGPT and Codex split. Model advice never suggests a model from the other vendor. A ChatGPT seat price can be set for licence costs.
- ChatGPT and Codex across the rest of Command Centre: personal data and risky-intent alerts on their prompts, the Audit Log (with spend for each prompt), each person's combined spend on their Person 360 page, Use Cases, the Skills and Connectors Board, human time, reports, briefings and telemetry-silence alerts.
- Department sync from Microsoft Entra ID. With single sign-on through Entra, Command Centre reads each person's department when they sign in and, once a day, looks up everyone it knows by email, including people who never sign in (read-only Microsoft Graph permissions `User.Read` and `User.Read.All`). Switching it on changes nothing until an administrator previews the directory's department names, maps any that differ, and applies. A department set by hand is never overwritten, an empty directory value never removes one, and every change is recorded on the person's page. In FinOps, a move between departments during an open month splits that person's spend at the move. Roles are never changed. For anyone who is not an admin, their department also sets which department's data they can see, so a move changes that too. Google Workspace is not supported yet.
- Sample data includes thirteen weeks of ChatGPT and Codex activity.
- A stand-in for OpenAI's Compliance API (`scripts/openai-mock`) for building and testing the sync without a ChatGPT Enterprise workspace.
- GitHub commits are matched to the tool that made them. A commit counts as made with Claude Code or Codex when its author is a Command Centre person whose Claude Code or Codex activity recorded a commit within 15 minutes of it; commit messages are never read. Shipping Alignment compares each tool with its own GitHub commits, and each person's repository count and the Codex view's codebase reach follow the same matching.
- The use cases register shows each use case's matched sessions in the last 13 weeks for each product that did the work (Claude Cowork, Claude Code, ChatGPT and Codex), and Use Case Governance shows sessions and measured hours the same way. Each department and cross-department suggestion says how many of its sessions came from Claude Cowork, Claude Code, ChatGPT and Codex.
- Identity conflicts catch one OpenAI account arriving under two email addresses, beside Claude's installation conflicts, with the same merge and undo.
- Anomaly detection runs once a day while a Claude API key is set and at least one of its alert types is on, takes the acceptable use policy into account, and sees Codex turns and tokens and ChatGPT replies per person (no prompt text).

### Changed

- Claude Chat prompts are stored beside Cowork prompts, so Work Pulse grades them into tiers like other work. With grading on, their text is sent to the classifier model, as Cowork prompts are.
- **Enterprise APIs** on **Admin → Access & Keys** is now **Claude Enterprise APIs**.
- The department table on the Work Pulse overview shows each department's resilience score, which was always blank, and marks only a concentrated score (below 0.35) as a risk.
- The Audit Log's source filter and labels name the vendor: OpenTelemetry (Claude), Anthropic Compliance API (Claude Chat) and OpenAI Compliance API (ChatGPT and Codex). Choosing the Anthropic Compliance API no longer returns ChatGPT and Codex too.
- FinOps splits its 12-month trend and spend concentration by product and its month-end projection into Claude spend and ChatGPT and Codex spend. Spend Review shows the month's totals for each and ranks the most efficient people on separate boards for Claude work and for ChatGPT and Codex work, in the page and in Reports.
- The Value page counts Codex spend, commits and people beside Claude Code's; Dev Framework Alignment has the Claude / Codex switch; Data Quality shows the last Codex record. The Observed signal stays Claude Code only, because Codex reports no engaged time.
- Codex sessions are graded from their real actions, failed actions, commits and models. The allowed-models and high-friction alerts cover Codex. Risky-intent alerts name the product the prompt came from.
- The human-time spot-check draws ChatGPT conversations. The weekly digest, Weekly Highlights, Reports and the Metrics Connector include Codex spend and ChatGPT and Codex time while they are shown.
- ChatGPT and Codex are watched for silence as two sources, and not while the OpenAI sync is paused. A rejected OpenAI Admin API key raises its own alert.
- Admin → Ingestion: the collector panel is named Claude collector (OpenTelemetry); Recent users shows the product each person was first seen in and includes people first seen through Claude Chat. The Pulse role reads Pulse (Work and Developer). Admin → Files shows each file's product, with a filter. Database health and the support bundle count ChatGPT and Codex on their own lines. Licensed seats is labelled Claude licensed seats.
- In the Audit Log, a ChatGPT or Codex conversation that used one model shows it on one line ("all on gpt-5").
- Wherever a source is named (the dashboard's source chips, the Users page, System health, personal-data and key-rejected alerts, the Audit Log's notes), it says whose API it is: Anthropic's or OpenAI's.

### Fixed

- Developer Pulse no longer shows "n/a" under a figure for a product a person has not used.
- "Last active" on the department page shows when the person last worked, not when their work was graded.
- Viewers no longer see Work Pulse's Users page in the menu, which they cannot open.
- A department's resilience score on the Work Pulse department page no longer falls back to "Pending data" after the daily run.
- In an Audit Log conversation the newest turn stays at the top and is now numbered last: Turn 1 is the first prompt, and each turn shows the time of its prompt. Turns used to be numbered from the newest.
- Spend Review's efficiency board says what its rule is: people are ranked when their share of Tier 3 work is no more than 10 points below colleagues', not "within 10 points".
- A model with two ids (a dated id and its alias, such as Claude Haiku 4.5) is listed once in spend by model and its legend, with one colour.
- The use case governance summary says how many completed weeks an at-risk bet has had no matching activity, not "quiet for 0 weeks".
- Opening a person or a use case that doesn't exist says so, instead of crashing or saying Use Cases is switched off.
- A use case's measured time under six minutes reads in minutes, never "0.0h".
- An AI session summary containing characters from another writing system is refused and written again.
- Opening another department's Work Pulse page says it is not available, instead of "Couldn't load, try again".
- Spend Review offers a manager "Show prompts" only for people in their own department, as the Audit Log does.
- A manager on the Work Pulse admin overview sees that process baselines are set by an admin, not "No departments found".
- The department page's "at this depth" line says it covers the same kind of work over the last 30 days.
- The S&C Board's tile reads "Organisation connectors", matching the skills tile, and Hot this week lists only rising entries.
- Person 360 no longer calls the combined spend an underestimate for someone with no coding activity.
- The dashboard no longer logs an error when a Pulse-only role is sent to its own page.
- The Users page shows "Agent" for people first seen by the retired local agent.
- Sample data: each use case match points at a real session the sample has, in the week that session happened (a match to a session the sample lacks moves to one the same person had that week), so each use case's people, sessions and time agree.
- Retention clears the names of files attached in a session once the session is past its window, in both modes, and archiving now copies ChatGPT and Codex reply records, turns, actions, spend and conversation times before they are deleted.

### Upgrading

- The database changes apply when the Hub starts. Claude Chat prompts move from their own table into the Cowork table in one step; if the move fails, nothing changes.
- Back up the database before you upgrade, as in [Updating](docs/troubleshooting.md#updating). The move deletes the old Claude Chat table, so a 1.2.0 Hub cannot run against the upgraded database; going back means restoring that backup.
- On a hub with a long Claude Chat history, the first start can take longer than usual while the prompts move. On AWS or Azure, give that start a longer health-check grace period, so the platform does not replace the Hub part-way through.
- After the upgrade, Work Pulse grades the Claude Chat prompts already stored, oldest first, and, once ChatGPT is connected, its first 30 days of prompts. This uses your Claude API key, and new Claude Cowork prompts wait behind them until the queue clears. To leave ChatGPT prompts ungraded, switch off **Classify ChatGPT prompts** under **Admin → Work Pulse**.
- To connect ChatGPT and Codex, create an OpenAI Admin API key with read access to conversation messages, Codex logs, Codex turns and costs, and enter it with the workspace and organisation IDs under **Admin → Access & Keys**. The first sync reaches back 30 days and reads at most 300 files a run, so on a busy workspace it spreads over several runs.
- Some details of OpenAI's Compliance API are not yet confirmed against a live workspace: the exact model names, and how ChatGPT Work is marked in the Codex logs. A model Command Centre has no price for is named as not priced, never counted as $0, and an admin can add its price under **Admin → Developer Pulse**.

## 1.2.0 (2026-11-06)

### Added

- Claude in Google Sheets, Docs and Slides. The Claude add-on for Google Workspace reports through the same **Office agents → Monitoring** setting as Claude in Office, and Command Centre now shows its work as its own products. The Work Pulse **By product** panel groups the apps under Cowork, Claude in Office (Excel, Word, PowerPoint, Outlook) and Claude in Google (Sheets, Docs, Slides). The FinOps and Spend Review estimate panels, the Audit Log app filter and labels, the FinOps and Spend Review report sections and the executive and department briefings all name the Google apps. Google spend is an estimate priced from the model rates, like Office spend, and is never added to any total. Google sends no document name, so Google work lists no file names.
- Sample data includes Google Sheets, Docs and Slides activity.

### Fixed

- Google Workspace work was filed under Microsoft Office: Google Sheets showed as Excel, Google Slides as PowerPoint and Google Docs as Word. Command Centre now reads which vendor sent each event. On upgrade, stored sessions that used Google Apps Script move to the Google apps; a Google Docs session with no Apps Script call cannot be told apart after the fact and stays under Word.

### Changed

- **Show Claude in Office** under **Admin → Work Pulse** is now **Show Claude in Office and Google**, and hides both groups.

## 1.1.1 (2026-11-06)

### Fixed

- The Audit Log's Surface column shows a Claude in Office prompt's app on its own (Excel, Word, PowerPoint or Outlook), not "Cowork" beside it.

## 1.1.0 (2026-11-05)

### Added

- Claude in Excel, Word, PowerPoint and Outlook. Their activity is stored beside Claude Cowork on Work Pulse, marked with the app, from the add-in's OpenTelemetry traces. Command Centre keeps each prompt, the model and tokens, and the name and outcome of each tool call; it never keeps document content or the document's address, only the file name of a document Claude changed. Set it up under **Office agents → Monitoring** in Claude's Organization settings: see [Connect Claude](docs/connect-claude.md#claude-in-office).
- A **By product** panel on the Work Pulse overview compares Cowork with each Office app: app users, sessions, meaningful work, produced something and spend, with an All products row that adds up. An app's meaningful work share shows once it has five judged prompts, and its produced something share once it has five sessions.
- Claude in Office spend on FinOps and Spend Review, as an estimate priced from the model rates (Office sends no cost). It is never added to Cowork's reported spend or any chargeback total.
- The FinOps and Spend Review report sections include the Office estimate, and the executive and department briefings say how work splits between Cowork and the Office apps when Office was used.
- The Audit Log labels each Claude in Office prompt with its app, and a new app filter shows Cowork alone, all of Claude in Office, or one Office app.
- **Show Claude in Office** under **Admin → Work Pulse** hides the Office panels on installations that do not use it.
- Sample data includes Office activity.
- Every published Claude model has a built-in price, including Opus 5.5, Sonnet 5.5 and Haiku 5.5, Mythos 5.1 and 5, Sonnet 4.5, and older models still served on Bedrock or Google Cloud. Prices saved on **Admin → Developer Pulse** still win. Spend on these models, left out as not priced before, now counts; Haiku 5.5 is priced at its rate for prompts up to 100,000 tokens.
- Each Cowork prompt records where its session ran (on the person's computer or in Anthropic's cloud), so a redacted prompt can be told apart.

### Changed

- The dashboard's "Cowork sessions" card is now "Work sessions", covering Cowork and Claude in Office. It no longer counts Claude Code sessions, which have their own card, so it reads lower where Claude Code is used.
- The bundled, AWS and Azure collector configurations accept Claude in Office's traces, sent from the person's browser.
- When a session has ended, the next page or request takes you straight to sign-in, and back to the same page afterwards.

### Upgrading

- With Docker Compose, the usual update (`docker compose up -d --build`) rebuilds the collector with the new configuration. The database changes apply when the Hub starts.
- If you run the collector yourself, on AWS, Azure or elsewhere, redeploy it from `deploy/aws/otelcol-ecs-config.yaml` or `deploy/azure/otelcol-azure-config.yaml`, or add the `cors` rule, `traces_endpoint` and `traces` pipeline to your own configuration. Without them Claude in Office's activity does not reach the Hub. A load balancer in front of the collector must pass the browser's `OPTIONS` requests through to it.
- To start receiving Claude in Office, open **Office agents → Monitoring** in Claude's Organization settings and select **Copy settings from Cowork**.

## 1.0.0 (2026-10-26)

First public release of Frontier Command Centre.

### What it does

- Shows whether people are moving from simple prompting to handing Claude substantial work and whole processes. Work Pulse grades Claude Cowork work against three tiers you can edit; Developer Pulse measures what Claude Code produces and what it costs.
- Finds recurring processes in everyday Claude activity, tracks how they are adopted and drafts reusable skills from them. The Skills and Connectors Board shows the skills and connectors in use and who owns them.
- FinOps and Spend Review attribute spend to people, departments, cost centres and models, and suggest cheaper ways to do the same work.
- Flags personal data, secrets and risky intent in stored prompts, with alerts, a searchable audit log, a record of who read each prompt, retention and erasure.
- Briefings, reports and a weekly digest, with every number in an AI-written briefing checked against the data.

### How it runs

- Claude Code and Claude Cowork send their activity through OpenTelemetry to a collector you run. On Claude for Enterprise, Claude Chat is read from Anthropic's Compliance API.
- Docker Compose runs everything on one computer or server. The docs also describe running it on AWS or Azure.
- Sample data from a fictional company lets you explore every page before connecting Claude.

### Not yet included

- Anthropic Analytics API and Admin API integrations, which are on the roadmap.
- Dev Framework Alignment is an example of how engineering indicators could look; it has not been fully tested and is switched off by default.
