#!/usr/bin/env bash
# Reverse-verify the new invariants: break each one, confirm the suite notices.
#
# A green suite is only evidence if it can go red for the specific defect it
# claims to catch. Each mutation below reintroduces one real bug; the named test
# must fail, then the file is restored. Anything reported "NOT CAUGHT" means the
# test is decorative.
set -u
cd "$(dirname "$0")/.."

BACKUP=$(mktemp -d)
cp lib/live-cursor.js lib/selfcheck.js lib/digester.js "$BACKUP/"
restore() { cp "$BACKUP"/live-cursor.js "$BACKUP"/selfcheck.js "$BACKUP"/digester.js lib/; }

run() { node scripts/incrementaltest.mjs 2>&1; }

# Find the name of the first failing check, or "" when everything passed.
first_failure() { run | grep -E '^ FAIL |^  - ' | head -1; }

check_mutation() {
  local label="$1" expect="$2"
  local out
  out=$(run)
  if echo "$out" | grep -q "all .* checks passed"; then
    echo "  NOT CAUGHT  $label — suite stayed green"
  elif echo "$out" | grep -qiE "$expect"; then
    echo "  caught      $label"
    echo "$out" | grep -E '^ FAIL ' | head -2 | sed 's/^/                /' | cut -c1-140
  else
    echo "  WRONG RED   $label — failed, but no test named '$expect'"
    echo "$out" | grep -E '^ FAIL ' | head -3 | sed 's/^/                /'
  fi
  restore
}

# Anchor mutations on a regex rather than a literal value: a mutation that silently
# fails to apply reports "NOT CAUGHT" and looks like a weak test when the real
# problem is that the edit never happened.
apply_mutation() {
  local file="$1" pattern="$2" replacement="$3"
  perl -0pi -e "$pattern" "$file"
  if ! grep -qE "$replacement" "$file"; then
    echo "  APPLY FAILED  pattern did not match in $file: $pattern" >&2
    return 1
  fi
}

echo "=== mutation 1: drop the partial-digest guard (would allow deleting a half-remembered log) ==="
apply_mutation lib/digester.js 's/state\.digested\[sessionId\]\?\.partial === true/false/' 'partial === false|&& false'
check_mutation "PARTIAL_DIGEST guard removed" "only partially remembered"

echo "=== mutation 2: ignore the cursor (would re-send already-digested content) ==="
apply_mutation lib/live-cursor.js 's/if \(seq <= lastSeq\) continue;/if (false) continue;/' 'if \(false\) continue;'
check_mutation "cursor exclusion removed" "watermark are excluded|only the new turns"

echo "=== mutation 3: delete instead of supersede (would destroy history) ==="
apply_mutation lib/selfcheck.js 's/loser\.validUntil = new Date\(now\)\.toISOString\(\);/ledger.facts = ledger.facts.filter((f) => f !== loser);/' 'ledger\.facts = ledger\.facts\.filter'
check_mutation "duplicate rows deleted instead of superseded" "no row may be removed|should become invalidated"

echo "=== mutation 4: lower the dedupe threshold to 0.5 (would merge same-topic facts) ==="
apply_mutation lib/selfcheck.js 's/export const FACT_DEDUPE_THRESHOLD = [0-9.]+;/export const FACT_DEDUPE_THRESHOLD = 0.5;/' 'FACT_DEDUPE_THRESHOLD = 0\.5;'
check_mutation "dedupe threshold lowered to 0.5" "separates restatements from same-topic noise"

echo "=== mutation 5: allow cross-kind merges (would promote a decision to a fact) ==="
apply_mutation lib/selfcheck.js 's/if \(live\[i\]\.kind !== live\[j\]\.kind\) continue;/if (false) continue;/' 'if \(false\) continue;'
check_mutation "cross-kind merge allowed" "different kinds are never merged"

echo "=== mutation 6: make a dry run write (would mutate the store on a report) ==="
apply_mutation lib/selfcheck.js 's/if \(!apply\) continue;/if (false) continue;/' 'if \(false\) continue;'
check_mutation "dry run applies changes" "dry run retires duplicates"

echo "=== mutation 7: never flag a skill as mergeable (would make the merge action dead code) ==="
apply_mutation lib/selfcheck.js 's/export const SKILL_MERGE_THRESHOLD = [0-9.]+;/export const SKILL_MERGE_THRESHOLD = 0.99;/' 'SKILL_MERGE_THRESHOLD = 0\.99;'
check_mutation "skill merge threshold unreachable" "skill redundancy is detected"

echo "=== mutation 8: let a stale-floor prune every kind (would retire decisions) ==="
apply_mutation lib/selfcheck.js "s/const PRUNABLE_KINDS = new Set\(\[[^]]*\]\);/const PRUNABLE_KINDS = new Set(['open', 'decision']);/" "PRUNABLE_KINDS = new Set\(\['open', 'decision'\]\)"
check_mutation "stale sweep widened to decisions" "only touches fast-decaying open"

restore
rm -rf "$BACKUP"
echo
echo "=== restore verified: full suite ==="
run | tail -2
