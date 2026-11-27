let chart
let walletsCache = []

// ---------------------------------------------------------------------------
// Notices: errors and warnings shown in a bar under the header. Each notice
// has a key, so a problem that keeps happening updates one notice instead of
// stacking copies, and clearNotice(key) removes it once things recover.
// ---------------------------------------------------------------------------

const notices = new Map()
// key -> message the user dismissed; it comes back only if the message changes
const dismissedNotices = new Map()

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function errorMessage(e, fallback = "Something went wrong") {
    if (!e) return fallback
    if (typeof e === "string") return e
    if (e.message === "Failed to fetch" || e.message === "Load failed" || e.message === "NetworkError when attempting to fetch resource.") {
        return "Could not reach the sovBalance server"
    }
    return e.message || fallback
}

function showNotice(key, message, level = "error") {
    if (dismissedNotices.get(key) === message) return
    dismissedNotices.delete(key)
    const prev = notices.get(key)
    if (prev && prev.message === message && prev.level === level) return
    notices.set(key, { message, level })
    renderNotices()
}

function clearNotice(key) {
    dismissedNotices.delete(key)
    if (!notices.delete(key)) return
    renderNotices()
}

function dismissNotice(key) {
    const n = notices.get(key)
    if (n) dismissedNotices.set(key, n.message)
    notices.delete(key)
    renderNotices()
}

function renderNotices() {
    const box = document.getElementById("notices")
    if (!box) return
    box.innerHTML = [...notices].map(([key, n]) => `
<div class="notice notice-${n.level}" role="${n.level === "error" ? "alert" : "status"}">
  <span class="notice-icon" aria-hidden="true">${n.level === "error" ? "⚠" : "ℹ"}</span>
  <span class="notice-text">${escapeHtml(n.message)}</span>
  <button type="button" class="notice-close" data-notice="${escapeHtml(key)}" aria-label="Dismiss">×</button>
</div>`).join("")
    box.hidden = notices.size === 0
}

document.addEventListener("click", e => {
    const btn = e.target.closest && e.target.closest(".notice-close")
    if (btn) dismissNotice(btn.dataset.notice)
})

// Errors nothing else caught still reach the user.
window.addEventListener("error", e => {
    // Failed <script>/<img> loads fire here without a message; libraries are
    // checked separately below.
    if (!e.message) return
    console.error("Unexpected error:", e.error || e.message)
    showNotice("unexpected", "Unexpected error: " + e.message)
})

window.addEventListener("unhandledrejection", e => {
    console.error("Unhandled rejection:", e.reason)
    showNotice("unexpected", "Unexpected error: " + errorMessage(e.reason))
})

function swalAvailable() {
    return typeof Swal !== "undefined"
}

function chartAvailable() {
    return typeof Chart !== "undefined"
}

// Dialogs come from SweetAlert2 on a CDN. When it did not load, say so
// instead of failing silently on every button press.
function requireSwal() {
    if (swalAvailable()) return true
    showNotice("lib-swal", "The dialog library (SweetAlert2) failed to load, so dialogs are unavailable. Check this device's internet connection and reload the page.")
    return false
}

// An error the user caused by an action: a dialog when possible, otherwise
// the notice bar.
function alertError(title, text) {
    if (swalAvailable()) {
        return Swal.fire({ icon: "error", title, text })
    }
    showNotice("action", text ? `${title}: ${text}` : title)
    return Promise.resolve()
}

function checkLibraries() {
    requireSwal()
    if (!chartAvailable()) {
        showNotice("lib-chart", "The chart library (Chart.js) failed to load, so the balance chart is hidden. Check this device's internet connection and reload the page.", "warning")
    }
}
const ASSETS = ["btc", "xmr", "zec"]

// Everything that differs per coin. The first unit in each list is the
// default; `tooltipUnit` picks the unit shown in a wallet's balance tooltip.
const COINS = {
    btc: {
        name: "Bitcoin",
        node: "an Electrum server app (Electrs, Fulcrum, or ElectrumX)",
        color: "#f7931a",
        units: [
            { id: "btc", label: "BTC", format: n => n.toFixed(8) + " BTC" },
            { id: "mbtc", label: "mBTC", format: n => (n * 1000).toFixed(5) + " mBTC" },
            { id: "sats", label: "sats", format: n => btcToSats(n).toLocaleString() + " sats" }
        ],
        tooltipUnit: unit => unit === "sats" ? "btc" : "sats"
    },
    xmr: {
        name: "Monero",
        node: "the Monero Node app",
        color: "#ff6600",
        units: [
            { id: "xmr", label: "XMR", format: n => n.toFixed(6) + " XMR" },
            { id: "piconero", label: "piconeros", format: n => xmrToPiconero(n).toLocaleString() + " piconeros" }
        ]
    },
    zec: {
        name: "Zcash",
        node: "the Zcash Node app",
        color: "#ffd24a",
        units: [
            { id: "zec", label: "ZEC", format: n => n.toFixed(8) + " ZEC" },
            { id: "zats", label: "zats", format: n => btcToSats(n).toLocaleString() + " zats" }
        ],
        tooltipUnit: unit => unit === "zats" ? "zec" : "zats"
    }
}

var totals = { btc: 0, xmr: 0, zec: 0 }
var totalFiat = 0
var prices = { btc: { USD: 0, CAD: 0 }, xmr: { USD: 0, CAD: 0 }, zec: { USD: 0, CAD: 0 } }
var lastPriceFetch = 0
// Storage can throw (private mode, blocked site data); settings then just
// do not persist.
function storageGet(key) {
    try {
        return localStorage.getItem(key)
    } catch (e) {
        return null
    }
}

function storageSet(key, value) {
    try {
        localStorage.setItem(key, value)
    } catch (e) {
        console.warn("Could not save setting", key, e)
    }
}

var fiatCurrency = storageGet("sovbalance-fiat") === "CAD" ? "CAD" : "USD"

// Display unit per coin, persisted as sovbalance-<asset>-unit
var coinUnits = {}
for (const asset of ASSETS) {
    const saved = storageGet(`sovbalance-${asset}-unit`)
    coinUnits[asset] = COINS[asset].units.some(u => u.id === saved) ? saved : COINS[asset].units[0].id
}

