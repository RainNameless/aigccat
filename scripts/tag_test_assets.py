"""Label only manifest-owned test assets; preserve existing tags."""
import base64
import json
from pathlib import Path
import requests

# Local service authentication, shared with the installed generation workers.
import sys as _auth_sys
from pathlib import Path as _AuthPath
_auth_sys.path.insert(0, str(_AuthPath.home() / '.config/aigccat/client'))
from aigccat_auth import urlopen as _auth_urlopen, headers as _auth_headers

root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'outputs/test-models-100/manifest.json').read_text())
for record in manifest['records']:
    asset=record.get('asset_id')
    if not asset or not record['name'].startswith('test_'):continue
    url=f'http://127.0.0.1:8080/api/assets/characters/{asset}/file/source/tags.json'
    response=requests.get(url,headers=_auth_headers(url),timeout=30)
    tags=response.json().get('tags',[]) if response.ok else []
    data={'tags':list(dict.fromkeys([*tags,'test'])),'experiment':'test-models-100','assessment':'rejected_same_template_variations'}
    response=requests.put(url,headers=_auth_headers(url),json={'bytes_b64':base64.b64encode(json.dumps(data).encode()).decode()},timeout=30)
    response.raise_for_status()
print('Tagged manifest-owned assets: '+str(sum(bool(r.get('asset_id')) for r in manifest['records'])))
