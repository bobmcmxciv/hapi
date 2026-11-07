#!/usr/bin/env python3
"""Guarded ECS source for desktop-owned HAPI offsite transfers (Python 3.6+).

Only stdout is the JSON protocol. No command prunes directories. Destination
verification is performed by the desktop; remove requires its per-file SHA256
proof and the complete hashed source identity. A predump removal must include
all remaining members, including metadata and SQLite sidecars.
"""

import argparse
import datetime
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import zlib


LIVE = "/root/.hapi"
DAILY = "/data/hapi-backups/daily"
PREDUMP = "/data/backups/predump"
STAGING = "/data/hapi-backups/offsite-staging"
MAINTENANCE = "/root/bin/hapi-db-maint.sh"
RAW_DELTA = "/data/hapi-backups/.raw-delta"
MIN_FREE = 5368709120
DATABASES = (
    "hapi.db", "multi-user-gateway.sqlite", "session-digests.sqlite",
    "work-overview.sqlite", "subscription-snapshots.sqlite",
)
# Exact closed deployment snapshots observed during the migration inventory.
PRE_NAMES = frozenset(
    name + ".pre-" + suffix
    for name, suffixes in (
        ("hapi.db", (
            "archive-reopen-20261106-offline", "native-usage-20261105T210750Z",
            "0271-reliability-20261106T075055", "agy-remote-20261103T165454Z")),
        ("multi-user-gateway.sqlite", (
            "archive-reopen-20261106-offline", "native-usage-20261105T210750Z",
            "0271-reliability-20261106T075055", "agy-remote-20261103T165454Z")),
        ("subscription-snapshots.sqlite", (
            "archive-reopen-20261106-offline", "native-usage-20261105T210750Z",
            "0271-reliability-20261106T075055")),
    )
    for suffix in suffixes
)
PREDUMP_NAMES = frozenset((
    "npm-database.sqlite", "docker-images.txt", "harbor-pgdumpall.err",
    "rpm-list.txt", "docker-volumes.txt", "hapi.db", "harbor-pgdumpall.sql",
    "lls.db", "systemd-enabled.txt", "docker-ps.txt", "root-crontab.txt",
    "hapi.db-shm", "sqlite-err.txt", "hapi.db-wal",
))
COMPRESSED_NAMES = frozenset(name + ".gz" for name in DATABASES)
SQLITE_HEADER = b"SQLite format 3\x00"
IDENTITY_KEYS = (
    "size", "allocated", "mtime_ns", "ctime_ns", "inode", "device", "mode",
)
SIDE_SUFFIXES = ("-wal", "-shm", "-journal")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


class SourceError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise SourceError(message)


def valid_run_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", value):
        return False
    try:
        datetime.datetime.strptime(value, "%Y%m%dT%H%M%SZ")
        return True
    except ValueError:
        return False


def valid_day(value):
    if not re.fullmatch(r"[0-9]{8}", value):
        return False
    try:
        datetime.datetime.strptime(value, "%Y%m%d")
        return True
    except ValueError:
        return False


def group_for(path):
    require(isinstance(path, str) and path.startswith("/") and
            os.path.normpath(path) == path and "//" not in path and
            "\x00" not in path, "Noncanonical source path")
    parent, name = os.path.split(path)
    if parent == LIVE and name in PRE_NAMES:
        return "pre"
    if parent == PREDUMP and name in PREDUMP_NAMES:
        return "predump"
    date_parent, date_name = os.path.split(parent)
    if date_parent == DAILY and valid_day(date_name) and name in COMPRESSED_NAMES:
        return "daily/" + date_name
    if date_parent == STAGING and valid_run_id(date_name) and name in COMPRESSED_NAMES:
        return "staging/" + date_name
    raise SourceError("Source is outside the exact backup allowlist: " + path)


def inode_key(info):
    return info.st_dev, info.st_ino


