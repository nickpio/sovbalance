let chart
let walletsCache = []
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
var fiatCurrency = localStorage.getItem("sovbalance-fiat") === "CAD" ? "CAD" : "USD"

// Display unit per coin, persisted as sovbalance-<asset>-unit
var coinUnits = {}
for (const asset of ASSETS) {
    const saved = localStorage.getItem(`sovbalance-${asset}-unit`)
    coinUnits[asset] = COINS[asset].units.some(u => u.id === saved) ? saved : COINS[asset].units[0].id
}

var enabledAssets = loadAssetFlags("sovbalance-assets", false)
// null until /nodes answers; every asset counts as available until then
var availableAssets = null
var canWrite = false

function loadAssetFlags(key, allowEmpty) {
    const fallback = Object.fromEntries(ASSETS.map(a => [a, true]))
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        const enabled = new Set(
            Array.isArray(parsed)
                ? parsed
                : Object.keys(parsed || {}).filter(k => parsed[k])
        )
        const next = Object.fromEntries(ASSETS.map(a => [a, enabled.has(a)]))
        if (!allowEmpty && !ASSETS.some(a => next[a])) return fallback
        return next
    } catch (e) {
        return fallback
    }
}

function saveAssetFlags(key, flags) {
    localStorage.setItem(key, JSON.stringify(ASSETS.filter(asset => flags[asset])))
}

// Table order: { key: "name" | "percent" | "currency", dir: 1 | -1 }
const SORT_KEYS = ["name", "percent", "currency"]
var walletSort = loadSort()

function loadSort() {
    try {
        const parsed = JSON.parse(localStorage.getItem("sovbalance-sort"))
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
    localStorage.setItem("sovbalance-sort", JSON.stringify(walletSort))
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
    return Number(BigInt(Math.round(Number(btc) * 1e8)))
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
    if (w.type === "xmr") return "xmr"
    if (w.type === "zec") return "zec"
    return "btc"
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
    } catch (e) {
        console.error("nodes error", e)
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
            throw new Error((data && data.error) || ("Request failed (" + r.status + ")"))
        }

        return data
    } catch (e) {
        if (e.name === "AbortError") {
            throw new Error("Request timed out")
        }
        throw e
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

        for (const asset of ASSETS) prices[asset] = readFiatMap(data[asset])
        if (ASSETS.some(a => fiatOf(prices[a]))) {
            lastPriceFetch = Date.now()
        }

    } catch (e) {

        console.error("price error", e)

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
    paintPrices()
    if (walletsCache.length) {
        renderWallets(walletsCache)
    }
}

function setFiat(next) {
    if (next !== "USD" && next !== "CAD") return
    if (next === fiatCurrency) return
    fiatCurrency = next
    localStorage.setItem("sovbalance-fiat", next)
    updatePrices()
}

function setUnit(asset, next) {
    if (!COINS[asset] || !COINS[asset].units.some(u => u.id === next)) return
    if (next === coinUnits[asset]) return
    coinUnits[asset] = next
    localStorage.setItem(`sovbalance-${asset}-unit`, next)
    applyDisplay()
}

