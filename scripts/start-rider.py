#!/usr/bin/env python3
"""Unified Python entry. Uses the active Python environment, not Node."""
import argparse
import os
from pathlib import Path
import signal
import secrets
import socket
import subprocess
import sys
import time
import threading
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'services/training-agent'
sys.path.insert(0, str(BACKEND))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker-only', action='store_true')
    parser.add_argument('--without-worker', action='store_true')
    parser.add_argument('--host')
    parser.add_argument('--port', type=int)
    parser.add_argument('--assets', type=Path)
    parser.add_argument('--public-entry', action='store_true', help='Use Rider public host/port (default 8787).')
    parser.add_argument('--parent-stdin', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker_only and args.without_worker:
        parser.error('--worker-only and --without-worker are mutually exclusive')
    from app.runtime_config import load_runtime_environment
    from project_paths import runtime_paths
    env = load_runtime_environment(ROOT)
    runtime_paths(base=ROOT, environ=env)  # Fail closed on conflicting databases.
    if args.assets:
        asset_root = args.assets.resolve()
        if not (asset_root / 'index.html').is_file():
            parser.error('--assets must contain index.html')
        env['RIDER_BROWSER_ASSET_ROOT'] = str(asset_root)
    env['PYTHONUNBUFFERED'] = '1'
    default_host = (env.get('HOST') or '127.0.0.1') if args.public_entry else env['PERSONAL_FIT_AGENT_HOST']
    default_port = (env.get('PORT') or '8787') if args.public_entry else env['PERSONAL_FIT_AGENT_PORT']
    host = args.host or default_host
    port = args.port if args.port is not None else int(default_port)
    if not 1 <= port <= 65535:
        parser.error('port must be between 1 and 65535')
    env['PERSONAL_FIT_AGENT_HOST'] = host
    env['PERSONAL_FIT_AGENT_PORT'] = str(port)
    subprocess.run([sys.executable, str(ROOT / 'scripts/database-tool.py'), 'ensure', '--quiet'],
                   cwd=ROOT, env=env, check=True)
    children = []
    web = worker = agent = None
    worker_failure_reported = False
    agent_failure_reported = False
    stopping = False

    def stop(_signum=None, _frame=None):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, stop)
    if args.parent_stdin:
        def watch_parent():
            # Node's Windows pipe also needs to stay out of Python's buffered
            # stdin lock (used by subprocess startup and interpreter shutdown).
            while os.read(sys.stdin.fileno(), 1):
                pass
            stop()
        threading.Thread(target=watch_parent, daemon=True).start()
    try:
        if not args.worker_only:
            with socket.socket() as reserved:
                reserved.bind(('127.0.0.1', 0))
                agent_port = reserved.getsockname()[1]
            while agent_port == port:
                with socket.socket() as reserved:
                    reserved.bind(('127.0.0.1', 0))
                    agent_port = reserved.getsockname()[1]
            env['RIDER_AGENT_PROCESS_URL'] = f'http://127.0.0.1:{agent_port}'
            env['RIDER_AGENT_PROCESS_TOKEN'] = secrets.token_urlsafe(32)
            try:
                # The parent's stdin is a lifecycle channel, not child input.
                agent = subprocess.Popen([sys.executable, '-m', 'uvicorn',
                    'app.agent_process:create_agent_process_app', '--factory', '--host', '127.0.0.1',
                    '--port', str(agent_port), '--log-level', 'warning', '--no-access-log'], cwd=BACKEND, env=env,
                    stdin=subprocess.DEVNULL)
                children.append(agent)
            except OSError:
                print('[rider] Agent process could not start; ordinary Rider features remain available.', file=sys.stderr, flush=True)
            # Avoid serving a page whose first session request races normal Agent
            # startup. A broken Agent still cannot prevent the Web from starting.
            if agent is not None:
                agent_ready = False
                readiness = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                deadline = time.monotonic() + 5
                probe = urllib.request.Request(env['RIDER_AGENT_PROCESS_URL'] + '/health',
                    headers={'X-Rider-Agent-Token': env['RIDER_AGENT_PROCESS_TOKEN']})
                while not stopping and agent.poll() is None and time.monotonic() < deadline:
                    try:
                        with readiness.open(probe, timeout=.5) as response:
                            if response.status == 200:
                                agent_ready = True
                                break
                    except OSError:
                        time.sleep(.1)
                if not agent_ready and not stopping:
                    print('[rider] Agent is not ready; starting the ordinary Rider interface anyway.', file=sys.stderr, flush=True)
            if stopping:
                return
            web = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.browser:app',
                '--host', host, '--port', str(port), '--log-level', 'warning', '--no-access-log'], cwd=BACKEND, env=env,
                stdin=subprocess.DEVNULL)
            children.append(web)
            url_host = '127.0.0.1' if host == '0.0.0.0' else ('[::1]' if host == '::' else host)
            if ':' in url_host and not url_host.startswith('['):
                url_host = f'[{url_host}]'
            url = f'http://{url_host}:{port}'
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 30
            while not stopping:
                if web.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Python browser entry failed to become ready.')
                try:
                    with opener.open(url + '/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(.25)
            if not stopping:
                print(f'[rider] Python browser entry: {url}', flush=True)
        if not stopping and not args.without_worker:
            try:
                worker = subprocess.Popen([sys.executable, '-m', 'worker.main'], cwd=BACKEND, env=env,
                    stdin=subprocess.DEVNULL)
                children.append(worker)
            except OSError:
                if args.worker_only:
                    raise
                print('[rider] Worker could not start; the browser and ordinary APIs remain available.', file=sys.stderr, flush=True)
        while not stopping:
            if web is not None and web.poll() is not None:
                raise RuntimeError('Rider web process stopped; shutting down its companion processes.')
            if worker is not None and worker.poll() is not None:
                if args.worker_only:
                    raise RuntimeError('Rider Worker stopped.')
                if not worker_failure_reported:
                    print('[rider] Worker stopped; background jobs are unavailable. The browser remains available.', file=sys.stderr, flush=True)
                    worker_failure_reported = True
            if agent is not None and agent.poll() is not None and not agent_failure_reported:
                print('[rider] Agent process stopped; ordinary Rider features remain available. Requests will not be replayed.', file=sys.stderr, flush=True)
                agent_failure_reported = True
            time.sleep(.2)
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        deadline = time.monotonic() + 10
        for child in children:
            try:
                child.wait(timeout=max(.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    main()
