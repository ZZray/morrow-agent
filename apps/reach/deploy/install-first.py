#!/usr/bin/env python3
"""Ray Zhang: first Reach release, separate from the existing workbench cutover.

Run as root with explicit archive/hash/credential file. No existing Reach install
is replaced. The receipt contains paths/hashes/status only, never credentials.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tarfile


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def extract_release(archive, release):
    release.mkdir(parents=True, mode=0o700)
    with tarfile.open(archive, 'r:gz') as package:
        entries = package.getmembers()
        for entry in entries:
            target = (release / entry.name).resolve()
            if not target.is_relative_to(release) or entry.issym() or entry.islnk() or not (entry.isfile() or entry.isdir()):
                raise RuntimeError('unexpected archive member')
            # Windows tar can mark the root member 0777. Keep extraction
            # private, including the root, until every file is normalized.
            entry.mode = 0o700 if entry.isdir() else 0o600
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = ''
        package.extractall(release, members=entries)
    for path in release.rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o644)
    (release / 'bin/ray-front').chmod(0o755)
    release.chmod(0o755)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('first deployment requires root')
    archive = Path(args.archive).resolve()
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != args.sha256 or len(digest) != 64:
        raise RuntimeError('archive digest mismatch')
    root = Path('/opt/reach')
    existing_targets = [Path('/etc/systemd/system/reach.service'), Path('/etc/systemd/system/reach-ingress.service'), Path('/var/lib/reach/reach.sqlite'), Path('/etc/reach/service.env'), Path('/etc/reach/ingress.json')]
    if (root / 'current').exists() or (root / 'current').is_symlink() or any(path.exists() or path.is_symlink() for path in existing_targets):
        raise RuntimeError('existing Reach installation detected; use a reviewed update plan')
    version = '20261102-' + digest[:12]
    release = root / 'releases' / version
    if release.exists():
        raise RuntimeError('candidate directory already exists')
    credentials = json.loads(Path(args.credentials).read_text())
    if credentials['server'] != 'https://118.25.103.226:8443' or credentials['username'] != 'ray':
        raise RuntimeError('unexpected deployment target/account')
    password = credentials['password']
    if len(password) < 32 or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-' for c in password):
        raise RuntimeError('bootstrap secret format invalid')
    certificate = Path('/var/lib/ray-front/tls/combined.pem')
    if not certificate.is_file():
        raise RuntimeError('maintained TLS certificate missing')
    receipt = {'release': str(release), 'archive_sha256': digest, 'workbench_changed': False, 'status': 'provisioning'}
    try:
        try:
            pwd.getpwnam('reach')
        except KeyError:
            command('useradd', '--system', '--user-group', '--home-dir', '/var/lib/reach', '--shell', '/usr/sbin/nologin', 'reach')
        extract_release(archive, release)
        (root / 'current').symlink_to(release, target_is_directory=True)
        config = Path('/etc/reach')
        config.mkdir(mode=0o755, exist_ok=True)
        environment = '\n'.join([
            'REACH_LISTEN_HOST=127.0.0.1', 'REACH_PORT=18910',
            'REACH_PUBLIC_ORIGIN=https://118.25.103.226:8443', 'REACH_DATA_DIR=/var/lib/reach',
            'REACH_TRUSTED_PROXY_ADDRESSES=127.0.0.1', 'REACH_BOOTSTRAP_USERNAME=ray',
            'REACH_BOOTSTRAP_PASSWORD=' + password, '',
        ])
        env_file = config / 'service.env'
        fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(environment)
        ingress_config = config / 'ingress.json'
        ingress_config.write_text(json.dumps({'public_ip': '118.25.103.226', 'tls_cert': str(certificate), 'tls_key': str(certificate)}))
        ray_user = pwd.getpwnam('ray-front')
        ingress_config.chmod(0o600)
        os.chown(ingress_config, ray_user.pw_uid, ray_user.pw_gid)
        for unit in ('reach.service', 'reach-ingress.service'):
            shutil.copyfile(release / 'deploy' / unit, Path('/etc/systemd/system') / unit)
            (Path('/etc/systemd/system') / unit).chmod(0o644)
        command('systemctl', 'daemon-reload')
        command('systemctl', 'enable', '--now', 'reach.service', 'reach-ingress.service')
        receipt['services'] = {unit: command('systemctl', 'is-active', unit) for unit in ('reach.service', 'reach-ingress.service')}
        receipt['status'] = 'started-awaiting-live-verification'
    except Exception as error:
        cleanup = subprocess.run(['systemctl', 'disable', '--now', 'reach-ingress.service', 'reach.service'], check=False, capture_output=True)
        receipt['failure_type'] = type(error).__name__
        receipt['cleanup_exit'] = cleanup.returncode
        receipt['status'] = 'failed-disabled-original-workbench-unchanged' if cleanup.returncode == 0 else 'failed-cleanup-needs-attention'
        raise
    finally:
        Path(args.receipt).write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()
