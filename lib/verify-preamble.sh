# Check helpers for `gotcha verify`.
#
# Lifted VERBATIM from repo-truth/verify.sh (the owner's offline verifier) so that a
# check evaluated by gotcha and the same check evaluated by verify.sh cannot diverge.
# Do not "improve" these: `code()` skipping comment lines, `has()` doing substring
# matching and `orphans()`'s conservative literal-path screen are all part of the
# contract that the existing checks were written against.
#
# Contract: ROOT is the directory containing the repo clones; HERE is the directory
# holding facts.yaml and its sidecar files (orphan-candidates.txt, web-route-groups.tsv).

file() { [[ $1 != /* && $1 != *..* && -f "$ROOT/$1" ]]; }
absent() { file "$1" || return 1; local text; text=$(<"$ROOT/$1"); [[ $text != *"$2"* ]]; }
missing() { [[ ! -e "$ROOT/$1" ]]; }
default_branch() { [[ $(git -C "$ROOT/$1" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) == "origin/$2" ]]; }
unresolved() { printf 'requires external evidence: %s\n' "$*"; return 2; }
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
    file "user-dashboard/$target" || return 1
    stem=${target##*/}; stem=${stem%.*}
    hits=$(git -C "$ROOT/user-dashboard" grep -n -F "$stem" -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' ':!**/node_modules/**' ':!repo-truth/**') && rc=0 || rc=$?
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