def row_for(path, info):
    require(stat.S_ISREG(info.st_mode), "Not a regular source file: " + path)
    return {
        "path": path, "size": info.st_size, "allocated": info.st_blocks * 512,
        "mtime_ns": info.st_mtime_ns, "ctime_ns": info.st_ctime_ns,
        "inode": info.st_ino, "device": info.st_dev, "mode": info.st_mode,
        "group": group_for(path),
    }


def same_row(left, right):
    return all(left.get(key) == right.get(key)
               for key in IDENTITY_KEYS + ("path", "group"))


class Directory(object):
    """Hold every ancestor open; never resolve an ancestor through a symlink."""

    def __init__(self, path):
        require(path.startswith("/") and os.path.normpath(path) == path,
                "Noncanonical directory: " + path)
        self.path = path
        self.fds = []
        self.links = []
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            self.fds.append(os.open("/", flags))
            for name in path.split("/")[1:]:
                if not name:
                    continue
                parent = self.fds[-1]
                child = os.open(name, flags, dir_fd=parent)
                self.fds.append(child)
                self.links.append((parent, name, inode_key(os.fstat(child))))
        except BaseException:
            self.close()
            raise

    @property
    def fd(self):
        return self.fds[-1]

    def check(self):
        for parent, name, identity in self.links:
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISDIR(info.st_mode) and inode_key(info) == identity,
                    "Directory changed or became a symlink: " + self.path)

    def info(self, name):
        self.check()
        return os.stat(name, dir_fd=self.fd, follow_symlinks=False)

    def entries(self):
        self.check()
        result = sorted(os.listdir(self.fd))
        self.check()
        return result

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds = []

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        self.close()


def existing_names(path):
    try:
        with Directory(path) as directory:
            return directory.entries()
    except FileNotFoundError:
        return []


def current_row(path):
    with Directory(os.path.dirname(path)) as directory:
        return row_for(path, directory.info(os.path.basename(path)))


def protected_inodes():
    protected = set()
    with Directory(LIVE) as directory:
        names = directory.entries()
        require(all(name in names for name in DATABASES),
                "A primary database is missing; refusing source operations")
        for name in names:
            # Protect every SQLite sidecar name, not only currently known suffixes.
            if name not in DATABASES and not any(name.startswith(db + "-") for db in DATABASES):
                continue
            info = directory.info(name)
            require(stat.S_ISREG(info.st_mode),
                    "Primary database/sidecar is not a regular file: " + name)
            protected.add(inode_key(info))
        directory.check()
    return protected


def ensure_not_live(rows):
    protected = protected_inodes()
    for row in rows:
        require((row["device"], row["inode"]) not in protected,
                "Refusing a live database/sidecar inode alias: " + row["path"])


def ensure_closed(rows):
    """Fail closed on unreadable /proc; any FD (even read-only) blocks removal."""
    targets = {(row["device"], row["inode"]): row["path"] for row in rows}
    if not targets:
        return
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        fd_dir = "/proc/" + pid + "/fd"
        try:
            fds = os.listdir(fd_dir)
        except (FileNotFoundError, ProcessLookupError):
            continue
        for fd in fds:
            try:
                info = os.stat(fd_dir + "/" + fd)
            except (FileNotFoundError, ProcessLookupError):
                continue
            key = inode_key(info)
            require(key not in targets,
                    "Source is currently open by pid " + pid + ": " + targets.get(key, ""))


def ensure_no_sidecars(path):
    if group_for(path) == "predump":
        return  # The historical WAL/SHM and metadata must travel as one intact set.
    with Directory(os.path.dirname(path)) as directory:
        name = os.path.basename(path)
        if name.endswith(".gz"):
            name = name[:-3]
        for suffix in SIDE_SUFFIXES:
            try:
                directory.info(name + suffix)
            except FileNotFoundError:
                continue
            raise SourceError("Snapshot has a sidecar; refusing standalone copy: " + path)


