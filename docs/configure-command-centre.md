# Frontier Command Centre: Configure Command Centre

Once you have signed in as the first administrator, this page walks through each area of Command Centre's settings, in a sensible order. It applies to every installation, on your own server or in the cloud.

All configuration lives under **Admin** in the navigation; only administrators see all of it. Settings are stored in the database and take effect without a restart. Secret values (API keys, webhooks, the SSO client secret, the SMTP password, the GitHub token) are encrypted at rest with `CCC_ENCRYPTION_KEY`, are shown masked after saving, and are only ever cleared with their **Remove** button; saving a blank field leaves the stored secret in place.

Several major features are off until you enable them.

| Area | Where | State on a new instance |
|---|---|---|
| Claude API key, Compliance Access Key, SSO, SMTP, user accounts | Admin → Access & Keys | Empty |
| Core AI model, FinOps, seats, Weekly Digest, Weekly Highlights, Metrics Connector, system health | Admin → System | FinOps, digest and highlights off |
| Departments (bulk), monitoring exclusions, collector status | Admin → Ingestion | Empty |
| Work Pulse settings and tiers | Admin → Work Pulse | On |
| Developer Pulse settings, GitHub overlay, prices, tiers | Admin → Developer Pulse | On |
| Use Cases | Admin → Use Cases | Off |
| Cost centres | Admin → Cost Centres | Available once FinOps is on |
| Retention | Admin → Data | Defaults applied |
| Alerts, thresholds, Slack alerts | Admin → Risk Scoring | Slack alerts off; Claude Code daily spend limit $100 |

