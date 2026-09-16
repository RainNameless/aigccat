"""Compatibility entry point for the unified authenticated gateway deployment."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name('deploy-unified.py')), run_name='__main__')
