# Mock OpenAI export

Sample ChatGPT and Codex activity, served by a stand-in for OpenAI's Compliance Logs Platform on localhost. It is for building and testing the ChatGPT and Codex sync without a ChatGPT Enterprise workspace. ChatGPT Business has no access to this export, so it cannot be used for testing either.

```bash
node scripts/openai-mock/server.mjs
```

The stand-in listens on `http://localhost:4010/v1`. Use these settings:

| Setting | Value |
|---|---|
| Workspace ID | `7f3c2a10-5b1e-4c8d-9a6f-0e2d4b8c1a55` |
| Organisation ID | `org-MockAcmeCorp000000000000` |
| Admin key, all log types | `mock-admin-key` |
| Admin key, costs only | `mock-costs-key` |

Add `--write <folder>` to also save the files available at start-up, to read them directly.

## What it contains

- **People.** ChatGPT users from every department of the Acme Corp sample organisation, Codex users from Engineering and Product, and two people the sample organisation does not have.
- **ChatGPT Chat and Work.** Conversations of one to four prompts, mostly on weekdays with a little weekend use, on the desktop apps, the web and mobile. Work tasks end with a file. There are custom GPTs, projects, uploaded files, skills and tools, one temporary chat, one locked chat and one edited message.
- **Codex.** Sessions in the CLI, VS Code, JetBrains, the desktop app and the web. They include prompts, replies with token counts, file reads, patches, test runs (some failing), `git commit` calls, connector calls, a plugin install, and a daily automation.
- **Codex turns.** One record per turn about two hours after its hour, with credits, an estimated dollar cost, OpenAI's work label and an `automation` tag.
- **Costs.** One record per person, model, product and app per hour, three to five hours late. Most are billed in credits with an estimated dollar figure; one person is billed in dollars. There is also one record with no email and one for a workspace agent with no person.
- **Personal data and risky requests.** A few ChatGPT prompts carry a National Insurance number, a phone number, customer emails, a request to send data to a personal account and a request for admin passwords. Codex prompts in the last three days carry a quoted password, an access key, an export to a personal Dropbox and a request to switch off logging.

## How it behaves like the real export

- Files cover about 10 minutes each, per log type. A file lists only once its end time has passed, so new files keep appearing while it runs.
- Events reach a file within 30 minutes; about 2% appear in two files, so the sync must remove duplicates by `event_id`.
- The file link returns a 307 redirect to a download link that lasts five minutes and needs no key.
- Costs are listed only on the organisation route, the other types only on the workspace route.
- More than 100 requests a minute per key and route gets a 429 with `Retry-After`. Tests raise the limit with `OPENAI_MOCK_RATE_LIMIT`.
- A missing key gets 401; the costs-only key gets 403 on the other types.

## What is assumed, not documented

OpenAI's Admin API reference (version 2.5.40, downloadable from its OpenAPI link) documents the four log types the sync reads. The mock follows it where it is specific. Check the rest on a real workspace before release:

- **Model names and prices.** Models take the names on OpenAI's rate cards in lower case with hyphens (`gpt-6`, `gpt-5.3`, `gpt-6-pro`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-5.6-sol`). OpenAI's own examples use both forms, such as `gpt-5.1-codex-max` and `gpt-5-2-pro`, so whether the real export names them so is unconfirmed. Credits use the credit rate card's per-token rates at $0.04 a credit, which equals the token-based USD card. On real credit plans Chat is charged per message, not per token.
- **ChatGPT Work in both logs.** OpenAI's reference confirms there is no shared identifier. Work is marked in conversation messages (`conversation.mode` is `work`), but no field in the Codex logs is documented as marking it. The mock's `CODEX_WORK_` client names, which the sync uses to skip Work in the Codex logs, are an assumption.
- **Codex token counts.** Documented for Codex turns: uncached input, cached input and output are separate figures, which is how the mock writes them and what the sync reads. Cost records also keep cached input apart from input. For Codex log replies the reference lists input, output, cached input and reasoning tokens without saying whether cached input is inside input; the mock treats it as inside, and the sync takes no token counts from that log.
- **Wording.** OpenAI documents its turn work labels (`classification` levels) as open labels that may change; the sync does not read them. Error message text and cost SKU names in the mock are illustrative.