var enabledAssets = loadEnabledAssets()
// null until /nodes answers; every asset counts as available until then
var availableAssets = null
var canWrite = false

function loadEnabledAssets() {
    const fallback = Object.fromEntries(ASSETS.map(a => [a, true]))
    try {
        const raw = storageGet("sovbalance-assets")
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        const enabled = new Set(
            Array.isArray(parsed)
                ? parsed
                : Object.keys(parsed || {}).filter(k => parsed[k])
        )
        const next = Object.fromEntries(ASSETS.map(a => [a, enabled.has(a)]))
        return ASSETS.some(a => next[a]) ? next : fallback
    } catch (e) {
        return fallback
    }
}

function saveEnabledAssets(flags) {
    storageSet("sovbalance-assets", JSON.stringify(ASSETS.filter(asset => flags[asset])))
}

// Table order: { key: "name" | "percent" | "currency", dir: 1 | -1 }
const SORT_KEYS = ["name", "percent", "currency"]
var walletSort = loadSort()

function loadSort() {
    try {
        const parsed = JSON.parse(storageGet("sovbalance-sort"))
        if (parsed && SORT_KEYS.includes(parsed.key) && [1, -1].includes(parsed.dir)) return parsed
    } catch (e) {
        // fall through to the default order
    }
    return { key: "name", dir: 1 }
}

// Clicking the active key flips its direction; a new key starts with the
// natural one (largest share first, otherwise ascending).
function toggleSort(key) {
    const dir = walletSort.key === key ? -walletSort.dir : (key === "percent" ? -1 : 1)
    walletSort = { key, dir }
    storageSet("sovbalance-sort", JSON.stringify(walletSort))
    syncSortButtons()
    renderRows()
}

function syncSortButtons() {
    document.querySelectorAll(".sort-btn").forEach(btn => {
        const active = walletSort.key === btn.dataset.sort
        btn.classList.toggle("active", active)
        btn.querySelector(".sort-arrow").textContent = active ? (walletSort.dir === 1 ? "▲" : "▼") : ""
    })
}

function sortWallets(wallets, shareOf) {
    const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true })
    const compare = walletSort.key === "name"
        ? (a, b) => collator.compare(a.wallet, b.wallet)
        : walletSort.key === "currency"
            ? (a, b) => ASSETS.indexOf(walletAsset(a)) - ASSETS.indexOf(walletAsset(b))
            : (a, b) => shareOf(a) - shareOf(b)
    return wallets.slice().sort((a, b) => walletSort.dir * compare(a, b))
}

let scanCounter = 0
let scanInterval
let scanning = false



function btcToSats(btc) {
    return Math.round((Number(btc) || 0) * 1e8)
}

function xmrToPiconero(xmr) {
    const n = Number(xmr)
    if (!Number.isFinite(n) || n === 0) return 0n
    const sign = n < 0 ? -1n : 1n
    const [w, f = ""] = Math.abs(n).toFixed(12).split(".")
    return sign * BigInt(w + f.padEnd(12, "0").slice(0, 12))
}

// unitId defaults to the asset's current display unit
function formatAssetAmount(asset, amount, unitId = coinUnits[asset]) {
    const unit = COINS[asset].units.find(u => u.id === unitId)
    return unit.format(Number(amount) || 0)
}

function splitAmountLabel(text) {
    const i = String(text).lastIndexOf(" ")
    if (i < 0) return { value: text, unit: "" }
    return { value: text.slice(0, i), unit: text.slice(i + 1) }
}

function walletAsset(w) {
    return COINS[w.type] ? w.type : "btc"
}

function assetAvailable(asset) {
    return !availableAssets || !!availableAssets[asset]
}

function availableAssetList() {
    return ASSETS.filter(assetAvailable)
}

function assetEnabled(asset) {
    return assetAvailable(asset) && !!enabledAssets[asset]
}

function enabledAssetList() {
    return ASSETS.filter(assetEnabled)
}

async function loadNodes() {
    try {
        const data = await fetchJson("/nodes", 10000)
        availableAssets = Object.fromEntries(ASSETS.map(a => [a, !!data[a]]))
        clearNotice("nodes")
    } catch (e) {
        console.error("nodes error", e)
        showNotice("nodes", "Could not detect installed node apps: " + errorMessage(e) + ". All currencies are shown until detection works.", "warning")
        return
    }
    if (availableAssetList().length && !enabledAssetList().length) {
        ASSETS.forEach(asset => { enabledAssets[asset] = assetAvailable(asset) })
    }
}

function visibleWallets(wallets = walletsCache) {
    return wallets.filter(w => assetEnabled(walletAsset(w)))
}

function fiatOf(priceMap) {
    return Number(priceMap[fiatCurrency]) || 0
}

function walletFiat(w) {
    return w.balance * fiatOf(prices[walletAsset(w)])
}

function formatFiat(amount, digits = 2) {
    return "$" + amount.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function formatAmount(w) {
    return formatAssetAmount(walletAsset(w), w.balance)
}

function amountTitle(w) {
    const asset = walletAsset(w)
    if (asset === "xmr") {
        const auto = w.autoSpends
        if (auto && auto.error) {
            return "View-only balance. Spend detection unavailable: " + auto.error
        }
        if (auto && auto.count) {
            return `View-only balance. ${auto.count} spend${auto.count === 1 ? "" : "s"} detected automatically (${formatAssetAmount("xmr", auto.xmr)} removed).`
        }
        return "View-only balance. Spends are detected automatically from your Monero Node."
    }
    return formatAssetAmount(asset, w.balance, COINS[asset].tooltipUnit(coinUnits[asset]))
}

async function fetchJson(url, timeoutMs) {

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const r = await fetch(url, { signal: controller.signal })
        const data = await r.json().catch(() => null)

        if (!r.ok) {
            throw new Error((data && data.error) || ("Request failed (HTTP " + r.status + (r.statusText ? " " + r.statusText : "") + ")"))
        }

        if (data === null) {
            throw new Error("The server sent an unreadable response")
        }

        return data
    } catch (e) {
        if (e.name === "AbortError") {
            throw new Error("Request timed out")
        }
        throw new Error(errorMessage(e, "Request failed"))
    } finally {
        clearTimeout(timer)
    }

}

