"""Ray Zhang: assemble a deterministic, self-contained Windows payload; no installation."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    if not name or len(name) > 240 or '\\' in name or ':' in name:
        raise ValueError(f'invalid package path: {name!r}')
    for part in name.split('/'):
        if (part in ('', '.', '..') or part.endswith((' ', '.'))
                or re.search(r'[\x00-\x1f<>"|?*]', part)
                or re.match(r'(?i)^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)', part)):
            raise ValueError(f'invalid Windows package path: {name!r}')
    return name


def x64(data, name):
    if len(data) < 64 or data[:2] != b'MZ':
        raise ValueError(f'not a PE image: {name}')
    offset = struct.unpack_from('<I', data, 60)[0]
    if offset < 64 or offset + 6 > len(data) or data[offset:offset+6] != b'PE\0\0d\x86':
        raise ValueError(f'not a Windows x64 PE image: {name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('node', 'node-sha', 'agent', 'agent-sha', 'notices', 'openssh', 'destination'):
        parser.add_argument('--' + name, required=True)
    for name in ('helper', 'helper-sha', 'runtime', 'runtime-sha'):
        parser.add_argument('--' + name)
    parser.add_argument('--version', default='0.1.0')
    args = parser.parse_args()
    if not re.fullmatch(r'(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){2}', args.version) or any(int(part) > 65535 for part in args.version.split('.')):
        raise ValueError('expected a canonical three-component Windows version')
    desktop_args = (args.helper, args.helper_sha, args.runtime, args.runtime_sha)
    desktop = all(desktop_args)
    if any(desktop_args) and not desktop:
        raise ValueError('Desktop helper and runtime must both be included and pinned')
    destination = Path(args.destination).absolute()
    if destination.exists():
        raise ValueError('preserve existing outputs; use a new payload destination')
    for value in (args.node_sha, args.agent_sha) + ((args.helper_sha, args.runtime_sha) if desktop else ()):
        if not re.fullmatch('[0-9a-f]{64}', value):
            raise ValueError('expected a full lowercase SHA256')
    binaries = {'reach.exe': (args.node, args.node_sha), 'agent/morrow-agent-jsonl.exe': (args.agent, args.agent_sha)}
    items = {}
    if desktop:
        root = Path(args.runtime).resolve(strict=True)
        raw_manifest = (root / 'reach-provenance/files.json').read_bytes()
        if digest(raw_manifest) != args.runtime_sha:
            raise ValueError('runtime inventory changed')
        expected = {safe_path(item['path']): item for item in json.loads(raw_manifest)}
        paths = sorted(root.rglob('*'))
        if any(path.is_symlink() or path.is_junction() for path in paths):
            raise ValueError('runtime contains a link or junction')
        actual = {path.relative_to(root).as_posix(): path for path in paths if path.is_file()}
        if set(actual) != set(expected) | {'reach-provenance/files.json'}:
            raise ValueError('runtime file set differs from its frozen inventory')
        for name, path in actual.items():
            data = path.read_bytes()
            if name in expected and (len(data) != expected[name]['bytes'] or digest(data) != expected[name]['sha256']):
                raise ValueError(f'runtime file changed: {name}')
            if path.suffix.lower() in ('.dll', '.pyd', '.exe'):
                x64(data, name)
            items['desktop/python/' + name] = path
        binaries['desktop/reach-desktop.exe'] = (args.helper, args.helper_sha)
        items['desktop/config.toml'] = root / 'reach-provenance/config.toml'
        items['desktop-runtime.json'] = b'{"helper":"desktop/reach-desktop.exe","python":"desktop/python/python.exe","config":"desktop/config.toml"}\n'
    for name, (path, sha) in binaries.items():
        items[name] = Path(path).resolve(strict=True)
        data = items[name].read_bytes()
        x64(data, name)
        if digest(data) != sha:
            raise ValueError(f'reviewed binary changed: {name}')
    items['THIRD_PARTY_NOTICES.txt'] = Path(args.notices).resolve(strict=True)
    openssh = Path(args.openssh).read_bytes()
    if digest(openssh) != '23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5':
        raise ValueError('offline OpenSSH payload identity changed')
    items['openssh-vendor.zip'] = openssh
    items['agent-runtime.json'] = (json.dumps(dict(sidecar='agent/morrow-agent-jsonl.exe', sha256=args.agent_sha, inspectionLeaseVersion=1), separators=(',', ':')) + '\n').encode('utf-8')
    names = set()
    files = []
    for name, item in sorted(items.items()):
        safe_path(name)
        if name.lower() in names:
            raise ValueError('case-insensitive path collision')
        names.add(name.lower())
        data = item if isinstance(item, bytes) else item.read_bytes()
        files.append(dict(path=name, bytes=len(data), sha256=digest(data)))
    manifest = dict(schema=2, product='Reach', version=args.version, architecture='x86_64-pc-windows-msvc',
                    desktopBundled=desktop, nodeSha256=args.node_sha,
                    agentBundled=True, agentSha256=args.agent_sha, files=files)
    if desktop:
        manifest.update(helperSha256=args.helper_sha, runtimeManifestSha256=args.runtime_sha)
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    records = {record['path']: record for record in files}
    items['payload-manifest.json'] = manifest_bytes
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, item in sorted(items.items()):
            data = item if isinstance(item, bytes) else item.read_bytes()
            if name in records and (len(data) != records[name]['bytes'] or digest(data) != records[name]['sha256']):
                raise ValueError(f'input changed while assembling: {name}')
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compresslevel=6)
    receipt = dict(schema=2, kind='complete-payload-candidate', version=args.version, desktopBundled=desktop, agentBundled=True, installationTested=False,
                   packageSha256=digest(destination.read_bytes()), payloadManifestSha256=digest(manifest_bytes),
                   nodeSha256=args.node_sha, helperSha256=args.helper_sha, agentSha256=args.agent_sha, runtimeManifestSha256=args.runtime_sha,
                   files=len(files), bytes=sum(item['bytes'] for item in files), zipBytes=destination.stat().st_size)
    destination.with_suffix('.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
