import sys
from pathlib import Path

# make `synth` and the package importable when running pytest from the repo root
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))