function toggleAsset(asset) {
    if (!ASSETS.includes(asset) || !assetAvailable(asset)) return
    if (enabledAssets[asset] && enabledAssetList().length === 1) return
    enabledAssets[asset] = !enabledAssets[asset]
    saveAssetFlags("sovbalance-assets", enabledAssets)
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
    paintPrices()

    if (walletsCache.length) {
        renderWallets(walletsCache)
    }

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
    renderChart()

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

        const status = w.error
            ? `<div class="wallet-error">${w.error}</div>`
            : walletSyncMarkup(w)

        rows += canWrite
            ? `
<tr onclick="editWallet(${w.id})">
<td class="walletName">${w.wallet}<span class="coin-badge ${asset}">${asset.toUpperCase()}</span>${status}</td>
<td class="percentage">${perc}%</td>
<td class="balance" title="${amountTitle(w)}">${formatAmount(w)}</td>
<td class="chevron">›</td>
</tr>`
            : `
<tr class="view-only-row">
<td class="walletName">${w.wallet}<span class="coin-badge ${asset}">${asset.toUpperCase()}</span>${status}</td>
<td class="percentage">${perc}%</td>
<td class="balance" title="${amountTitle(w)}">${formatAmount(w)}</td>
<td class="chevron"></td>
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
    } catch (e) {
        stopScanIndicator()
        scanning = false
        console.error(e)
        document.querySelector("#t tbody").innerHTML = `
        <tr>
          <td colspan="4" class="wallet-error">${e.message || "Could not load wallets"}</td>
        </tr>`
        return
    }

    if (!rescan) return

    document.getElementById("lastUpdated").innerText = "Scanning…"

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
    } catch (e) {
        console.error(e)
        document.getElementById("lastUpdated").innerText = e.message || "Scan failed"
        return
    } finally {
        if (poll) clearInterval(poll)
        scanning = false
    }

    if (lastPriceFetch) {
        document.getElementById("lastUpdated").innerText = new Date(lastPriceFetch).toLocaleTimeString()
    }

}


// The server refreshes Monero wallets on its own; pick those balances up
// without a manual Sync. Only re-render when something changed so the
// chart does not re-animate every poll.
async function pollWallets() {

    if (scanning) return

    try {
        const data = await fetchWallets(false)
        if (JSON.stringify(data) !== JSON.stringify(walletsCache)) {
            renderWallets(data)
        }
    } catch (e) {
        console.error("poll error", e)
    }

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
    chart.destroy()
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
    if (!slices.length) return

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


function loginRequiredError(r, data) {
    return !r || r.type === "opaqueredirect" || !data
}

async function saveWalletRequest(url, body) {

    try {

        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            redirect: "manual"
        })

        if (r.type === "opaqueredirect") {
            await Swal.fire({
                icon: "error",
                title: "Log in to Umbrel to make changes"
            })
            return false
        }

        const data = await r.json().catch(() => null)

        if (loginRequiredError(r, data)) {
            await Swal.fire({
                icon: "error",
                title: "Log in to Umbrel to make changes"
            })
            return false
        }

        if (!r.ok) {
            await Swal.fire({
                icon: "error",
                title: data.error || ("Request failed (" + r.status + ")")
            })
            return false
        }

        return true

    } catch (e) {

        const loginish = !e.message || e.message === "Failed to fetch" || e.name === "TypeError"
        await Swal.fire({
            icon: "error",
            title: loginish ? "Log in to Umbrel to make changes" : (e.message || "Request failed")
        })
        return false

    }

}


async function openWalletModal() {

    if (!canWrite) return

    const enabled = enabledAssetList()
    if (!enabled.length) return

    const tabsHtml = enabled.map((asset, i) =>
        `<button type="button" class="asset-tab${i === 0 ? " active" : ""}" data-asset="${asset}">${COINS[asset].name}</button>`
    ).join("")

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
            const walletInput = document.getElementById("swal-wallet")
            const xpubInput = document.getElementById("swal-xpub")
            const addressInput = document.getElementById("swal-address")
            const viewKeyInput = document.getElementById("swal-viewkey")
            const restoreInput = document.getElementById("swal-restore")
            const zecAddressInput = document.getElementById("swal-zec-address")
            const zecBirthdayInput = document.getElementById("swal-zec-birthday")
            const label = document.getElementById("wallet-type")
            const btcFields = document.getElementById("btc-fields")
            const xmrFields = document.getElementById("xmr-fields")
            const zecFields = document.getElementById("zec-fields")
            const tabs = root.querySelectorAll(".asset-tab")
            const btn = Swal.getConfirmButton()

            let asset = enabled[0]
            btn.disabled = true

            function setAsset(next) {
                asset = next
                btcFields.style.display = asset === "btc" ? "" : "none"
                xmrFields.style.display = asset === "xmr" ? "" : "none"
                zecFields.style.display = asset === "zec" ? "" : "none"
                tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.asset === asset))
                validate()
            }

            function validate() {

                const wallet = cleanInput(walletInput.value)

                if (asset === "zec") {
                    const address = zecAddressInput.value.trim()
                    const birthday = zecBirthdayInput.value.trim()
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
                    const address = addressInput.value.trim()
                    const viewKey = viewKeyInput.value.trim()
                    const restore = restoreInput.value.trim()
                    const validAddress = address.startsWith("4") && address.length === 95
                    const validViewKey = /^[0-9a-fA-F]{64}$/.test(viewKey)
                    const validRestore = restore === "" || /^\d+$/.test(restore)
                    btn.disabled = !(wallet && validAddress && validViewKey && validRestore)
                    return
                }

                const key = xpubInput.value.trim().toLowerCase()

                const validPrefix =
                    key.startsWith("xpub") ||
                    key.startsWith("ypub") ||
                    key.startsWith("zpub")

                const validLength = key.length > 100

                btn.disabled = !(wallet && validPrefix && validLength)
            }

            tabs.forEach(tab => {
                tab.addEventListener("click", () => setAsset(tab.dataset.asset))
            })

            walletInput.addEventListener("input", validate)
            addressInput.addEventListener("input", validate)
            viewKeyInput.addEventListener("input", validate)
            restoreInput.addEventListener("input", validate)
            zecAddressInput.addEventListener("input", validate)
            zecBirthdayInput.addEventListener("input", validate)

            xpubInput.addEventListener("input", () => {

                const v = xpubInput.value.trim().toLowerCase()

                if (v.startsWith("zpub"))
                    label.innerText = "Detected: Native SegWit (BIP84)"

                else if (v.startsWith("ypub"))
                    label.innerText = "Detected: Nested SegWit (BIP49)"

                else if (v.startsWith("xpub"))
                    label.innerText = "Detected: Legacy (BIP44)"

                else
                    label.innerText = ""

                validate()
            })

            setAsset(enabled[0])

        },

        preConfirm: () => {
            const active = Swal.getHtmlContainer().querySelector(".asset-tab.active")
            const type = (active && active.dataset.asset) || enabled[0]

            if (!assetEnabled(type)) return false

            return {
                type,
                wallet: cleanInput(document.getElementById("swal-wallet").value),
                xpub: document.getElementById("swal-xpub").value.trim(),
                address: document.getElementById("swal-address").value.trim(),
                viewKey: document.getElementById("swal-viewkey").value.trim(),
                restoreHeight: document.getElementById("swal-restore").value.trim() || 0,
                zecAddress: document.getElementById("swal-zec-address").value.trim(),
                zecBirthday: document.getElementById("swal-zec-birthday").value.trim()
            }
        }

    })

    if (!result.isConfirmed) return

    const { type, wallet, xpub, address, viewKey, restoreHeight, zecAddress, zecBirthday } = result.value

    let ok = false

    if (type === "xmr") {
        ok = await saveWalletRequest("/wallet", {
            wallet,
            type: "xmr",
            address,
            viewKey,
            restoreHeight
        })
    } else if (type === "zec") {
        ok = zecAddress.startsWith("uview1")
            ? await saveWalletRequest("/wallet", {
                wallet,
                type: "zec",
                ufvk: zecAddress,
                birthday: zecBirthday
            })
            : await saveWalletRequest("/wallet", {
                wallet,
                type: "zec",
                address: zecAddress
            })
    } else {
        ok = await saveWalletRequest("/wallet", {
            wallet,
            type: "btc",
            xpub
        })
    }

    if (ok) load(true)
}


async function editWallet(id) {

    if (!canWrite) return

    const wallet = walletsCache.find(w => w.id === id)

    if (!wallet) return

    const isXmr = walletAsset(wallet) === "xmr"
    const isZec = walletAsset(wallet) === "zec"
    const isZecShielded = isZec && !!wallet.ufvk

    const result = await Swal.fire({

        title: "Edit Wallet",

        customClass: { popup: "wallet-popup" },

        html: isXmr ? `
<input id="swal-wallet" class="swal2-input" value="${wallet.wallet}">
<textarea id="swal-address" class="swal2-textarea" rows="2">${wallet.address || ""}</textarea>
<textarea id="swal-viewkey" class="swal2-textarea" rows="2">${wallet.viewKey || ""}</textarea>
<input id="swal-restore" class="swal2-input" value="${wallet.restoreHeight || 0}" inputmode="numeric">
<div class="wallet-hint">Spends are detected automatically. Key images are optional: import them after a sweep with no change output, or to reconcile the balance exactly (Monero GUI: Settings → Wallet → Export key images; Feather: File → Export → Key images). Incoming funds do not need this.</div>
<input id="swal-keyimages" class="keyimages-file" type="file">
<textarea id="swal-keyimages-text" class="swal2-textarea" rows="3" placeholder="Or paste key images JSON" spellcheck="false"></textarea>
` : isZecShielded ? `
<input id="swal-wallet" class="swal2-input" value="${wallet.wallet}">
<textarea id="swal-ufvk" class="swal2-textarea" rows="3">${wallet.ufvk || ""}</textarea>
<input id="swal-birthday" class="swal2-input" value="${wallet.birthday || 1687104}" inputmode="numeric">
<div class="wallet-hint">Unified viewing key (uview1…). Birthday defaults to NU5 (1687104). Changing the key or birthday starts a new scan.</div>
` : isZec ? `
<input id="swal-wallet" class="swal2-input" value="${wallet.wallet}">
<textarea id="swal-address" class="swal2-textarea" rows="2" maxlength="35">${wallet.address || ""}</textarea>
<div class="wallet-hint">Transparent mainnet address (t1 or t3). Requires the Zcash Node app.</div>
` : `
<input id="swal-wallet" class="swal2-input" value="${wallet.wallet}">
<textarea id="swal-xpub" class="swal2-textarea" rows="2">${wallet.xpub || ""}</textarea>
`,

        showCancelButton: true,
        confirmButtonText: "Save",

        showDenyButton: true,
        denyButtonText: "Delete",
        denyButtonColor: "#ef4444",

        preConfirm: async () => {
            if (isZecShielded) {
                return {
                    wallet: cleanInput(document.getElementById("swal-wallet").value),
                    ufvk: document.getElementById("swal-ufvk").value.trim(),
                    birthday: document.getElementById("swal-birthday").value.trim()
                }
            }

            if (isZec) {
                return {
                    wallet: cleanInput(document.getElementById("swal-wallet").value),
                    address: document.getElementById("swal-address").value.trim()
                }
            }

            if (isXmr) {
                const file = document.getElementById("swal-keyimages").files[0]
                let fileBase64 = ""

                if (file) {
                    fileBase64 = await new Promise((resolve, reject) => {
                        const reader = new FileReader()
                        reader.onload = () => {
                            const dataUrl = String(reader.result || "")
                            resolve(dataUrl.split(",")[1] || "")
                        }
                        reader.onerror = reject
                        reader.readAsDataURL(file)
                    })
                }

                return {
                    wallet: cleanInput(document.getElementById("swal-wallet").value),
                    address: document.getElementById("swal-address").value.trim(),
                    viewKey: document.getElementById("swal-viewkey").value.trim(),
                    restoreHeight: document.getElementById("swal-restore").value.trim() || 0,
                    fileBase64,
                    keyImagesText: document.getElementById("swal-keyimages-text").value.trim()
                }
            }

            return {
                wallet: cleanInput(document.getElementById("swal-wallet").value),
                xpub: document.getElementById("swal-xpub").value.trim()
            }
        }

    })

    if (result.isDismissed) return

    if (result.isDenied) {

        const ok = await saveWalletRequest("/wallet/remove", { id: wallet.id })
        if (ok) load(true)
        return
    }

    if (isXmr) {
        const { wallet: newWallet, address, viewKey, restoreHeight, fileBase64, keyImagesText } = result.value
        const rescan = address !== wallet.address
            || viewKey !== wallet.viewKey
            || Number(restoreHeight) !== Number(wallet.restoreHeight)

        const ok = await saveWalletRequest("/wallet/update", {
            id: wallet.id,
            wallet: newWallet,
            address,
            viewKey,
            restoreHeight
        })

        if (!ok) return

        if (fileBase64 || keyImagesText) {

            Swal.fire({
                title: "Importing key images",
                text: "Refreshing the view-only wallet, then applying spends. This can take a while.",
                allowOutsideClick: false,
                didOpen: () => Swal.showLoading()
            })

            const imported = await fetch("/wallet/key-images", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: wallet.id,
                    fileBase64: fileBase64 || undefined,
                    payload: keyImagesText || undefined
                }),
                redirect: "manual"
            }).then(async r => {
                if (r.type === "opaqueredirect") {
                    return { ok: false, data: { error: "Log in to Umbrel to make changes" } }
                }
                const data = await r.json().catch(() => null)
                if (!data) return { ok: false, data: { error: "Log in to Umbrel to make changes" } }
                return { ok: r.ok, data }
            }).catch(() => ({ ok: false, data: { error: "Log in to Umbrel to make changes" } }))

            if (!imported.ok) {
                await Swal.fire({
                    icon: "error",
                    title: imported.data.error || "Key image import failed"
                })
                load(false)
                return
            }

            await Swal.fire({
                icon: "success",
                title: "Key images imported",
                text: `Unspent ${Number(imported.data.unspent).toFixed(6)} XMR · spent ${Number(imported.data.spent).toFixed(6)} XMR`
            })

            load(false)
            return
        }

        load(rescan)
        return
    }

    if (isZecShielded) {
        const { wallet: newWallet, ufvk, birthday } = result.value
        const ok = await saveWalletRequest("/wallet/update", {
            id: wallet.id,
            wallet: newWallet,
            ufvk,
            birthday
        })

        if (!ok) return

        load(ufvk !== wallet.ufvk || Number(birthday) !== Number(wallet.birthday))
        return
    }

    if (isZec) {
        const { wallet: newWallet, address } = result.value
        const ok = await saveWalletRequest("/wallet/update", {
            id: wallet.id,
            wallet: newWallet,
            address
        })

        if (!ok) return

        load(address !== wallet.address)
        return
    }

    const { wallet: newWallet, xpub: newXpub } = result.value

    const ok = await saveWalletRequest("/wallet/update", {
        id: wallet.id,
        wallet: newWallet,
        xpub: newXpub
    })

    if (!ok) return

    if (newXpub === wallet.xpub) return load(false)

    load()

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

    if (navigator.clipboard && navigator.clipboard.writeText) {

        navigator.clipboard.writeText(text)

    } else {

        const t = document.createElement("textarea")
        t.value = text
        document.body.appendChild(t)
        t.select()
        document.execCommand("copy")
        document.body.removeChild(t)

    }

    Swal.fire({
        toast: true,
        position: "top",
        icon: "success",
        title: "Lightning address copied",
        showConfirmButton: false,
        timer: 1500
    })

}



function donateModal() {

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

    const appVersion = await fetch("/appversion")
        .then(res => res.json())
        .then(data => data.appversion)
        .catch(() => "1.0.0")

    document.title = `sovBalance ${appVersion}`
    document.getElementById("app_version").innerText = appVersion

    document.getElementById("donateBtn").addEventListener("click", donateModal)
    syncSortButtons()

    canWrite = await probeWriteAccess()
    await loadNodes()
    applyWriteUi()

    load(false)
    updatePrices()

    setInterval(updatePrices, 60 * 1000)
    setInterval(pollWallets, 30 * 1000)

})
