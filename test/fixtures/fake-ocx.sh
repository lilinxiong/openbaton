#!/bin/sh
printf "%s\n" "$*" >> "$OCX_ARGV_LOG"
if [ "$1" = "account" ] && [ "$2" = "list" ]; then
  echo "PROVIDER TYPE ID"
  echo "kimi oauth acc-1"
  exit 0
fi
if [ "$1" = "account" ] && [ "$2" = "login" ]; then
  echo "login $3"
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
