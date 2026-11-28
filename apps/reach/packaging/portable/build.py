# Copyright (c) Ray Zhang. Build a native Reach Worker preview archive.
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def collect_notices(metadata, output, supplements_dir):
    supplements = json.loads((supplements_dir / 'sources.json').read_text(encoding='utf-8'))
    packages = {package['id']: package for package in metadata['packages']}
    dependencies = {node['id']: node['deps'] for node in metadata['resolve']['nodes']}
    pending = [metadata['resolve']['root']]
    visited = set()
    while pending:
        package_id = pending.pop()
        if package_id in visited:
            continue
        visited.add(package_id)
        pending.extend(dep['pkg'] for dep in dependencies[package_id])

    for package_id in sorted(visited):
        package = packages[package_id]
        if package['source'] is None:
            continue
        root = Path(package['manifest_path']).parent
        files = {
            path.relative_to(root): path for path in root.rglob('*')
            if path.is_file() and re.match(r'^(license|licence|copying|copyright|notice)([.\-_]|$)', path.name, re.I)
        }
        if package['license_file']:
            files[Path(package['license_file']).name] = root / package['license_file']
        for supplement in supplements:
            if (supplement['name'], supplement['version']) != (package['name'], package['version']):
                continue
            revision = (json.loads((root / '.cargo_vcs_info.json').read_text(encoding='utf-8'))['git']['sha1']
                        if package['source'].startswith('registry+') else package['source'].split('#')[-1])
            if revision != supplement['revision']:
                raise ValueError(f"Notice source differs for {package['name']}")
            for original in supplement['files']:
                path = supplements_dir / original['path']
                if hashlib.sha256(path.read_bytes()).hexdigest() != original['sha256']:
                    raise ValueError(f'Notice digest differs for {path.name}')
                files[Path('supplemental') / path.name] = path
        if not files:
            raise ValueError(f"Missing license text for {package['name']} {package['version']}")
        for name, path in files.items():
            destination = output / f"{package['name']}-{package['version']}" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)

    rust_docs = Path(run('rustc', '--print', 'sysroot')) / 'share/doc/rust'
    rust_output = output / 'rust-standard-library'
    shutil.copytree(rust_docs / 'licenses', rust_output / 'licenses')
    shutil.copyfile(rust_docs / 'COPYRIGHT-library.html', rust_output / 'COPYRIGHT-library.html')


def publish(stage, temporary, archive):
    checksum_target = archive.with_name(archive.name + '.sha256')
    for target in (archive, checksum_target):
        if os.path.lexists(target):
            raise FileExistsError(f'Refusing to overwrite existing release file: {target}')

    candidate = temporary / archive.name
    checksum = temporary / checksum_target.name

    def permissions(member):
        member.mode = 0o755 if member.isdir() or member.name == f'{stage.name}/ryreach' else 0o644
        return member

    with tarfile.open(candidate, 'w:gz') as package:
        package.add(stage, arcname=stage.name, filter=permissions)
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    checksum.write_text(f'{digest}  {archive.name}\n', encoding='ascii')

    # The temporary directory is inside the output directory, so both links
    # are on the same filesystem and fail if a destination already exists.
    os.link(candidate, archive)
    try:
        os.link(checksum, checksum_target)
    except Exception:
        try:
            if os.path.samestat(candidate.stat(), archive.lstat()):
                archive.unlink()
        except FileNotFoundError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser(description='Build a native Reach Worker preview archive.')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    package_os = {'Linux': 'linux', 'Darwin': 'macos'}.get(platform.system())
    arch = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if not package_os or not arch:
        parser.error('Build on Linux or macOS on x86_64 or ARM64')
    rust_cpu = 'x86_64' if arch == 'x64' else 'aarch64'
    rust_target = rust_cpu + ('-apple-darwin' if package_os == 'macos' else '-unknown-linux-gnu')

    project = Path(__file__).resolve().parents[2]
    cargo_options = ['--manifest-path', str(project / 'Cargo.toml'), '--locked']
    if args.offline:
        cargo_options.append('--offline')
    subprocess.run(['cargo', 'build', *cargo_options, '--target', rust_target, '--release', '--bin', 'ryreach'], check=True)
    metadata = json.loads(run('cargo', 'metadata', *cargo_options, '--format-version', '1', '--filter-platform', rust_target))
    binary = Path(metadata['target_directory']) / rust_target / 'release/ryreach'
    name, version = run(str(binary), '--version').split()
    if name != 'ryreach' or version != os.environ.get('REACH_RELEASE_VERSION', version):
        raise ValueError('Built Worker reported an unexpected version')
    stem = f'Reach-Worker-{version}-{package_os}-{arch}-preview'
    args.out.mkdir(parents=True, exist_ok=True)
    archive = args.out / f'{stem}.tar.gz'

    with tempfile.TemporaryDirectory(dir=args.out) as temporary:
        stage = Path(temporary) / stem
        stage.mkdir()
        shutil.copy2(binary, stage / 'ryreach')
        shutil.copyfile(project / 'packaging/portable/README.md', stage / 'README.md')
        shutil.copyfile(project.parents[1] / 'LICENSE', stage / 'LICENSE')
        collect_notices(metadata, stage / 'notices', project / 'packaging/windows/notices')
        publish(stage, Path(temporary), archive)
    print(archive.resolve())


if __name__ == '__main__':
    main()
