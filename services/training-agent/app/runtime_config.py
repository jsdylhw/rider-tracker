"""Rider's Python launch environment; compatibility with the legacy Node entry.

This is startup-only: never print the resulting environment (it contains secrets).
"""
import os
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from dotenv import dotenv_values

SCOPES = 'read,read_all,activity:read_all,activity:write'


def load_runtime_environment(root: Path, environ=None):
    root = root.resolve()
    supplied = os.environ if environ is None else environ
    env_file = Path(supplied.get('RIDER_ENV_PATH') or root / '.env')
    env = {k: v for k, v in dotenv_values(env_file).items() if v is not None}
    env.update(supplied)
    config_path = Path(env.get('RIDER_CONFIG_PATH') or root / 'config.yaml').resolve()
    if config_path.exists():
        with config_path.open(encoding='utf-8') as stream:
            values = yaml.safe_load(stream) or {}
    else:
        values = {}
    if not isinstance(values, dict):
        raise ValueError('Rider configuration must be a YAML object.')
    return build_runtime_environment(root, config_path, values, env)


def build_runtime_environment(root: Path, config_path: Path, values: dict, environ: dict):
    env = dict(environ)
    root = root.resolve()

    def section(name):
        value = values.get(name)
        return value if isinstance(value, dict) else {}

    def default(name, value):
        if not env.get(name) and value is not None and value != '':
            env[name] = str(value).lower() if isinstance(value, bool) else str(value)

    def path_default(name, value):
        default(name, (root / str(value)).resolve())

    rider, backend = section('rider'), section('training_agent')
    for name, key in {'HOST': 'host', 'PORT': 'port', 'APP_BASE_URL': 'app_base_url',
                      'FRONTEND_REDIRECT_URL': 'frontend_redirect_url', 'RIDER_OPEN_BROWSER': 'open_browser',
                      'STRAVA_REDIRECT_URI': 'strava_redirect_uri'}.items():
        default(name, rider.get(key))
    default('STRAVA_SCOPES', rider.get('strava_scopes') or SCOPES)
    env['STRAVA_SCOPES'] = ','.join(dict.fromkeys(s.strip() for s in (SCOPES + ',' + env['STRAVA_SCOPES']).split(',') if s.strip()))
    path_default('RIDER_DATA_ROOT', rider.get('data_root') or 'data')
    data = (root / env['RIDER_DATA_ROOT']).resolve()
    env['RIDER_DATA_ROOT'] = str(data)
    paths = {
        'RIDER_TRACKER_DB_PATH': ('database_path', 'rider-tracker.db'),
        'FIT_FILE_DIR': ('fit_file_dir', 'files/fit'),
        'GARMIN_FIT_DIR': ('garmin_fit_dir', 'files/fit/garmin'),
        'RIDER_CREDENTIALS_DIR': ('credentials_dir', 'credentials'),
        'RIDER_WORKFLOW_DIR': ('workflow_dir', 'workflows'),
        'RIDER_WORKFLOW_JOURNAL_DIR': ('workflow_journal_dir', 'workflows/journals'),
        'RIDER_ACTIVITY_WORKFLOW_DIR': ('activity_workflow_dir', 'workflows/activity-runs'),
        'RIDER_LOG_DIR': ('log_dir', 'logs'), 'RIDER_CACHE_DIR': ('cache_dir', 'cache'),
        'RIDER_EVALUATION_ARTIFACT_DIR': ('evaluation_artifact_dir', 'artifacts/evaluation'),
        'RIDER_MIGRATION_DIR': ('migration_dir', 'migrations'),
    }
    for name, (key, fallback) in paths.items():
        path_default(name, rider.get(key) or data / fallback)
    path_default('STRAVA_TOKEN_STORE', section('strava').get('token_store') or data / 'credentials/strava-tokens.json')
    default('TRAINING_AGENT_DB_PATH', env['RIDER_TRACKER_DB_PATH'])
    default('TRAINING_AGENT_MANAGED_DATABASE', '1')
    default('RIDER_PROJECT_ROOT', root)
    try:
        endpoint = urlsplit(env.get('PERSONAL_FIT_AGENT_URL', ''))
        host = endpoint.hostname if endpoint.scheme in {'http', 'https'} else None
        port = endpoint.port if host else None
    except ValueError:
        host = port = None
    default('PERSONAL_FIT_AGENT_HOST', host or backend.get('host') or '127.0.0.1')
    default('PERSONAL_FIT_AGENT_PORT', port or backend.get('port') or '8000')
    default('PERSONAL_FIT_AGENT_URL', f"http://{env['PERSONAL_FIT_AGENT_HOST']}:{env['PERSONAL_FIT_AGENT_PORT']}")
    default('PERSONAL_FIT_AGENT_TOKEN', values.get('web_api_token'))
    default('PYTHON_EXECUTABLE', backend.get('python_executable'))
    default('TRAINING_AGENT_CONFIG_PATH', config_path)
    key = str(section('google').get('api_key') or '').strip()
    if not key.startswith('replace-with-'):
        default('GOOGLE_MAPS_API_KEY', key)
    try:
        endpoint = urlsplit(str(section('agent').get('base_url') or ''))
        host = endpoint.hostname if endpoint.scheme in {'http', 'https'} else None
    except ValueError:
        host = None
    if host:
        entries = [s.strip() for value in (env.get('NO_PROXY', ''), env.get('no_proxy', '')) for s in value.split(',') if s.strip()]
        env['NO_PROXY'] = env['no_proxy'] = ','.join(dict.fromkeys([*entries, host]))
    return env
