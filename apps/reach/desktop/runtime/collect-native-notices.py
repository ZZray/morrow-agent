"""Ray Zhang: collect original Rust dependency notices from cryptography's fixed source lock."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
import tomllib
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    source_sha = hashlib.sha256(args.source.read_bytes()).hexdigest()
    assert source_sha == '7b46165bb56eb4704e2eaaf86f3c940d19154535d9b0ca7d6d590b04060e00d5'
    with tarfile.open(args.source) as archive:
        lock_bytes = archive.extractfile('cryptography-50.0.2/Cargo.lock').read()
    lock = tomllib.loads(lock_bytes.decode())
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / 'Cargo.lock').write_bytes(lock_bytes)
    registry = [p for p in lock['package'] if p.get('source', '').startswith('registry+')]
    assert len(registry) == 32

    def fetch(package):
        name, version, expected = package['name'], package['version'], package['checksum']
        url = f'https://static.crates.io/crates/{name}/{name}-{version}.crate'
        path = args.cache / f'{name}-{version}.crate'
        if not path.exists():
            if args.offline:
                raise RuntimeError(f'Cache missing: {path.name}')
            data = urlopen(url, timeout=45).read()
            assert hashlib.sha256(data).hexdigest() == expected, path.name
            path.write_bytes(data)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, path.name
        output = args.output / f'{name}-{version}'
        output.mkdir()
        notices = []
        with tarfile.open(path) as archive:
            prefix = f'{name}-{version}/'
            metadata = tomllib.loads(archive.extractfile(prefix + 'Cargo.toml').read().decode())['package']
            for member in archive.getmembers():
                if not member.isfile() or not member.name.startswith(prefix):
                    continue
                relative = PurePosixPath(member.name[len(prefix):])
                assert not relative.is_absolute() and '..' not in relative.parts
                if not relative.name.lower().startswith(('license', 'licence', 'notice', 'copying', 'copyright')):
                    continue
                data = archive.extractfile(member).read()
                target = output.joinpath(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                notices.append(dict(path=target.relative_to(args.output).as_posix(), bytes=len(data),
                                    sha256=hashlib.sha256(data).hexdigest(), sourcePath=member.name))
        assert notices, f'No original notice text for {name} {version}'
        return dict(name=name, version=version, license=metadata.get('license'), source=url,
                    archiveSha256=expected, files=notices)

    with ThreadPoolExecutor(max_workers=4) as pool:
        packages = list(pool.map(fetch, registry))
    record = dict(schema=1, component='cryptography 50.0.2 Rust dependency notices',
                  sourceArchiveSha256=source_sha, sourceLockSha256=hashlib.sha256(lock_bytes).hexdigest(),
                  scope='Full locked registry dependency set, including build-time components; not all are linked into the wheel',
                  localWorkspacePackages=[p['name'] for p in lock['package'] if 'source' not in p],
                  localWorkspaceLicense='Use the retained cryptography LICENSE, LICENSE.APACHE and LICENSE.BSD',
                  packages=packages)
    (args.output / 'sources.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    print(json.dumps(dict(packages=len(packages), notices=sum(len(p['files']) for p in packages))))


if __name__ == '__main__':
    main()
