#!/bin/sh
printf "%s\n" "$*" >> "$OCX_ARGV_LOG"
if [ "$1" = "--version" ]; then
  echo "opencodex-test"
  exit 0
fi
if [ "$1" = "models" ] && [ "$2" = "live" ] && [ "$3" = "--json" ]; then
  echo '{"models":[]}'
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
