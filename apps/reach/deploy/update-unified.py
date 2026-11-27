#!/usr/bin/env python3
"""Ray Zhang. 把 Ray 上的 Reach 更新为「统一前端、默认带云端对话」的版本。

只更新 Reach 应用（reach.service），不动 ray-front、Ray 登录密钥和工作台卡片。
新版本启动时会升级数据库结构，旧代码读不了新结构，所以停服后先整份备份数据库；
任何一步失败都切回旧发行目录、恢复数据库与环境文件，再启动旧服务。
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.request
import uuid

CURRENT = Path('/opt/reach/current')
RELEASES = Path('/opt/reach/releases')
DATA = Path('/var/lib/reach')
ENV = Path('/etc/reach/service.env')
SIDECAR = CURRENT / 'bin/morrow-agent-jsonl'
DESK_DATABASE = 'desk/desk.sqlite'
DATABASES = ('reach.sqlite', 'ray-auth.sqlite', DESK_DATABASE)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def command(*args):
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)


def link(release):
    temp = CURRENT.with_name('current.reach-' + uuid.uuid4().hex)
    try:
        temp.symlink_to(release, target_is_directory=True)
        os.replace(temp, CURRENT)
    finally:
        temp.unlink(missing_ok=True)


def health():
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:18910/healthz', timeout=5) as response:
                if response.status == 200:
                    return json.loads(response.read())
        except OSError:
            pass
        time.sleep(0.5)
    raise RuntimeError('health check did not settle')


def ledger():
    with closing(sqlite3.connect('file:' + str(DATA / 'reach.sqlite') + '?mode=ro', uri=True)) as db:
        counts = {t: db.execute('SELECT count(*) FROM ' + t).fetchone()[0] for t in ('users', 'nodes', 'operations', 'operation_events')}
        active = db.execute("SELECT count(*) FROM operations WHERE execution IN ('received','running') OR (delivery IN ('queued','claimed') AND execution NOT IN ('succeeded','failed','cancelled','unknown'))").fetchone()[0]
        return counts, active


def desk_ledger():
    path = DATA / DESK_DATABASE
    if not path.is_file():
        return None, 0
    with closing(sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)) as db:
        counts = {t: db.execute('SELECT count(*) FROM ' + t).fetchone()[0] for t in ('conversations', 'turns', 'events')}
        active = db.execute("SELECT count(*) FROM turns WHERE status IN ('submitting','starting','running','cancelling')").fetchone()[0]
        return counts, active


def extract(archive, release):
    release.mkdir(parents=True, mode=0o700)
    with tarfile.open(archive, 'r:gz') as package:
        entries = package.getmembers()
        for entry in entries:
            target = (release / entry.name).resolve()
            if not target.is_relative_to(release) or entry.issym() or entry.islnk() or not (entry.isfile() or entry.isdir()):
                raise RuntimeError('unexpected archive member: ' + entry.name)
            entry.mode = 0o700 if entry.isdir() else 0o600
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = ''
        package.extractall(release, members=entries)
    for path in release.rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o644)
    (release / 'bin/morrow-agent-jsonl').chmod(0o755)
    # 服务工作目录固定为 current/service；指向保持仓库相对层级的应用目录，
    # 这样 platform/src 到 crates/ 的相对引用不变，systemd 单元也不用改。
    (release / 'service').symlink_to('morrow/apps/reach', target_is_directory=True)
    release.chmod(0o755)


# 对话运行组件路径；REACH_MODEL_LOOPBACK=1 允许使用服务器本机的模型网关（OMP，127.0.0.1），流量不出本机。
MANAGED_ENV = {'REACH_DESK_SIDECAR': str(SIDECAR), 'REACH_MODEL_LOOPBACK': '1'}


def env_with_sidecar(text):
    lines = [line for line in text.splitlines() if line.split('=', 1)[0] not in MANAGED_ENV]
    lines += [f'{key}={value}' for key, value in MANAGED_ENV.items()]
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--expect-current', required=True)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    archive = Path(args.archive).resolve()
    old = Path(args.expect_current)
    release = RELEASES / args.name
    backup = Path('/root/reach-unified-backup-' + time.strftime('%Y%m%d-%H%M%S'))
    if os.geteuid() != 0 or digest(archive) != args.sha256 or CURRENT.resolve() != old:
        raise RuntimeError('update precondition failed (root, archive hash or current release)')
    if release.exists():
        raise RuntimeError('release directory already exists')
    backup.mkdir(mode=0o700)
    receipt = {'status': 'prepared', 'old_release': str(old), 'release': str(release), 'archive_sha256': args.sha256, 'backup': str(backup)}
    stopped = switched = False
    try:
        extract(archive, release)
        receipt['sidecar_sha256'] = digest(release / 'bin/morrow-agent-jsonl')
        # 运行组件在目标机上能启动才继续：没有输入时它会报 start_frame_required 并退出，不连接任何服务。
        probe = subprocess.run([str(release / 'bin/morrow-agent-jsonl')], stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
        receipt['sidecar_probe_exit'] = probe.returncode
        if b'start_frame_required' not in probe.stdout + probe.stderr:
            raise RuntimeError('sidecar does not run on this host')
        before, active = ledger()
        desk_before, desk_active = desk_ledger()
        if active or desk_active:
            raise RuntimeError('active work; service unchanged')
        shutil.copy2(ENV, backup / 'service.env')
        stopped = True
        command('systemctl', 'stop', 'reach')
        before, active = ledger()
        desk_stopped, desk_active = desk_ledger()
        receipt['state_before'] = before
        receipt['desk_before'] = desk_stopped
        if active or desk_active or desk_before != desk_stopped:
            raise RuntimeError('new active work; update refused')
        for name in DATABASES:
            for suffix in ('', '-wal', '-shm'):
                source = DATA / (name + suffix)
                if source.exists():
                    saved = backup / (name + suffix)
                    saved.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, saved)
        switched = True
        ENV.write_text(env_with_sidecar(ENV.read_text()))
        link(release)
        command('systemctl', 'start', 'reach')
        receipt['health'] = health()
        after, _ = ledger()
        receipt['state_after'] = after
        desk_after, _ = desk_ledger()
        receipt['desk_after'] = desk_after
        if before != after:
            raise RuntimeError('operation ledger counts changed during update')
        if desk_stopped is not None and (
            desk_after is None or any(desk_after[table] < count for table, count in desk_stopped.items())
        ):
            raise RuntimeError('Desk ledger lost records during update')
        receipt['status'] = 'updated-ledger-preserved'
    except Exception as error:
        receipt['failure'] = f'{type(error).__name__}: {error}'
        receipt['status'] = 'preparation-failed-services-unchanged'
        if stopped:
            try:
                command('systemctl', 'stop', 'reach')
                if switched:
                    link(old)
                    shutil.copy2(backup / 'service.env', ENV)
                    for name in DATABASES:
                        for suffix in ('', '-wal', '-shm'):
                            saved, target = backup / (name + suffix), DATA / (name + suffix)
                            target.unlink(missing_ok=True)
                            if saved.exists():
                                shutil.copy2(saved, target)
                                shutil.chown(target, 'reach', 'reach')
                command('systemctl', 'start', 'reach')
                health()
                receipt['status'] = 'old-service-and-database-restored'
            except Exception as rollback:
                receipt['status'] = 'restore-needs-attention'
                receipt['restore_failure'] = f'{type(rollback).__name__}: {rollback}'
        raise
    finally:
        (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2, ensure_ascii=False))
        print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