def predump_rows():
    rows = []
    try:
        directory = Directory(PREDUMP)
    except FileNotFoundError:
        return []
    with directory:
        names = directory.entries()
        for name in names:
            require(name in PREDUMP_NAMES,
                    "Unexpected predump member; preserve the whole set: " + name)
            rows.append(row_for(PREDUMP + "/" + name, directory.info(name)))
        require(directory.entries() == names, "Predump membership changed while listing")
    return rows


def inventory():
    paths = [LIVE + "/" + name for name in existing_names(LIVE) if name in PRE_NAMES]
    for root, is_valid in ((DAILY, valid_day), (STAGING, valid_run_id)):
        for name in existing_names(root):
            if not is_valid(name):
                continue  # In particular, never inventory maintenance/compression locks.
            parent = root + "/" + name
            for member in existing_names(parent):
                if member in COMPRESSED_NAMES:
                    paths.append(parent + "/" + member)
    rows = [current_row(path) for path in paths]
    rows.extend(predump_rows())
    ensure_not_live(rows)
    for row in rows:
        ensure_no_sidecars(row["path"])
    ensure_closed(rows)
    for row in rows:
        require(same_row(row, current_row(row["path"])),
                "Source changed during inventory: " + row["path"])
    return {"version": 1, "files": sorted(rows, key=lambda row: row["path"])}


def hash_file(path, expected=None):
    group = group_for(path)
    before = current_row(path)
    if expected is not None:
        require(same_row(before, expected), "Source identity changed: " + path)
    ensure_not_live([before])
    ensure_no_sidecars(path)
    peers = predump_rows() if group == "predump" else [before]
    ensure_closed(peers)
    with Directory(os.path.dirname(path)) as directory:
        fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=directory.fd)
        with os.fdopen(fd, "rb") as stream:
            require(same_row(before, row_for(path, os.fstat(stream.fileno()))),
                    "Source replaced before hashing: " + path)
            header = stream.read(16)
            if path.endswith(".gz"):
                require(header.startswith(b"\x1f\x8b\x08"), "Invalid gzip header: " + path)
                stream.seek(0)
                with gzip.GzipFile(fileobj=stream, mode="rb") as compressed:
                    require(compressed.read(16) == SQLITE_HEADER,
                            "Compressed snapshot lacks SQLite header: " + path)
                stream.seek(0)
            elif path.endswith((".db", ".sqlite")) or group == "pre":
                require(header == SQLITE_HEADER, "Invalid SQLite snapshot header: " + path)
            stream.seek(0)
            digest = hashlib.sha256()
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            require(same_row(before, row_for(path, os.fstat(stream.fileno()))),
                    "Source changed while hashing: " + path)
        directory.check()
        require(same_row(before, row_for(path, directory.info(os.path.basename(path)))),
                "Source replaced while hashing: " + path)
    ensure_not_live([before])
    ensure_no_sidecars(path)
    ensure_closed(peers)
    for peer in peers:
        require(same_row(peer, current_row(peer["path"])),
                "Snapshot group changed while hashing: " + peer["path"])
    result = dict(before)
    result.update(sha256=digest.hexdigest(), header=header.hex())
    return result


def validate_receipt(row, proof):
    require(isinstance(row, dict), "Each source receipt must be an object")
    path = row.get("path")
    group = group_for(path)
    require(row.get("group") == group, "Invalid source group: " + path)
    for key in IDENTITY_KEYS:
        require(type(row.get(key)) is int and row[key] >= 0,
                "Invalid source identity field " + key + ": " + path)
    require(stat.S_ISREG(row["mode"]), "Receipt is not for a regular file: " + path)
    digest = row.get("sha256")
    require(isinstance(digest, str) and SHA256_RE.fullmatch(digest) is not None,
            "Missing SHA256 in source receipt: " + path)
    require(proof.get(path) == digest, "Missing/mismatched destination SHA256 proof: " + path)
    header = row.get("header")
    require(isinstance(header, str) and re.fullmatch(r"(?:[0-9a-f]{2}){0,16}", header) is not None
            and len(header) == min(row["size"], 16) * 2,
            "Invalid source header receipt: " + path)
    if path.endswith(".gz"):
        require(header.startswith("1f8b08"), "Receipt lacks gzip header: " + path)
    elif path.endswith((".db", ".sqlite")) or group == "pre":
        require(header == SQLITE_HEADER.hex(), "Receipt lacks SQLite header: " + path)
    return path


