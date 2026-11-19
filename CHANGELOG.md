# Changelog

## 1.4.2 (2026-11-19)

### Changed

- So What's "used it once and hardly since" no longer reads every prompt ever stored. On a test hub with two years of activity for 5,000 people it took 17 seconds on every build; it now looks each person up in one of two new indexes, one for Claude and one for ChatGPT (migration 0056). The count is unchanged.
- A dead-code check (knip) runs on every pull request. Its first run found 15 components that no page showed, the unused chart package recharts and a few unused functions and settings, which are gone.

### Fixed

- So What's waves, on Work Pulse and Developer Pulse, measured each person from their first prompt or session still stored. Once a hub was older than its retention window (90 days unless changed), everyone who started earlier looked as if they had started in the oldest month kept. Retention now keeps each person's first date and first meaningful date before it deletes anything (migration 0057), so the waves stay right. Dates only, never content, and they are erased with the person. Dates retention deleted before 1.4.2 are gone, so a wave that started before then is left out rather than shown wrong.
- Removing the OpenAI key while a sync was running could still leave a sync position, or the last sync time and figures, saved afterwards. A key added later then carried on from the old position instead of starting again.

## 1.4.1 (2026-11-16)

### Changed

- Every Work Pulse page (Overview, My Pulse, Users, Departments, Team Coaching and So What) and the dashboard's Work Pulse panels keep their figures for five minutes and then refresh them in the background, as Spend Review does. Figures that depend on who is looking are kept for each viewer, and reading someone's prompt text is recorded in the Audit Log on every visit, kept or not. On a large hub they took several seconds on every visit; now only the first visit after a restart waits. Confirming a new way of working or generating a briefing shows the change straight away. A result with a part that failed to load is never kept.
- So What works its figures out about twice as fast. The evenings card built a new timezone reader for every prompt, which made it most of the page's wait; it now builds one per timezone and checks each 15-minute slot once. On the sample hub So What's own work went from 1.4 seconds to 0.65.
- Work Pulse's "What did the work produce?" and FinOps Model Efficiency work out each session's kind of work in the database, and the panel counts sessions by week and kind there too. The app gets back about a hundred rows instead of every session and every label. The answers are unchanged.
- The dashboard's "Which skills and connectors are spreading?" says how its product users split between Claude and ChatGPT, since someone using both counts in each.
- Claude Chat conversations for So What and "What did the work produce?" are found through the conversations with a prompt in the window, rather than by grouping every conversation ever held.

### Fixed

- A panel no longer disappears while its feature is switched on. If its figures fail to load it says "Couldn't load this. Try refreshing the page.", and with no data it says there is nothing yet. Only a feature that is switched off, or a page that isn't for that role, still hides a panel. This covers Work Pulse, Developer Pulse, the dashboard, FinOps, Spend Review, Use Cases, the S&C Board, Reports, Alerts, the Audit Log and Admin.
- A page that failed to load no longer showed "No work yet", "No alerts", "No reports" or "No events found" as if there were none. It now says it couldn't load. The S&C Board no longer goes blank, and an entry that fails to load no longer sends you back to the Board without saying why.
- Switching view while a load failed no longer leaves the last view's figures on show under the new view's name.
- The dashboard's AI briefing could set this week's active users against everyone on record, as in "141 of 100 active users". It now gives active users as the dashboard does and never against a total.
- On a hub with more than about 65,000 sessions in a quarter, Work Pulse's "What did the work produce?" panel disappeared, because Postgres refuses more than 65,535 values in one query. Sessions are now looked up 1,000 at a time.
- One person's Spend Review showed Claude in Office and Google even when **Show Claude in Office and Google** was off. It now follows the setting, as FinOps does.
- In the Codex view, panels for figures Codex doesn't send (Language mix, Efficiency, Leverage and Observed signal) now say so instead of disappearing.
- An unconfirmed use case shows its Skill and Spread opportunities panels, saying to confirm it first. An archived one says it is archived.
- The AI data flow guide said administrators, managers and viewers could ask for adoption suggestions. Nothing in the app asks for them; it only runs through `/api/ai/analyze`.

### Removed

- The unused AI summary for FinOps, and its model setting. The FinOps summary has always been written in code.
- The skills discovery code, switched off in 1.4.0.

### Security

- vitest 4 and fast-xml-parser 5.12.0, which clear the remaining Dependabot alerts.

## 1.4.0 (2026-11-16)

### Added

