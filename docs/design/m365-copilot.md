# Microsoft 365 Copilot: design note

Status: not built. This note sets out where Microsoft 365 Copilot would fit when it is added, so the work can start from a plan rather than a blank page. It follows the pattern of the OpenAI integration (ChatGPT and Codex), which is the closest precedent in this codebase.

## What Microsoft offers

These facts were checked on Microsoft Learn on 2 November 2026. Recheck them before building.

- **One pull API, per person.** `GET https://graph.microsoft.com/v1.0/copilot/users/{id}/interactionHistory/getAllEnterpriseInteractions` returns a person's Copilot prompts and replies. There is no organisation-wide call, so a sync makes one call per person.
- **Permission.** The app-only permission is `AiEnterpriseInteraction.Read.All`; there is no delegated version. The tenant needs Microsoft 365 Copilot licences with the Graph-grounded chat plan.
- **Paging and windows.** `$top` (100 recommended) and `$filter` on `appClass` and on `createdDateTime`. A `createdDateTime` filter needs both bounds. There is no delta query, so the sync keeps its own position per person.
- **Records.** `interactionType` is `userPrompt` or `aiResponse`, and `requestId` pairs a prompt with its reply. Each record also carries `sessionId`, `appClass` (which app: for example `IPM.SkypeTeams.Message.Copilot.BizChat` or `.Teams`), `body.content`, and `from.user.id`, which is the Entra object id, not an email. `contexts`, `attachments` and `links` name the files and meetings used.
- **Not covered.** Copilot Studio agents are excluded, and coverage varies by licence. There are no tokens and no cost, because Copilot is priced per seat.
- **Unknown.** Graph throttling for this API has not been checked.

## Where it fits

Microsoft 365 Copilot is knowledge work, so it joins Work Pulse beside Cowork, Claude in Office and Google, Claude Chat and ChatGPT. It is a third vendor beside Claude and OpenAI.

| Area | What changes | Where in the code today |
|---|---|---|
| Storage | Prompts go into `cowork_messages` with a new `source` (say `m365_copilot`), surface `cowork`, the person's own words only. Replies are never stored as text, the same rule as ChatGPT: keep the reply's time, so conversation time can be measured. | `lib/openai/sync.ts` (the ChatGPT pattern) |
| Sync | A new job beside the OpenAI one: interval-gated, a per-person position on `createdDateTime`, oldest first, a cap per run, Pause sync from day one. | `lib/openai/job.ts`, `lib/openai/client.ts`, `lib/ingestion/scheduler.ts` |
| Identity | Records name people by Entra object id. The sync must look each id up in Graph (`User.Read.All`) to get an email, then match accounts by email as everywhere else. Someone with no single plain email is skipped. | `lib/otel/resolve-user.ts` (`resolveOtelUser`), `lib/email/address.ts` (`isPlainEmail`) |
| Whom to poll | Graph has no organisation-wide call, so the sync needs a list of people to ask about: those holding a Copilot licence, read from Graph. | new |
| Vendor switch | The switch is two-valued today (Claude, OpenAI). A third value means the vendor list, labels, the SQL vendor clauses and the per-vendor weekly figures all take Microsoft too. The per-vendor tables already key on a text `vendor` column, so they need no migration. | `lib/dashboard/vendor.ts`, `lib/dashboard/product-sql.ts`, `lib/pulse/vendor-filter.ts` (`SPLIT_VENDORS`), `pulse_metrics_vendor`, `components/shared/VendorSwitch.tsx` |
| Products | A new product on the dashboard and in the Audit Log's Product list, under a Microsoft group, and a row on the By product panel. | `PRODUCTS` in `lib/dashboard/vendor.ts`, `lib/pulse/cowork/by-product.ts`, `app/audit/page.tsx` |
| Tiers | The classifier judges Copilot prompts like ChatGPT's, with its own switch to stop that. | `lib/pulse/work-surfaces.ts` (`classifiableSource`) |
| Spend | No usage spend exists. FinOps shows the seat licence, as it does for ChatGPT seats: a seat count and monthly price entered by an admin, never added to the chargeback total. The By product row shows spend as not measured. | `lib/finance/seats.ts` (`getChatgptSeatsSummary`) |
| Show and hide | A "Show Microsoft 365 Copilot" switch on its panel, working like Show ChatGPT and Codex: hidden from the analytics screens, always in the Audit Log. The visibility helper becomes per vendor. | `lib/sources/openai-visibility.ts`, `lib/sources/connected.ts` |
| Audit Log | Each prompt tagged Microsoft 365 Copilot, with "Microsoft Graph" as its source. | `app/api/events/route.ts` |
| Erasure and retention | The new tables, if any, join the person-erasure and retention engines; the erasure coverage test fails until they do. | `test/gdpr-erasure-coverage.test.ts` |

## Decisions to make before building

1. **Which kind of work.** Copilot Chat (BizChat) reads like Chat, while Copilot in Word, Excel or Teams reads like Work. `appClass` could split them into two products, or Copilot could be one Work product.
2. **Attachments and meetings.** Whether to keep the names of files and meetings Copilot used (as ChatGPT keeps file names), or nothing.
3. **Who to poll.** All licensed people, or only people already known to Command Centre.

## Before building

- A test tenant with Microsoft 365 Copilot licences and recorded interactions, for the same reason the OpenAI work needs a real ChatGPT workspace: the record shape and identity lookup must be checked against real data.
- A measurement of Graph throttling at a realistic number of people, because the sync makes one call per person per run.
