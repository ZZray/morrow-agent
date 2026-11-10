"""Single-file business Host. Author: Ray Zhang."""
import os
from pathlib import Path
from common import Host, cli


class LocalFileHost(Host):
    kind = 'local-file'

    @staticmethod
    def target(root: Path) -> dict:
        return {'path': str(root / 'result.txt')}

    def write_payload(self, content: bytes) -> dict:
        path = Path(self.manifest['target']['path'])
        with path.open('wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        return {'path': str(path)}

    def read_payload(self) -> bytes:
        return Path(self.manifest['target']['path']).read_bytes()


if __name__ == '__main__':
    cli(LocalFileHost)
