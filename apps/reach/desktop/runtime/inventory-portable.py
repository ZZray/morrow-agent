"""Ray Zhang: finalize modified RECORD entries and inventory original distribution notices."""
import base64
import csv
import hashlib
import importlib.metadata as metadata
import json
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
site = root / 'Lib/site-packages'
distributions = list(metadata.distributions(path=[str(site)]))
assert len(distributions) == int(sys.argv[2]), 'unexpected installed distribution set'
assert metadata.version('windows-mcp') == '0.8.8+reach.4'
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
assert all(Path(p).resolve().is_relative_to(root) for p in sys.path)
assert not (root / 'pyvenv.cfg').exists()
inventory = []
notices = ['Reach desktop runtime - original third-party notices\nCopyright (c) Ray Zhang.\n',
           'comtypes 1.4.17 is adapted to generate COM wrappers in memory; see comtypes-memory.patch.\n',
           'Original native notices and fixed source maps are included under reach-provenance/notices.\n',
           '\n=== Official CPython embedded runtime LICENSE.txt ===\n',
           (root / 'LICENSE.txt').read_text(encoding='utf-8')]
for d in sorted(distributions, key=lambda item: item.metadata['Name'].lower()):
    files = list(d.files or [])
    record = next(site / f for f in files if str(f).endswith('.dist-info/RECORD'))
    rows = list(csv.reader(record.read_text(encoding='utf-8').splitlines()))
    omitted = []
    retained = []
    for row in rows:
        path = (site / row[0]).resolve()
        assert path.is_relative_to(root), 'installed RECORD escaped the package'
        if row[0].startswith('bin/'):
            assert not path.exists(), 'developer launcher was not removed'
            omitted.append(row[0])
        elif row[0].endswith('.dist-info/direct_url.json'):
            # The local build directory is not an installation dependency or a
            # distributable URL. Fixed source/wheel digests live in build.json.
            path.unlink()
            omitted.append(row[0])
        else:
            retained.append(row)
    rows = retained
    if d.metadata['Name'] == 'comtypes':
        modified = ['comtypes/client/__init__.py', 'comtypes/gen/__init__.py']
        rows = [row for row in rows if row[0] not in modified]
        for relative in modified:
            data = (site / relative).read_bytes()
            digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
            rows.append([relative, 'sha256=' + digest, str(len(data))])
    with record.open('w', encoding='utf-8', newline='') as stream:
        csv.writer(stream, lineterminator='\n').writerows(rows)
    license_files = []
    for relative in files:
        if not any(part.lower().startswith(('license', 'licence', 'notice', 'copying', 'copyright')) for part in Path(relative).parts):
            continue
        path = (site / relative).resolve()
        assert path.is_relative_to(root), 'distribution notice escaped the package'
        if not path.is_file():
            continue
        data = path.read_bytes()
        license_files.append(dict(path=path.relative_to(root).as_posix(), sha256=hashlib.sha256(data).hexdigest()))
        notices.extend([f"\n=== {d.metadata['Name']} {d.version} / {relative} ===\n", data.decode('utf-8', errors='replace')])
    inventory.append(dict(name=d.metadata['Name'], version=d.version,
                          license=d.metadata.get('License-Expression') or d.metadata.get('License'),
                          classifiers=d.metadata.get_all('Classifier', []),
                          urls=d.metadata.get_all('Project-URL', []), licenseFiles=license_files, omittedInstallerMetadata=omitted))
notice_dir = root / 'reach-provenance'
supplements = json.loads((notice_dir / 'notices/sources.json').read_text(encoding='utf-8-sig'))
for item in supplements:
    original = notice_dir / 'notices' / item['file']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == item['sha256']
    entry = next(d for d in inventory if d['name'].lower() == item['distribution'].lower())
    assert entry['version'] == item['version']
    entry['licenseFiles'].append(dict(path=original.relative_to(root).as_posix(), sha256=item['sha256'], supplemental=True))
for original in sorted((notice_dir / 'notices').rglob('*')):
    if original.is_file() and original.suffix.lower() not in ('.json', '.docx', '.html'):
        notices.extend([f'\n=== Supplement: {original.relative_to(notice_dir).as_posix()} ===\n', original.read_text(encoding='utf-8')])
assert all(item['licenseFiles'] for item in inventory), 'distribution license text missing'
(notice_dir / 'distribution-inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding='utf-8')
(notice_dir / 'THIRD_PARTY_NOTICES.txt').write_text('\n'.join(notices), encoding='utf-8')
paths = sorted(root.rglob('*'))
assert not any(path.is_symlink() or path.is_junction() for path in paths), 'runtime contains links'
manifest = []
for path in paths:
    if path.is_file():
        data = path.read_bytes()
        manifest.append(dict(path=path.relative_to(root).as_posix(), bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
raw = json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode()
(notice_dir / 'files.json').write_bytes(raw)
print(json.dumps(dict(files=len(manifest), fileManifestSha256=hashlib.sha256(raw).hexdigest(), distributions=len(inventory),
                      missingNoticeFiles=[d['name'] for d in inventory if not d['licenseFiles']])))