function readFiatMap(value) {
    if (value && typeof value === "object") {
        return {
            USD: Number(value.USD) || 0,
            CAD: Number(value.CAD) || 0
        }
    }
    const n = Number(value) || 0
    return { USD: n, CAD: 0 }
}

async function loadPrices(force = false) {

    const now = Date.now()

    if (!force && ASSETS.some(a => fiatOf(prices[a])) && now - lastPriceFetch < 300000) {
        return
    }

    try {

        const data = await fetchJson(force ? "/prices?refresh=true" : "/prices", 15000)

        const next = Object.fromEntries(ASSETS.map(a => [a, readFiatMap(data[a])]))
        // Keep prices we already have rather than replace them with zeros
        for (const asset of ASSETS) {
            if (fiatOf(next[asset]) || !fiatOf(prices[asset])) prices[asset] = next[asset]
        }
        if (ASSETS.some(a => fiatOf(next[a]))) {
            lastPriceFetch = Number(data.updatedAt) || Date.now()
        }

        if (data.stale || data.error) {
            const have = ASSETS.some(a => fiatOf(prices[a]))
            const since = have && lastPriceFetch ? ` Showing prices from ${new Date(lastPriceFetch).toLocaleTimeString()}.` : " Fiat values are unavailable."
            showNotice("prices", (data.error ? data.error + "." : "Prices could not be updated.") + since, "warning")
        } else {
            const missing = ASSETS.filter(a => assetEnabled(a) && data.failures && data.failures[a] && !fiatOf(prices[a]))
            if (missing.length) {
                showNotice("prices", `No price available for ${missing.map(a => a.toUpperCase()).join(", ")}: ${missing.map(a => data.failures[a]).join("; ")}`, "warning")
            } else {
                clearNotice("prices")
            }
        }

    } catch (e) {

        console.error("price error", e)
        showNotice("prices", "Could not load prices: " + errorMessage(e), "warning")

    }

}

function coinTotals(wallets) {

    const sums = { btc: 0, xmr: 0, zec: 0 }

    for (const w of wallets) {
        const asset = walletAsset(w)
        if (assetEnabled(asset)) sums[asset] += w.balance
    }

    return sums

}

function totalId(asset) {
    return "total" + asset.toUpperCase()
}

function paintPrices() {

    totals = coinTotals(walletsCache)
    totalFiat = ASSETS.reduce((sum, a) => sum + totals[a] * fiatOf(prices[a]), 0)

    document.getElementById("totalTop").innerText = formatFiat(totalFiat) + " " + fiatCurrency
    for (const asset of ASSETS) {
        const price = fiatOf(prices[asset])
        setLine(totalId(asset), assetEnabled(asset),
            formatAssetAmount(asset, totals[asset]), fiatLabel(totals[asset], price))
        setPriceLine(asset + "Price", assetEnabled(asset) && !!price,
            formatFiat(price) + " " + fiatCurrency)
    }

    if (lastPriceFetch && !scanning) {
        document.getElementById("lastUpdated").innerText = new Date(lastPriceFetch).toLocaleTimeString()
    }

}

// Empty until the price is known
function fiatLabel(amount, price) {
    return price ? "≈ " + formatFiat(amount * price) + " " + fiatCurrency : ""
}

function setLine(id, show, text, fiat = "") {
    const el = document.getElementById(id)
    if (!el) return
    el.querySelector(".sub-amount").textContent = show ? text : ""
    el.querySelector(".sub-fiat").textContent = show ? fiat : ""
    el.hidden = !show
}

function setPriceLine(id, show, text) {
    const el = document.getElementById(id)
    if (!el) return
    const fiat = el.querySelector(".price-fiat")
    if (fiat) fiat.textContent = show ? "= " + text : ""
    el.hidden = !show
}

function applyDisplay() {
    if (walletsCache.length) {
        renderWallets(walletsCache)
    } else {
        paintPrices()
    }
}

function setFiat(next) {
    if (next !== "USD" && next !== "CAD") return
    if (next === fiatCurrency) return
    fiatCurrency = next
    storageSet("sovbalance-fiat", next)
    updatePrices()
}

function setUnit(asset, next) {
    if (!COINS[asset] || !COINS[asset].units.some(u => u.id === next)) return
    if (next === coinUnits[asset]) return
    coinUnits[asset] = next
    storageSet(`sovbalance-${asset}-unit`, next)
    applyDisplay()
}

function toggleAsset(asset) {
    if (!ASSETS.includes(asset) || !assetAvailable(asset)) return
    if (enabledAssets[asset] && enabledAssetList().length === 1) return
    enabledAssets[asset] = !enabledAssets[asset]
    saveEnabledAssets(enabledAssets)
    applyDisplay()
}

// Buttons carry data-setting (fiat | asset | unit) and data-value. Unit
// buttons also carry data-coin; asset buttons carry data-asset, which the
// stylesheet uses to colour the active tab.
function syncSettingsTabs() {
    document.querySelectorAll("[data-setting]").forEach(btn => {
        const { setting, value, coin } = btn.dataset
        const on = (setting === "fiat" && value === fiatCurrency)
            || (setting === "asset" && assetEnabled(value))
            || (setting === "unit" && value === coinUnits[coin])
        btn.classList.toggle("active", on)
        btn.setAttribute("aria-pressed", on ? "true" : "false")
        if (setting === "asset") {
            const missing = !assetAvailable(value)
            btn.disabled = missing
            btn.title = missing ? `Install ${COINS[value].node} to track ${COINS[value].name}` : ""
        }
    })
    document.querySelectorAll("[data-asset-row]").forEach(row => {
        row.hidden = !assetEnabled(row.dataset.assetRow)
    })
}

