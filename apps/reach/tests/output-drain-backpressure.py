"""Ray Zhang: real Windows worker pipes and Job, with a deliberately stopped consumer."""
import argparse
import base64
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import msvcrt
from pathlib import Path
import struct
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--expected', choices=['succeeded', 'unknown'], required=True)
    parser.add_argument('--bytes', type=int, default=16384)
    args = parser.parse_args()
    kernel = c.WinDLL('kernel32', use_last_error=True)
    for name, inputs, result in [
        ('CreateJobObjectW', [c.c_void_p, w.LPCWSTR], w.HANDLE),
        ('SetInformationJobObject', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
        ('AssignProcessToJobObject', [w.HANDLE, w.HANDLE], w.BOOL),
        ('TerminateJobObject', [w.HANDLE, w.UINT], w.BOOL),
        ('QueryInformationJobObject', [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p], w.BOOL),
        ('CloseHandle', [w.HANDLE], w.BOOL),
        ('OpenProcess', [w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
        ('WaitForSingleObject', [w.HANDLE, w.DWORD], w.DWORD),
        ('GetExitCodeProcess', [w.HANDLE, c.POINTER(w.DWORD)], w.BOOL),
        ('PeekNamedPipe', [w.HANDLE, c.c_void_p, w.DWORD, c.c_void_p, c.POINTER(w.DWORD), c.c_void_p], w.BOOL),
        ('GetNamedPipeInfo', [w.HANDLE, c.c_void_p, c.POINTER(w.DWORD), c.POINTER(w.DWORD), c.c_void_p], w.BOOL),
    ]:
        fn = getattr(kernel, name)
        fn.argtypes, fn.restype = inputs, result

    def ok(result):
        if not result:
            raise c.WinError(c.get_last_error())
        return result

    job = ok(kernel.CreateJobObjectW(None, None))
    child = None
    shell = None
    try:
        limits = c.create_string_buffer(144)  # x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        struct.pack_into('<I', limits, 16, 0x2000)  # KILL_ON_JOB_CLOSE
        ok(kernel.SetInformationJobObject(job, 9, limits, len(limits)))
        child = subprocess.Popen([str(args.binary.resolve()), 'worker'], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        ok(kernel.AssignProcessToJobObject(job, int(child._handle)))
        # Containment is armed before the worker can read any instruction.
        command = f"[Console]::Out.Write(('x' * {args.bytes})); Start-Sleep -Milliseconds 600"
        child.stdin.write(json.dumps({'command': {'kind': 'command.run', 'command': command}}).encode())
        child.stdin.close()
        child.stdin = None
        first = bytearray()
        # Do not prefetch any bytes from the next frame into a Python buffer.
        while not first.endswith(b'\n'):
            part = child.stdout.read(1)
            assert part and len(first) < 16384, 'process-start frame missing'
            first.extend(part)
        started = json.loads(first)
        shell_pid = started['data']['pid']
        shell = ok(kernel.OpenProcess(0x101000, False, shell_pid))
        assert kernel.WaitForSingleObject(shell, 10000) == 0, 'shell did not exit while consumer was stopped'
        exit_code = w.DWORD()
        ok(kernel.GetExitCodeProcess(shell, c.byref(exit_code)))
        assert exit_code.value == 0
        handle = msvcrt.get_osfhandle(child.stdout.fileno())
        available, out_size, in_size = w.DWORD(), w.DWORD(), w.DWORD()
        ok(kernel.PeekNamedPipe(handle, None, 0, None, c.byref(available), None))
        ok(kernel.GetNamedPipeInfo(handle, None, c.byref(out_size), c.byref(in_size), None))
        # The single base64 frame cannot fit; the pipe is full, and the shell has
        # exited. This proves sending backpressure, rather than a sleeping shell.
        frame_min = len(base64.b64encode(b'x' * args.bytes))
        assert available.value >= out_size.value > 0
        assert available.value < frame_min, (available.value, out_size.value, frame_min)
        pause_start = time.monotonic()
        time.sleep(3.25)
        assert child.poll() is None, 'worker unexpectedly exited with a full output pipe'
        paused_ms = round((time.monotonic() - pause_start) * 1000)
        remaining, stderr = child.communicate(timeout=15)
        frames, malformed = [started], []
        for line in remaining.splitlines():
            try:
                frames.append(json.loads(line))
            except json.JSONDecodeError:
                malformed.append(dict(bytes=len(line), sha256=hashlib.sha256(line).hexdigest()))
        output = b''.join(base64.b64decode(f['data']['base64']) for f in frames if f['data'].get('stream') == 'stdout')
        terminal = [f for f in frames if f['kind'] == 'result']
        assert child.returncode == 0, stderr.decode(errors='replace')
        assert len(terminal) == 1
        assert terminal[0]['state'] == args.expected, terminal[0]
        if args.expected == 'unknown':
            assert terminal[0]['data']['outputComplete'] is False
        else:
            assert not malformed and frames[-1] == terminal[0]
            assert output == b'x' * args.bytes
        ok(kernel.TerminateJobObject(job, 1))
        accounting = c.create_string_buffer(48)
        ok(kernel.QueryInformationJobObject(job, 1, accounting, len(accounting), None))
        active = struct.unpack_from('<I', accounting, 40)[0]
        assert active == 0
        receipt = dict(binary=str(args.binary.resolve()), binarySha256=hashlib.sha256(args.binary.read_bytes()).hexdigest(),
                       shellPid=shell_pid, shellExitCode=exit_code.value, pipeCapacity=out_size.value,
                       queuedBytesAtShellExit=available.value, minimumFrameBytes=frame_min,
                       consumerPausedAfterShellExitMs=paused_ms, outputBytes=len(output),
                       outputSha256=hashlib.sha256(output).hexdigest(), jobActiveProcesses=active, frames=frames,
                       malformedFrames=malformed)
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.with_suffix('.stdout').write_bytes(first + remaining)
        args.receipt.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        print(json.dumps({k: v for k, v in receipt.items() if k != 'frames'}))
    finally:
        kernel.TerminateJobObject(job, 1)
        if child:
            child.wait(timeout=10)
        if shell:
            kernel.CloseHandle(shell)
        kernel.CloseHandle(job)


if __name__ == '__main__':
    main()
