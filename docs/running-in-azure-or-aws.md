# Frontier Command Centre: Running in Azure or AWS

Command Centre is two containers, the Hub and the collector, plus a PostgreSQL database. To run it in the cloud, use the services your organisation already has for running containers, storing images and secrets, and hosting PostgreSQL. This page sets out what those services must provide, then what to watch for if you use particular AWS or Azure services. No infrastructure code is supplied.

This is a deployment reference, not a supported infrastructure template. Cloud services and their settings change over time, so check your design against your environment and the cloud provider's current documentation before you deploy.

## What you need

| Part | What it must provide |
|---|---|
| **Somewhere to run containers** | Two services: the Hub and the collector |
| **An image registry** | To hold the two images you build |
| **A secret store** | To hold the four secrets below and pass them to the containers |
| **PostgreSQL 16** | Reachable only from the Hub, with a database for Command Centre. The Hub must connect directly: a transaction pooler in between stops the scheduled jobs running |
| **HTTPS** | Two addresses with valid certificates: one where people sign in (the Hub) and one where Claude sends its activity (the collector) |
| **Persistent storage for the collector's queue** | So telemetry waiting to be delivered survives a restart |
| **Outbound access** | HTTPS from the Hub to `api.anthropic.com`, and to any service you switch on, such as Slack or your identity provider |

| Container | Port | Health check | Settings |
|---|---|---|---|
| **Hub** | 3000 | `/api/health` on port 3000 | Secrets: `DATABASE_URL`, `CCC_ENCRYPTION_KEY`, `CCC_COLLECTOR_TOKEN` |
| **Collector** | 4318 | Port 13133, set separately from 4318: the collector answers health checks there | Secrets: `OTEL_ENDPOINT_SECRET`, and `CCC_COLLECTOR_TOKEN` with the same value as the Hub's. Plain: `HUB_HOST`, the Hub address it sends to; `OTEL_QUEUE_ROOT`, where the queue storage is mounted; `OTEL_QUEUE_SLOTS` (below) |

Generate the secrets as long random values. Never change `CCC_ENCRYPTION_KEY` once Command Centre holds data: settings saved under one key cannot be read under another. Keep a copy with your backups.

The Hub encrypts its connection to any database other than the bundled one and verifies the certificate, so a managed database needs no extra setting, but the Hub must trust the database's certificate authority (see "If your database is Amazon RDS" below).

For an evaluation, two Hub copies of 1 vCPU and 2 GB and two collector copies of 0.5 vCPU and 1 GB are a reasonable start. Size production for your telemetry volume, the number of people signing in and how long you keep data.

**The collector's queue.** Each running copy of the collector locks a queue slot of its own on the shared storage, so copies never write to the same queue, and a replacement takes over the slot its predecessor released and sends what was left in it. Set `OTEL_QUEUE_SLOTS` to at least the number of copies that can run at once, including during a deployment. With too few, a new copy waits up to five minutes for a slot and then fails to start.

## Build the images

From the root of this repository, build the Hub from `Dockerfile` and the collector from the file for your cloud in `deploy/`, then push both to your registry:

```bash
docker build -t <registry>/ccc-hub:<tag> .
docker build -f deploy/aws/Dockerfile.otel-ecs -t <registry>/ccc-otel:<tag> .    # AWS
docker build -f deploy/azure/Dockerfile.otel -t <registry>/ccc-otel:<tag> .      # Azure
docker push <registry>/ccc-hub:<tag>
docker push <registry>/ccc-otel:<tag>
```

Both collector files start the collector through `deploy/otel-slot-launcher.sh`, which claims the queue slot. If your platform runs x86-64 and you build on an Apple-silicon Mac, add `--platform linux/amd64` to each `docker build`.

## If you use AWS services

- **If your database is Amazon RDS:** the Hub verifies the database's certificate, and RDS certificates are issued by Amazon's own certificate authority. Build the Hub image with one extra layer that adds Amazon's bundle, and set `NODE_EXTRA_CA_CERTS=/opt/rds/rds-global-bundle.pem` on the Hub:

  ```bash
  docker build -t ccc-hub-base:<tag> .
  docker build -f deploy/aws/Dockerfile.hub-rds-ca \
    --build-arg BASE_IMAGE=ccc-hub-base:<tag> -t <registry>/ccc-hub:<tag> .
  ```

- **If the collector's queue is on Amazon EFS:** give the collector an access point owned by user and group 10001 (the collector's user), mount it at `/var/otel-wal`, set `OTEL_QUEUE_ROOT=/var/otel-wal`, and set `OTEL_QUEUE_SLOTS` to the collector's task count. On Amazon ECS, replace collector tasks one at a time (deployment minimum 50%, maximum 100%).
- **If you use an Application Load Balancer:** set the collector target group's health check to port 13133. `HUB_HOST` is then the Hub's hostname; the collector sends to `https://<HUB_HOST>/api/otel/ingest`.

