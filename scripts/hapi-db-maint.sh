#!/usr/bin/env bash
# ECS transient SQLite snapshots + weekly planner statistics, triggered from desktop.
# Snapshots are staged for offsite verification/transfer, not retained ECS backups.
set -euo pipefail
umask 027
RUN_ID=${HAPI_BACKUP_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
[[ "$RUN_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || {
    echo "Invalid HAPI_BACKUP_RUN_ID: expected UTC YYYYmmddTHHMMSSZ" >&2
    exit 1
}
ROOT=${HAPI_DB_BACKUP_ROOT:-/data/hapi-backups/offsite-staging}
SRC=${HAPI_DB_SOURCE:-/root/.hapi}
HAPI_BIN=${HAPI_BIN:-/usr/lib/node_modules/@twsxtd/hapi/node_modules/@twsxtd/hapi-linux-x64/bin/hapi}
SNAPSHOT=${HAPI_SNAPSHOT_SCRIPT:-/root/bin/snapshot-db.js}
COMPRESS=${HAPI_COMPRESS_SCRIPT:-/root/bin/compress-hapi-backups.sh}
MIN_FREE=${HAPI_BACKUP_MIN_FREE_BYTES:-5368709120}
[ -f "$SRC/hapi.db" ] || { echo "Missing source database: $SRC/hapi.db" >&2; exit 1; }
mkdir -p "$ROOT"
ROOT=$(realpath -e "$ROOT")
# All run IDs share one lock; never overlap snapshots or planner-stat injection.
exec 8>"$ROOT/.maintenance.lock"
flock -n 8 || { echo "Maintenance already running; no snapshots generated" >&2; exit 1; }
DST=$ROOT/$RUN_ID
mkdir -p "$DST"
log() { echo "$(date '+%F %T') $*"; }
has_room() {
    local blocks block_size
    read -r blocks block_size < <(stat -f -c '%a %S' "$ROOT")
    (( blocks * block_size >= $1 + MIN_FREE ))
}
log "start run=$RUN_ID; staging for offsite transfer, not a retained ECS backup"
FAILED=0
QC=missing
for f in hapi.db multi-user-gateway.sqlite session-digests.sqlite work-overview.sqlite subscription-snapshots.sqlite; do
    if [ ! -f "$SRC/$f" ]; then
        log "snapshot $f FAILED: missing source database"
        FAILED=1
        continue
    fi
    if [ -f "$DST/$f.gz" ]; then
        if gzip -t "$DST/$f.gz"; then
            log "snapshot $f skipped (verified compressed staging exists for $RUN_ID)"
        else
            log "snapshot $f FAILED: corrupt compressed staging"
            FAILED=1
        fi
        continue
    fi
    if [ -f "$DST/$f" ]; then
        log "snapshot $f skipped (staging exists for $RUN_ID; compression pending)"
        continue
    fi
    if ! has_room "$(stat -c %s "$SRC/$f")"; then
        log "snapshot $f FAILED: insufficient space; preserving $MIN_FREE bytes for hub storage"
        FAILED=1
        continue
    fi
    # An interrupted snapshot is never mistaken for successful offsite staging.
    partial=$DST/$f.partial
    rm -f -- "$partial"
    if out=$(BUN_BE_BUN=1 nice -n 19 ionice -c3 timeout 3600 "$HAPI_BIN" "$SNAPSHOT" "$SRC/$f" "$partial" 2>&1); then
        mv -- "$partial" "$DST/$f"
        log "snapshot $f ok size=$(stat -c %s "$DST/$f") $out"
        [ "$f" != hapi.db ] || QC=ok
    else
        log "snapshot $f FAILED: $out"
        rm -f -- "$partial"
        FAILED=1
    fi
done
log "quick_check hapi.db: $QC"
if [ "$QC" = ok ] && { [ "$(date +%u)" = 7 ] || [ "${FORCE_ANALYZE:-0}" = 1 ]; }; then
    STATS=$ROOT/.analyze-$RUN_ID.db
    # Never ANALYZE or inject statistics from an incomplete disk-full copy.
    if has_room "$(stat -c %s "$DST/hapi.db")" && cp -- "$DST/hapi.db" "$STATS" &&
        nice -n 19 ionice -c3 sqlite3 "$STATS" 'ANALYZE;'; then
        if sqlite3 "$SRC/hapi.db" '.timeout 10000' "ATTACH '$STATS' AS s;" 'BEGIN IMMEDIATE;' \
            'DELETE FROM main.sqlite_stat1;' 'INSERT INTO main.sqlite_stat1 SELECT tbl, idx, stat FROM s.sqlite_stat1;' 'COMMIT;'; then
            log "analyze on copy ok; stats injected"
        else
            log "stats injection FAILED (live DB unchanged)"
            FAILED=1
        fi
    else
        log "analyze skipped/FAILED: insufficient space or copy/analyze error; live DB unchanged"
        FAILED=1
    fi
    rm -f -- "$STATS"
fi
for f in "$DST"/*.db "$DST"/*.sqlite; do
    [ -f "$f" ] || continue
    if ! HAPI_BACKUP_COPY_RESERVE_BYTES="$MIN_FREE" nice -n 19 ionice -c3 bash "$COMPRESS" "$f"; then
        log "compression FAILED: original staging retained: $f"
        FAILED=1
    fi
done
# No source backup pruning: only the desktop's verified transfer may remove staged snapshots.
log "done run=$RUN_ID; staged for offsite, not retained backup; disk free $(df -h "$ROOT" | awk 'NR==2{print $4}') failed=$FAILED"
exit "$FAILED"