def remove_files(request):
    require(isinstance(request, dict) and isinstance(request.get("files"), list)
            and isinstance(request.get("verified_sha256"), dict), "Invalid remove request")
    receipts = request["files"]
    proof = request["verified_sha256"]
    paths = [validate_receipt(row, proof) for row in receipts]
    require(len(set(paths)) == len(paths), "Duplicate source path in removal request")
    predump = predump_rows() if any(row["group"] == "predump" for row in receipts) else []
    submitted = {row["path"] for row in receipts if row["group"] == "predump"}
    require(all(row["path"] in submitted for row in predump),
            "Predump must be verified and removed as a complete metadata/WAL/SHM group")
    # Validate the entire batch, including proof/hash/header, before the first unlink.
    present = []
    for row in receipts:
        try:
            actual = hash_file(row["path"], expected=row)
        except FileNotFoundError:
            # Missing allowlisted files are idempotent, but a replacement is never missing.
            continue
        require(actual["sha256"] == row["sha256"] and actual["header"] == row["header"],
                "Source content no longer matches verified copy: " + row["path"])
        present.append(row)
    ensure_not_live(present)
    ensure_closed(present)
    for row in present:
        ensure_no_sidecars(row["path"])
        require(same_row(row, current_row(row["path"])),
                "Source changed during batch validation: " + row["path"])
    if predump:
        current = predump_rows()
        require({row["path"] for row in current} == {row["path"] for row in predump}
                and all(same_row(left, right) for left, right in zip(current, predump)),
                "Predump membership/identity changed during batch validation")
    # Keep parent directory descriptors pinned throughout final validation and deletion.
    directories = {}
    removed = []
    freed = 0
    try:
        for row in present:
            parent = os.path.dirname(row["path"])
            if parent not in directories:
                directories[parent] = Directory(parent)
        for row in present:
            directory = directories[os.path.dirname(row["path"])]
            require(same_row(row, row_for(row["path"], directory.info(os.path.basename(row["path"])))),
                    "Source changed immediately before deletion: " + row["path"])
        # A final FD/inode check covers files opened during the potentially long hash pass.
        ensure_not_live(present)
        ensure_closed(present)
        for row in present:
            path = row["path"]
            directory = directories[os.path.dirname(path)]
            ensure_not_live([row])
            ensure_closed([row])
            ensure_no_sidecars(path)
            info = directory.info(os.path.basename(path))
            require(same_row(row, row_for(path, info)),
                    "Source changed at deletion: " + path)
            os.unlink(os.path.basename(path), dir_fd=directory.fd)
            removed.append(path)
            # Unlinking another hardlink does not actually free allocated storage.
            if info.st_nlink == 1:
                freed += row["allocated"]
        for directory in directories.values():
            os.fsync(directory.fd)
    except BaseException:
        if removed:
            sys.stderr.write("Already unlinked before failure: " + json.dumps(removed) + "\n")
        raise
    finally:
        for directory in directories.values():
            directory.close()
    return {"removed": removed, "freed_allocated": freed}