## If you use Azure services

- **If your database is Azure Database for PostgreSQL:** it refuses extensions it has not been told to allow, and the Hub creates `CITEXT` when it first starts. Add `CITEXT` to the server parameter `azure.extensions` before the Hub starts.
- **If you use Azure Container Apps:** mount an Azure Files share on the collector at `/var/otel-wal`, the image's default `OTEL_QUEUE_ROOT`, and leave `OTEL_QUEUE_SLOTS` at its default of 4 for two replicas, because a deployment briefly runs the old and new revisions side by side. Set the collector's health probe to port 13133, separately from its ingress port, 4318. `HUB_HOST` is the Hub's internal address in the environment, `<hub-app-name>.internal.<environment default domain>`.
- **If you use Azure Key Vault:** secret names allow only letters, digits and hyphens, for example `ccc-encryption-key`.

## Example designs

These show one way to build each, for reference. You do not need to follow them.

![Example AWS design: the Hub and collector on ECS Fargate across three zones, behind an Application Load Balancer with AWS WAF, with RDS for PostgreSQL, EFS for the queue, and Secrets Manager, KMS, ECR and CloudWatch](diagrams/AWS%20example%20design.png)

*AWS: close to the design we test-built, which used one NAT gateway rather than one per zone.*

![Example Azure design: Hub and collector replicas across three zones in a Container Apps environment, behind Application Gateway and Container Apps ingress, with PostgreSQL Flexible Server primary and standby, Azure Files for the queue, and Key Vault, Container Registry and storage behind private endpoints](diagrams/Azure%20example%20design.png)

*Azure: a hardened version. Our test build used the simpler public setup, with Container Apps ingress and no Application Gateway or private endpoints.*

## Then, on any platform

1. **Check it is running.** `https://<hub address>/api/health` returns `{"status":"ok"}`.
2. **Create your admin account** straight away. Search the Hub's log for `setup token`, open the Hub's address and enter the token. The token works once, and only until the first admin exists. If you lose it, wait ten minutes and restart the Hub for a new one.
3. **Add your Claude API key** under **Admin → Access & Keys**.
4. **Connect Claude.** On **Admin → Ingestion**, select **Edit** beside the collector address and enter the collector's HTTPS address. In the cloud the page does not show the bearer token: use `OTEL_ENDPOINT_SECRET` from your secret store. Then follow [Connect Claude](connect-claude.md).
5. **Set up the rest** by following [Configure Command Centre](configure-command-centre.md): single sign-on, email, retention, alerts and each feature.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| The Hub stops at start-up | `CCC_ENCRYPTION_KEY` missing or a placeholder, or `CCC_INSECURE_COOKIES=true` set without `CCC_ALLOW_INSECURE_COOKIES` | The Hub's log, for `FATAL` |
| `/api/health` returns 503 | The database is unreachable, failing over or out of connections | The database's status |
| The Hub cannot connect to the database over TLS | The Hub does not trust the database's certificate authority | With Amazon RDS, the extra image layer and `NODE_EXTRA_CA_CERTS` |
| People cannot stay signed in | The Hub reached over plain HTTP; its cookies are secure-only | Use the HTTPS address |
| No setup token in the log | An admin already exists, or another copy of the Hub issued one in the last ten minutes | Search every Hub log stream for `setup token` |
| One product sends nothing | Its Claude settings changed or were not distributed | For Claude Code, the managed settings; for Claude Cowork, Organization settings → Data and Privacy → Monitoring in claude.ai |
| Nothing arrives at all | The collector is down, the bearer token is wrong, or the collector cannot reach the Hub (`HUB_HOST`) | The collector's log |
| A collector copy will not start | No free queue slot | Its log for `no free queue slot`; raise `OTEL_QUEUE_SLOTS` |
| Claude Code figures too high | Clients sending cumulative metrics | The managed settings: temporality must be `delta` |
| A credential cannot be decrypted | `CCC_ENCRYPTION_KEY` differs from the one it was saved under | Restore the original key, or enter the credential again |
| AI-judged figures lag | The classifier queue is growing, or the Claude API key is failing | The Classifier health tabs on Admin → Work Pulse and Admin → Developer Pulse |
| Scheduled jobs not running | A transaction pooler between the Hub and the database | Hub log lines starting `[Scheduler leader]` |
| `too many connections` | Each Hub copy can open 21 database connections; copies times 21 exceeds the database's limit | Fewer Hub copies, a larger database, or a lower `CCC_PG_POOL_MAX` |

## Updating and backups

To update, build and push the new release's images with a new tag, then redeploy the Hub and the collector. The Hub updates its database itself when it starts. Updates only go forward, so take a database backup first.

Use your managed database's backups, with point-in-time recovery if it offers it. A restored database works only with the same `CCC_ENCRYPTION_KEY`.
