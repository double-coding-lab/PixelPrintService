#!/usr/bin/env bash
# Invoked by a dedicated forced-command SSH key. Configuration stays on the server.
set -euo pipefail
umask 077
release=${1:-}
[[ $release =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release commit' >&2; exit 2; }
app_dir=${PIXELPRINT_DEPLOY_DIR:-/opt/pixelprint}
cd "$app_dir"
[[ -f .runtime/deploy.env ]] && source .runtime/deploy.env
mkdir -p .runtime
exec 9>.runtime/deploy.lock
flock -w 900 9 || { echo 'Another deployment is still running' >&2; exit 1; }
stage=$(mktemp -d .runtime/release.XXXXXX)
trap 'rm -rf "$stage"' EXIT
# Drain stdin before fetching: only the CI-produced dist archive is accepted.
head -c 67108865 > "$stage/build.tgz"
[[ $(wc -c < "$stage/build.tgz") -le 67108864 ]] || { echo 'Build archive too large' >&2; exit 2; }
if [[ -n ${DEPLOY_GIT_PROXY:-} ]]; then
  git -c "http.proxy=$DEPLOY_GIT_PROXY" fetch --no-tags origin main
else
  git fetch --no-tags origin main
fi
current=$(git rev-parse refs/remotes/origin/main)
if [[ $release != "$current" ]]; then
  echo 'Skipped stale release: main has moved forward'
  exit 0
fi
# Never reset or discard operator changes.
git merge --ff-only refs/remotes/origin/main
mkdir "$stage/source"
git archive "$release" | tar -x -C "$stage/source"
python3 - "$stage/build.tgz" "$stage/source" "$release" <<'PY'
import json,sys,tarfile,posixpath
archive,dest,release=sys.argv[1:]
with tarfile.open(archive,'r:gz') as bundle:
    members=bundle.getmembers()
    if len(members)>10000 or sum(m.size for m in members)>268435456:
        raise SystemExit('Build archive exceeds limits')
    seen=set()
    for member in members:
        name=member.name.rstrip('/')
        if name in seen or name.startswith('/') or '..' in name.split('/') or posixpath.normpath(name)!=name:
            raise SystemExit('Invalid build archive path')
        if not (name=='dist' or name.startswith('dist/')) or not (member.isfile() or member.isdir()):
            raise SystemExit('Only regular dist assets are allowed')
        seen.add(name)
    meta=bundle.extractfile('dist/release.json')
    if not meta or json.load(meta).get('commit')!=release or 'dist/index.js' not in seen or 'dist/public/index.html' not in seen:
        raise SystemExit('Build archive does not match release')
    bundle.extractall(dest,members=members)
PY
# Snapshot the operator recipe and declared build inputs into the exact release context.
recipe=${DEPLOY_DOCKERFILE:-Dockerfile}
if [[ $recipe == Dockerfile ]]; then
  cp "$stage/source/Dockerfile" "$stage/source/Dockerfile.runtime"
else
  cp "$recipe" "$stage/source/Dockerfile.runtime"
fi
context_files=()
if [[ -n ${DEPLOY_BUILD_FILES:-} ]]; then
  IFS=: read -ra context_files <<< "$DEPLOY_BUILD_FILES"
  for file in "${context_files[@]}"; do
    [[ $file != /* && $file != *..* && $file != *project.config* && $file != *.env* && $file != *.private.json && ! -L $file && -f $file ]] || { echo 'Invalid extra build input' >&2; exit 2; }
    mkdir -p "$stage/source/$(dirname "$file")"
    cp "$file" "$stage/source/$file"
  done
fi
signature=$(cd "$stage/source" && bash scripts/runtime-signature.sh Dockerfile.runtime ${context_files[@]+"${context_files[@]}"})
IFS=: read -ra compose_files <<< "${DEPLOY_COMPOSE_FILES:-compose.yaml}"
compose=(docker compose)
for file in "${compose_files[@]}"; do compose+=(-f "$file"); done
# Existing deployment overrides remain in force; this last overlay changes only the app image.
release_file=.runtime/compose.release.yaml
container=$("${compose[@]}" ps -q app)
previous=''
previous_id=''
if [[ -n $container ]]; then
  previous_id=$(docker inspect --format '{{.Image}}' "$container")
  previous="pixelprint-app:rollback-${stage##*.}"
  docker image tag "$previous_id" "$previous"
fi
image="pixelprint-app:git-$release"
build=(docker build)
if [[ -n ${DEPLOY_BUILD_PROXY:-} ]]; then
  build+=(--build-arg "HTTP_PROXY=$DEPLOY_BUILD_PROXY" --build-arg "HTTPS_PROXY=$DEPLOY_BUILD_PROXY" --add-host host.docker.internal:host-gateway)
fi
# Bind the fingerprint to the exact running image, not a mutable tag.
if [[ -n $previous_id && -f .runtime/runtime-signature && -f .runtime/runtime-image && $(cat .runtime/runtime-signature) == "$signature" && $(cat .runtime/runtime-image) == "$previous_id" ]]; then
  runtime_base=$previous
else
  runtime_base="pixelprint-app:runtime-${stage##*.}"
  "${build[@]}" -f "$stage/source/Dockerfile.runtime" -t "$runtime_base" "$stage/source"
fi
# Both paths finish with the same CI-validated dist and exact archived release source.
printf 'FROM %s\nCOPY --chown=node:node . /app/\nLABEL org.opencontainers.image.revision="%s"\n' "$runtime_base" "$release" > "$stage/source/Dockerfile.release"
printf '.git\n.env\n.env.*\nproject.config.json\n*.private.json\n.runtime\n.data\n.task\n**/node_modules\nDockerfile.runtime\nDockerfile.release\n' > "$stage/source/.dockerignore"
docker build --pull=false -f "$stage/source/Dockerfile.release" -t "$image" "$stage/source"
docker run --rm --entrypoint npm "$image" run check:templates
# Preserve the old release overlay until the new process passes its health check.
[[ -f $release_file ]] && cp "$release_file" "$stage/previous-release.yaml"
activate() {
  printf 'services:\n  app:\n    image: %s\n' "$1" > "$release_file"
  "${compose[@]}" -f "$release_file" up -d --no-build app
}
rollback() {
  if [[ -n $previous ]]; then
    echo 'Activation failed; restoring previous app image' >&2
    activate "$previous" || true
  elif [[ -f $stage/previous-release.yaml ]]; then
    cp "$stage/previous-release.yaml" "$release_file"
  else
    rm -f "$release_file"
  fi
}
if ! activate "$image"; then rollback; exit 1; fi
healthy=false
for attempt in $(seq 1 30); do
  if curl --noproxy '*' --fail --silent --max-time 3 "${DEPLOY_HEALTH_URL:-http://127.0.0.1:8080/health}" > /dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ $healthy != true ]]; then rollback; exit 1; fi
docker image inspect --format '{{.Id}}' "$image" > .runtime/runtime-image
printf '%s\n' "$signature" > .runtime/runtime-signature
printf '%s\n' "$release" > .runtime/deployed-commit
echo "Deployment healthy: $release"