function openSettings() {
    if (!requireSwal()) return
    const assetTabs = ASSETS.map(asset =>
        `<button type="button" class="asset-tab" data-setting="asset" data-value="${asset}" data-asset="${asset}">${asset.toUpperCase()}</button>`
    ).join("")

    const unitRows = ASSETS.map(asset => `
  <div class="settings-row" data-asset-row="${asset}">
    <div class="settings-row-label ${asset}">${asset.toUpperCase()}</div>
    <div class="asset-tabs">
      ${COINS[asset].units.map(u =>
        `<button type="button" class="asset-tab" data-setting="unit" data-coin="${asset}" data-value="${u.id}">${u.label}</button>`
      ).join("")}
    </div>
  </div>`).join("")

    Swal.fire({
        title: "Settings",
        customClass: { popup: "settings-popup" },
        confirmButtonText: "Done",
        html: `
<div class="settings-section">
  <div class="settings-label">Currencies</div>
  <div class="asset-tabs">${assetTabs}</div>
</div>
<div class="settings-section">
  <div class="settings-label">Fiat</div>
  <div class="asset-tabs">
    <button type="button" class="asset-tab" data-setting="fiat" data-value="USD">USD</button>
    <button type="button" class="asset-tab" data-setting="fiat" data-value="CAD">CAD</button>
  </div>
</div>
<div class="settings-section">
  <div class="settings-label">Amount units</div>
  ${unitRows}
</div>
`,
        willOpen: () => {
            syncSettingsTabs()
            document.querySelectorAll("[data-setting]").forEach(btn => {
                btn.addEventListener("click", () => {
                    const { setting, value, coin } = btn.dataset
                    if (setting === "fiat") setFiat(value)
                    else if (setting === "asset") toggleAsset(value)
                    else if (setting === "unit") setUnit(coin, value)
                    syncSettingsTabs()
                })
            })
        }
    })
}

async function updatePrices(force = false) {
    await loadPrices(force)
    applyDisplay()
}


function startScanIndicator() {

    clearInterval(scanInterval)

    const tbody = document.querySelector("#t tbody")

    if (!tbody) return

    tbody.innerHTML = `
    <tr>
      <td colspan="4">
        <div class="scan-container">
            <div class="scanbar"></div>
            <div id="scanIndex">Scanning wallets</div>
        </div>
      </td>
    </tr>`

    scanCounter = 0

    scanInterval = setInterval(() => {

        const el = document.getElementById("scanIndex")
        if (!el) return

        el.innerText = `Scanning wallets ${scanCounter++}`

    }, 120)

}


function stopScanIndicator() {
    clearInterval(scanInterval)
}


async function fetchWallets(rescan) {

    const data = await fetchJson("/wallets?rescan=" + rescan, rescan ? 31 * 60 * 1000 : 15000)

    if (!Array.isArray(data)) {
        throw new Error("Could not load wallets")
    }

    return data

}


function syncPercent(sync) {
    if (!sync) return 0
    const pct = Number(sync.percent)
    if (Number.isFinite(pct)) return Math.max(0, Math.min(100, pct))
    const height = Number(sync.height || 0)
    const tip = Number(sync.tip || 0)
    const birthday = Number(sync.birthday || 0)
    if (tip <= birthday) return tip > 0 && height >= tip ? 100 : 0
    return Math.max(0, Math.min(100, ((height - birthday) * 100) / (tip - birthday)))
}


function walletSyncMarkup(w) {
    if (!w.sync) return ""
    const pct = syncPercent(w.sync)
    const tip = Number(w.sync.tip || 0)
    const birthday = Number(w.sync.birthday || 0)
    const hasRange = tip > birthday
    if (hasRange && pct >= 100) return ""
    const label = hasRange ? `Syncing ${Math.round(pct)}%` : "Syncing…"
    const fill = hasRange ? Math.max(2, Math.round(pct)) : 0
    const busy = hasRange ? "" : " wallet-sync-fill-busy"
    const width = hasRange ? `style="width:${fill}%"` : ""
    return `<div class="wallet-sync">
    <div class="wallet-sync-label">${label}</div>
    <div class="wallet-sync-bar"><div class="wallet-sync-fill${busy}" ${width}></div></div>
  </div>`
}


function renderWallets(wallets) {

    walletsCache = wallets
    stopScanIndicator()
    paintPrices()
    renderRows()
    try {
        renderChart()
    } catch (e) {
        console.error("chart error", e)
        showNotice("chart", "Could not draw the balance chart: " + errorMessage(e), "warning")
    }
    reportWalletErrors(wallets)

}


// A summary in the notice bar, so a failing wallet is noticed even when it
// is filtered out or scrolled away. Details stay on the wallet's row.
function reportWalletErrors(wallets) {
    const failing = wallets.filter(w => w.error)
    if (!failing.length) {
        clearNotice("wallets")
        return
    }
    const names = failing.map(w => `"${w.wallet}"`).join(", ")
    showNotice("wallets", failing.length === 1
        ? `Wallet ${names} could not be updated. See the wallet below for details.`
        : `${failing.length} wallets could not be updated (${names}). See each wallet below for details.`)
}


function renderRows() {

    const wallets = walletsCache
    const visible = visibleWallets(wallets)

    if (visible.length === 0) {
        const empty = !availableAssetList().length
            ? "ℹ️ No node apps detected. Install an Electrum server (Electrs, Fulcrum, ElectrumX), Monero Node, or Zcash Node to track wallets"
            : wallets.length ? "No wallets for the selected currencies" : "ℹ️ No wallets configured yet"
        document.querySelector("#t tbody").innerHTML = `
        <tr>
          <td colspan="4">${empty}</td>
        </tr>`
        return
    }

    const mixed = new Set(visible.map(walletAsset)).size > 1
    const useFiat = mixed && totalFiat > 0

    const shareOf = w => {
        const asset = walletAsset(w)
        if (useFiat) return totalFiat > 0 ? (walletFiat(w) / totalFiat) * 100 : 0
        const total = totals[asset]
        return total > 0 ? (w.balance / total) * 100 : 0
    }

    let rows = ""

    for (const w of sortWallets(visible, shareOf)) {

        const asset = walletAsset(w)
        const perc = shareOf(w).toFixed(1)

        const spendError = asset === "xmr" && w.autoSpends && w.autoSpends.error
        const status = w.error
            ? `<div class="wallet-error" role="alert">${escapeHtml(w.error)}</div>`
            : walletSyncMarkup(w) + (spendError
                ? `<div class="wallet-warning">Spend detection unavailable (${escapeHtml(w.autoSpends.error)}). Balance may include spent funds.</div>`
                : "")

        const rowAttr = canWrite ? `onclick="editWallet(${Number(w.id)})"` : `class="view-only-row"`
        rows += `
<tr ${rowAttr}>
<td class="walletName">${escapeHtml(w.wallet)}<span class="coin-badge ${asset}">${asset.toUpperCase()}</span>${status}</td>
<td class="percentage">${perc}%</td>
<td class="balance" title="${escapeHtml(amountTitle(w))}">${formatAmount(w)}</td>
<td class="chevron">${canWrite ? "›" : ""}</td>
</tr>`
    }

    document.querySelector("#t tbody").innerHTML = rows

}


