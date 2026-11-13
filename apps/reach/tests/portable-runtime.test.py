"""Ray Zhang: fresh-process imports, real DLL provenance and in-memory COM recovery."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def child(mode, root, spool):
    assert sys.version_info[:3] == (3, 14, 7)
    assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
    assert all(Path(p).resolve().is_relative_to(root) for p in sys.path)
    assert not (root / 'pyvenv.cfg').exists()
    import importlib
    orders = [
        ['win32api', 'pythoncom', 'windows_mcp.uia.core', 'win32ui', 'win32com.mapi.mapi'],
        ['win32ui', 'pythoncom', 'pywintypes', 'win32api', 'win32com.mapi.mapi', 'windows_mcp.uia.core'],
        ['win32com.mapi.mapi', 'windows_mcp.uia.core', 'win32api', 'pythoncom', 'win32ui'],
    ]
    for name in orders[mode]:
        importlib.import_module(name)
    import ctypes as c
    from ctypes import wintypes as w
    import comtypes.client
    import tempfile
    from windows_mcp.uia.comtypes_cache import safe_get_module, _LOCK_PATH
    assert comtypes.client.gen_dir is None
    assert Path(tempfile.gettempdir()).resolve() == spool
    assert Path(_LOCK_PATH).resolve().is_relative_to(spool)
    kernel = c.WinDLL('kernel32', use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [w.LPCWSTR]
    kernel.GetModuleHandleW.restype = w.HMODULE
    kernel.GetModuleFileNameW.argtypes = [w.HMODULE, w.LPWSTR, w.DWORD]
    kernel.GetModuleFileNameW.restype = w.DWORD
    dlls = []
    vc_pin = json.loads((root / 'reach-provenance/vc-runtime-lock.json').read_text(encoding='utf-8'))
    expected_hashes = {item['name']: item['sha256'] for item in vc_pin['files']}
    expected_hashes.update({name: digest(root / 'Lib/site-packages/pywin32_system32' / name)
                           for name in ('pythoncom314.dll', 'pywintypes314.dll')})
    for name, expected_hash in expected_hashes.items():
        handle = kernel.GetModuleHandleW(name)
        assert handle, (name, c.get_last_error())
        value = c.create_unicode_buffer(32768)
        count = kernel.GetModuleFileNameW(handle, value, len(value))
        assert 0 < count < len(value)
        loaded = Path(value.value).resolve()
        expected = root / name
        assert loaded == expected, (loaded, expected)
        assert digest(loaded) == expected_hash
        dlls.append(dict(name=name, loaded=str(loaded), sha256=digest(loaded)))
    recovered = []
    for dll, attr in [('UIAutomationCore.dll', 'IUIAutomation'), ('oleacc.dll', 'IAccessible')]:
        module = safe_get_module(dll, required_attr=attr)
        assert hasattr(module, attr)
        original = module
        delattr(module, attr)
        assert not hasattr(module, attr)
        module = safe_get_module(dll, required_attr=attr)
        assert module is not original and hasattr(module, attr)
        recovered.append(dict(library=dll, attribute=attr, module=module.__name__))
    import importlib.metadata as metadata
    assert metadata.version('windows-mcp') == '0.8.8+reach.4'
    for name in ('windows_mcp', 'comtypes', 'pythoncom', 'win32api', 'pywintypes', 'win32ui', 'win32com.mapi.mapi'):
        module = importlib.import_module(name)
        assert Path(module.__file__).resolve().is_relative_to(root)
    print(json.dumps(dict(order=orders[mode], isolated=True, bytecodeDisabled=True,
                         noSite=True, prefix=sys.prefix, dlls=dlls, recovered=recovered,
                         cacheLock=str(_LOCK_PATH)), ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--child', type=int, choices=range(3))
    parser.add_argument('--spool', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    if args.child is not None:
        child(args.child, root, args.spool.resolve())
        return
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    assert not evidence.is_relative_to(root)
    before = {p.relative_to(root).as_posix(): digest(p) for p in root.rglob('*') if p.is_file()}
    manifest = json.loads((root / 'reach-provenance/files.json').read_text(encoding='utf-8'))
    assert set(before) == {p['path'] for p in manifest} | {'reach-provenance/files.json'}
    assert all(before[p['path']] == p['sha256'] for p in manifest)
    results = []
    for mode in range(3):
        spool = evidence / f'spool-{mode}'
        spool.mkdir()
        environment = dict(os.environ, TEMP=str(spool), TMP=str(spool),
                           PYTHONPATH=str(evidence / 'untrusted-pythonpath'), PYTHONHOME=str(evidence / 'untrusted-pythonhome'))
        command = [str(root / 'python.exe'), '-I', '-B', '-X', 'utf8', str(Path(__file__).resolve()),
                   '--root', str(root), '--evidence', str(evidence), '--child', str(mode), '--spool', str(spool)]
        run = subprocess.run(command, env=environment, cwd=spool, capture_output=True, timeout=90)
        (evidence / f'imports-{mode}.stdout').write_bytes(run.stdout)
        (evidence / f'imports-{mode}.stderr').write_bytes(run.stderr)
        assert run.returncode == 0, (mode, run.returncode, run.stderr.decode(errors='replace'))
        results.append(json.loads(run.stdout))
    after = {p.relative_to(root).as_posix(): digest(p) for p in root.rglob('*') if p.is_file()}
    assert before == after, 'runtime mutated during fresh imports or corrupted-wrapper recovery'
    record = dict(root=str(root), files=len(before), runtimeManifestSha256=digest(root / 'reach-provenance/files.json'),
                  packageUnchanged=True, importOrders=results)
    (evidence / 'result.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(dict(importOrders=len(results), dllsVerified=sum(len(item['dlls']) for item in results), recoveredWrappers=6,
                         packageUnchanged=True, evidence=str(evidence)), ensure_ascii=False))


if __name__ == '__main__':
    main()
