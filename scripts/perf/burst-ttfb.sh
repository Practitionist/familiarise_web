#!/usr/bin/env bash
# Fires N concurrent unique-key requests at a URL and prints per-request TTFB plus the
# host's request/instance header; the burst protocol from #1124 (see docs/perf/vercel-experiment-runbook.md).
set -euo pipefail
url="${1:?usage: burst-ttfb.sh <url> [n=12] [key-param=k]}"
n="${2:-12}"
param="${3:-k}"
sep=$([[ "$url" == *\?* ]] && echo "&" || echo "?")
tmp=$(mktemp -d)
for i in $(seq 1 "$n"); do
  (
    key=$(uuidgen | tr 'A-Z' 'a-z')
    curl -s -o /dev/null -D "$tmp/h.$i" \
      -w "%{http_code} %{time_starttransfer} %{time_total}\n" \
      "${url}${sep}${param}=${key}" > "$tmp/t.$i" 2>&1 || echo "000 0 0" > "$tmp/t.$i"
  ) &
done
wait
printf "%-4s %-6s %-9s %-9s %s\n" "#" "code" "ttfb_s" "total_s" "instance/request id"
for i in $(seq 1 "$n"); do
  read -r code ttfb total < "$tmp/t.$i"
  id=$(grep -iE '^(x-nf-request-id|x-vercel-id|x-served-by|fly-request-id):' "$tmp/h.$i" | head -1 | cut -d' ' -f2- | tr -d '\r')
  printf "%-4s %-6s %-9s %-9s %s\n" "$i" "$code" "$ttfb" "$total" "${id:--}"
done | sort -k3 -n
slow=$(cat "$tmp"/t.* | awk '$2 > 10 {c++} END {print c+0}')
echo "slow (>10 s TTFB): $slow / $n"
rm -rf "$tmp"
