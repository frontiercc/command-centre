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
- **Personal data and risky requests.** A few prompts carry a National Insurance number, a phone number, customer emails, a request to send data to a personal account and a request for admin passwords.

## How it behaves like the real export

- Files cover about 10 minutes each, per log type. A file lists only once its end time has passed, so new files keep appearing while it runs.
- Events reach a file within 30 minutes; about 2% appear in two files, so the sync must remove duplicates by `event_id`.
- The file link returns a 307 redirect to a download link that lasts five minutes and needs no key.
- Costs are listed only on the organisation route, the other types only on the workspace route.
- More than 100 requests a minute per key and route gets a 429 with `Retry-After`. Tests raise the limit with `OPENAI_MOCK_RATE_LIMIT`.
- A missing key gets 401; the costs-only key gets 403 on the other types.

## What is assumed, not documented

Check each of these on a real workspace before release:

- **Model names and prices.** `gpt-5.5`, `gpt-5-mini`, `gpt-5.5-pro`, `gpt-5.5-codex` and `gpt-5-codex-mini`, priced with made-up credit rates at $0.04 a credit.
- **ChatGPT Work in both logs.** OpenAI says Work appears in both `CONVERSATION_MESSAGE` and `CODEX_LOG`. It documents no shared identifier, so the mock gives none; the two can only be matched on person, prompt text and time.
- **Codex token counts.** The mock treats cached input as part of input and reasoning as part of output.
- **Wording.** Error message text, OpenAI's work labels and cost SKU names are illustrative.
