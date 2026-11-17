#!/usr/bin/env bash
set -Eeuo pipefail

deploy_root="${1:?deployment root is required}"
release_id="${2:?release id is required}"
archive_path="${3:?archive path is required}"
app_port="${4:-3000}"

if [[ ! "$deploy_root" =~ ^/[A-Za-z0-9._/-]+$ || "$deploy_root" == "/" || ! "$release_id" =~ ^[a-f0-9]{40}$ || ! "$app_port" =~ ^[0-9]{1,5}$ ]]; then
  printf 'Invalid deployment arguments\n' >&2
  exit 2
fi

release_dir="${deploy_root}/releases/${release_id}"
current_link="${deploy_root}/current"
runtime_config="${deploy_root}/iseol-runtime.json"
previous_release="$(readlink -f "$current_link" 2>/dev/null || true)"
rollback_needed=0

restore_previous_release() {
  status=$?
  if [[ $status -ne 0 && $rollback_needed -eq 1 ]]; then
    printf 'Deployment failed; restoring previous Iseol release\n' >&2
    if [[ -n "$previous_release" && -d "$previous_release" ]]; then
      ln -sfn "$previous_release" "$current_link"
      export ISEOL_RELEASE_DIR="$current_link"
      export ISEOL_RUNTIME_CONFIG="$runtime_config"
      export ISEOL_WEB_HOST=127.0.0.1
      export ISEOL_WEB_PORT="$app_port"
      pm2 startOrReload "${current_link}/ecosystem.config.cjs" --only iseol-bot --update-env || true
      pm2 startOrReload "${current_link}/ecosystem.config.cjs" --only iseol-web --update-env || true
      pm2 save || true
    else
      pm2 delete iseol-bot || true
      pm2 delete iseol-web || true
    fi
  fi
  exit "$status"
}
trap restore_previous_release EXIT

mkdir -p "${deploy_root}/releases" "${deploy_root}/incoming" "${deploy_root}/data"
rm -rf "${release_dir}"
mkdir -p "${release_dir}"
tar -xzf "${archive_path}" -C "${release_dir}"

if [[ ! -f "${deploy_root}/.env" ]]; then
  cp "${release_dir}/.env.example" "${deploy_root}/.env"
fi

if [[ ! -f "${runtime_config}" ]]; then
  (
    cd "${release_dir}"
    npm run setup:self-hosted -- --data-root "${deploy_root}/data"
  )
  mv "${release_dir}/iseol-runtime.json" "${runtime_config}"
fi

# dotenv/config resolves from the release cwd; keep credentials outside versioned releases.
rm -f "${release_dir}/.env"
ln -s "${deploy_root}/.env" "${release_dir}/.env"

cd "${release_dir}"
npm ci --omit=optional
ln -sfn "${release_dir}" "${current_link}"
rollback_needed=1

export ISEOL_RELEASE_DIR="${current_link}"
export ISEOL_RUNTIME_CONFIG="${runtime_config}"
export ISEOL_WEB_HOST="127.0.0.1"
export ISEOL_WEB_PORT="${app_port}"
pm2 startOrReload "${current_link}/ecosystem.config.cjs" --only iseol-bot --update-env
pm2 startOrReload "${current_link}/ecosystem.config.cjs" --only iseol-web --update-env
pm2 save

for attempt in {1..30}; do
  bot_pid="$(pm2 pid iseol-bot 2>/dev/null || true)"
  if [[ "$bot_pid" =~ ^[1-9][0-9]*$ ]] && curl --fail --silent --show-error "http://127.0.0.1:${app_port}/healthz" >/dev/null; then
    rollback_needed=0
    printf 'SSH deployment health check passed: %s\n' "${release_id}"
    exit 0
  fi
  sleep 2
done

printf 'SSH deployment health check failed: %s\n' "${release_id}" >&2
pm2 logs iseol-web --lines 80 --nostream >&2 || true
exit 1
