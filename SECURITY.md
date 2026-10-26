# Security policy

## Reporting a vulnerability

Please do not report security issues in public issues, pull requests or discussions.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. If you cannot use GitHub, email frontiercommandcentre@proton.me instead. Include what you found, how to reproduce it, the version or commit you tested, and the impact you think it has.

## What happens next

- **Acknowledgement** within 14 days of your report.
- **First assessment** within 10 working days: whether we can reproduce it, and how serious we judge it to be.
- **Fix.** Critical issues are fixed as a priority. We keep you informed of progress and may ask you to confirm the fix.
- **Disclosure.** We publish a GitHub security advisory once a fix is released, or 90 days after your report at the latest, whichever comes first. We agree the timing with you where we can.
- **Credit.** We credit you in the advisory unless you would rather we did not.

The 90-day disclosure limit matches Google Project Zero's disclosure deadline.

## Supported versions

Security fixes are made to the latest release on the `main` branch. Please test against it before reporting.

## Scope

This policy covers the code in this repository. A deployment of Frontier Command Centre run by another organisation is that organisation's responsibility; report issues in it to them.

## Security design

How Command Centre protects the data it holds (authentication, roles, encryption, personal-data detection, retention and the audit log) is described in [Security and Data Protection](docs/security-and-data-protection.md).
