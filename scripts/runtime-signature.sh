#!/usr/bin/env bash
# Hash the actual build recipe plus installed dependency manifests and preparation scripts.
set -euo pipefail
[[ $# -gt 0 ]] || set -- Dockerfile
python3 - "$@" <<'PY'
import hashlib,sys
from pathlib import Path
files = ['package.json', 'package-lock.json', 'preview-template/package.json',
         'preview-template/package-lock.json', 'preview-browser/package.json',
         'preview-browser/package-lock.json', 'image-compression/requirements.txt',
         'scripts/prepare-image-compression.mjs', 'scripts/pip-environment.mjs',
         'scripts/prepare-preview.mjs', 'preview-browser/build.sh']
hash = hashlib.sha256()
hash.update(b'Dockerfile.recipe\0' + Path(sys.argv[1]).read_bytes())
for filename in files + sys.argv[2:]:
    hash.update(filename.encode() + b'\0')
    hash.update(Path(filename).read_bytes())
print(hash.hexdigest())
PY