def generate(run_id):
    require(valid_run_id(run_id), "Run ID must be UTC YYYYmmddTHHMMSSZ")
    destination = STAGING + "/" + run_id
    # Inspect any existing ancestors even if the final run directory does not exist.
    try:
        with Directory(STAGING) as directory:
            require(run_id not in directory.entries(), "Run ID already exists; refusing regeneration")
    except FileNotFoundError:
        # Maintenance creates the staging root, but /data/hapi-backups must already be safe.
        with Directory(os.path.dirname(STAGING)):
            pass
    protected_inodes()
    with Directory(os.path.dirname(MAINTENANCE)) as directory:
        info = directory.info(os.path.basename(MAINTENANCE))
        require(stat.S_ISREG(info.st_mode), "Maintenance script is not a regular file")
    environment = dict(os.environ)
    # Do not let an inherited maintenance override redirect live inputs or backup output.
    for key in tuple(environment):
        if key.startswith("HAPI_BACKUP_") or key in (
                "HAPI_DB_BACKUP_ROOT", "HAPI_DB_SOURCE", "HAPI_BIN",
                "HAPI_SNAPSHOT_SCRIPT", "HAPI_COMPRESS_SCRIPT"):
            del environment[key]
    environment.update(HAPI_DB_BACKUP_ROOT=STAGING, HAPI_BACKUP_RUN_ID=run_id,
                       HAPI_DB_SOURCE=LIVE)
    completed = subprocess.run(["/bin/bash", MAINTENANCE], env=environment,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               universal_newlines=True)
    log = completed.stdout
    require(completed.returncode == 0,
            "Snapshot generation failed (exit " + str(completed.returncode) + "); source retained\n" + log)
    rows = []
    try:
        with Directory(destination) as directory:
            require(set(directory.entries()) == COMPRESSED_NAMES,
                    "Successful generation did not publish exactly five compressed snapshots")
        for name in sorted(COMPRESSED_NAMES):
            rows.append(hash_file(destination + "/" + name))
        with Directory(destination) as directory:
            require(set(directory.entries()) == COMPRESSED_NAMES,
                    "Generated snapshot group changed during validation")
            for row in rows:
                require(same_row(row, row_for(row["path"], directory.info(os.path.basename(row["path"])))),
                        "Generated snapshot changed during group validation: " + row["path"])
        ensure_not_live(rows)
        ensure_closed(rows)
    except (SourceError, OSError, ValueError, EOFError, zlib.error) as exc:
        raise SourceError("Generated group failed validation; source retained: " + str(exc) + "\n" + log)
    return {"version": 1, "files": rows, "log": log}

