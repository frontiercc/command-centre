# Frontier Command Centre: Uninstall

Removing Command Centre has three parts: what you set in Claude, the keys you gave Command Centre, and what runs on your computer or server.

## 1. Stop Claude sending telemetry

If you connected Claude to Command Centre:

- **Claude Code:** in claude.ai, open **Organization settings → Claude Code → Managed settings** and remove the telemetry settings. If you distributed them another way, remove the `managed-settings.json` file or the device management profile.
- **Claude Cowork:** in claude.ai, open **Organization settings → Data and Privacy → Monitoring** and clear the three fields.
- **The `otlpContentCapture` device setting:** if you set it on any machine so Claude Cowork sends prompts in full, remove it.

  On Windows, in PowerShell run as administrator:

  ```powershell
  Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Claude' -Name otlpContentCapture
  ```

  On a Mac:

  ```bash
  sudo defaults delete "/Library/Managed Preferences/$(whoami)/com.anthropic.claudefordesktop" otlpContentCapture
  ```

## 2. Revoke the keys you gave it

Delete or revoke each key you entered in Command Centre, where you created it:

- the Claude API key, in the Claude Console;
- the Compliance Access Key, in claude.ai → Organization settings → API;
- the Analytics API key, if you set one, at [claude.ai/analytics/api-keys](https://claude.ai/analytics/api-keys);
- the Admin API key, if you set one, in the Claude Console;
- any GitHub token, single sign-on client secret, Slack webhook, SMTP password, and the AWS access key used for the archive.

## 3. Remove Command Centre

Take a backup first if you need to keep anything: see [Back up first](troubleshooting.md#back-up-first). This deletes every prompt and figure Command Centre stored, and cannot be undone.

From inside the `command-centre` folder:

```bash
docker compose --profile demo down -v --rmi local
```

This stops Command Centre, deletes its data and removes the images it built. To also remove the images it downloaded:

```bash
docker image rm postgres:16 node:22-alpine otel/opentelemetry-collector-contrib:0.157.0 busybox:1.38-musl
```

Then delete the `command-centre` folder, including `.env`.

If you used the archive, delete the archived data from your S3 bucket too.

On AWS or Azure, delete the resources you created, including the database and its backups.
