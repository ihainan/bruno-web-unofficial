#!/usr/bin/env bash
# Weekly upstream upgrade job.
#
# Moves Bruno Web to the newest Bruno release in a dedicated clone, runs the
# upgrade gate (scripts/upstream-gate.sh) with the current pin as its baseline
# (failures that also happen there do not count), and:
#   gate passes            commit, push to main (CI then builds the image)
#   gate fails             run a coding agent to adapt Bruno Web, run the
#                          whole gate again itself, open a pull request for
#                          review (draft if it still fails). Agent changes are
#                          never merged without review.
# The script, not the agent, runs the gate and decides; notifications are sent
# from here so a crashed or stuck agent still gets reported.
#
# Configuration (environment):
#   BRUNO_WEB_AUTO_DIR        work directory: clone, logs, lock, state (required)
#   BRUNO_WEB_AUTO_REPO       repository to clone (default: git@github.com:ihainan/bruno-web.git)
#   BRUNO_WEB_AUTO_NOTIFY     command run as: $NOTIFY <key> <title> <body>   (optional)
#   BRUNO_WEB_AUTO_AGENT      agent CLI (default: claude)
#   BRUNO_WEB_AUTO_BUDGET_USD agent spending cap per run (default: 25)
#   BRUNO_WEB_AUTO_AGENT_TIMEOUT  (default: 3h)
#   BRUNO_WEB_AUTO_START_MIN_MB   do not start below this much free memory (default: 12288)
#   BRUNO_WEB_AUTO_TARGET     upgrade to this tag or commit instead of the latest release (testing)
#   BRUNO_WEB_AUTO_FORCE      1: run even if this week is done / the branch exists
#   BRUNO_WEB_AUTO_NO_PUSH    1: do everything except push, merge and pull requests (testing)
#   BRUNO_WEB_AUTO_SKIP_UPSTREAM_E2E  1: gate without upstream's suite (testing only)
#   BRUNO_WEB_AUTO_TEST_BREAK  1: break a selector after branching, so the gate
#                             fails and the agent path runs (testing only)
set -uo pipefail

WORK=${BRUNO_WEB_AUTO_DIR:?set BRUNO_WEB_AUTO_DIR}
REPO_URL=${BRUNO_WEB_AUTO_REPO:-git@github.com:ihainan/bruno-web.git}
UPSTREAM_REPO=usebruno/bruno
AGENT=${BRUNO_WEB_AUTO_AGENT:-claude}
BUDGET=${BRUNO_WEB_AUTO_BUDGET_USD:-25}
AGENT_TIMEOUT=${BRUNO_WEB_AUTO_AGENT_TIMEOUT:-3h}
START_MIN_MB=${BRUNO_WEB_AUTO_START_MIN_MB:-12288}
NOTIFY=${BRUNO_WEB_AUTO_NOTIFY:-}
FORCE=${BRUNO_WEB_AUTO_FORCE:-0}
NO_PUSH=${BRUNO_WEB_AUTO_NO_PUSH:-0}
export GATE_SKIP_UPSTREAM_E2E=${BRUNO_WEB_AUTO_SKIP_UPSTREAM_E2E:-0}

mkdir -p "$WORK/runs" "$WORK/state"
RUN="$WORK/runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
exec > >(tee -a "$RUN/job.log") 2>&1
CLONE="$WORK/repo"
WEEK=$(date +%G-W%V)
NOTIFIED=0

log() { echo "[$(date '+%F %T')] $*"; }

notify() { # key title body
  NOTIFIED=1
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RUN/notifications.tsv"
  [ -n "$NOTIFY" ] && $NOTIFY "$1" "$2" "$3" || true
}

fail() { # step message
  log "FAILED at $1: $2"
  notify "bruno-web-weekly-error" "Bruno 升级任务出错" "$WEEK 在「$1」这一步出错：$2。日志 $RUN/job.log"
  exit 1
}

on_exit() {
  local code=$?
  if [ "$code" != 0 ] && [ "$NOTIFIED" = 0 ]; then
    notify "bruno-web-weekly-error" "Bruno 升级任务异常退出" "$WEEK 任务以退出码 $code 结束且没有给出结论。日志 $RUN/job.log"
  fi
}
trap on_exit EXIT

exec 9> "$WORK/lock"
flock -n 9 || { log "another run holds the lock; exiting"; NOTIFIED=1; exit 0; }

if [ -f "$WORK/state/done-$WEEK" ] && [ "$FORCE" != 1 ]; then
  log "already done this week ($(cat "$WORK/state/done-$WEEK")); exiting"
  exit 0
fi
mark_done() { echo "$1" > "$WORK/state/done-$WEEK"; log "week $WEEK: $1"; }

avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if [ "$avail" -lt "$START_MIN_MB" ]; then
  log "only ${avail} MB free (< $START_MIN_MB); not starting"
  # The next scheduled attempt this week tries again; say so only once a week.
  if [ ! -f "$WORK/state/lowmem-$WEEK" ]; then
    touch "$WORK/state/lowmem-$WEEK"
    notify "bruno-web-weekly-lowmem" "Bruno 升级任务推迟" "本机可用内存只有 ${avail} MB，低于 ${START_MIN_MB} MB，本次没有开始，本周稍后会再试。"
  fi
  NOTIFIED=1
  exit 0
fi

# ---------------------------------------------------------------- clone
log "updating clone in $CLONE"
if [ ! -d "$CLONE/.git" ]; then
  git clone -q "$REPO_URL" "$CLONE" || fail "clone" "git clone 失败"
fi
cd "$CLONE" || fail "clone" "进不了 $CLONE"
git fetch -q --prune origin || fail "fetch" "git fetch 失败"
git checkout -q -f main && git reset -q --hard origin/main && git clean -qfdx -e upstream -e node_modules \
  || fail "reset" "重置到 origin/main 失败"

# ---------------------------------------------------------------- target
current=$(tr -d '[:space:]' < UPSTREAM_COMMIT)
target_ref=${BRUNO_WEB_AUTO_TARGET:-$(gh api "repos/$UPSTREAM_REPO/releases/latest" --jq .tag_name)} \
  || fail "target" "查不到上游最新版本"
[ -n "$target_ref" ] || fail "target" "上游最新版本为空"
target=$(gh api "repos/$UPSTREAM_REPO/commits/$target_ref" --jq .sha) || fail "target" "查不到 $target_ref 对应的提交"
current_tag=$(gh api "repos/$UPSTREAM_REPO/tags?per_page=100" --jq ".[] | select(.commit.sha == \"$current\") | .name" | head -1)
current_label=${current_tag:-main@${current::10}}
log "current: $current_label ($current), target: $target_ref ($target)"

if [ "$target" = "$current" ]; then
  mark_done "up to date at $current_label"
  NOTIFIED=1; exit 0
