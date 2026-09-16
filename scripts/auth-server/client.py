"""Machine authentication for local automation; never sends credentials off-host."""
import os
from pathlib import Path
import urllib.parse
import urllib.request


def headers(url):
    target = urllib.parse.urlsplit(url)
    if target.scheme != 'http' or target.hostname not in ('127.0.0.1', 'localhost', '::1') or target.port != 8080:
        return {}
    token = os.environ.get('AIGCCAT_AUTOMATION_TOKEN')
    if not token:
        token = (Path.home() / '.config/aigccat/auth/secrets/automation.token').read_text().strip()
    return {'Authorization': 'Bearer ' + token}


def urlopen(request, *args, **kwargs):
    if isinstance(request, str):
        request = urllib.request.Request(request)
    for name, value in headers(request.full_url).items():
        # urllib must not forward the secret when following any redirect.
        request.add_unredirected_header(name, value)
    return urllib.request.urlopen(request, *args, **kwargs)