async function load(rescan = true) {

    if (rescan && scanning) return

    if (!walletsCache.length) {
        clearTable()
        startScanIndicator()
    }

    if (rescan) {
        scanning = true
        document.getElementById("lastUpdated").innerText = "Scanning…"
    }

    try {
        renderWallets(await fetchWallets(false))
        clearNotice("load")
    } catch (e) {
        stopScanIndicator()
        scanning = false
        console.error(e)
        const message = "Could not load wallets: " + errorMessage(e)
        showNotice("load", walletsCache.length ? message + ". Balances shown may be out of date." : message)
        if (walletsCache.length) {
            // Keep showing the last data we had
            document.getElementById("lastUpdated").innerText = "Update failed"
        } else {
            document.querySelector("#t tbody").innerHTML = `
        <tr>
          <td colspan="4" class="wallet-error">${escapeHtml(message)} <button type="button" class="btn btn-secondary btn-inline" onclick="load(false)">Retry</button></td>
        </tr>`
            document.getElementById("lastUpdated").innerText = ""
        }
        return
    }

    if (!rescan) return

    let poll = null
    let pollInFlight = false
    try {
        poll = setInterval(async () => {
            if (pollInFlight) return
            pollInFlight = true
            try {
                renderWallets(await fetchWallets(false))
            } catch {
                // keep waiting on the rescan request
            } finally {
                pollInFlight = false
            }
        }, 2000)
        renderWallets(await fetchWallets(true))
        clearNotice("scan")
    } catch (e) {
        console.error(e)
        document.getElementById("lastUpdated").innerText = "Sync failed"
        showNotice("scan", "Sync failed: " + errorMessage(e) + ". Balances shown may be out of date.")
        return
    } finally {
        if (poll) clearInterval(poll)
        scanning = false
    }

    document.getElementById("lastUpdated").innerText =
        new Date(lastPriceFetch || Date.now()).toLocaleTimeString()

}


// The server refreshes Monero wallets on its own; pick those balances up
// without a manual Sync. Only re-render when something changed so the
// chart does not re-animate every poll.
async function pollWallets() {

    if (scanning) return

    try {
        const data = await fetchWallets(false)
        clearNotice("load")
        if (JSON.stringify(data) !== JSON.stringify(walletsCache)) {
            renderWallets(data)
        }
    } catch (e) {
        console.error("poll error", e)
        showNotice("load", "Could not load wallets: " + errorMessage(e) + ". Balances shown may be out of date.")
    }

    await loadStatus()
}


// Server-wide problems (storage, Electrum connection) that are not tied to
// one request.
const statusKeys = new Set()

async function loadStatus() {
    let data
    try {
        data = await fetchJson("/status", 10000)
    } catch (e) {
        // Unreachable servers are already reported by the wallet poll
        console.error("status error", e)
        return
    }
    const seen = new Set()
    for (const issue of Array.isArray(data.issues) ? data.issues : []) {
        const key = "server-" + issue.key
        seen.add(key)
        showNotice(key, issue.message, issue.level === "warning" ? "warning" : "error")
    }
    for (const key of statusKeys) {
        if (!seen.has(key)) clearNotice(key)
    }
    statusKeys.clear()
    seen.forEach(k => statusKeys.add(k))

}


function clearTable() {
    document.querySelector("#t tbody").innerHTML = ""
    document.getElementById("totalTop").innerText = "-"
    ASSETS.forEach(asset => setLine(totalId(asset), false, ""))
    destroyChart()
}



const innerShadow = {
    id: "innerShadow",

    afterDatasetsDraw(chart) {

        const { ctx } = chart
        const meta = chart.getDatasetMeta(0)

        if (!meta.data.length) return

        const x = meta.data[0].x
        const y = meta.data[0].y

        const innerRadius = meta.data[0].innerRadius

        ctx.save()

        const g = ctx.createRadialGradient(
            x, y, innerRadius * 0.7,
            x, y, innerRadius
        )

        g.addColorStop(0, "rgba(0,0,0,0)")
        g.addColorStop(1, "rgba(0,0,0,0.35)")

        ctx.fillStyle = g

        ctx.beginPath()
        ctx.arc(x, y, innerRadius, 0, Math.PI * 2)
        ctx.fill()

        ctx.restore()
    }
}





function destroyChart() {
    if (!chart) return
    try {
        chart.destroy()
    } catch (e) {
        console.error("chart destroy error", e)
    }
    chart = null
}


function chartSlices() {
    return ASSETS.filter(asset => totals[asset] > 0).map(asset => {
        const amount = totals[asset]
        return {
            asset,
            label: asset.toUpperCase(),
            amount,
            fiat: amount * fiatOf(prices[asset]),
            color: COINS[asset].color
        }
    })
}


