#!/bin/sh
# No-mock audit (CLAUDE.md §2.1, PRD §2.3/§10): runtime code under apps/ and
# packages/ must contain no mock/faker references and no fixture-data imports.
# Test files are exempt. NOTE: the word "fixture" alone is legitimate sports
# vocabulary (a fixture = a scheduled match; fixtureId is TxLINE's id) — what
# is banned is fixture *data*: fixtures/ directories, *.fixture.* files, and
# imports from fixture paths (PRD §10 criterion 3).

set -eu

fail=0

content=$(grep -rniE '\bmock|faker' apps packages \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -vE '\.(test|spec)\.tsx?:' \
  | grep -vE '/__tests__/' \
  || true)

fixture_imports=$(grep -rnE "(import|require).*['\"/](fixtures?)/" apps packages \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -vE '\.(test|spec)\.tsx?:' \
  || true)

fixture_files=$(find apps packages \
  \( -name '*.fixture.*' -o \( -type d -name 'fixtures' \) \) \
  -not -path '*/node_modules/*' 2>/dev/null || true)

if [ -n "$content" ]; then
  echo "no-mock audit FAILED — mock/faker found in runtime code:" >&2
  echo "$content" >&2
  fail=1
fi
if [ -n "$fixture_imports" ]; then
  echo "no-mock audit FAILED — fixture-data imports in runtime code:" >&2
  echo "$fixture_imports" >&2
  fail=1
fi
if [ -n "$fixture_files" ]; then
  echo "no-mock audit FAILED — fixture data files/directories present:" >&2
  echo "$fixture_files" >&2
  fail=1
fi

[ "$fail" -eq 0 ] && echo "no-mock audit passed: runtime code is clean."
exit "$fail"