def stage_raw(request):
    path = request.get("path")
    group = group_for(path)
    require((group.startswith("daily/") or group.startswith("staging/")) and path.endswith(".gz"),
            "Raw delta staging requires an allowlisted compressed snapshot")
    row = hash_file(path, expected=request.get("expected"))
    with Directory(os.path.dirname(path)) as directory:
        fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=directory.fd)
        with os.fdopen(fd, "rb") as stream:
            header = stream.read(10)
            require(len(header) == 10 and header[:3] == b"\x1f\x8b\x08",
                    "Compressed snapshot lacks a standard gzip header")
            stream.seek(-4, os.SEEK_END)
            expected_tail = int.from_bytes(stream.read(4), "little")
    os.makedirs(RAW_DELTA, 0o700, exist_ok=True)
    with Directory(RAW_DELTA) as directory:
        statvfs = os.fstatvfs(directory.fd)
        require(statvfs.f_bavail * statvfs.f_frsize >= max(row["size"] * 3, expected_tail) + MIN_FREE,
                "Insufficient blob headroom for raw delta staging")
        name = hashlib.sha256(path.encode()).hexdigest() + "-" + os.path.basename(path[:-3])
        partial = name + ".partial"
        for stale in (partial, name):
            try:
                os.unlink(stale, dir_fd=directory.fd)
            except FileNotFoundError:
                pass
        out_fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=directory.fd)
        size = 0
        try:
            with gzip.open(path, "rb") as source, os.fdopen(out_fd, "wb") as output:
                first = source.read(16)
                require(first == SQLITE_HEADER, "Compressed snapshot lacks SQLite header")
                output.write(first)
                size += len(first)
                while True:
                    chunk = source.read(4 * 1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    require(statvfs.f_bavail * statvfs.f_frsize >= size + MIN_FREE,
                            "Expanded snapshot exceeds safe blob headroom")
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(partial, name, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
            os.fsync(directory.fd)
            sample = []
            with open(RAW_DELTA + "/" + name, "rb") as raw_stream:
                raw_stream.seek(min(max(0, size // 2) & ~4095, max(0, size - 4 * 1024 * 1024)))
                window = raw_stream.read(2 * 1024 * 1024)
                for index in range(0, len(window), 4096):
                    sample.append(zlib.crc32(window[index:index + 4096]))
        except BaseException:
            for stale in (partial, name):
                try:
                    os.unlink(stale, dir_fd=directory.fd)
                except FileNotFoundError:
                    pass
            raise
    require(same_row(row, current_row(path)), "Compressed snapshot changed while staging raw delta")
    return {"raw_path": RAW_DELTA + "/" + name, "raw_size": size,
            "gzip_mtime_hex": header[4:8].hex(), "sample_crcs": sample}


def sample_pages(request):
    path = request.get("path")
    require(group_for(path) == "pre", "Page sampling is only for raw pre-snapshots")
    row = current_row(path)
    ensure_not_live([row])
    ensure_no_sidecars(path)
    ensure_closed([row])
    offset = min(max(0, row["size"] // 2) & ~4095, max(0, row["size"] - 4 * 1024 * 1024))
    sample = []
    with Directory(os.path.dirname(path)) as directory:
        fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                     dir_fd=directory.fd)
        with os.fdopen(fd, "rb") as stream:
            stream.seek(offset)
            window = stream.read(2 * 1024 * 1024)
            for index in range(0, len(window), 4096):
                sample.append(zlib.crc32(window[index:index + 4096]))
    return {"offset": offset, "sample_crcs": sample}


def release_raw(request):
    raw_path = request.get("raw_path")
    require(isinstance(raw_path, str) and os.path.dirname(raw_path) == RAW_DELTA
            and re.fullmatch(r"[0-9a-f]{64}-[A-Za-z0-9._-]+", os.path.basename(raw_path)),
            "Refusing to remove a non-staged raw delta path")
    try:
        with Directory(RAW_DELTA) as directory:
            info = directory.info(os.path.basename(raw_path))
            require(stat.S_ISREG(info.st_mode), "Staged raw delta is not a regular file")
            os.unlink(os.path.basename(raw_path), dir_fd=directory.fd)
            os.fsync(directory.fd)
            return {"released": raw_path}
    except FileNotFoundError:
        return {"released": None}



def lower_priority():
    try:
        os.nice(19)
    except OSError:
        pass
    ionice = shutil.which("ionice")
    if ionice:
        subprocess.call([ionice, "-c", "3", "-p", str(os.getpid())],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("inventory")
    commands.add_parser("hash")
    commands.add_parser("remove")
    commands.add_parser("stage-raw")
    commands.add_parser("release-raw")
    commands.add_parser("sample-pages")
    generate_parser = commands.add_parser("generate")
    generate_parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    require(args.command is not None, "A command is required")
    require(sys.platform.startswith("linux") and os.geteuid() == 0,
            "Run as root on the ECS Linux source")
    lower_priority()
    # Serialize helper invocations only; this is not a lock respected by SQLite or rsync.
    lock_fd = os.open("/run/lock/hapi-offsite-source.lock",
                      os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(lock_fd, "a+") as lock:
        require(stat.S_ISREG(os.fstat(lock.fileno()).st_mode), "Unsafe helper lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.command == "inventory":
            result = inventory()
        elif args.command == "generate":
            result = generate(args.run_id)
        else:
            request = json.load(sys.stdin)
            require(isinstance(request, dict), "JSON request must be an object")
            handlers = {"hash": lambda: hash_file(request.get("path")),
                        "remove": lambda: remove_files(request),
                        "stage-raw": lambda: stage_raw(request),
                        "release-raw": lambda: release_raw(request),
                        "sample-pages": lambda: sample_pages(request)}
            result = handlers[args.command]()
        sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (SourceError, OSError, ValueError, EOFError, zlib.error) as error:
        sys.stderr.write("ecs-offsite-source: " + str(error) + "\n")
        sys.exit(1)