- Ask the data, in preview: administrators ask a question in their own words and get a short answer built from the figures the pages already show, with links to those pages. Every number in an answer is checked against what the pages returned. It runs on Claude Haiku 5.5 within a monthly spend cap ($5 unless changed), never stores its answers, and is off until an administrator turns it on under **Admin → Ask the data** (migration 0055). See [Ask the data](docs/product-overview.md#ask-the-data) and [AI data flow](docs/ai-data-flow.md#ask-the-data).
- So What, on Work Pulse and on Developer Pulse, for administrators and managers: the gap between the people who get the most from AI and everyone else doing the same work, turned into a decision (hire or hold, replace or not, roll a way of working out). Each decision is recorded with the figures as they stood and comes back 30 days later with what has changed since, never claiming the decision caused it (migration 0052).
- Team Coaching, on Work Pulse and on Developer Pulse, for administrators and managers: a plan for one team, written in code from its own figures. It shows where the team is, what to work on, who to learn from and what to try. Thirty days after an action is marked done, it says whether the figure the action aimed at moved, against the organisation's own movement (migrations 0050 and 0051).
- An intended share per kind of work on **Admin → Developer Pulse**, which Developer Pulse Team Coaching reads each team against, and a department adoption target and depth floor on **Admin → System**.
- The names of files Claude Chat and ChatGPT replies list, so Team Coaching can say what a session produced (migrations 0053 and 0054). Names only, never contents.

### Changed

- Every page is redesigned: each panel asks a plain question and answers it in a sentence written in code from its figures. AI-judged and estimated figures carry a grey tag and say so in words, and empty values read "not measured" or "not priced" rather than a dash.
- Pages use the tier names set in the rubric (Administrative, Meaningful and Frontier for Work Pulse by default), never tier numbers, so renaming a tier renames it on the pages.
- The Work Pulse Overview and the dashboard answer four questions (people doing meaningful or frontier work, the share of such tasks, new ways of working, and who frontier work rests on) in place of the four scores. Reports still carry the scores.
- Developer Pulse counts repositories over 30 days everywhere, and shows no month-end projection before day 7 of the month.
- Developer Pulse Value counts time saved from pull requests and commits only. The minutes-saved settings for Claude Cowork sessions and Claude Chat conversations are removed.
- FinOps leads with four figures and where the spend goes by product, with the detail folded below. Anyone else who opens it is told it is for administrators and managers, and sees no figures.
- Spend Review leads with better routes, proven savings first. The most efficient board compares each session with colleagues' typical session for the same kind of work.
- A person's spend is shown only to them, administrators and managers, on Work Pulse and Developer Pulse alike. Colleagues and viewers see "hidden".
- The S&C Board leaves out Claude's own connectors and Claude Code's bundled skills, says how many connectors come from Anthropic, and counts only unclaimed entries that are in use. The Tool Usage page is folded into the Board.
- Use Case Governance groups bets by lifecycle, says how long each has been at its stage, and reads "Not estimated" for a bet with no sessions.
- Opening Work Pulse takes administrators, managers and viewers to the Overview. Viewers no longer get Developer Pulse Users, which could not show them another person, matching Work Pulse.
- Only administrators see the buttons to acknowledge, resolve, dismiss or clear alerts, the actions only they can take.
- Features that defaulted to Claude Haiku 4.5 (the Core AI model, both classifiers and transcript import) now default to Claude Haiku 5.5. Every AI call asks for thinking off, so a model that thinks by default cannot use up a short reply before writing it. A model already chosen in Admin, and features that default to Sonnet, are unchanged.
- Skills discovery no longer runs: no page showed its results, so its weekly web search made model calls for nothing.

### Fixed

- Weekly Highlights could fail with "The model call failed or produced nothing that could be traced back to real work items" when the reply came wrapped in text or ran long. The draft is now read reliably, with room for six full sentences, and the log says why a draft was rejected.
- The Dashboard briefing's Refresh could fail with "failed the number check twice" when the AI model spent its whole reply thinking, or put text around its reply. Every briefing now asks for thinking off and reads its reply as Weekly Highlights does, and the message no longer blames the numbers.
- A Pulse colleague with no sign-in account could not be opened from the Users list, which offered them.
- Opening the address of a Pulse page your menu does not offer now takes you to your own page, not one that cannot load. Someone with Developer Pulse only goes to My Developer Pulse, and someone with Work Pulse only goes to My Pulse.
- So What and Team Coaching sentences: singular and plural agree ("1 person is left out"), "most" no longer claims more than the figure shows, time windows read as they are counted, and the 30-day follow-up is said against the card's aim rather than the leader's choice. A decided Developer Pulse So What card keeps its follow-up after its finding stops qualifying.
- Messages that pointed to the wrong admin page now name the right one: the Claude API key is on Access & Keys, Use Cases is switched on under Use Cases, model rates are under Developer Pulse → Rates, and Work Pulse tiers are on Tier config.
- Twelve dependency security alerts, report dates that are not real dates, and month links on FinOps and Spend Review.

### Upgrading from 1.3.0

Back up first: see [Upgrading from 1.3.0 to 1.4.0](docs/troubleshooting.md#upgrading-from-130-to-140). The first start adds six tables and columns (migrations 0050 to 0055) and rewrites nothing.

## 1.3.0 (2026-11-10)

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