fi
if [ -z "${BRUNO_WEB_AUTO_TARGET:-}" ] && [ -n "$current_tag" ] \
   && [ "$(printf '%s\n%s\n' "${current_tag#v}" "${target_ref#v}" | sort -V | tail -1)" = "${current_tag#v}" ]; then
  mark_done "pinned $current_tag is not older than $target_ref"
  NOTIFIED=1; exit 0
fi
# Pinned to a main commit: releases are cut on release branches, so a release
# can lack main's newer work. Only upgrade to a release that contains the pin.
if [ -z "${BRUNO_WEB_AUTO_TARGET:-}" ] && [ -z "$current_tag" ]; then
  read -r rel ahead behind < <(gh api "repos/$UPSTREAM_REPO/compare/$current...$target" --jq '"\(.status) \(.ahead_by) \(.behind_by)"') \
    || fail "target" "比较 $current_label 与 $target_ref 失败"
  if [ "$rel" != ahead ]; then
    if [ ! -f "$WORK/state/skipped-$target_ref" ]; then
      touch "$WORK/state/skipped-$target_ref"
      notify "bruno-web-weekly-skip" "Bruno $target_ref 不升级" "现在用的是 Bruno 主分支上的 $current_label，最新正式版 $target_ref 不包含它（少 $behind 个提交），换过去会丢功能。先不升级，等出了包含它的正式版再升。"
    fi
    mark_done "latest release $target_ref does not contain the pinned $current_label ($rel, $behind behind)"
    NOTIFIED=1; exit 0
  fi
fi

BRANCH="auto/upstream-${target_ref//[^A-Za-z0-9._-]/-}"
if [ "$FORCE" != 1 ] && git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null 2>&1; then
  mark_done "branch $BRANCH already exists (waiting for review)"
  NOTIFIED=1; exit 0
fi
COMPARE="https://github.com/$UPSTREAM_REPO/compare/$current...$target"
git checkout -q -B "$BRANCH" origin/main
echo "$target" > UPSTREAM_COMMIT
if [ "${BRUNO_WEB_AUTO_TEST_BREAK:-0}" = 1 ]; then
  log "TEST_BREAK: renaming a selector in web/bridge.js"
  sed -i "s/'.close-gradient.has-changes'/'.close-gradient.has-unsaved-edits'/" web/bridge.js
  git -c core.hooksPath=/dev/null commit -q -am "Test: break a selector (weekly job self-test)"
fi

# ---------------------------------------------------------------- gate
export GATE_BASELINE_COMMIT=$current GATE_BASELINE_DIR="$WORK/upstream-baseline"
log "gate 1 (upstream $target_ref, baseline $current_label)"
scripts/upstream-gate.sh "$RUN/gate1"
gate1=$?
upstream_line() { grep -m1 -E '^upstream e2e:' "$1/upstream-e2e.log" 2>/dev/null; }
counts() { # gate dir -> one line of upstream counts
  local f="$1/upstream-summary.json"
  [ -f "$f" ] || { echo "上游整套测试未运行"; return; }
  node -e 'const s=require(process.argv[1]); const b=(s.baseline||[]).length; console.log(`上游测试 ${s.total} 个：首次通过 ${s.passed}，重试后通过 ${s.flaky.length}，已知差异 ${s.known.length}，${b ? `旧版本也失败 ${b}（不算），` : ""}新失败 ${s.failed.length + s.notRun.length}`)' "$f"
}
baseline_note() { # gate dir -> commit message lines for failures the baseline shares
  local f="$1/upstream-summary.json"
  [ -f "$f" ] && node -e 'const b=require(process.argv[1]).baseline||[]; if (b.length) console.log(`\nAlso failing against the previous upstream, so not counted:\n${b.map((t) => `  ${t}`).join("\n")}`)' "$f"
}

push_branch() {
  [ "$NO_PUSH" = 1 ] && { log "NO_PUSH: not pushing $BRANCH"; return 0; }
  git push -q -f origin "$BRANCH"
}

open_pr() { # title body-file [--draft]
  [ "$NO_PUSH" = 1 ] && { log "NO_PUSH: would open PR \"$1\"" >&2; echo "(dry run, no PR)"; return 0; }
  gh pr create --base main --head "$BRANCH" --title "$1" --body-file "$2" ${3:-}
}

if [ "$gate1" = 0 ]; then
  git add UPSTREAM_COMMIT web/channels.json
  git commit -q -m "Upgrade Bruno to $target_ref

Upstream: $COMPARE
The upgrade gate passed without changes to Bruno Web: unit tests, upstream
selector check, selfcheck, Bruno Web e2e and upstream's e2e suite.
$(upstream_line "$RUN/gate1")$(baseline_note "$RUN/gate1")" || fail "commit" "提交失败"
  if [ "$NO_PUSH" = 1 ]; then
    log "NO_PUSH: would push $BRANCH and fast-forward main"
  elif git push -q origin "HEAD:main"; then
    git push -q origin --delete "$BRANCH" 2>/dev/null || true
    # CI builds and smoke-tests the image from main; wait for it so a broken
    # image build is reported here too, not only by GitHub's e-mail.
    ci="CI 结果未知"
    sha=$(git rev-parse HEAD)
    for _ in $(seq 1 30); do
      run_id=$(gh run list --commit "$sha" --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
      [ -n "$run_id" ] && break
      sleep 20
    done
    if [ -n "${run_id:-}" ]; then
      if timeout 90m gh run watch "$run_id" --exit-status --interval 60 > "$RUN/ci-watch.log" 2>&1; then ci="CI（测试 + 镜像构建与冒烟）通过"
      else ci="但 GitHub CI 失败了，请看 https://github.com/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/actions/runs/$run_id"; fi
    fi
    notify "bruno-web-weekly-done" "Bruno 已升级到 $target_ref" "测试全部通过并已合并到 main，$ci。$(counts "$RUN/gate1")。"
  else
    push_branch || fail "push" "推送分支失败"
    cp "$RUN/gate1/summary.md" "$RUN/pr-body.md"
    url=$(open_pr "Upgrade Bruno to $target_ref" "$RUN/pr-body.md") || fail "pr" "开 PR 失败"
    notify "bruno-web-weekly-done" "Bruno $target_ref 待合并" "测试全部通过，但 main 在此期间有新提交，没能直接合并，已开 PR：$url"
  fi
  mark_done "upgraded to $target_ref (gate passed)"
  exit 0
fi

# ---------------------------------------------------------------- agent
log "gate 1 failed; running the agent"
brief=$(cat scripts/auto-update/agent-brief.md)
summary=$(cat "$RUN/gate1/summary.md")
brief=${brief//\{\{REPO\}\}/$CLONE}
brief=${brief//\{\{BRANCH\}\}/$BRANCH}
brief=${brief//\{\{CURRENT\}\}/$current_label}
brief=${brief//\{\{TARGET\}\}/$target_ref}
brief=${brief//\{\{COMPARE_URL\}\}/$COMPARE}
brief=${brief//\{\{GATE_DIR\}\}/$RUN/gate1}
brief=${brief//\{\{RUN\}\}/$RUN}
brief=${brief//\{\{SUMMARY\}\}/$summary}
printf '%s\n' "$brief" > "$RUN/agent-brief.md"
before_agent=$(git rev-parse HEAD)

timeout "$AGENT_TIMEOUT" "$AGENT" -p "$brief" \
  --permission-mode auto \
  --output-format json \
  --max-budget-usd "$BUDGET" \
  --disallowedTools "Bash(git push:*)" "Bash(git commit:*)" "Bash(gh:*)" \
  > "$RUN/agent.json" 2> "$RUN/agent.stderr"
agent_exit=$?
agent_field() { node -e 'const fs=require("fs");let d={};try{const t=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");d=JSON.parse(t[t.length-1])}catch(e){};const v=d[process.argv[2]];console.log(v===undefined?"":(typeof v==="string"?v:JSON.stringify(v)))' "$RUN/agent.json" "$1"; }
agent_cost=$(agent_field total_cost_usd)
agent_session=$(agent_field session_id)
agent_result=$(agent_field result)
log "agent exit $agent_exit, cost \$${agent_cost:-?}, session ${agent_session:-?}"

# Nothing outside Bruno Web's own files may change.
changed=$(git status --porcelain | cut -c4-)
outside=$(printf '%s\n' "$changed" | grep -v -E '^(server/|web/|test/|scripts/|docs/|README\.md|CLAUDE\.md|Dockerfile|package\.json|package-lock\.json|UPSTREAM_COMMIT|patches/|$)' || true)
if [ -n "$outside" ]; then
  log "agent changed files outside Bruno Web's own: $outside"
fi
if [ "$(git rev-parse HEAD)" != "$before_agent" ]; then
  log "note: the agent created commits despite the brief; they are kept for review"
fi

# ---------------------------------------------------------------- gate 2
log "gate 2 (after the agent)"
rm -f upstream/.bruno-web-built   # rebuild upstream from scratch: the agent must not have changed it
scripts/upstream-gate.sh "$RUN/gate2"
gate2=$?

msg_file="$RUN/agent-commit-message.txt"
[ -s "$msg_file" ] || printf 'Adapt to Bruno %s\n\nUpstream: %s\n' "$target_ref" "$COMPARE" > "$msg_file"
git add -A
git -c core.hooksPath=/dev/null commit -q -F "$msg_file" || log "nothing to commit after the agent"

{
  if [ "$gate2" = 0 ]; then echo "The weekly job upgraded Bruno to **$target_ref**. The gate failed at first; a coding agent adapted Bruno Web and the full gate then passed. **Review before merging.**"
  else echo "The weekly job tried to upgrade Bruno to **$target_ref**. The gate failed; a coding agent tried to adapt Bruno Web, and **the gate still fails**. Needs a person."; fi
  echo
  echo "Upstream changes: $COMPARE"
  echo
  if git diff --name-only origin/main...HEAD | grep -q '^test/upstream-e2e/known-failures.txt$'; then
    echo "> **Note:** this change edits \`test/upstream-e2e/known-failures.txt\`. Check every added line is a real browser/Electron difference."
    echo
  fi
  [ -n "$outside" ] && { echo "> **Note:** the agent touched files outside Bruno Web's own: \`$outside\`"; echo; }
  echo "### Agent report"
  echo
  if [ -s "$RUN/agent-report.md" ]; then cat "$RUN/agent-report.md"; else echo "${agent_result:-（no report; agent exit code $agent_exit）}"; fi
  echo
  echo "Agent: exit $agent_exit, cost \$${agent_cost:-?}, session \`${agent_session:-?}\` (resume in $CLONE with \`claude --resume <session>\`)."
  echo
  echo "### Gate before the agent"
  echo
  cat "$RUN/gate1/summary.md"
  echo
  echo "### Gate after the agent"
  echo
  cat "$RUN/gate2/summary.md"
} > "$RUN/pr-body.md"
# GitHub caps a pull request body at 65536 characters.
head -c 60000 "$RUN/pr-body.md" > "$RUN/pr-body.trimmed.md"

push_branch || fail "push" "推送分支 $BRANCH 失败"
if [ "$gate2" = 0 ]; then
  url=$(open_pr "Upgrade Bruno to $target_ref (adapted, needs review)" "$RUN/pr-body.trimmed.md") || fail "pr" "开 PR 失败"
  notify "bruno-web-weekly-review" "Bruno $target_ref 待审核" "上游改动需要适配，agent 改完后测试全部通过（$(counts "$RUN/gate2")），请审核 PR：$url"
  mark_done "adapted to $target_ref, PR opened"
else
  url=$(open_pr "WIP: upgrade Bruno to $target_ref (gate still failing)" "$RUN/pr-body.trimmed.md" --draft) || fail "pr" "开 PR 失败"
  notify "bruno-web-weekly-failed" "Bruno $target_ref 升级失败" "agent 修过后测试仍不通过，需要人工处理。草稿 PR：$url"
  mark_done "upgrade to $target_ref failed after the agent, draft PR opened"
fi
exit 0
