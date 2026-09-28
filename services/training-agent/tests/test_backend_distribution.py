"""Build the actual wheel offline and verify non-Python runtime resources."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib
import zipfile


def test_wheel_contains_skills_and_runs_outside_checkout(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    project = tomllib.loads((backend / 'pyproject.toml').read_text())
    source = tmp_path / 'source'
    source.mkdir()
    shutil.copyfile(backend / 'pyproject.toml', source / 'pyproject.toml')
    for name in project['tool']['setuptools']['py-modules']:
        shutil.copyfile(backend / f'{name}.py', source / f'{name}.py')
    packages = project['tool']['setuptools']['packages']['find']['include']
    for name in packages:
        if '.' in name:
            continue
        # Explicit source allowlist: never collect local data, credentials or logs.
        for path in (backend / name).rglob('*'):
            if path.suffix not in {'.py', '.md'} or not path.is_file():
                continue
            target = source / path.relative_to(backend)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    wheels = tmp_path / 'wheels'
    built = subprocess.run([sys.executable, '-m', 'pip', 'wheel', '--no-deps', '--no-build-isolation',
                            '--no-index', '--disable-pip-version-check', '--wheel-dir', str(wheels), str(source)],
                           capture_output=True, text=True, timeout=60)
    assert built.returncode == 0, built.stdout + built.stderr
    installed = tmp_path / 'installed'
    with zipfile.ZipFile(next(wheels.glob('*.whl'))) as archive:
        names = archive.namelist()
        expected = [p.relative_to(backend).as_posix() for p in (backend / 'agent/skills/library').rglob('*.md')]
        assert expected and set(expected).issubset(names)
        assert not any(n.startswith(('tests/', 'data/', 'logs/')) or n.endswith('config.yaml') for n in names)
        archive.extractall(installed)
    probe = '''
from pathlib import Path
from agent.skills.catalog import SKILL_CATALOG
from agent.skills.loader import load_skill_instructions
import app.browser
import sys
assert Path(app.browser.__file__).is_relative_to(Path.cwd() / 'installed')
assert 'agent.main_agent.loop' not in sys.modules
assert 'agent.route.agent' not in sys.modules
assert 'agent.tools.handlers.route' not in sys.modules
for skill in SKILL_CATALOG:
    assert load_skill_instructions(skill, sport_types=['cycling', 'running', 'walking']).strip()
'''
    env = {**os.environ, 'PYTHONPATH': str(installed), 'RIDER_PROJECT_ROOT': str(tmp_path),
           'TRAINING_AGENT_CONFIG_PATH': str(tmp_path / 'absent.yaml')}
    result = subprocess.run([sys.executable, '-c', probe], cwd=tmp_path, env=env,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