function renderChart() {
    const slices = chartSlices()
    destroyChart()
    if (!slices.length || !chartAvailable()) return

    const useFiat = slices.length > 1 && slices.every(s => s.fiat > 0)
    const values = slices.map(s => useFiat ? s.fiat : s.amount)
    const total = values.reduce((sum, n) => sum + n, 0)

    chart = new Chart(document.getElementById("chart").getContext("2d"), {

        type: "doughnut",

        data: {
            labels: slices.map(s => s.label),
            datasets: [{
                data: values,
                backgroundColor: slices.map(s => s.color),
                borderColor: "rgba(0,0,0,0.35)",
                borderWidth: 1,

                hoverBorderColor: "#000000",
                hoverOffset: 12,
                hoverBorderWidth: 3

            }]
        },

        plugins: [centerText, innerShadow],

        options: {

            maintainAspectRatio: false,
            cutout: "72%",

            layout: {
                padding: {
                    top: 16,
                    bottom: 16,
                    left: 16,
                    right: 16
                }
            },

            animation: {
                duration: 1200,
                easing: "easeOutQuart"
            },

            plugins: {

                legend: {
                    position: "bottom",
                    labels: { color: "#ffffff" }
                },

                tooltip: {
                    backgroundColor: "#111111",
                    titleColor: "#ffffff",
                    bodyColor: "#ffffff",
                    borderColor: "#f7931a",
                    borderWidth: 1,
                    callbacks: {
                        label: (ctx) => {
                            const slice = slices[ctx.dataIndex]
                            if (!slice) return ""
                            const perc = total > 0 ? ((ctx.raw / total) * 100).toFixed(2) : "0.00"
                            const amount = formatAssetAmount(slice.asset, slice.amount)
                            if (useFiat) {
                                return `${perc}%   •   ${amount}   •   ${formatFiat(slice.fiat)} ${fiatCurrency}`
                            }
                            return `${perc}%   •   ${amount}`
                        }
                    }
                }

            }

        }

    })

}


const XPUB_LABELS = {
    zpub: "Detected: Native SegWit (BIP84)",
    ypub: "Detected: Nested SegWit (BIP49)",
    xpub: "Detected: Legacy (BIP44)"
}

function readFileBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "")
        reader.onerror = () => reject(new Error("Could not read " + (file.name || "the file") + ": " + ((reader.error && reader.error.message) || "unknown error")))
        reader.readAsDataURL(file)
    })
}

async function saveWalletRequest(url, body, fallbackError) {

    const showError = title => alertError(title)

    try {

        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            redirect: "manual"
        })

        const data = r.type === "opaqueredirect" ? null : await r.json().catch(() => null)

        if (!data) {
            await showError(r.type === "opaqueredirect" || r.status === 401 || r.status === 403
                ? "Log in to Umbrel to make changes"
                : (fallbackError || "Request failed") + " (HTTP " + r.status + ", unreadable response)")
            return null
        }

        if (!r.ok) {
            await showError(data.error || fallbackError || ("Request failed (" + r.status + ")"))
            return null
        }

        return data

    } catch (e) {

        console.error("request error", url, e)
        const network = !e.message || e.message === "Failed to fetch" || e.name === "TypeError"
        await showError(network
            ? "Could not reach the sovBalance server. Check your connection, or log in to Umbrel to make changes."
            : (e.message || "Request failed"))
        return null

    }

}


async function openWalletModal() {

    if (!canWrite || !requireSwal()) return

    const enabled = enabledAssetList()
    if (!enabled.length) return

    const tabsHtml = enabled.map((asset, i) =>
        `<button type="button" class="asset-tab${i === 0 ? " active" : ""}" data-asset="${asset}">${COINS[asset].name}</button>`
    ).join("")

    const val = id => document.getElementById(id).value.trim()

    const result = await Swal.fire({

        title: "Add Wallet",

        customClass: { popup: "wallet-popup" },

        html: `
<div class="asset-tabs"${enabled.length === 1 ? " hidden" : ""}>
  ${tabsHtml}
</div>

<input id="swal-wallet" class="swal2-input" placeholder="Wallet Name" maxlength="45">

<div id="btc-fields">
<textarea id="swal-xpub"
class="swal2-textarea"
rows="2"
maxlength="130"
placeholder="XPUB / YPUB / ZPUB"
spellcheck="false"></textarea>
<div id="wallet-type" class="wallet-type"></div>
</div>

<div id="xmr-fields" style="display:none">
<textarea id="swal-address"
class="swal2-textarea"
rows="2"
maxlength="106"
placeholder="Primary address (starts with 4)"
spellcheck="false"></textarea>
<textarea id="swal-viewkey"
class="swal2-textarea"
rows="2"
maxlength="64"
placeholder="Private view key"
spellcheck="false"></textarea>
<input id="swal-restore" class="swal2-input" placeholder="Restore height (0 = genesis)" inputmode="numeric">
<div class="wallet-hint">View-only wallets can see received outputs, including subaddresses. Spends are detected automatically from your Monero Node when change returns to the wallet; key images are only needed after a sweep with no change output. Use a restore height from around when the wallet was created to avoid a full-chain scan.</div>
</div>

<div id="zec-fields" style="display:none">
<textarea id="swal-zec-address"
class="swal2-textarea"
rows="3"
placeholder="Transparent address (t1… or t3…) or viewing key (uview1…)"
spellcheck="false"></textarea>
<input id="swal-zec-birthday" class="swal2-input" placeholder="Birthday height (blank = NU5)" inputmode="numeric" style="display:none">
<div class="wallet-hint">Requires the Zcash Node app. Paste a transparent t1/t3 address, or a unified viewing key starting with uview1. Birthday defaults to NU5 (1687104); set it earlier only if this wallet received funds before May 2022. First shielded sync can take a while and resumes on the next rescan.</div>
</div>
`,

        showCancelButton: true,
        confirmButtonText: "Save",

        willOpen: () => {

            const root = Swal.getHtmlContainer()
            const xpubInput = document.getElementById("swal-xpub")
            const zecBirthdayInput = document.getElementById("swal-zec-birthday")
            const label = document.getElementById("wallet-type")
            const tabs = root.querySelectorAll(".asset-tab")
            const btn = Swal.getConfirmButton()

            let asset = enabled[0]
            btn.disabled = true

            function setAsset(next) {
                asset = next
                ASSETS.forEach(a => {
                    document.getElementById(`${a}-fields`).style.display = a === asset ? "" : "none"
                })
                tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.asset === asset))
                validate()
            }

            function validate() {

                const wallet = cleanInput(document.getElementById("swal-wallet").value)

                if (asset === "zec") {
                    const address = val("swal-zec-address")
                    const birthday = val("swal-zec-birthday")
                    const isUfvk = address.startsWith("uview1")
                    zecBirthdayInput.style.display = isUfvk ? "" : "none"
                    const validBirthday = birthday === "" || /^\d+$/.test(birthday)
                    const validKey = isUfvk
                        ? address.length >= 80 && /^uview1[0-9a-z]+$/.test(address)
                        : /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
                    btn.disabled = !(wallet && validKey && validBirthday)
                    return
                }

                if (asset === "xmr") {
                    const address = val("swal-address")
                    const viewKey = val("swal-viewkey")
                    const restore = val("swal-restore")
                    const validAddress = address.startsWith("4") && address.length === 95
                    const validViewKey = /^[0-9a-fA-F]{64}$/.test(viewKey)
                    const validRestore = restore === "" || /^\d+$/.test(restore)
                    btn.disabled = !(wallet && validAddress && validViewKey && validRestore)
                    return
                }

                const key = val("swal-xpub").toLowerCase()
                const validPrefix = Object.keys(XPUB_LABELS).some(p => key.startsWith(p))
                btn.disabled = !(wallet && validPrefix && key.length > 100)
            }

            tabs.forEach(tab => {
                tab.addEventListener("click", () => setAsset(tab.dataset.asset))
            })

            for (const id of ["swal-wallet", "swal-address", "swal-viewkey", "swal-restore", "swal-zec-address", "swal-zec-birthday"]) {
                document.getElementById(id).addEventListener("input", validate)
            }

            xpubInput.addEventListener("input", () => {
                label.innerText = XPUB_LABELS[xpubInput.value.trim().toLowerCase().slice(0, 4)] || ""
                validate()
            })

            setAsset(enabled[0])

        },

        preConfirm: () => {
            const active = Swal.getHtmlContainer().querySelector(".asset-tab.active")
            const type = (active && active.dataset.asset) || enabled[0]

            if (!assetEnabled(type)) return false

            const wallet = cleanInput(document.getElementById("swal-wallet").value)

            if (type === "xmr") {
                return {
                    wallet,
                    type: "xmr",
                    address: val("swal-address"),
                    viewKey: val("swal-viewkey"),
                    restoreHeight: val("swal-restore") || 0
                }
            }

            if (type === "zec") {
                const zecAddress = val("swal-zec-address")
                return zecAddress.startsWith("uview1")
                    ? { wallet, type: "zec", ufvk: zecAddress, birthday: val("swal-zec-birthday") }
                    : { wallet, type: "zec", address: zecAddress }
            }

            return { wallet, type: "btc", xpub: val("swal-xpub") }
        }

    })

    if (!result.isConfirmed) return

    if (await saveWalletRequest("/wallet", result.value)) load(true)
}


