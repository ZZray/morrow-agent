"""Model-only Host with independent exact-output review. Author: Ray Zhang."""
from pathlib import Path
from common import Host, cli


class ModelOnlyHost(Host):
    kind = 'model-only'
    tools = False

    @staticmethod
    def target(root: Path) -> dict:
        return {'kind': 'model-output'}


if __name__ == '__main__':
    cli(ModelOnlyHost)
