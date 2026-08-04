#!/usr/bin/env bash
# Manually dispatch up to MAX ready-for-agent tickets as background `claude` sessions.
#
# Usage:
#   scripts/dispatch-tickets.sh              # auto-compute the frontier, dispatch up to MAX
#   scripts/dispatch-tickets.sh 10 11 15     # dispatch exactly these ticket numbers (still
#                                             # skipped if already assigned or blocked)
#
# Each dispatched ticket: claimed via assignee, worked in its own git worktree branch
# (worktree-ticket-<n>-<slug>, matching existing PRs #47-#52), one PR per ticket.
set -euo pipefail

MAX="${MAX:-3}"
LOG_DIR="${LOG_DIR:-.claude/dispatch-logs}"
mkdir -p "$LOG_DIR"

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

is_blocked() {
  local n="$1"
  gh api "repos/$REPO/issues/$n" --jq '.issue_dependencies_summary.blocked_by'
}

is_assigned() {
  local n="$1"
  gh issue view "$n" --json assignees --jq '.assignees | length'
}

if [ "$#" -gt 0 ]; then
  candidates=("$@")
else
  echo "No ticket IDs given -- computing frontier (ready-for-agent, open, unassigned)..." >&2
  candidates=()
  while IFS= read -r n; do
    candidates+=("$n")
  done < <(gh issue list --state open --label ready-for-agent --json number,assignees \
      --jq '.[] | select(.assignees | length == 0) | .number' | sort -n)
fi

dispatched=0
for n in "${candidates[@]}"; do
  if [ "$dispatched" -ge "$MAX" ]; then
    echo "Reached max of $MAX dispatches this run; stopping (remaining candidates skipped)." >&2
    break
  fi

  if [ "$(is_assigned "$n")" -gt 0 ]; then
    echo "#$n already assigned -- skipping." >&2
    continue
  fi

  blocked_by="$(is_blocked "$n")"
  if [ "$blocked_by" -gt 0 ]; then
    echo "#$n has $blocked_by open blocker(s) -- skipping." >&2
    continue
  fi

  title="$(gh issue view "$n" --json title --jq .title)"
  slug="$(echo "$title" \
    | sed -E 's/^[0-9]+ *(—|-) *//' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -c 'a-z0-9' '-' \
    | sed -E 's/-+/-/g; s/^-|-$//g' \
    | cut -c1-40)"
  branch="worktree-ticket-${n}-${slug}"

  echo "Claiming and dispatching #$n ($title) on branch $branch..." >&2
  gh issue edit "$n" --add-assignee @me

  prompt="$(cat <<EOF
Implement GitHub issue #$n in this repo ($REPO): "$title".

- Work in an isolated git worktree on branch $branch.
- Read the issue (\`gh issue view $n --comments\`), plus CONTEXT.md and any ADRs it references.
- Follow the repo's existing conventions and run the test suite.
- Commit, push $branch, and open a PR titled "Ticket #$n — $title".
- Leave issue #$n open -- it gets closed when the PR merges, not by you.
EOF
)"

  logfile="$LOG_DIR/ticket-${n}.log"
  # NOTE: adjust this line to match however you actually start a background `claude`
  # session in your environment -- `claude -p` here is a best-effort default that could
  # not be verified from within this sandboxed session (see the design doc, section 6).
  claude -p "$prompt" > "$logfile" 2>&1 &
  echo "  -> PID $!  log: $logfile"

  dispatched=$((dispatched + 1))
done

echo "Dispatched $dispatched ticket(s) this run."