async function editWallet(id) {

    if (!canWrite || !requireSwal()) return

    const wallet = walletsCache.find(w => w.id === id)

    if (!wallet) {
        showNotice("action", "That wallet is no longer available. Reload the page.", "warning")
        return
    }

    const asset = walletAsset(wallet)
    const isXmr = asset === "xmr"
    const isZec = asset === "zec"
    const isZecShielded = isZec && !!wallet.ufvk

    const fieldsHtml = isXmr ? `
<textarea id="swal-address" class="swal2-textarea" rows="2">${escapeHtml(wallet.address)}</textarea>
<textarea id="swal-viewkey" class="swal2-textarea" rows="2">${escapeHtml(wallet.viewKey)}</textarea>
<input id="swal-restore" class="swal2-input" value="${escapeHtml(wallet.restoreHeight || 0)}" inputmode="numeric">
<div class="wallet-hint">Spends are detected automatically. Key images are optional: import them after a sweep with no change output, or to reconcile the balance exactly (Monero GUI: Settings → Wallet → Export key images; Feather: File → Export → Key images). Incoming funds do not need this.</div>
<input id="swal-keyimages" class="keyimages-file" type="file">
<textarea id="swal-keyimages-text" class="swal2-textarea" rows="3" placeholder="Or paste key images JSON" spellcheck="false"></textarea>
` : isZecShielded ? `
<textarea id="swal-ufvk" class="swal2-textarea" rows="3">${escapeHtml(wallet.ufvk)}</textarea>
<input id="swal-birthday" class="swal2-input" value="${escapeHtml(wallet.birthday || 1687104)}" inputmode="numeric">
<div class="wallet-hint">Unified viewing key (uview1…). Birthday defaults to NU5 (1687104). Changing the key or birthday starts a new scan.</div>
` : isZec ? `
<textarea id="swal-address" class="swal2-textarea" rows="2" maxlength="35">${escapeHtml(wallet.address)}</textarea>
<div class="wallet-hint">Transparent mainnet address (t1 or t3). Requires the Zcash Node app.</div>
` : `
<textarea id="swal-xpub" class="swal2-textarea" rows="2">${escapeHtml(wallet.xpub)}</textarea>
`

    const val = fieldId => document.getElementById(fieldId).value.trim()

    const result = await Swal.fire({

        title: "Edit Wallet",

        customClass: { popup: "wallet-popup" },

        html: `<input id="swal-wallet" class="swal2-input" value="${escapeHtml(wallet.wallet)}">` + fieldsHtml,

        showCancelButton: true,
        confirmButtonText: "Save",

        showDenyButton: true,
        denyButtonText: "Delete",
        denyButtonColor: "#ef4444",

        preConfirm: async () => {
            const name = cleanInput(document.getElementById("swal-wallet").value)

            if (isZecShielded) {
                const ufvk = val("swal-ufvk")
                const birthday = val("swal-birthday")
                return {
                    body: { id: wallet.id, wallet: name, ufvk, birthday },
                    rescan: ufvk !== wallet.ufvk || Number(birthday) !== Number(wallet.birthday)
                }
            }

            if (isZec) {
                const address = val("swal-address")
                return {
                    body: { id: wallet.id, wallet: name, address },
                    rescan: address !== wallet.address
                }
            }

            if (isXmr) {
                const file = document.getElementById("swal-keyimages").files[0]
                const address = val("swal-address")
                const viewKey = val("swal-viewkey")
                const restoreHeight = val("swal-restore") || 0
                return {
                    body: { id: wallet.id, wallet: name, address, viewKey, restoreHeight },
                    rescan: address !== wallet.address
                        || viewKey !== wallet.viewKey
                        || Number(restoreHeight) !== Number(wallet.restoreHeight),
                    fileBase64: file ? await readFileBase64(file).catch(e => {
                        Swal.showValidationMessage(errorMessage(e))
                        return null
                    }) : "",
                    keyImagesText: val("swal-keyimages-text")
                }
            }

            const xpub = val("swal-xpub")
            return {
                body: { id: wallet.id, wallet: name, xpub },
                rescan: xpub !== wallet.xpub
            }
        }

    })

    if (result.isDismissed) return

    if (result.isDenied) {
        if (await saveWalletRequest("/wallet/remove", { id: wallet.id })) load(true)
        return
    }

    const { body, rescan, fileBase64, keyImagesText } = result.value

    if (fileBase64 === null) return

    if (!await saveWalletRequest("/wallet/update", body)) return

    if (fileBase64 || keyImagesText) {

        Swal.fire({
            title: "Importing key images",
            text: "Refreshing the view-only wallet, then applying spends. This can take a while.",
            allowOutsideClick: false,
            didOpen: () => Swal.showLoading()
        })

        const imported = await saveWalletRequest("/wallet/key-images", {
            id: wallet.id,
            fileBase64: fileBase64 || undefined,
            payload: keyImagesText || undefined
        }, "Key image import failed")

        if (imported) {
            await Swal.fire({
                icon: "success",
                title: "Key images imported",
                text: `Unspent ${Number(imported.unspent).toFixed(6)} XMR · spent ${Number(imported.spent).toFixed(6)} XMR`
            })
        }

        load(false)
        return
    }

    load(rescan)

}


