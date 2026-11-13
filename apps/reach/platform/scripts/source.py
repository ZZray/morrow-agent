#!/usr/bin/env python3
"""Ray Zhang. One-time platform import and reproducible pinned shared dependency export."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'source.lock.json').read_text(encoding='utf-8'))
REV = LOCK['commit']


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(['git', '-C', str(repo), *args])


def source_repository(value: str | None) -> Path:
    if value:
        repo = Path(value).resolve()
        if git(repo, 'rev-parse', REV + '^{commit}').decode().strip() != REV:
            raise RuntimeError('source commit mismatch')
        return repo
    repo = ROOT / 'work' / 'repository'
    if not repo.exists():
        repo.mkdir(parents=True)
        git(repo, 'init')
        git(repo, 'remote', 'add', 'origin', LOCK['repository'])
    remote = git(repo, 'remote', 'get-url', 'origin').decode().strip()
    if remote != LOCK['repository']:
        raise RuntimeError('cached source remote differs from lock')
    known = subprocess.run(['git', '-C', str(repo), 'cat-file', '-e', REV + '^{commit}'], capture_output=True)
    if known.returncode:
        git(repo, 'fetch', '--filter=blob:none', '--no-tags', 'origin', REV)
    return repo


def archive(repo: Path, paths: list[str]) -> dict[str, bytes]:
    raw = git(repo, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', REV, *paths)
    result = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as bundle:
        for member in bundle:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise RuntimeError('unsafe source archive path')
            if member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError('nonregular source input: ' + member.name)
            item = bundle.extractfile(member)
            if item is None:
                raise RuntimeError('missing source member')
            result[member.name] = item.read()
    return result


def write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prepare(repository: str | None):
    target = ROOT / 'work' / 'shared-source'
    marker = ROOT / 'work' / 'shared-source-manifest.json'
    if target.exists():
        if not marker.is_file():
            raise RuntimeError('incomplete shared source cache; inspect it before recovery')
        prior = json.loads(marker.read_text(encoding='utf-8'))
        actual = {p.relative_to(target).as_posix(): digest(p.read_bytes()) for p in target.rglob('*') if p.is_file()}
        if prior['commit'] != REV or actual != prior['files']:
            raise RuntimeError('shared dependency cache changed; do not develop in the cache')
        print('Pinned shared source cache verified:', len(actual), 'files')
        return
    files = archive(source_repository(repository), LOCK['shared_paths'])
    for name, data in files.items():
        write(target / name, data)
    write(marker, (json.dumps({'commit': REV, 'files': {name: digest(data) for name, data in files.items()}}, indent=2) + '\n').encode())
    print('Pinned external shared source prepared:', len(files), 'files')


def import_platform(repo: Path):
    if (ROOT / 'legacy').exists() or (ROOT / 'source-manifest.json').exists():
        raise RuntimeError('platform already imported; maintain the new source, do not overwrite it')
    files = archive(repo, [LOCK['application']])
    prefix = LOCK['application'] + '/'
    node = files[prefix + 'node.go']
    token = re.search(rb'defaultToken\s*=\s*"([^"\r\n]+)"', node)
    if token is None:
        raise RuntimeError('expected legacy credential location changed')
    old_secret = token.group(1)
    records = []
    provenance = {'AGENTS.md': 'AGENTS.upstream.txt', 'README.md': 'README.upstream.txt', 'build_dist.py': 'build_dist.upstream.py.txt', 'scripts/build-maintained-release.py': 'build-maintained-release.upstream.py.txt'}
    for name, original in files.items():
        relative = name.removeprefix(prefix)
        target = ('provenance/' + provenance[relative]) if relative in provenance else ('legacy/' + relative)
        data = original
        changes = []
        if old_secret in data:
            data = data.replace(old_secret, b'')
            changes.append('removed legacy embedded enrollment credential')
        if relative.endswith('.go') and b'ara/apps/handwave/' in data:
            data = data.replace(b'ara/apps/handwave/', b'ara/apps/reach/platform/legacy/')
            changes.append('relocated platform package import')
        if relative == 'main.go':
            start = data.index(b'func usage() {')
            end = data.index(b'func runHub(')
            entry = (ROOT / 'scripts' / 'entry.go.txt').read_bytes()
            data = data[:start] + entry + b'\n' + data[end:]
            changes.append('platform-only explicit entry and separate runtime state directory')
        if b'-----BEGIN PRIVATE KEY-----' in data or b'-----BEGIN RSA PRIVATE KEY-----' in data:
            raise RuntimeError('private key material requires review: ' + name)
        write(ROOT / target, data)
        records.append({'source': name, 'destination': target, 'source_sha256': digest(original), 'import_sha256': digest(data), 'changes': changes})
    module = git(repo, 'show', REV + ':go.mod').decode()
    module = module.replace('module ara\n', 'module ara/apps/reach/platform\n', 1)
    module = module.replace('=> ./third_party/systray', '=> ./work/shared-source/third_party/systray')
    module += '\nrequire ara v0.0.0\n\nreplace ara => ./work/shared-source\n'
    write(ROOT / 'go.mod', module.encode())
    write(ROOT / 'go.sum', git(repo, 'show', REV + ':go.sum'))
    write(ROOT / 'source-manifest.json', (json.dumps({'author': 'Ray Zhang', 'commit': REV, 'files': records}, ensure_ascii=False, indent=2) + '\n').encode())
    print('Platform source imported:', len(records), 'files; legacy credential removed; no runtime state imported')


def import_ray(repo: Path):
    target = ROOT / 'adapters' / 'ray' / '_source'
    if target.exists():
        raise RuntimeError('Ray adapter source already imported; maintain the new source, do not overwrite it')
    prefix = 'apps/provider/cmd/ray_front/'
    names = git(repo, 'ls-tree', '-rz', '--name-only', REV, prefix).decode().split('\0')
    explicit = {'model_menu_patch.json', 'cloud_memory.go', 'cloud_memory_test.go', 'context_links.go', 'context_links_test.go', 'next_suggestion.go', 'next_suggestion_test.go'}
    selected = []
    for name in names:
        relative = name.removeprefix(prefix)
        if name and (relative.startswith('handwave_') or relative in explicit or relative.startswith(('assets/brand/', 'assets/avatars/', 'vendor/xterm/', 'testdata/'))):
            selected.append(name)
    if len(selected) != 70:
        raise RuntimeError('locked Ray adapter inventory differs from reviewed 70 files')
    records = []
    for name, data in archive(repo, selected).items():
        destination = 'adapters/ray/_source/' + name.removeprefix(prefix)
        write(ROOT / destination, data)
        records.append({'source': name, 'destination': destination, 'source_sha256': digest(data), 'import_sha256': digest(data), 'changes': []})
    write(ROOT / 'ray-source-manifest.json', (json.dumps({'author': 'Ray Zhang', 'commit': REV, 'build_status': 'reference sources pending host extraction; not built or loaded', 'files': records}, ensure_ascii=False, indent=2) + '\n').encode())
    print('Ray platform UI and dependent source imported:', len(records), 'files; not enabled')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['import', 'import-ray', 'prepare'])
    parser.add_argument('--source-repository', help='optional local Git object source; only the locked commit is read')
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.source_repository)
    else:
        repo = source_repository(args.source_repository)
        {'import': import_platform, 'import-ray': import_ray}[args.action](repo)


if __name__ == '__main__':
    main()
