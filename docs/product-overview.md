# Frontier Command Centre: Product Overview

This document describes what Frontier Command Centre is, the question it answers and what each part of the product does. [Security and Data Protection](security-and-data-protection.md) and [AI Data Flow and Sub-processors](ai-data-flow.md) cover how it handles data; [Running in Azure or AWS](running-in-azure-or-aws.md) covers running it in the cloud.

**Contents:** [What Command Centre is](#what-command-centre-is) · [At a glance](#at-a-glance) · [The problem it answers](#the-problem-it-answers) · [What it observes](#what-it-observes) · [How Command Centre measures productivity](#how-command-centre-measures-productivity) · [The dashboard](#the-dashboard) · [Work Pulse](#work-pulse) · [Developer Pulse](#developer-pulse) · [Use Cases](#use-cases) · [Skills and Connectors Board](#skills-and-connectors-board) · [FinOps](#finops) · [Governance and risk](#governance-and-risk) · [Reporting and outputs](#reporting-and-outputs) · [Administration](#administration) · [What Command Centre does not do](#what-command-centre-does-not-do)

## What Command Centre is

Command Centre is a self-hosted web application that receives activity from your organisation's use of Claude and ChatGPT, analyses it and shows whether teams are becoming more productive with it. Command Centre runs on infrastructure you control: a single machine with Docker Compose, or your own servers or cloud. Its inputs are the telemetry that Claude Code, Claude Cowork and Claude in Office and Google apps already send, and the conversation exports Anthropic and OpenAI provide through their Compliance APIs: Claude Chat for Claude for Enterprise customers, and ChatGPT and Codex for ChatGPT Enterprise and Edu workspaces.

The object of measurement is the work people hand to AI. Command Centre answers four questions for every employee and department:

- Is each employee and department producing more valuable work with the same time?
- Is each employee and department using AI for simple tasks, or fundamentally changing how work gets done?
- How many new types of work has each employee and department handed to AI?
- Would this capability survive if the best AI person in the department left tomorrow?

Anthropic's and OpenAI's administration consoles already report who uses their products and how often. Command Centre tells leaders whether the investment is changing the work, where it is changing fastest, where capability is fragile and where the next gains lie. Governance and security controls sit underneath that view. They are a substantial part of the product and a secondary benefit: they allow an organisation to leave the telemetry switched on with confidence.

## At a glance

This section lists the parts of Command Centre in the order of the app's menu. All screenshots show sample data from Acme Corp, a fictional company.

**Dashboard**

Command Centre opens on the dashboard. An AI briefing explains what changed this week and what to do next, with recommendations and an organisation risk score beside it. Below are activity over the last 14 days, how it splits across Chat, Work and Code, each department's activity, and the five most active people. Chat is Claude Chat and ChatGPT Chat, Work is Claude Cowork and ChatGPT Work, and Code is Claude Code and Codex. Once ChatGPT or Codex data arrives, a switch above the dashboard shows All, Claude or ChatGPT, the same wording as in Work Pulse and Developer Pulse. Here the ChatGPT view covers ChatGPT and Codex, and in the All view each box shows its Claude figure and its own OpenAI product's under the total: ChatGPT for Chat and Work, Codex for Code, and ChatGPT and Codex for active users. On a new installation, its Get started panel walks you through setup.

![The dashboard: an AI briefing, the organisation risk score and AI recommendations](images/dashboard.png)

![The dashboard: activity over 14 days by product, product stickiness, department activity and top users](images/dashboard-activity.png)

![The Get started panel on a new installation, with the setup steps ticked off as they are done](images/get-started.png)

*Sample data from Acme Corp, a fictional company.*

**Alerts**

Command Centre flags personal data, secrets, risky intent, anomalies, spend thresholds, unapproved models and sensitive repository activity, each with the evidence behind it.

![Alerts: risky intent, personal data and use cases at risk, each with its evidence](images/alerts.png)

*Sample data from Acme Corp, a fictional company.*

### Productivity

**Work Pulse**

Work Pulse shows how deeply your people hand work to AI, from routine tasks to multi-step work and whole processes. Work Pulse grades everyday work in Claude and ChatGPT (Claude Chat, Claude Cowork, Claude in Office/Google, ChatGPT Chat and ChatGPT Work) against three tiers you can edit, follows each person's progress, compares departments, and shows whether deeper capability is spreading or sitting with a few people.

Work Pulse also surfaces new kinds of work, standout individual contributions and outputs such as documents and files. Managers see where to coach; leaders see whether their investment is changing how work gets done. Every grade is labelled as an AI judgement, and an administrator can sample grades for human review.

![Work Pulse: how deeply people hand work to AI, and how each product compares, from Claude Chat and Cowork to Claude in Office, Claude in Google and ChatGPT](images/work-pulse.png)

![Work Pulse: top skills and connectors, sessions that produced a file, and the work mix](images/work-pulse-signals.png)

*Sample data from Acme Corp, a fictional company.*

**Developer Pulse**

Developer Pulse shows how Claude Code and Codex are changing engineering activity: the kind of work, autonomy measured as actions per developer instruction, AI-assisted commits checked against GitHub, spend, and how much of the work came from the prompt cache. Claude Code's own telemetry adds engaged time, code and accepted edits, and the cost per commit and per pull request.

Dev Framework Alignment, switched off by default, is an example of how Developer Pulse's engineering indicators could be organised using DORA, SPACE and DX Core 4 concepts, with measured values, proxies and AI-specific indicators distinguished. It has not been fully tested, and its getDX figures are demo data: a live getDX integration is not yet available.

![Developer Pulse: engaged time, code output, shipping, edit acceptance and cost](images/developer-pulse.png)

![Developer Pulse: shipping alignment with GitHub, per-repository activity, work mix and model mix](images/developer-pulse-shipping.png)

*Sample data from Acme Corp, a fictional company.*

**Use Cases**

Command Centre discovers use cases from real activity, groups related sessions and tracks how processes are adopted across departments. Strategic use cases have owners, status and alerts when activity declines, with estimates of value clearly identified.

When colleagues repeatedly perform the same process, Command Centre can draft it as a reusable Claude skill for an owner to review and publish. Command Centre then tracks uptake and identifies people doing similar work who could benefit from the shared skill. In the sample data, a month-end commentary process repeated by Finance colleagues is ready to draft as a skill and share.

![A department process opportunity, drafted from what Command Centre observed](images/use-cases-process-opportunity.png)

![Suggested use cases across departments, and the register of confirmed use cases](images/use-cases-register.png)

![A use case: time in the workflow, its AI footprint and who is doing the work](images/use-case-detail.png)

![Turn this into a skill: the evidence a skill draft is built from](images/turn-into-a-skill.png)

*Sample data from Acme Corp, a fictional company.*

**S&C Board**

The Skills and Connectors Board discovers capabilities already being used, including those hidden in individual accounts. The Board shows each entry's owner, installation guidance, usage, adoption trend and the use cases it supports, so organisations can build on what their people have already created.

![The Skills and Connectors Board: tools in use, their owners and their usage](images/skills-and-connectors-board.png)

*Sample data from Acme Corp, a fictional company.*

### Spend

**FinOps**

FinOps attributes AI spend across Claude and OpenAI to people, departments and cost centres, down to models, activities, prompts, skills and subagents. FinOps shows caching savings, unallocated costs and opportunities to use a more appropriate model or an existing skill or connector.

![FinOps: the Claude in Office and Google estimate app by app, beside model efficiency by kind of work](images/finops.png)

*Sample data from Acme Corp, a fictional company.*

**Spend Review**

Spend Review shows what each person's AI spend goes on, whether it produced anything, and how colleagues do the same kind of work, with cheaper routes where they exist. Savings are labelled as estimates based on list prices.

![Spend Review: who spends what, who is most efficient, and who has a better route](images/spend-review.png)

![Spend Review for one person: spend by kind of work and model, against colleagues](images/spend-review-person.png)

![Where the money goes: models used for each kind of work, with a suggested better route](images/spend-review-where-money-goes.png)

*Sample data from Acme Corp, a fictional company.*

### Governance

**Audit Log**

Command Centre brings supported Claude, ChatGPT and Codex activity into a searchable audit trail, with role-based access to prompt content and logging of who reads it. Retention, erasure, departmental access, single sign-on and encrypted stored secrets support organisational controls.

**Operational boundary:** Command Centre sees activity only after prompts reach Claude, ChatGPT or Codex, so Command Centre cannot block or change a prompt. Command Centre stores people's prompts, never the replies of Claude, ChatGPT or Codex.

![The Audit Log filtered to Claude in Google, each prompt labelled with its app](images/audit-log.png)

![The Audit Log filtered to flagged prompts, with their severity](images/audit-log-flagged.png)

![A flagged prompt opened in the Audit Log, with the reason and the conversation it came from](images/audit-log-conversation.png)

*Sample data from Acme Corp, a fictional company.*

**Reports**

Command Centre produces individual, departmental and executive briefings that explain what changed and what to do next. Weekly digests, Slack highlights, configurable reports and an MCP Metrics Connector make findings available beyond the dashboard, including organisation-level figures for BI tools (the Metrics Connector is not yet tested with a real BI tool). Reports provide evidence relevant to GDPR, the EU AI Act, ISO 27001 and ISO 42001; they do not certify compliance.

The system checks numerical statements in AI-written briefings against supplied facts and withholds claims it cannot substantiate. Briefings and reports point to the decisions they support: where to coach, which use cases to invest in, which skills to share and where to cut cost.

**Admin**

Admin holds Command Centre's settings: users and roles, integration keys, alert thresholds, intent categories, grading rubrics and models, cost centres, compliance declarations, retention and system health. The Claude Sub Agents page lists every subagent people run in Claude Code and Claude Cowork, who runs it and what it costs. Anthropic's Compliance API integration for Claude Chat needs Claude for Enterprise, and OpenAI's for ChatGPT and Codex needs ChatGPT Enterprise or Edu; the Admin and Analytics API integrations are on the roadmap. Measured data, AI judgements and estimates are identified separately, and unavailable measurements are not presented as zero.

![Admin: Claude Sub Agents, showing every subagent in use, who runs it and what it costs](images/admin-claude-sub-agents.png)

*Sample data from Acme Corp, a fictional company.*

Explore Command Centre with sample data, connect Claude, ChatGPT and Codex, inspect the code and extend Command Centre for your organisation.

## The problem it answers

A count of licences and active people does not show whether the work has changed. Volume says little: a thousand requests to reformat text produce less than a handful of sessions in which AI assembles a month-end pack from three systems. Command Centre therefore grades the work itself, follows how its depth moves for each person and department, detects new kinds of work as they appear, ties recurring processes to the sessions that carry them out, and sets spend beside what it produced.

## What it observes

| Surface | What it is | How Command Centre receives it |
|---|---|---|
| Claude Code | Claude working in a terminal or IDE, including Claude Code inside Claude Desktop | OpenTelemetry logs and metrics, pushed from each client |
| Claude Cowork | Claude Desktop's agent mode, working across files, connectors and skills | OpenTelemetry logs, pushed from each client |
| Claude in Office/Google | Claude in Excel, Word, PowerPoint, Outlook and Google Sheets, Docs and Slides | OpenTelemetry traces, pushed from each person's browser |
| Claude Chat | Conversations in the Claude apps | Anthropic Compliance API, pulled by Command Centre (Claude for Enterprise) |
| ChatGPT Chat and ChatGPT Work | ChatGPT conversations; OpenAI's Compliance API marks those in work mode as ChatGPT Work | OpenAI's Compliance API, pulled by Command Centre (ChatGPT Enterprise or Edu) |
| Codex | OpenAI's coding agent, in the same ChatGPT workspace | OpenAI's Compliance API, pulled by Command Centre (ChatGPT Enterprise or Edu) |

Claude Code, Claude Cowork and Claude in Office/Google, given the collector's address and bearer token through their telemetry settings, push OpenTelemetry records to an OpenTelemetry Collector you run, which batches them and forwards them to the Command Centre Hub. Nothing is installed on user machines beyond Claude's own apps. For Claude Chat, the Hub calls Anthropic's Compliance API on a schedule with your organisation's Compliance Access Key and reads conversations incrementally. For ChatGPT and Codex, the Hub reads OpenAI's Compliance API files on a schedule with your OpenAI Admin API key; [Connect ChatGPT and Codex](configure-command-centre.md#connect-chatgpt-and-codex) explains the setup. The Hub and the collector run as containers, with PostgreSQL holding the stored data; the collector keeps telemetry awaiting delivery in a disk queue, and an optional archive writes records due for removal to an Amazon S3 bucket you name. With Docker Compose, the collector reaches the Hub over the private Docker network; before connecting other people's machines, serve the collector and the Hub over HTTPS through a reverse proxy or load balancer you add. [Running in Azure or AWS](running-in-azure-or-aws.md) shows one way to run it in the cloud.

![High-level data flow](diagrams/High-level%20data%20flow.png)

*Figure 1. How data reaches Command Centre. Command Centre sits outside the path between people and Claude, ChatGPT or Codex.*

## How Command Centre measures productivity

### Depth of delegation

The foundation is a three-tier grading of delegated work. A Claude model grades every everyday-work prompt (Claude Chat, Claude Cowork, Claude in Office/Google, ChatGPT Chat and ChatGPT Work) against a written rubric, and a separate classifier grades every finished coding session in Claude Code or Codex against its own rubric. An administrator can stop ChatGPT prompts or Codex sessions being graded. Administrators can edit both rubrics, including tier names, descriptions and the list of kinds of work; edits apply to work graded afterwards.

| Tier | Work Pulse default | Developer Pulse default |
|---|---|---|
| Tier 1 | Administrative: single-step, low consequence, such as formatting, summarising or basic drafting, reviewed in full by the person | Single-step or conversational: explanations, lookups, one-shot edits steered at every step |
| Tier 2 | Meaningful: multi-step work needing judgement, such as synthesis, structured reports or analysis, or work using an external connector or specialised skill | Delegated work: a defined task carried out across several tool actions |
| Tier 3 | Frontier: work that coordinates several systems, runs with real autonomy or replaces output that once needed an outside specialist | Frontier delegation: long sessions in which Claude Code or Codex orchestrates substantial work and the person supervises outcomes |

The tiers measure how much a person trusts AI with, which frequency of use cannot show. Each graded item also carries a kind of work: for everyday work, labels such as analysis, synthesis, structured report or autonomous workflow; for coding, feature, bug fix, refactor, testing, documentation, infrastructure, exploration or other. Connector and skill use counts as evidence for a tier and never as a kind of work.

### The four signals

Four signals sit on top of the grades, each presented as a plain question with a plain status beside the number.

| Signal | Question | How it is computed |
|---|---|---|
| Delegation depth | Is the team using AI for simple tasks, or fundamentally changing how work gets done? | Weighted average tier of graded Work Pulse work over the last 14 days, from 1 to 3 |
| Output quality | Is the team producing more valuable work with the same time? | A person's last seven days against a frozen baseline of their own first 30 graded tasks, using the median of each active day's weighted output; a self-comparison |
| Capabilities created | How many new types of work has the team handed to AI? | The count of confirmed capability-creation events |
| Resilience | Would this capability survive if the best AI person on the team left tomorrow? | A score from 0 to 1 over the last 30 days, combining the share of active people doing Tier 2 or 3 work, shared use of connectors on serious work, and skills used by more than one person |

Resilience can be low while many people are active, if what they learn is not shared.

### Measured, AI-judged and estimated

Command Centre keeps three kinds of figure apart and labels each wherever it appears.

- **Measured** figures come directly from telemetry: sessions, active time, spend, lines of code, commits, pull requests, connector and skill use, files produced.
- **AI-judged** figures come from a Claude model reading the work: tiers, kinds of work, which use case a session belongs to, session descriptions and suggested processes.
- **Estimates** apply a stated assumption to a measured or judged count: hours a task would take by hand, value recovered by a use case, return on Claude Code spend.

An unmeasured value is shown as "not measured" or a dash, never as zero, and a model with no known price is shown as unpriced. Every briefing a model writes is checked so that each number in it appears in the facts it was given. A sentence that fails the check is removed; a briefing that cannot be repaired is withheld, and the previous one, where there is one, stays in place.

## The dashboard

The dashboard is the landing page for administrators, managers and viewers. The dashboard carries an Intelligence Briefing written by Claude and labelled as an AI summary, open alerts, activity on each surface, the Work Pulse and Developer Pulse headline bands and a department breakdown.

## Work Pulse

Work Pulse is the productivity view of everyday work in Claude and ChatGPT, with an executive view, a department view, a list of people, a personal view ("My Pulse") and a view of skills and connectors in use.

The executive view opens with five headline figures: people using AI for work each week, the share of work at Tier 2 or 3, output against baseline, delegation depth, and concentration (the share of the last 14 days' Tier 3 work carried by the three people who did the most of it). Beneath them sit the four signals, a department table and a "what to act on next" panel listing suggested department processes and coaching opportunities and, for administrators and managers when Model Efficiency is on, kinds of work where a cheaper model merits review.

Once ChatGPT data arrives, a switch reading All, Claude or ChatGPT appears on the executive view, the department view, My Pulse, the Users page and the per-person view. It is the dashboard's switch, with the same wording, and the choice carries across the dashboard and these views. In the All view each headline figure shows its Claude and ChatGPT parts, each kind of work in Work Mix shows its split, and skills and connectors carry a tag naming the product they came from; choosing Claude or ChatGPT narrows the headline figures, signals, charts, skills and connectors and Work Mix to that product's work; department process opportunities and model review are not narrowed by the switch, though each opportunity says how many of its sessions came from each product. The spend figure on the executive view, the department view and My Pulse shows Claude Cowork's spend, measured from its telemetry, and ChatGPT's spend: the tokens in OpenAI's hourly cost records, a few hours behind, priced at OpenAI's published USD rates for token-based Enterprise contracts; a cost record that carries only token totals is valued at OpenAI's own figure. The All view shows their total with each part beneath it, and each vendor view shows its own. As Claude is priced at Anthropic's list rates whatever the plan, ChatGPT is priced at these list rates whether the customer's contract is token-based or credit-based; seat fees, discounts and extra charges such as web search and voice are not included. Claude Chat carries no spend. The Produced a file card (Session Output Rate) comes from Claude's telemetry. OpenAI's Compliance API does not record whether a conversation produced a file, so the card is hidden in the ChatGPT view, and once ChatGPT is connected it says its figure covers Claude sessions. Human time covers ChatGPT conversations (see below). An administrator can stop ChatGPT prompts being graded under **Admin → Work Pulse**.

### By product

The By product panel, under the headline figures, compares each product over the last 30 days: Claude Chat, Claude Cowork, Claude in Excel, Word, PowerPoint and Outlook, Claude in Google Sheets, Docs and Slides, and ChatGPT (ChatGPT Chat and Work together, because OpenAI reports their spend as one figure), whose row appears once OpenAI is connected. Each row shows app users, sessions, the share of work at Tier 2 or 3, the share of sessions that produced something, and spend. Claude Cowork's spend is the cost Claude reports. Claude in Office/Google sends no cost, so its spend is priced from the model rates and marked as an estimate. ChatGPT's spend is priced from OpenAI's token counts at the rate table, as on FinOps; a cost record that carries only token totals is valued at OpenAI's own figure. Claude Chat's spend and the share of ChatGPT and Claude Chat sessions that produced something are not measured. The panel follows the All, Claude or ChatGPT switch, and the All products row adds up the rows shown; its spend is marked as an estimate once Office or Google spend is part of it. An app's shares show once it has five judged prompts or five sessions, so one prompt never reads as 0% or 100%. Every Office and Google app is listed from the start, at zero until its activity arrives. An administrator can hide the Office and Google rows under **Admin → Work Pulse → Show Claude in Office and Google**.

### Work Mix and Session Output Rate

Work Mix shows the kinds of work the tiers were spent on over 30 days, and is labelled as AI-judged. Session Output Rate, the Produced a file card, is its measured counterpart: the share of Claude Cowork and Claude in Office/Google sessions that produced something, meaning Claude successfully wrote a file, sent a file to the user or created an artifact. Edits to existing files do not count. The rate covers the last 13 completed weeks and breaks down by kind of work, omitting any kind with fewer than five sessions.

### Delegation View

The Delegation View charts the weekly tier mix over 13, 26 or 52 weeks for the organisation and each department, and compares the first weeks of the period with the latest for each department and each person within it. A person's week appears only when it holds enough graded work to mean something.

### Best work, deep work and capability creation

The person and department pages describe frontier work by what was done. The top panel shows the best work of the last seven days: for a person, their deepest session, ranked by tier, new capability, steps and active time; for a department, how many people did Tier 3 work and the three strongest sessions, one per person. The person page also shows their main kind of Tier 3 work over 30 days.

Each of these sessions can carry a one-sentence description written by Claude from the session's prompts, with personal data masked on the way in and scrubbed from the reply, and the names of files the session produced. Descriptions and file names are shown to administrators and managers for everyone and to each person for their own work. Everyone else sees counts, and the withheld text never reaches their browser. Administrators can switch descriptions off, which also hides existing ones.

When the classifier judges a piece of work to be new to the organisation, it raises a capability candidate. Each person can confirm or dismiss their own candidates, and administrators can review all of them. A reviewer may record an estimated value (external spend replaced, cost avoided or time reclaimed), which must carry a stated basis and is labelled as an estimate. Confirmed capabilities feed the capabilities-created signal.

### Human time and AI time

For Tier 2 and Tier 3 sessions of everyday work, in Claude and ChatGPT, Command Centre sets an AI estimate of how long the same result would take by hand beside the measured time the AI spent. The estimate is a low, likely and high range, made from the session's masked prompts and the names of any files it produced, and framed in the person's departmental role. AI time is measured active time: the sum of gaps of up to 30 minutes between a session's events, which for ChatGPT are the times of its prompts and replies, since OpenAI's Compliance API records no other timings. Only sessions carrying both figures are counted, and the ratio appears once at least 20 such sessions exist. The card reads By hand vs with AI, with Claude Cowork's and ChatGPT's parts beneath, and follows the Claude / ChatGPT switch. Figures for individuals are shown only to administrators, managers and the person concerned. An administrator can spot-check a monthly sample of estimates, Claude Cowork and ChatGPT alike, each labelled with its product, and record the result. The weekly digest, Highlights, Reports and the Metrics Connector carry the same totals, including ChatGPT and Codex while they are shown. The same comparison is available for Claude Code and Codex sessions. Both ship switched off: an administrator turns them on under **Admin → Work Pulse** and **Admin → Developer Pulse**.

### Briefings

Each person has a weekly briefing on their own work, administrators and managers can generate a briefing for each department on its page, and the executive view carries a monthly organisation briefing. All are written by Claude from figures computed in code and pass the number check; organisation-level briefings are written from figures that carry no names. Each briefing compares Claude and ChatGPT work when both were used in the period, and the executive and department briefings also say how the work split between Claude Cowork and the Office and Google apps when those were used.

## Developer Pulse

Developer Pulse is the productivity view of coding with Claude Code and Codex: an overview, a personal view ("My Developer Pulse"), a list of people, a department view and a value estimate. Developer Pulse's figures are measured, with one AI-judged layer.

The productivity strip shows four measured figures for the last seven days: engaged time (active, AI-assisted engineering time), code output (lines added and removed), shipping (AI-assisted commits from Claude Code and Codex, and Claude Code's pull requests) and edit acceptance (proposed edits accepted against rejected). Around these sit:

- **Spend**, priced from a model rate table that administrators maintain. Claude Code through Amazon Bedrock or Google Vertex AI is priced at Anthropic's list rate and labelled as an estimate.
- **Autonomy**, the number of tool actions Claude takes per human prompt.
- **Model mix and cache use**, showing which models carried the work and how much came from the prompt cache.
- **Skills and subagents** in use, and the programming-language mix of Claude's edits.

Once Codex data arrives, a switch reading All, Claude or ChatGPT appears on the overview, My Developer Pulse, the list of people and the department view; it is the dashboard's switch, with the same wording, and the choice carries across them. In the All view each headline figure shows its Claude Code and Codex parts, and Work Mix shows each kind of work's split; choosing Claude narrows the figures to Claude Code, and choosing ChatGPT narrows them to Codex, which the page names. Codex's spend is priced from the same rate table, which has OpenAI's published USD rates for token-based Enterprise contracts built in; a model the export names differently is listed as unpriced, never counted as zero, until an administrator adds its rate. Codex's actions, failed actions and commits come from its log, counted and never stored as commands. Engaged time, code output, pull requests, edit acceptance, languages, and spend by skill and subagent come from Claude Code's own telemetry, which Codex does not send, so they show Claude Code only and are not shown for Codex. The value estimate counts Codex spend, commits and people beside Claude Code's, and Dev Framework Alignment has the same switch, with the indicators Codex never reports marked as not captured. Data Quality shows when the last Codex record arrived.

### Work Mix and tiers

The session classifier grades each Claude Code and Codex session once it has been idle for 30 minutes, assigning a kind of work and a tier from a short digest of the session; a session still running after two hours receives a provisional grade that is replaced when it ends. This drives the AI-judged Work Mix card and the tier progression on each person's page. An administrator can stop Codex sessions being graded by switching off **Classify Codex sessions** under **Admin → Developer Pulse**. A Classifier Health tab shows the classifier's queue, confidence and failures, and, once Codex sessions exist, classified and failed sessions for each tool.

### GitHub overlay

The GitHub overlay, connected with a read-only GitHub token, adds daily commit and pull request counts for repositories an administrator selects, and attributes commits to people by matching commit author emails to Command Centre users, with an administrator's identity map for exceptions. The GitHub overlay sets the commits Claude Code and Codex recorded beside the commits and pull requests GitHub shows shipped, with a card per repository. Each GitHub commit is matched to the tool that made it: it counts as made with Claude Code or Codex when its author email belongs to a Command Centre person and that person's Claude Code or Codex activity recorded a commit within 15 minutes of it; anything else counts as no AI tool recorded. On the Claude and Codex views the chart compares each tool with its own GitHub commits, and on the All view GitHub's commits are stacked by tool. Each person's repository count, and the codebase reach on the Codex view, follow the same matching, because Codex does not report which repository it worked in. The overlay never reads commit messages and stores daily counts only, never commit identifiers.

### Value estimate and alerts

The Value page estimates the return on Claude Code and Codex: team size multiplied by an assumed productivity lift and a loaded annual cost per engineer, set against annual spend. Team size and spend default to measured values; the lift and cost assumptions carry defaults that an administrator can change, and are stated on the page beside the measured figures. The Observed signal beside it compares Claude Code's engaged time with its commits, so it stays Claude Code only, because Codex reports no engaged time.

Developer Pulse also raises deterministic alerts. A spend alert fires when a person's Claude Code spend in the last 24 hours is over a daily limit an administrator sets ($100 by default), whatever they usually spend; over twice the limit it is high priority. If the same person passes twice the limit within 24 hours of a lower-priority alert, a high-priority alert follows. The alert states the 24-hour window and the person's spend for the calendar month so far, the period Spend Review shows. Codex has its own daily limit ($500 by default), and over twice that limit its alert is high priority too. Another alert flags use of models outside an administrator-defined allowed list, in Claude Code or Codex, and a high-friction alert flags sessions in either tool where a large share of actions failed. The sensitive-repository alert covers Claude Code only, because Codex does not report which repository it worked in.

## Use Cases

Use Cases connects the productivity view to the work an organisation cares about. A use case is a named, recurring piece of work, such as a weekly margin update or month-end variance commentary, with a description, an owner, departments and surfaces. Use Cases ships switched off; an administrator turns it on under **Admin → Use Cases**.

### The register

Administrators and managers maintain the register. A use case can be entered through a guided form, extracted from an uploaded meeting transcript (text, subtitle, PDF or Word files), developed in a brainstorming conversation with Claude grounded in the organisation's own activity, or adopted from a suggestion. Each has a status set by people (candidate, confirmed or archived) and a lifecycle derived from activity, and each row shows how many of its matched sessions in the last 13 completed weeks ran in Claude and how many in OpenAI's ChatGPT or Codex.

| Lifecycle | Meaning with default settings |
|---|---|
| Not seen | No matching work observed, or none for six weeks |
| Piloting | Matching work observed, below the adopted threshold |
| Adopted | Active in at least three of the last four weeks, by at least two people |
| At risk | Previously active, quiet for two to five weeks; an alert is raised |

A use case can be marked as a strategic bet, which places it in the governance view.

### How sessions are matched to use cases

Command Centre decides who is doing a use case by reading the work. Once a session in Claude Cowork, ChatGPT, Claude Code or Codex has been idle for 30 minutes, a Claude model reads up to six of its prompts, drawn from the beginning, middle and end and cleaned to the person's own words, with clues such as skills and connectors used and the names of files uploaded and produced. Given the live use cases for the person's department, it decides whether the session is an instance of none, one or several, and records a short reason. The model judges by subject and output, matches the specific job rather than its general area, and treats tools as clues that are never sufficient alone. A session that runs a use case's own published skill matches without a model call. Adding or rewording a use case re-judges up to 13 weeks of history. Matching is most precise when a use case's description names a specific job and its output.

ChatGPT conversations count as Work and Codex sessions as Code, so a use case scoped to Work takes in Claude Cowork and ChatGPT, and one scoped to Code takes in Claude Code and Codex.

### Suggested department processes

Command Centre reads each department's recent prompts in every connected product, everyday work and coding separately, with personal data masked, and suggests specific recurring jobs that produce a named output and that at least two people carry out. General activities, personal development and one-off projects are excluded. Each suggestion arrives as a drafted canvas (the process, its rhythm, people, sessions, systems, measured hours and tier mix) with every count taken from telemetry. A second pass lists jobs carried out across several departments. Each list names the products its work came from, each suggestion says how many of its sessions came from each product, and a reviewer adds or dismisses each suggestion.

### Spread and coaching

For a confirmed use case with its own published skill, the Spread panel lists people who have done the work in at least two judged sessions over the last four completed weeks without using the skill. The department page turns the strongest into up to three coaching prompts for the manager, each naming the person, the use case and the evidence. A manager can mark a conversation done, which clears it everywhere. The weekly digest carries only counts per department. Spread suggests a skill only to people doing the work in Claude, because the skill is a Claude skill.

### Workflow Impact and the governance view

Each use case has a drill-in showing, over 13 completed weeks, measured hours on its matched sessions beside an estimate of hours saved (matched sessions multiplied by an administrator-set number of minutes saved per session), the skills, connectors and models it relies on in each product, each product's sessions and measured hours on their own line, and the tier mix. An administrator or manager can request a short Claude summary of these facts, checked against them before it is stored.

The governance view is a read-only page for administrators, managers and viewers. The governance view shows lifecycle counts, the strategic bets grouped by lifecycle with a 13-week activity line, measured hours and estimated hours saved for each, with sessions and measured hours split between Claude and OpenAI, an aggregate estimate of hours and value saved with its assumptions stated, and every other confirmed use case ranked by measured hours, with its sessions by vendor. A week without measurement appears as a gap.

### Turning a use case into a skill

A confirmed use case with enough evidence can be turned into an Agent Skill, the reusable instruction package Claude loads when a matching request arrives. Command Centre reads the prompts matched to the use case and asks Claude to draft a skill in the standard format: a name, a description telling Claude when to use it, and sections from purpose and steps through quality rules and edge cases, with questions for the owner. Drafting is available once the evidence clears a readiness bar (by default three people, ten distinct prompts, three separate days and three follow-up prompts, with a separate bar for work one person does over at least four weeks).

Every draft is checked before it is shown: no number absent from the prompts, no system that was not observed and no detectable personal data, and any long passage copied from a prompt is flagged for the owner to reword. An administrator or manager edits the draft and downloads it, and an owner of your Claude organisation uploads it under Plugins and skills in Claude's organisation settings, which provisions it for the organisation. On first download Command Centre adds the skill to the use case, so sessions using it match automatically, and creates a claimed entry on the Skills and Connectors Board.

## Skills and Connectors Board

The Board catalogues the skills and connectors in use across the organisation and is open to every signed-in person. Every skill and connector seen in any connected product is registered automatically, from Claude Cowork, Claude Code and Claude Chat to ChatGPT's skills and Codex's connectors, and each entry is tagged with the products it is used in: Claude, ChatGPT or Codex. Anthropic skills and connectors that Command Centre recognises are labelled as Anthropic's; other entries start unclaimed, including OpenAI's built-in skills, whose names OpenAI does not document. The person who built an entry can claim it and add a description, installation guidance and a source link, and administrators or managers can restrict an entry to one department. An entry offers installation only once it is claimed and carries guidance.

Each entry shows usage, the number of people using it, its trend, whether people invoke it or Claude chains it, upvotes and the use cases that depend on it. Unclaimed entries with wide use point to tooling that nobody owns.

## FinOps

FinOps is available to administrators and managers. FinOps ships switched off, as does its Model Efficiency view; an administrator turns both on under **Admin → System**. FinOps attributes Claude Code, Claude Cowork, ChatGPT and Codex spend to people and rolls it up by cost centre for each calendar month, with a Claude / OpenAI split. Claude in Office/Google spend is shown beside it in its own panel, app by app, as an estimate priced from the model rates, because Claude in Office/Google sends no cost; it is never part of the chargeback total, a closed month's snapshot or the CSV export. Developer Pulse carries its own Claude Code and Codex spend figures, and its department view lists each member's spend for the last seven days to the roles that can open that department.

### Chargeback and period close

Each department is a cost centre by default. Administrators can create named cost centres with general-ledger codes and group departments under them. Spend from people with no department, or that cannot be attributed, appears in an "Unallocated" line, and the total always equals the centres plus that line. The page adds spend by surface, a 12-month trend and a spend-concentration chart, both split by product (Claude Code, Claude Cowork, ChatGPT and Codex), a month-end projection with its Claude and OpenAI parts, top spenders and a plain-language summary of the month built in code from those figures. A Model Efficiency view flags kinds of work where a cheaper model merits review, and where seat count and price are recorded, the page estimates the cost of unused seats.

List-rate spend, such as Claude Code through Amazon Bedrock, is labelled "estimated, for visibility, not billing".

**How ChatGPT and Codex spend is priced.** ChatGPT (Chat and Work) and Codex are priced from tokens at OpenAI's published USD rates for token-based Enterprise contracts, the same figures Work Pulse and Developer Pulse show. On plans where OpenAI's cost records carry only token totals, which cannot be split into input and output, those records are valued at the dollar figure OpenAI reports in them; one with no dollar figure either is named as not priced, never counted as $0. The page names each product and says how the OpenAI figures are priced: a credit-based contract, negotiated discounts and seat fees are not reflected. ChatGPT or Codex models with no rate are named and left out, never counted as $0; an administrator adds their rates under **Admin → Developer Pulse → Rates**. Where an administrator records ChatGPT seats and a seat price under **Admin → System**, the licence cost appears on its own line, never added to usage, with how many seats were used in the last 30 days. Claude's own seat count leaves out ChatGPT and Codex users. Model Efficiency gains ChatGPT and Codex tabs: spend by kind of work and model, cost drivers and review flags that only name a cheaper model the same work already uses, so a flag never crosses vendors; ChatGPT's split by kind of work is an estimate, because OpenAI reports cost per hour. The prompt-caching estimate includes ChatGPT's and Codex's cached input. With only OpenAI connected, the page shows no Claude figures.

An administrator can close a month, which stores an immutable snapshot; every later view and CSV export of that month returns the snapshot exactly, so a billed figure cannot drift.

With department sync on, when the directory moves someone from one department to another during a month that has not been closed, their spend before the move counts to the old department and their spend after it to the new one; the leaderboard and Spend Review still show them once. Otherwise a person's spend for the month counts to their current department.

### Spend Review

Spend Review shows, for one person and one month and across every connected product, what the spend went on, whether it produced anything and whether a better route exists. For each kind of work it shows spend, sessions, typical session cost and model split. Where at least three colleagues and five sessions of the same kind of work exist in the last 90 days, it compares the person with them without naming anyone and suggests routes: a skill or connector colleagues commonly use, a cheaper model colleagues use with comparable outcomes, a stronger model where their outcomes are clearly better, or a change of approach where long conversations spend heavily on re-reading context. Spend Review also identifies scheduled tasks running repeatedly on the most expensive class of model, and shows a person's Claude in Office/Google spend as a separate estimate. Savings are estimates based on list prices. An index lists everyone's spend, with the month's Claude and OpenAI totals, and suggested routes, and ranks the people who work most efficiently against colleagues on two boards, one for Claude work and one for OpenAI work, so nobody ranks on one vendor's work against the other's. Administrators and managers can open any review; each person can open their own.

Codex sessions carry the cost of their own turns. OpenAI reports ChatGPT cost per person, model and hour, not per conversation, so each hour's cost is shared evenly across the replies in that hour; a conversation's ChatGPT figure is therefore an estimate, and the page says so. Cost in an hour with no reply on record stays in the person's total, which always equals FinOps's. Each product's work is compared only with colleagues' work on the same product, and model suggestions stay with the same vendor: Codex work is never pointed at a model OpenAI offers only in Chat, and no suggestion names a research model.

## Governance and risk

Command Centre applies its controls to what it stores. Command Centre sees a prompt only after the prompt has reached Claude, ChatGPT or Codex, so Command Centre flags, alerts, restricts access and applies retention, but cannot block.

### Personal data, secrets and intent

Every stored prompt from every surface is scanned at ingest by 20 patterns covering personal data under GDPR and LGPD (such as email addresses, UK National Insurance numbers, payment card numbers with checksum validation, IBANs, passport numbers and Brazilian CPF numbers) and secrets (such as cloud access keys, API keys, tokens, private keys and database connection strings). On Claude Cowork, Claude Code, ChatGPT and Codex prompts, seven patterns that match on shape alone, such as phone numbers and IP addresses, are confirmed by a Claude model before an alert fires; a match judged to be something else is recorded as dismissed with a one-sentence reason, and any failure in the check raises the alert regardless. Detection flags the message and raises an alert; the stored prompt is unchanged.

Prompts are also matched, in English and Brazilian Portuguese, against 12 built-in categories of risky intent, among them data exfiltration, access escalation, credential harvesting, policy evasion and destructive actions. Administrators can add categories. A Claude model then assesses each match in context and sets the alert's severity, and the alert names the product the prompt came from.

### Alerts

Alerts from detection, Developer Pulse, at-risk use cases and system health appear on one Alerts page, filterable by status and category. Administrators, managers and viewers can read them; only administrators resolve or dismiss them.

- **High-priority alerts to Slack.** Switched off until an administrator turns it on and saves a webhook under **Admin → Risk Scoring**. An hourly job then sends every high or critical alert, from any source, to a Slack channel you choose, carrying the title, explanation, type, severity and time; the evidence stored with the alert is removed before sending. Alerts refer to a person by display name, or by email where no name is set, never by an internal user ID, both in Slack and on the Alerts page. For an intent alert the explanation is Claude's assessment of the prompt and can quote it.
- **Anomaly detection.** Once a day, while a Claude API key is set and at least one of its alert types is on under **Admin → Risk Scoring**, a Claude model reviews recent activity for unusual patterns: activity metadata, flag reasons and per-person counts, including Codex turns and tokens and ChatGPT replies, but no prompt text. It takes your acceptable use policy into account where one is set.
- **Telemetry-silence alerts.** When system-health alerting is on, Command Centre raises a high-severity alert if a connected source sends nothing for a set number of working hours (three by default, Monday to Friday within a working day and time zone you configure). The sources watched are Claude Cowork, Claude Code, Claude Code metrics, ChatGPT and Codex, each on its own, and a source that has never sent anything is never raised; ChatGPT and Codex are not watched while the OpenAI sync is paused. This brings to light a client configuration change, collector fault or sync failure that stops activity arriving. A rejected OpenAI Admin API key raises its own alert, as a rejected Anthropic key does.

### The Audit Log

The Audit Log is where people's prompt text is browsed. The Audit Log lists each captured message with its product (Claude Chat, Claude Cowork, the Claude in Office/Google app such as Excel or Google Sheets, Claude Code, ChatGPT Chat, ChatGPT Work or Codex), its source (OpenTelemetry, Anthropic Compliance API or OpenAI Compliance API), its flags, a conversation thread view and the reason for any dismissed match. It can be filtered by source (OpenTelemetry for Claude, Anthropic's Compliance API for Claude Chat, OpenAI's for ChatGPT and Codex) and by product: Claude Chat, Cowork alone, all of Claude in Office or one Office app, all of Claude in Google or one Google app, Claude Code, ChatGPT Chat, ChatGPT Work or Codex. Opening a prompt shows the conversation's spend and where it went: the prompt's own share and the split by model. For ChatGPT and Codex, each reply or turn counts towards the prompt before it; a ChatGPT figure is an estimate, because OpenAI reports cost per hour and each hour's cost is shared across the replies in it. A conversation that used one model reads as one line, such as "This conversation: $1.20, all on gpt-5". The Audit Log is restricted to administrators, who see everyone, and managers, who see their own department (and no prompt text until a department is set for them). Reads of prompt text, here and on the few other pages that show prompts or short quotes from them, are recorded in an access audit log whose database triggers reject updates and deletes. Administrators review that log on its own page.

### Retention and data-subject rights

Each surface has its own retention window under one organisation-wide mode that either removes the content of old messages while keeping metadata and flags, or deletes the rows; the [Security and Data Protection](security-and-data-protection.md) document sets out the defaults. The names of files attached in a session are cleared once the session is past its window. On request, an administrator can export a defined set of one person's records as JSON (their person record, Claude Cowork and Claude Code prompts and activity messages, Claude Chat prompts and reply metadata, ChatGPT and Codex prompts with their reply records, conversation times, Codex turns, tool calls and hourly costs, telemetry events, Compliance activity, usage snapshots and alerts) and can erase the person, which deletes their monitoring record and the records keyed to it, including the OpenAI account identifier stored for them; their sign-in account is removed separately, in user administration.

## Reporting and outputs

**Reports.** Administrators, managers and viewers can generate reports for any period from a choice of sections. Compliance sections cover GDPR, LGPD, the EU AI Act, ISO/IEC 27001, ISO/IEC 42001 and open compliance gaps, combining evidence from live data with declarations administrators complete. Analytics sections cover Work Pulse, Developer Pulse, the Board, use cases, human time against Claude time and, for administrators and managers only, chargeback and Spend Review, each with the Claude in Office/Google spend estimate on its own line. The compliance and analytics sections are built in code from live data and passed to Claude with an instruction to include them exactly as provided, without restating or recalculating any figure; Claude writes the remaining sections, such as the executive summary, usage, alerts and recommendations. The reports evidence alignment with these frameworks and do not certify compliance. Every section reports each connected product on its own line: the data sources table lists each source, usage and adoption are reported per product from Command Centre's own counts, the audit sections give each product its own figures, Developer Pulse shows Claude Code and Codex in separate tables, the Board names each tool's product, and alerts are attributed to the product they came from. The human time section counts ChatGPT conversations and Codex sessions while they are shown, with Claude Cowork's and ChatGPT's parts on their own lines, and the Spend Review section carries the Claude and OpenAI efficiency boards.

**Weekly Digest.** Every Monday Command Centre can send a digest of the last completed week by email and Slack, built from stored weekly figures with no model involved, including use cases needing attention and coaching counts by department. Its coding figures cover Claude Code and Codex, with spend split between them, and its time-saved line includes ChatGPT while it is shown. Weekly Highlights names Claude Code on its code-output line, which only Claude Code reports.

**Weekly Highlights.** Switched off until an administrator turns it on from its card under **Admin → System**. An administrator can then generate a draft "what the week produced" post from the last completed week's Tier 3 work, with personal data and identifying paths removed. Claude writes the descriptive sentences, each checked against a real work item; figures are inserted from measured data. The administrator edits the draft, then copies it or sends it to Slack. The post is never scheduled or sent unreviewed, and names people only if the organisation allows it.

**Metrics Connector.** Business-intelligence tools and Model Context Protocol clients can read organisation-level figures (a weekly summary, metric trends and data-health indicators) over REST or as MCP tools, using bearer tokens that administrators issue, shown once and stored as hashes. The connector never carries data about individual people or sessions. It is not yet tested with a real BI tool.

**Briefings.** A weekly coding briefing, covering Claude Code and Codex, joins the Work Pulse briefings and the dashboard's Intelligence Briefing, all number-checked.

## Administration

### Roles

Command Centre has six roles, enforced on the server for every page and data request.

| Role | Intended for | Access |
|---|---|---|
| Administrator | The team running Command Centre | Everything, including all prompt text, configuration, users, alert resolution, cost centres and period close |
| Manager | Department and functional leaders | Dashboard, Alerts (read), Reports, Audit Log for their department (none until a department is set), all Pulse views, FinOps, Spend Review, the Use Cases register, the Work Pulse administration overview, the Board |
| Viewer | Executives and reviewers | Dashboard, Alerts (read), Reports, Work Pulse and Developer Pulse views (including each department member's Claude Code and Codex spend), Use Case governance, the Board, their own Spend Review; no Audit Log or FinOps |
| Pulse (Work and Developer) | People whose work is observed | Their own and their department's Work Pulse and Developer Pulse views, the Board, their own Spend Review |
| Work Pulse | As above, Work Pulse only (Claude Cowork, Claude Chat, Claude in Office/Google and ChatGPT) | Their own and their department's Work Pulse views, the Board, their own Spend Review |
| Developer Pulse | As above, Developer Pulse only (Claude Code and Codex) | Their own and their department's Developer Pulse views, the Board, their own Spend Review |

When telemetry, Anthropic's Compliance API or OpenAI's Compliance API first shows a new person, Command Centre creates a record with the Pulse (Work and Developer) role so their work can be attributed. That record has no password and cannot be used to sign in until the account is activated.

### Sign-in, single sign-on and MFA

People sign in with email and password or through single sign-on with an OpenID Connect identity provider. Single sign-on proves identity only: the person must already hold a Command Centre account with single sign-on enabled, and their role is held in Command Centre. Password accounts can add one-time passcodes from an authenticator app, with single-use recovery codes. Sessions expire after 24 hours or eight hours of inactivity; a person who chooses to be remembered on a device stays signed in for up to seven days. Administrators can see and revoke active sessions. When a session has ended, the next page or request takes the person straight to sign-in, and back to the same page afterwards.

### Configuration

Settings live in the database and are edited in the administration area, covering users, tokens and integration keys, alert thresholds, intent categories, rubrics and model choices, cost centres, compliance declarations, retention and system health. Keys and other secrets are encrypted in the database and never displayed after saving. Administrators choose the Claude models Command Centre uses from those available to the Claude API key.

### The admin pages

Administrators reach these from **Admin** in the sidebar.

| Page | What it does | Read more |
|---|---|---|
| ***Setting up*** | | |
| **Overview** | Shows the health of the installation at a glance: people, database size, open alerts, recent events, archive status and compliance progress, so administrators can spot problems early. | |
| **Access & Keys** | Holds the Claude API key and the keys that connect Claude Chat, ChatGPT and Codex, and controls who can sign in: accounts, roles, departments, single sign-on, two-factor authentication and active sessions, so each person sees only what their role allows. With single sign-on through Microsoft Entra ID, department sync keeps everyone's department in step with the directory, at sign-in and in a daily lookup, after an administrator has previewed and applied it. | [Roles](security-and-data-protection.md#roles) · [Sign-in methods](security-and-data-protection.md#sign-in-methods) |
| **Ingestion** | Connects each product and confirms its activity is arriving: the Claude collector's address, bearer token and settings to copy for Claude Code, Claude Cowork and Claude in Office/Google, and the sync status for ChatGPT and Codex. Recent users shows the product each person was first seen in, identity conflicts catch one Claude installation or one OpenAI account arriving under two emails, and people can be excluded from monitoring here, in every product. | [Connect Claude](connect-claude.md) · [Troubleshooting](troubleshooting.md#connecting-claude) |
| **User Insights** | Lists everyone whose Claude, ChatGPT or Codex activity has been seen, with each person's main product and how active they are, and lets administrators deactivate people who should no longer be monitored. | [How accounts come to exist](security-and-data-protection.md#how-accounts-come-to-exist) |
| **System** | Sets the Core AI model, switches on FinOps, Weekly Digest and Weekly Highlights, issues read-only Metrics Connector tokens for BI tools, and shows whether every scheduled job and the database are healthy. | [Reporting and outputs](#reporting-and-outputs) |
| ***Risk and oversight*** | | |
| **Risk Scoring** | Tunes how alerts are raised: anomaly detection sensitivity and thresholds, which alert types are on, Claude Code alerts for a daily spend limit, unapproved models and sensitive repositories, a separate daily spend limit for Codex, file-name patterns for files uploaded to Claude Cowork or attached in ChatGPT, and the Slack channel that receives high-priority alerts. | [Alerts](#alerts) |
| **Intent Detection** | Controls which kinds of risky intent are flagged in prompts: twelve built-in categories that can be switched on or off, and your own categories written as plain phrases. | [Personal data, secrets and intent](#personal-data-secrets-and-intent) |
| **Claude Sub Agents** | Shows every subagent people ran in Claude Code and Claude Cowork in the last 30 days, built-in or custom, who ran each one and what it cost, with new custom subagents marked. | |
| **Access Audit** | Keeps an unalterable record of who read what and when, including prompt text, exports and reports, as evidence for security reviews and audits. | [Audit logging](security-and-data-protection.md#audit-logging) |
| **Files** | Lists the files people attached in Claude Cowork, Claude Chat and ChatGPT across the organisation, with the product each came from, a product filter and a breakdown by kind of document. | |
| ***Products*** | | |
| **Work Pulse** | Configures how everyday work in Claude and ChatGPT is graded: the AI models, the tier definitions, whether ChatGPT prompts are graded, and optional features, with drill-downs by person and department, classifier health, and a monthly audit an administrator can run against the AI's grades. | [Work Pulse](#work-pulse) · [Measured and AI-judged](ai-data-flow.md#measured-and-ai-judged) |
| **Developer Pulse** | Configures Claude Code and Codex analytics: the grading models and tiers, whether Codex sessions are graded, the model prices used for spend, the GitHub connection, the assumptions behind the value estimate, and checks on data quality and classifier health. | [Developer Pulse](#developer-pulse) |
| **Use Cases** | Switches Use Cases on and sets how it works: the models used, when a use case counts as adopted or at risk, how suggestions and session matching behave, skill drafting, and the assumptions behind the governance value estimate. | [Use Cases](#use-cases) |
| **Cost Centres** | Groups departments into the cost centres your finance team uses, with their codes, so FinOps can charge AI spend back to the right budget. | [Chargeback and period close](#chargeback-and-period-close) |
| ***Data and compliance*** | | |
| **Data** | Sets how long each kind of data is kept, exports the audit trail as CSV for any date range and product, and archives data to your own storage before it is removed. | [Retention and deletion](security-and-data-protection.md#retention-and-deletion) |
| **Compliance** | Records your GDPR, LGPD, EU AI Act, ISO/IEC 27001 and ISO/IEC 42001 declarations, such as a named data protection officer and completed impact assessments, which feed the compliance sections of reports. | [Reporting and outputs](#reporting-and-outputs) |

## What Command Centre does not do

- **Command Centre does not sit between people and Claude, ChatGPT or Codex.** Activity arrives after a prompt has reached the model, so Command Centre can flag, alert and restrict access to what it stores, but cannot block, alter or delay a prompt.
- **Command Centre does not store the AI's replies.** For Claude Code, Claude Cowork and Claude in Office/Google, Command Centre stores people's prompts (up to 4,000 characters each) and metadata about Claude's activity: model, tokens, cost, tool names and outcomes, and, for Claude Cowork and Claude in Office, the file name of an output or document Claude wrote or changed (Claude in Google sends no file name). Command Centre never stores the text of Claude's answers or the contents of files. For Claude Chat it stores prompts and, for replies, only the model and counts of artifacts and generated files. For ChatGPT and Codex it stores prompts up to the same 4,000 characters; for ChatGPT replies it keeps only the model and time, and it never stores the commands Codex runs.

Several features send prompt text from every connected product, Claude and OpenAI alike, to Anthropic's Claude API using your Claude API key, among them the classifiers, use case judging and suggestions, skill drafting, session descriptions, human-time estimates, personal-data confirmation and intent assessment. The [AI Data Flow and Sub-processors](ai-data-flow.md) document lists each feature and what it sends.