function cleanInput(str) {

    return str
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .replace(/\s+/g, " ")
        .trim()

}



const centerText = {
    id: "centerText",
    afterDatasetsDraw(chart) {

        const { ctx } = chart

        const meta = chart.getDatasetMeta(0)
        if (!meta.data.length) return

        const x = meta.data[0].x
        const y = meta.data[0].y

        ctx.save()

        ctx.textAlign = "center"
        ctx.textBaseline = "middle"

        ctx.fillStyle = "#ffffff"
        ctx.font = "600 18px system-ui"

        if (totalFiat > 0) {
            ctx.fillText(formatFiat(totalFiat, 0), x, y - 8)
            ctx.fillStyle = "#a3a3a3"
            ctx.font = "400 14px system-ui"
            ctx.fillText(fiatCurrency, x, y + 14)
        } else {
            // Name the coin when it is the only one held; otherwise show BTC
            const held = ASSETS.filter(a => totals[a])
            const coin = held.length === 1 ? held[0] : "btc"
            const { value, unit } = splitAmountLabel(formatAssetAmount(coin, totals[coin]))
            ctx.fillText(value, x, y - 8)
            ctx.fillStyle = COINS[coin].color
            ctx.font = "400 14px system-ui"
            ctx.fillText(unit, x, y + 14)
        }

        ctx.restore()
    }
}



function copyText(text) {

    const fallback = () => {
        const t = document.createElement("textarea")
        t.value = text
        document.body.appendChild(t)
        t.select()
        let ok = false
        try {
            ok = document.execCommand("copy")
        } catch (e) {
            ok = false
        }
        document.body.removeChild(t)
        if (!ok) throw new Error("Copy is not supported in this browser")
    }

    const copied = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text).catch(fallback)
        : Promise.resolve().then(fallback)

    copied.then(() => Swal.fire({
        toast: true,
        position: "top",
        icon: "success",
        title: "Lightning address copied",
        showConfirmButton: false,
        timer: 1500
    })).catch(e => {
        alertError("Could not copy the address", errorMessage(e) + ". Select it and copy it manually: " + text)
    })

}



function donateModal() {

    if (!requireSwal()) return

    const addr = "thanksalot@walletofsatoshi.com"

    Swal.fire({
        title: "Send a Lightning tip ⚡",
        html: `
      <div style="margin-top:10px;font-size:16px;color:#888">
        If this tool is useful to you, consider a tip to support development and maintenance. Thank you! 🙏
        <br><br>
        Lightning Address ⚡
      </div>

        <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=lightning:${addr}"
           style="margin:10px auto;display:block">


      <div style="margin-top:4px;font-size:14px;font-family:monospace">
        ${addr}
      </div>
    `,
        confirmButtonText: "Copy Lightning address"
    }).then((result) => {
        if (result.isConfirmed) {
            copyText(addr)
        }
    })
}


async function probeWriteAccess() {
    try {
        const r = await fetch("/wallet", { redirect: "manual" })
        if (r.type === "opaqueredirect" || !r.ok) return false
        const data = await r.json().catch(() => null)
        return !!(data && data.ok)
    } catch (e) {
        return false
    }
}

function applyWriteUi() {
    const addBtn = document.getElementById("addWalletBtn")
    if (addBtn) addBtn.hidden = !canWrite || !availableAssetList().length
    document.body.classList.toggle("view-only", !canWrite)
}

document.addEventListener('DOMContentLoaded', async function () {

    await new Promise(resolve => setTimeout(resolve, 500))

    checkLibraries()

    const appVersion = await fetchJson("/appversion", 10000)
        .then(data => data.appversion || "")
        .catch(e => {
            console.error("version error", e)
            showNotice("load", "Could not reach the sovBalance server: " + errorMessage(e))
            return ""
        })

    document.title = appVersion ? `sovBalance ${appVersion}` : "sovBalance"
    document.getElementById("app_version").innerText = appVersion

    document.getElementById("donateBtn").addEventListener("click", donateModal)
    syncSortButtons()

    canWrite = await probeWriteAccess()
    await loadNodes()
    applyWriteUi()

    load(false)
    updatePrices()
    loadStatus()

    setInterval(updatePrices, 60 * 1000)
    setInterval(pollWallets, 30 * 1000)

})
