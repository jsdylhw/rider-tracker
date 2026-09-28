#!/usr/bin/env python3
"""Optional real Chromium/Edge smoke, isolated from local configuration/accounts.

Example (WSL): python scripts/test-python-browser-ui.py --browser
  '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
The selected browser must support --headless and --dump-dom. No downloads.
"""
import argparse
import base64
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
HARNESS = r'''
<script>
(async () => {
  const result = document.createElement('pre');
  let stage = 'initialization';
  result.id = 'rider-browser-smoke';
  document.body.append(result);
  const wait = async (predicate) => {
    for (let i=0; i<200; i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,50)); }
    throw new Error('UI condition timed out at '+stage);
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  try {
    await wait(()=>document.querySelector('#agentSessions select')?.value &&
                   !document.querySelector('#agentSessions .agent-session-new')?.disabled);
    const controls = document.querySelector('#agentSessions');
    const select = controls.querySelector('select');
    const saved = 'browser-smoke-session';
    stage='create persisted session';
    const created = await fetch('/api/agent/sessions', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session_id:saved,kind:'chat'})});
    assert(created.ok,'Cookie-authenticated session creation failed');
    stage='refresh session list';
    controls.querySelector('[aria-label="刷新会话记录"]').click();
    await wait(()=>[...select.options].some(o=>o.value===saved) && !select.disabled);
    select.value=saved; select.dispatchEvent(new Event('change',{bubbles:true}));
    stage='select persisted session';
    await wait(()=>!select.disabled && select.value===saved);
    controls.querySelector('[aria-label="删除当前会话"]').click();
    stage='open delete dialog';
    const dialog=controls.querySelector('dialog');
    await wait(()=>dialog.open);
    dialog.querySelector('button:not(.is-danger)').click();
    assert(!dialog.open,'Cancel did not close deletion dialog');
    controls.querySelector('[aria-label="删除当前会话"]').click();
    await wait(()=>dialog.open);
    dialog.querySelector('button.is-danger').click();
    stage='delete persisted session';
    await wait(()=>!select.disabled && ![...select.options].some(o=>o.value===saved));
    assert((await fetch('/api/agent/sessions/'+saved)).status===404,'Deleted session still exists');
    const old=select.value;
    controls.querySelector('.agent-session-new').click();
    stage='new draft';
    await wait(()=>!select.disabled && select.value!==old && select.value);
    await import('/vendor/@garmin/fitsdk/src/index.js');
    assert(document.querySelector('#routeModeAiBtn').disabled,'Unconfigured map should degrade');
    result.textContent='PASS: initialized, cookie auth, persisted session selection, cancel/delete, new draft, SDK, degradation';
  } catch(error) { result.textContent='FAIL: '+error.message; }
})();
</script>
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', required=True)
    args = parser.parse_args()
    windows = sys.platform == 'linux' and args.browser.lower().endswith('.exe')
    with tempfile.TemporaryDirectory(prefix='rider-browser-smoke-') as directory:
        temp = Path(directory)
        spec = importlib.util.spec_from_file_location('browser_assets', ROOT / 'scripts/build-browser-assets.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        assets = temp / 'assets'
        builder.build(ROOT, assets)
        page = assets / 'index.html'
        page.write_text(page.read_text(encoding='utf-8').replace('</body>', HARNESS + '</body>'), encoding='utf-8')
        config = temp / 'config.yaml'
        config.write_text('web_api_token: browser-smoke-token\n', encoding='utf-8')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env = {**os.environ, 'RIDER_CONFIG_PATH': str(config), 'TRAINING_AGENT_CONFIG_PATH': str(config),
               'RIDER_ENV_PATH': str(temp / 'absent.env'), 'RIDER_PROJECT_ROOT': str(temp),
               'RIDER_DATA_ROOT': str(temp / 'data'), 'RIDER_TRACKER_DB_PATH': str(temp / 'rider.db'),
               'TRAINING_AGENT_DB_PATH': str(temp / 'rider.db'), 'FIT_FILE_DIR': str(temp / 'fit'),
               'RIDER_CREDENTIALS_DIR': str(temp / 'credentials'), 'STRAVA_TOKEN_STORE': str(temp / 'tokens.json'),
               'GOOGLE_MAPS_API_KEY': '', 'RIDER_LOG_DIR': str(temp / 'logs'),
               'RIDER_CACHE_DIR': str(temp / 'cache'), 'RIDER_WORKFLOW_DIR': str(temp / 'workflows'),
               'RIDER_WORKFLOW_JOURNAL_DIR': str(temp / 'workflows/journals'),
               'RIDER_ACTIVITY_WORKFLOW_DIR': str(temp / 'workflows/activities')}
        profile = str(temp / 'profile')
        if windows:
            parent = subprocess.check_output([POWERSHELL, '-NoProfile', '-NonInteractive', '-Command', '$env:TEMP'], text=True).strip()
            profile = parent + '\\' + temp.name
        server = subprocess.Popen([sys.executable, str(ROOT / 'scripts/start-rider.py'), '--without-worker',
                                   '--host', '127.0.0.1', '--port', str(port), '--assets', str(assets)],
                                  env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        browser = None
        try:
            url = f'http://127.0.0.1:{port}'
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 30
            while True:
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Isolated browser backend did not become ready')
                try:
                    with opener.open(url + '/health', timeout=1):
                        break
                except OSError:
                    time.sleep(.2)
            browser = subprocess.Popen([args.browser, '--headless=new', '--disable-gpu', '--no-first-run',
                '--disable-background-networking', '--disable-extensions', '--no-default-browser-check',
                '--user-data-dir=' + profile, '--dump-dom', '--virtual-time-budget=20000', url],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            output, _ = browser.communicate(timeout=55)
            text = output.decode('utf-8', errors='replace')
            start = text.find('<pre id="rider-browser-smoke">')
            result = text[start:text.find('</pre>', start)] if start >= 0 else 'No test result rendered'
            if browser.returncode or '>PASS:' not in result:
                raise RuntimeError('Real browser check failed: ' + result)
            print(result.split('>', 1)[1])
        finally:
            if browser and browser.poll() is None:
                browser.kill()
                browser.wait()
            server.terminate()
            server.wait(timeout=15)
            if windows:
                literal = "'" + profile.replace("'", "''") + "'"
                command = "$ProgressPreference='SilentlyContinue'; if (Test-Path -LiteralPath " + literal + ") { Remove-Item -LiteralPath " + literal + " -Recurse -Force -ErrorAction Stop }"
                encoded = base64.b64encode(command.encode('utf-16-le')).decode('ascii')
                subprocess.run([POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], check=True)


if __name__ == '__main__':
    main()
