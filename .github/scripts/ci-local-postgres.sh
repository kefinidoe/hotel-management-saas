#!/usr/bin/env bash
# Start only a newly created, marked runner-local cluster. Never use an ambient URL.
set -euo pipefail
root=${1:?expected new disposable root}
pgbin=${2:?expected PostgreSQL bin directory}
[[ -d "$root" && ! -L "$root" && ! -e "$root/pgdata" && ! -e "$root/DISPOSABLE" ]]
printf 'DISPOSABLE_HOTEL_SAAS_ONLY\n' > "$root/DISPOSABLE"
"$pgbin/initdb" -D "$root/pgdata" -U postgres -A trust --no-instructions
"$pgbin/pg_ctl" -D "$root/pgdata" -l "$root/postgres.log" -o "-h 127.0.0.1 -p 55434 -k $root" -w start
# Verify both the Unix socket's server identity and TCP listener ownership before
# creating a database or applying migrations. A port conflict must fail closed.
pid=$(sed -n '1p' "$root/pgdata/postmaster.pid")
[[ "$pid" =~ ^[0-9]+$ ]]
[[ $(sed -n '2p' "$root/pgdata/postmaster.pid") == "$root/pgdata" ]]
[[ $(sed -n '4p' "$root/pgdata/postmaster.pid") == 55434 ]]
inode=$(awk '$2 == "0100007F:D88A" && $4 == "0A" {print $10}' /proc/net/tcp)
[[ "$inode" =~ ^[0-9]+$ ]]
found=0
for fd in /proc/"$pid"/fd/*; do
  if [[ $(readlink "$fd" || true) == "socket:[$inode]" ]]; then found=1; break; fi
done
[[ $found == 1 ]]
actual=$("$pgbin/psql" -h "$root" -p 55434 -U postgres -d postgres -Atc 'SHOW data_directory')
[[ "$actual" == "$root/pgdata" ]]
"$pgbin/createdb" -h "$root" -p 55434 -U postgres hotel_saas_disposable_audit
printf 'Verified marked local PostgreSQL cluster: %s, port 55434\n' "$root"
