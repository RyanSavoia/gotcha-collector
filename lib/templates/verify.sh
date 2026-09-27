#!/usr/bin/env bash
# Offline; Bash 3.2+ and git only. Never executes application code.
# Usage: bash repo-truth/verify.sh /directory/containing/the/clones
# --- which clones this table is written against ------------------------------
# Written by `gotcha init`. Every repo named here must be present next to the
# others under ROOT, because a check path starts with the repo name. This block
# is the ONLY repo-specific part of the file; everything below is generic.
GOTCHA_REPOS="__GOTCHA_REPOS__"
# The repo the `orphans` helper scans. Only tables that use `orphans` care.
GOTCHA_ORPHAN_REPO="__GOTCHA_ORPHAN_REPO__"
set -uo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=${1:-$(cd "$HERE/../.." && pwd)}
FACTS=${REPO_TRUTH_FACTS:-$HERE/facts.yaml}
REPORT=${REPO_TRUTH_REPORT:-}
[[ -f $FACTS ]] || { printf 'ERROR missing facts file\n' >&2; exit 2; }
[[ -z $REPORT ]] || : > "$REPORT"
file() { [[ $1 != /* && $1 != *..* && -f "$ROOT/$1" ]]; }
has() {
  file "$1" || { printf 'missing file: %s\n' "$1"; return 1; }
  local text; text=$(<"$ROOT/$1")
  [[ $text == *"$2"* ]] || { printf 'missing evidence: %s: %s\n' "$1" "$2"; return 1; }
}
code() {
  file "$1" || return 1
  local row trim
  while IFS= read -r row || [[ -n $row ]]; do
    trim=${row#"${row%%[![:space:]]*}"}
    case $trim in '//'*|'#'*|'*'*|'--'*) continue;; esac
    [[ $trim == "$2" ]] && return 0
  done < "$ROOT/$1"
  printf 'code line changed or missing: %s: %s\n' "$1" "$2"
  return 1
}
absent() { file "$1" || return 1; local text; text=$(<"$ROOT/$1"); [[ $text != *"$2"* ]]; }
missing() { [[ ! -e "$ROOT/$1" ]]; }
default_branch() { [[ $(git -C "$ROOT/$1" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) == "origin/$2" ]]; }
unresolved() { printf 'requires external evidence: %s\n' "$*"; return 2; }
normalize() {
  local part value=$1 result=''
  local -a parts=() stack=()
  IFS=/ read -r -a parts <<< "$value"
  for part in "${parts[@]}"; do
    case $part in ''|.) ;; ..) ((${#stack[@]})) && unset 'stack[${#stack[@]}-1]' ;; *) stack[${#stack[@]}]=$part;; esac
  done
  for part in "${stack[@]}"; do result=${result:+$result/}$part; done
  printf '%s' "$result"
}
orphans() {
  # Conservative literal-path screen, not a complete JavaScript module graph.
  local target source rest row spec resolved stem found hits rc count=0
  local quoted="[\"']([^\"']+)[\"']"
  while IFS= read -r target || [[ -n $target ]]; do
    [[ -n $target && $target != \#* ]] || continue
    file "$GOTCHA_ORPHAN_REPO/$target" || return 1
    stem=${target##*/}; stem=${stem%.*}
    hits=$(git -C "$ROOT/$GOTCHA_ORPHAN_REPO" grep -n -F "$stem" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' ':!**/node_modules/**' ':!repo-truth/**') && rc=0 || rc=$?
    ((rc <= 1)) || return "$rc"
    while IFS= read -r row; do
      [[ -n $row ]] || continue
      source=${row%%:*}; rest=${row#*:}; rest=${rest#*:}
      [[ $source != "$target" ]] || continue
      rest=${rest#"${rest%%[![:space:]]*}"}
      case $rest in '//'*|'*'*) continue;; esac
      while [[ $rest =~ $quoted ]]; do
        found=${BASH_REMATCH[0]}; spec=${BASH_REMATCH[1]}; rest=${rest#*"$found"}
        case $spec in @/*) resolved=$(normalize "${spec#@/}");; ./*|../*) resolved=$(normalize "${source%/*}/$spec");; *) continue;; esac
        if [[ $resolved == "$target" || $resolved == "${target%.*}" || $resolved/index == "${target%.*}" ]]; then
          printf 'incoming literal path: %s -> %s\n' "$source" "$target"; return 1
        fi
      done
    done <<< "$hits"
    count=$((count+1))
  done < "$HERE/orphan-candidates.txt"
  [[ $count == 43 ]]
}
groups() {
  local consumer needle server declaration
  while IFS=$'\t' read -r consumer needle server declaration; do
    [[ -n $consumer && $consumer != \#* ]] || continue
    code "$consumer" "$needle" && code "$server" "$declaration" || return 1
  done < "$HERE/web-route-groups.tsv"
}
id='' status='' check='' in_check=0 total=0 regressions=0 seen='|'
claim=0 scope=0 evidence=0 dated=0
fail_schema() { emit "SCHEMA-ERROR ${id:-header}: $*"; exit 2; }
emit() { printf '%s\n' "$*"; [[ -z $REPORT ]] || printf '%s\n' "$*" >> "$REPORT"; }
run_fact() {
  [[ -n $id ]] || return 0
  [[ $seen != *"|$id|"* ]] || fail_schema 'duplicate id'
  seen="$seen$id|"
  [[ $claim == 1 && $scope == 1 && $evidence == 1 && $dated == 1 && -n $check ]] || fail_schema 'missing required field'
  case $status in verified|verified-runtime|human-asserted|failed) ;; *) fail_schema 'invalid status';; esac
  local output rc label
  output=$( (set -e; eval "$check") 2>&1) && rc=0 || rc=$?
  total=$((total+1))
  case $status in
    verified) if ((rc==0)); then label=PASS; else label=FAIL; regressions=$((regressions+1)); fi;;
    verified-runtime) label=RUNTIME-NOT-RECHECKED;;
    human-asserted) label=HUMAN-ASSERTED;;
    failed) if ((rc==0)); then label=RECOVERED; else label=KNOWN-FAIL; fi;;
  esac
  emit "$label $id (check exit $rc)"
  [[ -z $output ]] || emit "  $output"
}
for repo in $GOTCHA_REPOS; do
  git -C "$ROOT/$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { emit "INFRA-FAIL missing clone $repo"; exit 2; }
  emit "SNAPSHOT $repo $(git -C "$ROOT/$repo" rev-parse HEAD)"
done
while IFS= read -r line || [[ -n $line ]]; do
  if [[ $line == '  - id: '* ]]; then
    run_fact
    id=${line#'  - id: '}; [[ $id =~ ^[a-z0-9][a-z0-9-]+$ ]] || fail_schema 'invalid id'
    status=''; check=''; in_check=0; claim=0; scope=0; evidence=0; dated=0
    continue
  fi
  [[ -n $id ]] || continue
  if ((in_check)); then
    if [[ $line == '      '* ]]; then check+="${line#'      '}"$'\n'; continue; fi
    in_check=0
  fi
  case $line in
    '    claim: '*) claim=1;;
    '    scope: ['*) scope=1;;
    '    evidence: ['*) [[ $line != '    evidence: []' ]] || fail_schema 'empty evidence'; evidence=1;;
    '    check: |') in_check=1;;
    '    status: '*) status=${line#'    status: '};;
    '    verified_at: '*) dated=1;;
    '    note: '*|'    resolution: '*|'    recheck: '*|'    open_decision: '*) ;;
    '    provenance: '*) ;;   # how the fact entered the table (e.g. auto-gauntlet)
    '    counterexample: '*) ;;  # whether a falsifying mutation was demonstrated
    '    enforce: '*) ;;         # owner-set: this fact may block a matching command
    ''|'#'*) ;;
    *) fail_schema "unsupported YAML field or indentation: $line";;
  esac
done < "$FACTS"
run_fact
((total>0)) || fail_schema 'zero facts'
emit "SUMMARY facts=$total verified_regressions=$regressions"
((regressions==0))