**Contents:** [Claude API key and models](#claude-api-key-and-models) · [Claude Chat capture through the Compliance API](#claude-chat-capture-through-the-compliance-api) · [Single sign-on](#single-sign-on) · [Email (SMTP)](#email-smtp) · [Users, roles and departments](#users-roles-and-departments) · [Cost centres, licensed seats and seat price](#cost-centres-licensed-seats-and-seat-price) · [Retention](#retention) · [Content and AI switches](#content-and-ai-switches) · [Work Pulse](#work-pulse) · [Developer Pulse and the GitHub overlay](#developer-pulse-and-the-github-overlay) · [Use Cases](#use-cases) · [Skills and Connectors Board](#skills-and-connectors-board) · [Weekly Digest](#weekly-digest) · [Weekly Highlights](#weekly-highlights) · [High-priority alerts to Slack](#high-priority-alerts-to-slack) · [System health and telemetry-silence alerts](#system-health-and-telemetry-silence-alerts) · [Metrics Connector](#metrics-connector) · [Reports](#reports)

## Claude API key and models

Every AI-judged feature depends on this key, so set it first.

1. Go to **Admin → Access & Keys → AI features**, paste the key into **Claude API Key**, select **Test**, and then **Save settings**, below the Endpoint security panel.
2. Go to **Admin → System → Core AI model**, choose the **Model** and select **Save**. The default is Haiku. This model runs the dashboard briefing, anomaly detection, Reports, intent assessment, the PII confirmation check, the Cowork session descriptions and the Cowork human time estimates, and personal weekly briefings follow it unless you set otherwise.

Most features with their own model offer a drop-down filled from your key's model list, so those lists only fill once the key works. The defaults are sensible starting points and you can leave them: Cowork classifier Haiku, Code classifier Haiku, organisation briefings and skills discovery Sonnet, use case session judging Sonnet, department processes Sonnet, skill drafting Sonnet.

**Check:** the **Test** button reports success, and the model drop-downs on Admin → Work Pulse list models.

## Claude Chat capture through the Compliance API

Command Centre captures Claude Chat by pulling it from the Anthropic Compliance API, which requires Claude for Enterprise. Command Centre stores each person's prompts in full, subject to personal-data and intent flagging, with the number of files they attach. For Claude's replies it stores metadata only: the model and the number of artifacts and files Claude made, never the reply text. Command Centre also records which named connectors a chat used.

1. In claude.ai, open [Organization settings → API](https://claude.ai/admin-settings/api-access). The Primary Owner turns the Compliance API on there; a Primary Owner or Owner then creates a Compliance Access Key with the scopes `read:compliance_activities` and `read:compliance_user_data`.
2. In **Admin → Access & Keys → Enterprise APIs**, paste it into **Compliance Access Key**, select **Test**, then **Save settings** below the Endpoint security panel.

The sync runs every two minutes, up to 200 changed chats per run. The first run reaches back 30 days, or less if your Chat retention period is shorter.

**Check:** a **Last sync** line appears under the key within a few minutes, showing chats, prompts, connectors and activities, with an error count added only when a run has errors. The figures count what the run examined, so read the absence of errors as the signal of health. Claude Chat prompts then appear in the Audit Log with the Compliance API as their source.

## Single sign-on

Single sign-on lets people sign in through your identity provider while Command Centre keeps its own roles. A person can only sign in this way if an account already exists for their email and has SSO switched on; an unknown email is refused, never created.

1. In your identity provider, register a web application (a confidential client with a secret). Set its redirect URI to `https://<your-hub-hostname>/api/auth/sso/callback`. Make sure the ID token includes `email` and `email_verified` set to true. On Microsoft Entra ID, add `email` and `xms_edov` as optional ID token claims under **Token configuration**.
2. In **Admin → Access & Keys → Single sign-on (OIDC)**, enter the **Issuer URL** (Command Centre reads the provider's discovery document from it), the **Client ID**, the **Client secret**, a **Provider label** for the sign-in button, and the **Redirect base URL** `https://<your-hub-hostname>`. The page shows the exact **Callback URI** to register; compare it with what you entered in the provider.
3. Switch on **Enable SSO**, select **Save SSO settings**, then **Test connection**.
4. Switch on SSO for each person who should use it, in the SSO column of the Users table on the same page. To do it in bulk, tick the people and select **Enable SSO for selected**.

People who appear automatically because their telemetry arrived have SSO off until you switch it on.

**Check:** **Test connection** reports success. Sign out, use the SSO button on the sign-in page, complete your provider's prompt and land on the dashboard. A refused attempt returns to the sign-in page with a reason, and every attempt is written to the audit trail.

## Email (SMTP)

Email carries password reset links and the Weekly Digest.

1. In **Admin → Access & Keys → Email (SMTP)**, enter **SMTP host**, **Port** (587 by default), **SMTP username**, **SMTP password**, **From address** and **From name**, and select **Save SMTP settings**.
2. Set the Hub's public address in **Admin → System → Weekly digest → Hub URL** as `https://<your-hub-hostname>`, and save. Password reset links are built only from this address or the SSO redirect base URL, never from the address a browser happens to send, so with neither set no reset email is sent.

**Check:** on the sign-in page, request a password reset for your own account and confirm the email arrives with a link to your hostname.

## Users, roles and departments

People appear in Command Centre automatically the first time their telemetry or Claude Chat activity arrives, matched by email, with the contributor role "Pulse (Cowork + Code)" and no password. Your job is to assign departments and to give the right people wider roles.

| Role | What it can see |
|---|---|
| Admin | Everything, including the Admin area and every person's prompts in the Audit Log |
| Manager | Dashboard, Alerts, Reports, organisation overviews, FinOps, Use Cases, the Work Pulse admin page; the Audit Log for their own department |
| Viewer | Dashboard, Alerts, Reports, organisation-level Cowork and Developer Pulse pages and Use Case Governance; never the Audit Log or FinOps |
| Pulse (Cowork + Code) | Their own and their department's Work Pulse and Developer Pulse pages |
| Work Pulse | As above, Cowork only |
| Developer Pulse | As above, Code only |

1. **Load departments in bulk.** In **Admin → Ingestion → Pre-populate OTel users**, paste the CSV of `email,display_name,department` and select **Import users**. Rows whose email already exists are skipped, so import before you connect clients. Imported people are given the Work Pulse role; change it to Pulse (Cowork + Code) for anyone who also uses Claude Code.
2. **Exclude people from telemetry monitoring.** In **Admin → Ingestion → Exclude users from OTel monitoring**, list their emails, one per line, and select **Save exclusion list**. Telemetry for these addresses is dropped on arrival: nothing is written and no alert fires.
3. **Set roles and departments.** In **Admin → Access & Keys → Users**, use the role selector and **Set dept** on each row, and give every manager a department. Create accounts for administrators, managers and viewers who do not use Claude with **+ Add user**, which opens the **New admin user** form.

If your Claude Code settings send a `department` attribute with telemetry, Command Centre uses it for a person it has not seen before; an existing department is never overwritten.

**Check:** the Users table on **Admin → Access & Keys** shows imported people with their departments.

## Cost centres, licensed seats and seat price

FinOps rolls up each person's measured AI spend on Claude Code and Claude Cowork by cost centre for a calendar month, and Spend Review shows, person by person, where the money goes and whether a cheaper route exists. FinOps is visible to administrators and managers only, because individual cost is close to salary information; Spend Review shows administrators and managers everyone's review and each person their own. Spend figures are measured from telemetry: Claude Code spend is priced from the model rates in Developer Pulse, and Claude Cowork spend is the cost each Claude Cowork request reports. Claude Chat cost is not part of the chargeback total.

1. In **Admin → System → FinOps**, switch on **Enable FinOps (cost and chargeback)**. Switch on **Model efficiency (FinOps)** as well if you want the spend-by-activity and model view. Enter **Seat price (USD/month)** and save.
2. In **Admin → System → General**, enter **Licensed seats** and save. FinOps uses seats and price to estimate the cost of unused seats; the estimate never enters the chargeback total.
3. In **Admin → Cost Centres**, create each cost centre with its optional **GL code**, then use **Department mapping** to assign each department. A department with no mapping is its own cost centre; people with no department fall into Unallocated.
4. Check the model prices in **Admin → Developer Pulse → Rates** against your agreement with Anthropic, and add any provider-specific model identifiers you use. A model with no price is shown as unpriced, never as zero.

At month end an administrator can close a period on the FinOps page, which freezes an immutable snapshot for billing; a closed period cannot be reopened.

**Check:** FinOps appears in the navigation for administrators and managers, and the department mapping lists your departments.

## Retention

Retention decides how long people's prompt text and related records are kept. Set it to your data protection officer's decisions before telemetry arrives.

In **Admin → Data → Data retention**, set each period (minimum 7 days) and the **Retention mode**, then select **Save retention settings**.

| Setting | Default (days) |
|---|---|
| Cowork content retention | 90 |
| Code retention | 90 |
| OTel events retention | 30 |
| Adoption analytics retention | 365 |
| Compliance events retention | 365 |
| Chat retention | 90 |
| Error events retention | 90 |
| Alerts retention (resolved and dismissed only) | 90 |

**Strip content (keep metadata)**, the default, replaces prompt text past its period with a fixed marker and keeps the rows, so counts and trends survive. **Full purge (delete rows)** deletes them. Metadata-only records, such as those kept for Claude's replies in Claude Chat, are deleted in both modes.

**Check:** select **Run cleanup now** once; the result line reports rows affected per area.

## Content and AI switches

The features in the table below send people's prompt text, masked for personal data, to Anthropic through your API key, and each has its own switch so that your data protection officer can decide feature by feature; the last switch decides whether Weekly Highlights names people. The companion document [AI Data Flow and Sub-processors](ai-data-flow.md) describes exactly what every feature sends.

| Switch | Where | Default |
|---|---|---|
| Session descriptions (one AI-written sentence per notable Claude Cowork session) | Admin → Work Pulse → Overview | On |
| Human time vs Claude time · Cowork | Admin → Work Pulse → Overview | Off |
| Human time vs Claude time · Code | Admin → Developer Pulse → Overview | Follows the Cowork switch |
| Include first prompt (Code session classifier) | Admin → Developer Pulse → Overview | On |
| Content analysis (use case judging and process suggestions) | Admin → Use Cases | On |
| Include named shout-outs (Weekly Highlights) | Admin → System → Weekly highlights | Off |

Turning off **Content analysis** stops use case judging and suggestions, so use case tracking pauses except for sessions that run a use case's own skill. Turning off **Include first prompt** gives the Code classifier metadata only.

Three further settings shape alerting. **Admin → Risk Scoring → Developer Pulse alert settings → Daily spend limit** sets the Claude Code spend in 24 hours above which a person is alerted ($100 by default; over twice the limit is high priority and goes to Slack when Slack alerts are on). Set it to a figure your organisation would want to hear about for a single person in a day. **Admin → System → General → Acceptable use policy** takes your policy text, which the AI intent assessment and the dashboard briefing take into account and the compliance report sections record as declared. **Admin → Intent Detection** lists the twelve built-in intent categories, each on by default and switchable off, and lets you add your own with plain phrases.

## Work Pulse

Work Pulse shows the depth of work people hand to Claude in Claude Cowork: a judged tier for each prompt, whether that depth is growing and spreading by department, and what capability the organisation has built. The tiers are AI-judged and labelled as such; time and session counts are measured.

1. In **Admin → Work Pulse → Overview → Module settings**, confirm **Pulse enabled** is on, choose the **Classifier model**, **Organisation briefing model** and **Personal briefing model**, set **Human time vs Claude time · Cowork** and **Session descriptions** to your decision, and select **Save**.
2. Review the rubric in **Admin → Work Pulse → Tier config**: the tier definitions, the task type taxonomy and the detection criteria. The page previews the exact instructions the classifier receives. Changes apply from the next classification onward and never rewrite history.
3. Leave **Classifier health** open for the first day. Classifier health shows the queue awaiting classification and any failures, with a control to retry them.

Once a month, use **Admin → Work Pulse → Audit** to start an audit cycle with **Draw sample**: a reproducible sample of classifications for a person to score, giving you a measured agreement rate between the classifier and a human reviewer. When human time is on, the same tab carries the spot-check for human time estimates.

**Check:** within about ten minutes of the first Claude Cowork prompts, **Classifier health** shows classifications completed and none failing.

## Developer Pulse and the GitHub overlay

Developer Pulse measures Claude Code use (spend, engaged time, lines changed, AI-assisted commits and pull requests, edit acceptance) without judgement, and adds one AI-judged layer: a kind of work and a tier for each finished session.

1. In **Admin → Developer Pulse → Overview**, confirm **Session classifier enabled** is on, choose the **Classifier model** and **Briefing model**, set **Human time vs Claude time · Code** and **Include first prompt**, and save.
2. Review the session rubric in **Admin → Developer Pulse → Tiers**. As with Work Pulse, saving applies from now on.
3. Review **Admin → Developer Pulse → Rates** (see the FinOps section) and, after the first day of data, **Data quality**, which lists models with no price and telemetry that arrived without an identity.
4. In **Admin → Developer Pulse → Value**, replace the default calibrations (productivity lift, loaded annual compensation, coding hours per week, and minutes saved per pull request, AI-assisted commit, Claude Cowork session and Claude Chat conversation) with your own figures. Every estimate on the Value view is labelled as such and shown apart from the measured figures beside it.

For the GitHub overlay:

1. In **Admin → Developer Pulse → GitHub overlay → GitHub access**, paste the fine-grained token. Confirm the token carries both **Contents: read** and **Pull requests: read**.
2. Under **Tracked repositories**, add each repository as `owner/repo`, select **Save** (which also stores the token), then **Sync now**.
3. Use **Commit author mapping** to map commit authors whose email does not match their Command Centre email.

The overlay stores daily commit and merged pull request counts per repository and daily commit counts per person, never commit contents, messages or identifiers. It syncs every 12 hours.

**Check:** after **Sync now**, the module status shows a last GitHub sync time, and the Developer Pulse overview shows shipping figures for the tracked repositories.

## Use Cases

Use Cases lets you register the specific pieces of work your organisation cares about and see, from real sessions, who is doing each one, how it is spreading and what it is worth. A model reads each finished session and judges which registered use cases it is doing; it also proposes recurring department processes it finds, and can draft a Claude skill from a confirmed use case.

1. In **Admin → Use Cases → Enable and models**, switch on **Enable Use Cases** and leave the extraction and ideation models at their defaults.
2. Review **Lifecycle**: a use case counts as adopted when active in at least 3 of the last 4 weeks with at least 2 people, at risk after 2 quiet weeks, and not seen after 6.
3. In **Suggestions and judging**, keep **Content analysis** on (judging and suggestions need it), keep the **Session judging model**, and review the commodity skills list and the process suggestion denylist.
4. Review **Skill drafting**. The thresholds (3 people, 10 distinct prompts, 3 separate days, 3 follow-ups; 6 days over 4 weeks for single-owner work) are proposed defaults; revisit them once you have reviewed real drafts.
5. In **Governance value**, set **Minutes saved per matched session** (default 30) and **Annual loaded cost per person** (default 90,000). These drive estimated hours and dollars on the governance view and are labelled as estimates.
6. Select **Save settings**.

Then register your first use cases on the Use Cases page, by guided form, transcript import or the ideation chat. A description is required, because sessions are judged against it: describe a specific recurring job and its output, not a general kind of work.

**Check:** a new use case shows its activity box; matching sessions appear after the hourly judging run once they have been idle for 30 minutes.

## Skills and Connectors Board

The Skills and Connectors Board needs no configuration. The Board discovers the skills and connectors used in Claude Cowork and Claude Code, and the connectors used in Claude Chat, and invites the people who built them to claim and document them. A set of Anthropic's own skills, such as the document skills, is recognised and published automatically. After the first week, encourage the owners of unclaimed entries to claim them; an entry can be installed from the Board only once it is claimed and has an install guide. Administrators and managers can restrict an entry to one department.

## Weekly Digest

The Weekly Digest is a Monday summary of the last completed week, sent by email and Slack. The digest is built from stored weekly figures, and no AI model writes any of it.

1. In **Admin → System → Weekly digest**, switch on **Enable weekly digest**.
2. Set **Send hour (UTC)** (default 07:00; the digest is sent only on Mondays at or after this hour), **Hub URL** (`https://<your-hub-hostname>`), **Recipients (email)** as a comma-separated list, and the digest's **Slack webhook URL**.
3. Select **Save settings**.

**Check:** **Preview digest** opens the rendered digest, and **Send test now** reports the result for email and Slack separately. Before the first completed week, the preview and the test use sample data and say so.

## Weekly Highlights

Weekly Highlights drafts a short "what the week produced" post from last week's work for a person to edit, then copy or send; it is never scheduled or sent unreviewed. A model writes the sentences and every number is inserted from measured data. In **Admin → System → Weekly highlights**, switch on **Enable weekly highlights**, enter the **Model** (or leave it blank for the default) and decide on **Include named shout-outs**. Sending uses the Weekly Digest's Slack webhook.

**Check:** generate a draft after the first completed week; it refuses, with an explanation, when the week has no qualifying work.

## High-priority alerts to Slack

Every high or critical alert, from any source, can be posted to a dedicated Slack channel within the hour. Alert titles and explanations may name the person concerned, so choose a channel whose membership matches who may see that.

1. In **Admin → Risk Scoring → High-priority alerts → Slack**, paste the alerts webhook into **Slack webhook URL** and save.
2. Select **Send test** and confirm the message arrives.
3. Switch on **Enable high-priority Slack alerts** and save.

Only alerts raised after you switch on are posted. On the same page, review **Detection sensitivity**, **Threshold configuration**, **Alert types**, **Developer Pulse alert settings** and **Severity calibration**.

## System health and telemetry-silence alerts

The **System health** card in **Admin → System** shows each scheduled job's last result, when each telemetry stream last arrived, recent ingest failures and the state of each integration.

1. Switch on **Raise alerts for system health problems**. When on, a failing job, a rejected key, stalled retention or a quiet telemetry stream raises an alert (a scheduled job that fails twice in a row, a key rejected on its last use, a credential that cannot be decrypted, retention that has not succeeded in 26 hours, or telemetry silence), which also goes to Slack when high-priority Slack alerts are on.
2. Under **Telemetry received**, set **Working hours** of silence before an alert (default 3; 0 turns it off), **Working day** (default `08-18`) and **Time zone** (default `Europe/London`) to match your organisation, and select **Save**. Only Monday to Friday inside the working day counts.

**Check:** every job reads succeeded or not yet run, and the telemetry rows show recent arrivals once clients are connected.

## Metrics Connector

The Metrics Connector gives BI tools and Claude or MCP clients read-only, organisation-level figures through a REST export and an MCP endpoint. The Metrics Connector never returns per-person data. It is not yet tested with a real BI tool.

1. In **Admin → System → Metrics connector**, type a **New token name** and select **Mint token**.
2. Copy the token immediately; it is shown once and stored only as a hash.
3. Give the client the endpoints listed on the card (MCP, and the summary, trends and health exports) and the token as a bearer token.

**Check:** the token's **Last used** time updates after the client's first call. Revoke tokens you no longer need from the same table.

## Reports

Reports are generated on demand from the Reports page by choosing a period and sections. Sections carrying figures are built in code and inserted exactly; narrative sections are written by the Core AI model. The FinOps and Spend Review sections need FinOps on and are limited to administrators and managers. Set **Organisation name** in **Admin → System → General**, because reports use it, and record your declarations on **Admin → Compliance** so that the compliance sections reflect them.
