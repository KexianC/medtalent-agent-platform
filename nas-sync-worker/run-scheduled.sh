#!/bin/sh
set -eu

base_dir=/volume1/docker/agent-platform-sync
node_bin=/volume1/docker/agent-platform-tools/node24/bin/node
worker_entry="$base_dir/index.cjs"
worker_env="$base_dir/.env.nas-sync"
run_lock="$base_dir/run.lock"
schedule_lock="$base_dir/schedule.lock"
stdout_log="$base_dir/logs/scheduled.stdout.log"
stderr_log="$base_dir/logs/scheduled.stderr.log"
scheduler_error_log="$base_dir/logs/scheduler.stderr.log"
schedule_marker="# medtalent-agent-platform-nas-sync"
queue_name=n
self="$base_dir/run-scheduled.sh"

schedule_next() (
  umask 077
  flock -x 9

  if ! atq -q "$queue_name" 2>/dev/null | grep -q .; then
    {
      printf '%s\n' "$schedule_marker"
      printf 'exec %s\n' "$self"
    } | at -M -q "$queue_name" now + 5 minutes >/dev/null 2>>"$scheduler_error_log"
  fi
) 9>"$schedule_lock"

schedule_next
umask 077

(
  flock -n 8 || exit 0
  exec "$node_bin" --env-file="$worker_env" "$worker_entry" --once
) 8>"$run_lock" >>"$stdout_log" 2>>"$stderr_log"
