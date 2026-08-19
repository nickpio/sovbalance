#!/bin/sh
# Reproduce Umbrel bind-mount owners and assert POST /wallet succeeds.
set -eu

IMAGE=${1:-sovbalance:test}
XPUB="xpub$(python3 -c 'print("A" * 110)')"
XMR_ADDRESS="4$(python3 -c 'print("1" * 94)')"
XMR_VIEWKEY="$(python3 -c 'print("a" * 64)')"

cleanup_dir() {
  docker run --rm -v "${1}:/data" busybox sh -c 'rm -rf /data/* /data/.[!.]*' >/dev/null 2>&1 || true
  rmdir "$1" 2>/dev/null || true
}

pass=0
fail=0
containers=""

cleanup() {
  if [ -n "$containers" ]; then
    docker rm -f $containers >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

die() {
  echo "FAIL: $*" >&2
  fail=$((fail + 1))
}

ok() {
  echo "OK: $*"
  pass=$((pass + 1))
}

wait_health() {
  port=$1
  i=0
  while [ "$i" -lt 40 ]; do
    if curl -sf "http://127.0.0.1:${port}/health" >/dev/null; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.25
  done
  return 1
}

post_btc() {
  curl -sS -H "Content-Type: application/json" -X POST "http://127.0.0.1:${1}/wallet" \
    -d "{\"wallet\":\"btc-${2}\",\"type\":\"btc\",\"xpub\":\"${XPUB}\"}"
}

post_xmr() {
  curl -sS -H "Content-Type: application/json" -X POST "http://127.0.0.1:${1}/wallet" \
    -d "{\"wallet\":\"xmr-${2}\",\"type\":\"xmr\",\"address\":\"${XMR_ADDRESS}\",\"viewKey\":\"${XMR_VIEWKEY}\",\"restoreHeight\":0}"
}

run_case() {
  name=$1
  user=$2
  owner=$3
  seed_uid=$4

  dir=$(mktemp -d)
  port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()')

  docker run --rm -v "${dir}:/data" busybox chown "${owner}" /data >/dev/null
  docker run --rm -v "${dir}:/data" busybox chmod 755 /data >/dev/null

  if [ -n "$seed_uid" ]; then
    docker run --rm -v "${dir}:/data" busybox sh -c "echo '[]' > /data/wallets.json && chown ${seed_uid} /data/wallets.json && chmod 644 /data/wallets.json"
  fi

  user_args=""
  if [ -n "$user" ]; then
    user_args="--user ${user}"
  fi

  cid=$(docker run -d $user_args -p "${port}:3710" -v "${dir}:/data" -e PORT=3710 "$IMAGE")
  containers="$containers $cid"

  if ! wait_health "$port"; then
    die "$name: health check failed"
    docker logs "$cid" 2>&1 | tail -20
    cleanup_dir "$dir"
    return
  fi

  uid_inside=$(docker exec "$cid" id -u)
  btc=$(post_btc "$port" "$name" || true)
  xmr=$(post_xmr "$port" "$name" || true)

  echo "$name (container uid=${uid_inside}) BTC=${btc} XMR=${xmr}"

  echo "$btc" | grep -q '"ok":true' && echo "$xmr" | grep -q '"ok":true' || {
    die "$name: expected both POSTs to return {ok:true}"
    docker logs "$cid" 2>&1 | tail -30
    cleanup_dir "$dir"
    return
  }

  docker exec "$cid" test -w /data/wallets.json || {
    cleanup_dir "$dir"
    return
  }

  ok "$name"
  cleanup_dir "$dir"
}

echo "Testing image ${IMAGE}"

# Cases that 1.2.0 must pass (no compose user, image default = root)
run_case "root-owned-dir" "" "0:0" ""
run_case "uid1000-owned-dir" "" "1000:1000" ""
run_case "uid100-owned-dir" "" "100:100" ""
run_case "leftover-uid100-file" "" "0:0" "100:100"
run_case "leftover-uid1000-file" "" "1000:1000" "1000:1000"

# 1.1.3 failure mode: compose user 1000 against a Docker-created root mount
dir=$(mktemp -d)
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()')
docker run --rm -v "${dir}:/data" busybox chown 0:0 /data >/dev/null
docker run --rm -v "${dir}:/data" busybox chmod 755 /data >/dev/null
cid=$(docker run -d --user 1000:1000 -p "${port}:3710" -v "${dir}:/data" -e PORT=3710 "$IMAGE")
containers="$containers $cid"
wait_health "$port" || true
btc=$(post_btc "$port" "uid1000-on-root" || true)
echo "control uid1000-on-root-dir BTC=${btc}"
if echo "$btc" | grep -q '"ok":true'; then
  die "control: uid 1000 writing to root-owned 755 /data unexpectedly succeeded (then 1.1.3 would have worked)"
else
  ok "control: uid 1000 still cannot write root-owned /data (why 1.1.3 failed)"
fi
cleanup_dir "$dir"

echo
echo "passed=${pass} failed=${fail}"
[ "$fail" -eq 0 ]
