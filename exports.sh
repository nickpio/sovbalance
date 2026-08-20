# Monero Node is optional. Umbrel only sources exports of declared
# dependencies, so pull Monero's connection details when it is installed.
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
