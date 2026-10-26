#!/bin/sh
# Claims one fixed queue slot for this collector, then starts the collector
# on it. The entrypoint of both collector images: deploy/aws/Dockerfile.otel-ecs (AWS,
# slots on EFS) and deploy/azure/Dockerfile.otel (Azure, slots on the Azure Files share).
#
# Slots are directories slot-0 .. slot-(OTEL_QUEUE_SLOTS-1) under
# OTEL_QUEUE_ROOT. A collector takes the first slot it can lock and keeps
# the lock (file descriptor 9, inherited across exec) for its whole life.
# When it stops, its lock is released (on a crash, once the NFS/SMB client
# is gone, within a couple of minutes), and the next collector to start
# adopts that slot, sending whatever was still queued in it.
#
# There must be a free slot for every collector that runs at the same time:
# AWS deploys one task at a time (2 tasks, 2 slots); Azure runs the old and
# new revision side by side during a deploy (2 + 2 replicas, 4 slots). If
# none is free (a lock not yet released), this retries for
# OTEL_SLOT_WAIT_SECONDS before failing.
set -eu

ROOT="${OTEL_QUEUE_ROOT:?OTEL_QUEUE_ROOT must be set}"
SLOTS="${OTEL_QUEUE_SLOTS:-2}"
WAIT="${OTEL_SLOT_WAIT_SECONDS:-300}"
CONFIG="${OTEL_CONFIG:-/etc/otelcol-contrib/config.yaml}"

deadline=$(( $(date +%s) + WAIT ))

while :; do
  i=0
  while [ "$i" -lt "$SLOTS" ]; do
    dir="$ROOT/slot-$i"
    mkdir -p "$dir"
    exec 9>"$dir/.slot.lock"
    # A slot another collector holds fails here; on Azure Files that shows
    # up as "Permission denied" rather than a quiet refusal, so hide it.
    if flock -n 9 2>/dev/null; then
      echo "otel-slot-launcher: claimed $dir"
      export OTEL_QUEUE_DIR="$dir"
      exec /otelcol-contrib --config "$CONFIG"
    fi
    exec 9>&-
    i=$((i + 1))
  done
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "otel-slot-launcher: no free queue slot of $SLOTS under $ROOT after ${WAIT}s" >&2
    exit 1
  fi
  echo "otel-slot-launcher: all $SLOTS slots locked, retrying in 10s"
  sleep 10
done
