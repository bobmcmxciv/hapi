#!/usr/bin/env python3
"""Direct ECS -> HT3P09U backup, byte/SQLite verified before source removal."""
import argparse
import concurrent.futures
import datetime
import errno
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from urllib.parse import quote
import zlib

ROOT = Path('/mnt/d/Backups/ECS/hapi')
HOST = 'root@101.133.153.229'
SOURCE = '/root/bin/ecs-offsite-source.py'
SSH = ['ssh', '-T', '-i', '/root/.ssh/ecs-offsite-id_rsa',
       '-o', 'UserKnownHostsFile=/root/.ssh/ecs-offsite-known_hosts',
       '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15',
       '-o', 'ServerAliveCountMax=3', '-c', 'aes128-gcm@openssh.com']
SQLITE_HEADER = b'SQLite format 3\x00'
IDENTITY = ('path', 'size', 'mtime_ns', 'ctime_ns', 'inode', 'device')
LOG_LOCK = threading.Lock()
LOG_PATH = None


def emit(event, **fields):
    row = dict(time=datetime.datetime.now(datetime.timezone.utc).isoformat(),
               event=event, **fields)
    text = json.dumps(row, sort_keys=True)
    with LOG_LOCK:
        print(text, flush=True)
        if LOG_PATH is not None:
            with LOG_PATH.open('a', encoding='utf-8') as stream:
                stream.write(text + '\n')


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(str(temporary), str(path))
    descriptor = os.open(str(path.parent), os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(descriptor)


def source_call(arguments, request=None):
    result = subprocess.run(SSH + [HOST, 'python3', SOURCE] + arguments,
                            input=json.dumps(request) + '\n' if request is not None else None,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, timeout=10800)
    if result.returncode:
        raise RuntimeError('Source {} failed ({}): {}'.format(
            arguments[0], result.returncode, result.stderr[-12000:]))
    return json.loads(result.stdout)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            block = stream.read(4 * 1024 * 1024)
            if not block:
                break
            digest.update(block)
        os.fsync(stream.fileno())
    return digest.hexdigest()


def quick_check(path):
    connection = sqlite3.connect('file:' + quote(str(path), safe='/') +
                                 '?mode=ro&immutable=1', uri=True)
    try:
        result = connection.execute('PRAGMA quick_check').fetchall()
        if result != [('ok',)]:
            raise RuntimeError('SQLite quick_check failed: {}'.format(result[:10]))
        return dict(quick_check='ok', user_version=connection.execute(
            'PRAGMA user_version').fetchone()[0], page_count=connection.execute(
            'PRAGMA page_count').fetchone()[0])
    finally:
        connection.close()


def verify_content(path, row, run_id, keep_basis=False):
    with path.open('rb') as stream:
        header = stream.read(16)
    if header.hex() != row['header']:
        raise RuntimeError('Header changed for ' + row['path'])
    if path.name.endswith('.gz'):
        temporary_root = ROOT / 'restore-check'
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=run_id + '-', dir=str(temporary_root)) as directory:
            restored = Path(directory) / 'restored.sqlite'
            digest = hashlib.sha256()
            with gzip.open(str(path), 'rb') as compressed, restored.open('wb') as stream:
                while True:
                    block = compressed.read(4 * 1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
                    stream.write(block)
            with restored.open('rb') as stream:
                if stream.read(16) != SQLITE_HEADER:
                    raise RuntimeError('Compressed backup is not SQLite: ' + row['path'])
            checked = dict(encoding='gzip', restored_bytes=restored.stat().st_size,
                           restored_sha256=digest.hexdigest(), **quick_check(restored))
            if keep_basis:
                basis = ROOT / 'basis-cache' / run_id / Path(row['path']).name[:-3]
                basis.parent.mkdir(parents=True, exist_ok=True)
                os.replace(str(restored), str(basis))
            return checked
    if header == SQLITE_HEADER:
        return dict(encoding='sqlite', **quick_check(path))
    if row['group'] == 'pre':
        raise RuntimeError('Snapshot is not SQLite: ' + row['path'])
    return dict(encoding='historical-file', sha256_verified=True)


def destination(row, mode, run_id):
    if mode == 'migrate':
        relative = Path(row['path'].lstrip('/'))
        path = ROOT / 'archive' / run_id / relative
    else:
        path = ROOT / 'daily' / row['group'].split('/', 1)[1] / Path(row['path']).name
    if not path.resolve().is_relative_to(ROOT.resolve()):
        raise RuntimeError('Destination escapes backup root')
    return path


def receipt_path(run_id, row):
    identifier = hashlib.sha256(row['path'].encode()).hexdigest()
    return ROOT / 'receipts' / run_id / (identifier + '.json')


def raw_candidates(database, bases):
    candidates = [base for base in bases if base.is_file() and
                  (base.name == database or base.name.startswith(database + '.pre-'))]
    for path in (ROOT / 'basis-cache').glob('*/*'):
        if path.is_file() and (path.name == database or path.name.endswith('-' + database)):
            candidates.append(path)
    return list(dict.fromkeys(candidates))


def ensure_raw_bases(database, bases, run_id):
    found = raw_candidates(database, bases)
    if found:
        return found
    compressed = [base for base in bases if base.is_file() and base.name == database + '.gz']
    if not compressed:
        return []
    source = max(compressed, key=lambda item: str(item))
    target = ROOT / 'basis-cache' / run_id / database
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.tmp')
    with gzip.open(str(source), 'rb') as reader, temporary.open('wb') as writer:
        while True:
            block = reader.read(4 * 1024 * 1024)
            if not block:
                break
            writer.write(block)
    os.replace(str(temporary), str(target))
    return [target]


def select_raw_base(raw_bases, target_size, sample_crcs=None):
    if not sample_crcs:
        return min(raw_bases, key=lambda item: abs(item.stat().st_size - target_size))
    sample_set = set(sample_crcs)
    scored = []
    for base in raw_bases:
        size = base.stat().st_size
        offset = min(max(0, size // 2) & ~4095, max(0, size - 4 * 1024 * 1024))
        with base.open('rb') as stream:
            stream.seek(offset)
            window = stream.read(2 * 1024 * 1024)
        local = [zlib.crc32(window[index:index + 4096]) for index in range(0, len(window), 4096)]
        same_offset = sum(left == right for left, right in zip(local, sample_crcs))
        overlap = len(set(local) & sample_set)
        scored.append(((same_offset, overlap, -abs(size - target_size)), base))
    best_score, best_base = max(scored, key=lambda item: item[0])
    if best_score[0] < 16 and best_score[1] < 64:
        return None
    return best_base


def copy_compressed_via_raw_delta(row, path, raw_bases, run_id):
    staged = source_call(['stage-raw'], dict(path=row['path'], expected=row))
    try:
        with tempfile.TemporaryDirectory(prefix='.raw-gzip-', dir=str(path.parent)) as directory:
            temporary = Path(directory)
            basis_directory = temporary / 'basis'
            basis_directory.mkdir()
            raw_name = Path(row['path']).name[:-3]
            base = select_raw_base(raw_bases, staged['raw_size'], staged.get('sample_crcs')) or min(
                raw_bases, key=lambda item: abs(item.stat().st_size - staged['raw_size']))
            os.link(str(base), str(basis_directory / raw_name))
            raw_target = temporary / raw_name
            partial = path.parent / '.rsync-partial' / path.name
            if partial.is_file():
                partial.unlink()
            started = time.monotonic()
            result = subprocess.run(
                ['rsync', '-rt', '--protect-args', '--ignore-times', '--no-whole-file',
                 '--block-size=4096', '--compress', '--compress-level=6', '--stats',
                 '--copy-dest=' + str(basis_directory), '--rsync-path=nice -n 10 ionice -c2 -n7 rsync',
                 '-e', ' '.join(SSH), HOST + ':' + staged['raw_path'], str(raw_target)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            emit('COPY_RESULT', source=row['path'], mode='raw-delta',
                 seconds=round(time.monotonic() - started, 2), code=result.returncode,
                 stats=result.stdout[-6000:], stderr=result.stderr[-3000:])
            if result.returncode:
                raise RuntimeError('Raw delta rsync failed for ' + row['path'])
            rebuilt = path.with_name('.' + path.name + '.rebuilt')
            with rebuilt.open('wb') as out:
                subprocess.run(['gzip', '-1', '-c', '--', raw_name],
                               cwd=str(temporary), stdout=out, check=True)
            with rebuilt.open('r+b') as out:
                out.seek(4)
                out.write(bytes.fromhex(staged['gzip_mtime_hex']))
                out.flush()
                os.fsync(out.fileno())
            if rebuilt.stat().st_size == row['size'] and sha256_file(rebuilt) == row['sha256']:
                basis = ROOT / 'basis-cache' / run_id / (path.parent.name + '-' + raw_name)
                basis.parent.mkdir(parents=True, exist_ok=True)
                os.replace(str(raw_target), str(basis))
                os.replace(str(rebuilt), str(path))
                return True
            rebuilt.unlink()
            emit('RAW_DELTA_REBUILD_MISMATCH', source=row['path'])
            return False
    finally:
        source_call(['release-raw'], dict(raw_path=staged['raw_path']))


def copy_file(row, path, bases, run_id):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size == row['size'] and sha256_file(path) == row['sha256']:
        emit('COPY_ALREADY_PRESENT', source=row['path'], bytes=row['size'])
        return
    if path.name.endswith('.gz') and path.parent.name != '20261106':
        raw_bases = ensure_raw_bases(path.name[:-3], bases, run_id)
        if raw_bases and copy_compressed_via_raw_delta(row, path, raw_bases, run_id):
            return
    arguments = ['rsync', '-rt', '--protect-args', '--partial-dir=.rsync-partial',
                 '--ignore-times', '--no-whole-file', '--compress', '--compress-level=6',
                 '--stats', '--rsync-path=nice -n 10 ionice -c2 -n7 rsync',
                 '-e', ' '.join(SSH)]
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='.rsync-basis-', dir=str(path.parent)) as temporary:
        database = Path(row['path']).name.split('.pre-', 1)[0]
        raw_bases = ensure_raw_bases(database, bases, run_id) if row['group'] == 'pre' else []
        if row['group'] == 'pre' and raw_bases:
            sampled = source_call(['sample-pages'], dict(path=row['path']))['sample_crcs']
            base = select_raw_base(raw_bases, row['size'], sampled)
            if base is not None:
                os.link(str(base), str(Path(temporary) / Path(row['path']).name))
                # A matching family basis transfers less than a stale partial; an unrelated basis does not.
                partial = path.parent / '.rsync-partial' / path.name
                if partial.is_file():
                    partial.unlink()
                arguments.extend(['--block-size=4096', '--copy-dest=' + temporary])
        else:
            directories = list(dict.fromkeys(str(base.parent) for base in bases))[:12]
            arguments.extend('--copy-dest=' + directory for directory in directories)
        result = subprocess.run(arguments + [HOST + ':' + row['path'], str(path)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
    emit('COPY_RESULT', source=row['path'], seconds=round(time.monotonic() - started, 2),
         code=result.returncode, stats=result.stdout[-6000:], stderr=result.stderr[-3000:])
    if result.returncode:
        raise RuntimeError('Rsync failed for ' + row['path'])


def process_group(rows, mode, run_id, bases, keep_basis=False):
    records = []
    # Preserve historical WAL/SHM together; immutable verification cannot replay a WAL.
    by_path = {row['path']: row for row in rows}
    for row in rows:
        wal = by_path.get(row['path'] + '-wal')
        if wal is not None and wal['size']:
            raise RuntimeError('Historical WAL requires a WAL-aware restore: ' + row['path'])
    for row in sorted(rows, key=lambda item: item['size'], reverse=True):
        emit('HASH_SOURCE', source=row['path'], bytes=row['size'])
        hashed = source_call(['hash'], dict(path=row['path']))
        if any(hashed[key] != row[key] for key in IDENTITY):
            raise RuntimeError('Source identity changed since inventory: ' + row['path'])
        path = destination(hashed, mode, run_id)
        copy_file(hashed, path, bases, run_id)
        if path.stat().st_size != hashed['size']:
            raise RuntimeError('Destination length mismatch: ' + row['path'])
        target_sha256 = sha256_file(path)
        if target_sha256 != hashed['sha256']:
            raise RuntimeError('Destination SHA256 mismatch: ' + row['path'])
        records.append(dict(source=hashed, destination=str(path), sha256=target_sha256))
    # Whole predump/daily group is present before validating and deleting any member.
    for record in records:
        record['content'] = verify_content(
            Path(record['destination']), record['source'], run_id,
            keep_basis=keep_basis and Path(record['destination']).name.endswith('.gz'))
        record['state'] = 'destination_verified'
        atomic_json(receipt_path(run_id, record['source']), record)
        emit('DESTINATION_VERIFIED', source=record['source']['path'],
             sha256=record['sha256'], content=record['content'])
    proof = {record['source']['path']: record['sha256'] for record in records}
    removed = source_call(['remove'], dict(files=[record['source'] for record in records],
                                          verified_sha256=proof))
    acknowledged = set(removed['removed'])
    for record in records:
        if record['source']['path'] not in acknowledged:
            raise RuntimeError('Source removal not acknowledged: ' + record['source']['path'])
        record['state'] = 'source_removed'
        atomic_json(receipt_path(run_id, record['source']), record)
        if record['source']['group'] != 'predump':
            bases.append(Path(record['destination']))
    emit('SOURCE_GROUP_REMOVED', group=rows[0]['group'], files=len(records),
         freed_allocated=removed['freed_allocated'])


def retained_bases():
    candidates = list((ROOT / 'daily').glob('*/*.gz'))
    candidates.extend((ROOT / 'archive').glob('*/data/hapi-backups/daily/*/*.gz'))
    return sorted(candidates, key=lambda path: str(path), reverse=True)[:60]


def run_lane(groups, mode, run_id, bases=None):
    bases = list(bases if bases is not None else retained_bases())
    for rows in groups:
        process_group(rows, mode, run_id, bases)


def main():
    global LOG_PATH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('migrate', 'daily'))
    parser.add_argument('--run-id')
    arguments = parser.parse_args()
    run_id = arguments.run_id or datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    pattern = r'migration-[0-9]{8}T[0-9]{6}Z' if arguments.mode == 'migrate' else r'[0-9]{8}T[0-9]{6}Z'
    if not re.fullmatch(pattern, run_id):
        parser.error('Invalid run ID')
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True)
    lock = (ROOT / '.offsite.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | (0 if arguments.mode == 'daily' else fcntl.LOCK_NB))
    except BlockingIOError:
        raise SystemExit('Another offsite backup is running')
    LOG_PATH = ROOT / ('events-' + run_id + '.jsonl')
    emit('OFFSITE_STARTED', mode=arguments.mode, run_id=run_id)
    if arguments.mode == 'daily':
        # First rescue any previously failed stage; never prune a failed backup.
        pending = [row for row in source_call(['inventory'])['files']
                   if row['group'].startswith('staging/')]
        if pending:
            grouped = {}
            for row in pending:
                grouped.setdefault(row['group'], []).append(row)
            run_lane([grouped[key] for key in sorted(grouped)], 'daily', run_id)
        generated = source_call(['generate', '--run-id', run_id])
        emit('SOURCE_GENERATED', log=generated.get('log', ''), files=len(generated['files']))
        rows = generated['files']
    else:
        rows = [row for row in source_call(['inventory'])['files']
                if row['group'] == 'pre' or row['group'] == 'predump'
                or row['group'].startswith('daily/')]
    if not rows:
        raise RuntimeError('No backup files selected')
    if shutil.disk_usage(str(ROOT)).free < sum(row['size'] for row in rows) + 20 * 1024**3:
        raise RuntimeError('Insufficient target disk headroom')
    manifest = ROOT / 'receipts' / run_id / 'manifest.json'
    if not manifest.exists():
        atomic_json(manifest, dict(run_id=run_id, mode=arguments.mode, files=rows))
    grouped = {}
    for row in rows:
        grouped.setdefault(row['group'], []).append(row)
    pre = sorted(grouped.pop('pre', []), key=lambda row: row['size'], reverse=True)
    historical = grouped.pop('predump', [])
    daily_groups = [grouped[key] for key in sorted(grouped, reverse=True)]
    jobs = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        if historical:
            jobs.append(pool.submit(run_lane, [historical], arguments.mode, run_id))
        daily_bases = retained_bases()
        if pre and daily_groups:
            baseline = daily_groups.pop(0)
            # One transmitted gzip becomes the checked raw basis for the large pre snapshots.
            process_group(baseline, arguments.mode, run_id, daily_bases, keep_basis=True)
        if pre:
            cached = list((ROOT / 'basis-cache' / run_id).glob('*'))
            jobs.append(pool.submit(run_lane, [[row] for row in pre], arguments.mode,
                                    run_id, cached + daily_bases))
        if daily_groups:
            jobs.append(pool.submit(run_lane, daily_groups, arguments.mode, run_id, daily_bases))
        for job in concurrent.futures.as_completed(jobs):
            job.result()
    cache_root = ROOT / 'basis-cache'
    if cache_root.exists():
        for child in cache_root.iterdir():
            shutil.rmtree(str(child))
    receipts = []
    for path in (ROOT / 'receipts' / run_id).glob('*.json'):
        if path.name != 'manifest.json' and path.name != 'summary.json':
            with path.open(encoding='utf-8') as stream:
                receipts.append(json.load(stream))
    if any(record['state'] != 'source_removed' for record in receipts):
        raise RuntimeError('Unfinished verified backup receipts remain')
    summary = dict(run_id=run_id, mode=arguments.mode, files=len(receipts),
                   bytes=sum(record['source']['size'] for record in receipts),
                   sqlite_checks=sum(record['content'].get('quick_check') == 'ok'
                                     for record in receipts),
                   all_sha256_verified=True, all_sources_removed=True)
    atomic_json(ROOT / 'receipts' / run_id / 'summary.json', summary)
    emit('OFFSITE_COMPLETED', **summary)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit('OFFSITE_FAILED', error=str(error))
        raise
