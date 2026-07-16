#!/bin/sh
# No-mock audit (CLAUDE.md §2.1, PRD §2.3): runtime code under apps/ and packages/
# must contain no mock/faker/fixture references. Test files are exempt.
# Exits non-zero and prints offenders if any are found.

set -eu

matches=$(grep -rniE 'mock|faker|fixture' apps packages \
  --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -vE '\.(test|spec)\.tsx?:' \
  | grep -vE '/__tests__/' \
  | grep -viE 'fixtureId' \
  || true)

if [ -n "$matches" ]; then
  echo "no-mock audit FAILED — mock/faker/fixture found in runtime code:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "no-mock audit passed: runtime code is clean."
