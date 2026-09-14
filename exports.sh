# An Electrum server is optional. Umbrel only sources exports of declared
# dependencies, so pull the connection details of whichever one is installed.
# Fulcrum and ElectrumX implement electrs and export APP_ELECTRS_NODE_IP/PORT.
for electrum_id in electrs fulcrum electrumx; do
  electrum_dir="${UMBREL_ROOT}/app-data/${electrum_id}"
  electrum_exports="${electrum_dir}/exports.sh"
  if [[ -f "${electrum_exports}" ]]; then
    saved_exports_app_id="${EXPORTS_APP_ID-}"
    saved_exports_app_dir="${EXPORTS_APP_DIR-}"
    saved_exports_app_data_dir="${EXPORTS_APP_DATA_DIR-}"

    EXPORTS_APP_ID="${electrum_id}"
    EXPORTS_APP_DIR="${electrum_dir}"
    EXPORTS_APP_DATA_DIR="${electrum_dir}/data"

    # shellcheck disable=SC1090
    . "${electrum_exports}"

    EXPORTS_APP_ID="${saved_exports_app_id}"
    EXPORTS_APP_DIR="${saved_exports_app_dir}"
    EXPORTS_APP_DATA_DIR="${saved_exports_app_data_dir}"
    break
  fi
done

# Monero Node is optional. Pull Monero's connection details when it is installed.
monero_dir="${UMBREL_ROOT}/app-data/monero"
monero_exports="${monero_dir}/exports.sh"

if [[ -f "${monero_exports}" ]]; then
  saved_exports_app_id="${EXPORTS_APP_ID-}"
  saved_exports_app_dir="${EXPORTS_APP_DIR-}"
  saved_exports_app_data_dir="${EXPORTS_APP_DATA_DIR-}"

  EXPORTS_APP_ID="monero"
  EXPORTS_APP_DIR="${monero_dir}"
  EXPORTS_APP_DATA_DIR="${monero_dir}/data"

  # shellcheck disable=SC1090
  . "${monero_exports}"

  EXPORTS_APP_ID="${saved_exports_app_id}"
  EXPORTS_APP_DIR="${saved_exports_app_dir}"
  EXPORTS_APP_DATA_DIR="${saved_exports_app_data_dir}"
fi

# Zcash Node is optional. Community id is personal-zcash-node; store id may be zec-zcash-node.
for zcash_id in personal-zcash-node zec-zcash-node; do
  zcash_dir="${UMBREL_ROOT}/app-data/${zcash_id}"
  zcash_exports="${zcash_dir}/exports.sh"
  if [[ -f "${zcash_exports}" ]]; then
    saved_exports_app_id="${EXPORTS_APP_ID-}"
    saved_exports_app_dir="${EXPORTS_APP_DIR-}"
    saved_exports_app_data_dir="${EXPORTS_APP_DATA_DIR-}"

    EXPORTS_APP_ID="${zcash_id}"
    EXPORTS_APP_DIR="${zcash_dir}"
    EXPORTS_APP_DATA_DIR="${zcash_dir}/data"

    # shellcheck disable=SC1090
    . "${zcash_exports}"

    EXPORTS_APP_ID="${saved_exports_app_id}"
    EXPORTS_APP_DIR="${saved_exports_app_dir}"
    EXPORTS_APP_DATA_DIR="${saved_exports_app_data_dir}"
    break
  fi
done
