# Optional dependencies: Umbrel only sources exports of declared dependencies,
# so pull connection details from whichever optional node apps are installed.
_sovbalance_source_exports() {
  local app_id app_dir app_exports saved_id saved_dir saved_data_dir
  for app_id in "$@"; do
    app_dir="${UMBREL_ROOT}/app-data/${app_id}"
    app_exports="${app_dir}/exports.sh"
    if [[ -f "${app_exports}" ]]; then
      saved_id="${EXPORTS_APP_ID-}"
      saved_dir="${EXPORTS_APP_DIR-}"
      saved_data_dir="${EXPORTS_APP_DATA_DIR-}"

      EXPORTS_APP_ID="${app_id}"
      EXPORTS_APP_DIR="${app_dir}"
      EXPORTS_APP_DATA_DIR="${app_dir}/data"

      # shellcheck disable=SC1090
      . "${app_exports}"

      EXPORTS_APP_ID="${saved_id}"
      EXPORTS_APP_DIR="${saved_dir}"
      EXPORTS_APP_DATA_DIR="${saved_data_dir}"
      return 0
    fi
  done
}

# Fulcrum and ElectrumX implement electrs and export APP_ELECTRS_NODE_IP/PORT.
_sovbalance_source_exports electrs fulcrum electrumx
_sovbalance_source_exports monero
# Community id is personal-zcash-node; store id may be zec-zcash-node.
_sovbalance_source_exports personal-zcash-node zec-zcash-node
unset -f _sovbalance_source_exports
