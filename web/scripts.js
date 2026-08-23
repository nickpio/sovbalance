let chart
let walletsCache = []
var totalBTC = 0
var totalXMR = 0
var totalZEC = 0
var totalFiat = 0
var btcPrices = { USD: 0, CAD: 0 }
var xmrPrices = { USD: 0, CAD: 0 }
var zecPrices = { USD: 0, CAD: 0 }
var lastPriceFetch = 0
var fiatCurrency = localStorage.getItem("sovbalance-fiat") === "CAD" ? "CAD" : "USD"
var btcUnit = ["btc", "mbtc", "sats"].includes(localStorage.getItem("sovbalance-btc-unit"))
    ? localStorage.getItem("sovbalance-btc-unit")
    : "btc"
var xmrUnit = ["xmr", "piconero"].includes(localStorage.getItem("sovbalance-xmr-unit"))
    ? localStorage.getItem("sovbalance-xmr-unit")
    : "xmr"
var zecUnit = ["zec", "zats"].includes(localStorage.getItem("sovbalance-zec-unit"))
    ? localStorage.getItem("sovbalance-zec-unit")
    : "zec"
const ASSETS = ["btc", "xmr", "zec"]
const ASSET_NAMES = { btc: "Bitcoin", xmr: "Monero", zec: "Zcash" }
var enabledAssets = loadAssetFlags("sovbalance-assets", false)

function loadAssetFlags(key, allowEmpty) {
    const fallback = { btc: true, xmr: true, zec: true }
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        const enabled = new Set(
            Array.isArray(parsed)
                ? parsed
                : Object.keys(parsed || {}).filter(k => parsed[k])
        )
        const next = {
            btc: enabled.has("btc"),
            xmr: enabled.has("xmr"),
            zec: enabled.has("zec")
        }
        if (!allowEmpty && !next.btc && !next.xmr && !next.zec) return fallback
        return next
    } catch (e) {
        return fallback
    }
}

function saveAssetFlags(key, flags) {
    localStorage.setItem(key, JSON.stringify(ASSETS.filter(asset => flags[asset])))
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

function formatBtcAmount(btc) {
    const n = Number(btc) || 0
    if (btcUnit === "sats") {
        return btcToSats(n).toLocaleString() + " sats"
    }
    if (btcUnit === "mbtc") {
        return (n * 1000).toFixed(5) + " mBTC"
    }
    return n.toFixed(8) + " BTC"
}

function formatXmrAmount(xmr) {
    const n = Number(xmr) || 0
    if (xmrUnit === "piconero") {
        return xmrToPiconero(n).toLocaleString() + " piconeros"
    }
    return n.toFixed(6) + " XMR"
}

function formatZecAmount(zec) {
    const n = Number(zec) || 0
    if (zecUnit === "zats") {
        return btcToSats(n).toLocaleString() + " zats"
    }
    return n.toFixed(8) + " ZEC"
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

function assetEnabled(asset) {
    return !!enabledAssets[asset]
}

function enabledAssetList() {
    return ASSETS.filter(assetEnabled)
}

function visibleWallets(wallets = walletsCache) {
    return wallets.filter(w => assetEnabled(walletAsset(w)))
}

function fiatOf(prices) {
    return Number(prices[fiatCurrency]) || 0
}

function walletFiat(w) {
    const asset = walletAsset(w)
    if (asset === "xmr") return w.balance * fiatOf(xmrPrices)
    if (asset === "zec") return w.balance * fiatOf(zecPrices)
    return w.balance * fiatOf(btcPrices)
}

function formatFiat(amount, digits = 2) {
    return "$" + amount.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function formatAmount(w) {
    const asset = walletAsset(w)
    if (asset === "xmr") return formatXmrAmount(w.balance)
    if (asset === "zec") return formatZecAmount(w.balance)
    return formatBtcAmount(w.balance)
}

function amountTitle(w) {
    const asset = walletAsset(w)
    if (asset === "xmr") {
        return "View-only incoming balance. Spent outputs still count until key images are imported."
    }
    if (asset === "zec") {
        return zecUnit === "zats"
            ? Number(w.balance).toFixed(8) + " ZEC"
            : btcToSats(w.balance).toLocaleString() + " zats"
    }
    if (btcUnit === "sats") {
        return Number(w.balance).toFixed(8) + " BTC"
    }
    return btcToSats(w.balance).toLocaleString() + " sats"
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

async function loadPrices() {

    const now = Date.now()

    if ((fiatOf(btcPrices) || fiatOf(xmrPrices) || fiatOf(zecPrices)) && now - lastPriceFetch < 300000) {
        return
    }

    try {

        const data = await fetchJson("/prices", 15000)

        btcPrices = readFiatMap(data.btc)
        xmrPrices = readFiatMap(data.xmr)
        zecPrices = readFiatMap(data.zec)
        if (fiatOf(btcPrices) || fiatOf(xmrPrices) || fiatOf(zecPrices)) {
            lastPriceFetch = Date.now()
        }

    } catch (e) {

        console.error("price error", e)

    }

}

function coinTotals(wallets) {

    let btc = 0
    let xmr = 0
    let zec = 0

    for (const w of wallets) {
        const asset = walletAsset(w)
        if (!assetEnabled(asset)) continue
        if (asset === "xmr") xmr += w.balance
        else if (asset === "zec") zec += w.balance
        else btc += w.balance
    }

    return { btc, xmr, zec }

}

function paintPrices() {

    const { btc, xmr, zec } = coinTotals(walletsCache)
    const btcPrice = fiatOf(btcPrices)
    const xmrPrice = fiatOf(xmrPrices)
    const zecPrice = fiatOf(zecPrices)
    const fiat = btc * btcPrice + xmr * xmrPrice + zec * zecPrice

    totalBTC = btc
    totalXMR = xmr
    totalZEC = zec
    totalFiat = fiat

    document.getElementById("totalTop").innerText = formatFiat(fiat) + " " + fiatCurrency
    setLine("totalBTC", assetEnabled("btc"), formatBtcAmount(btc))
    setLine("totalXMR", assetEnabled("xmr"), formatXmrAmount(xmr))
    setLine("totalZEC", assetEnabled("zec"), formatZecAmount(zec))

    setPriceLine("btcPrice", assetEnabled("btc") && !!btcPrice,
        formatFiat(btcPrice) + " " + fiatCurrency)

    setPriceLine("xmrPrice", assetEnabled("xmr") && !!xmrPrice,
        formatFiat(xmrPrice) + " " + fiatCurrency)

    setPriceLine("zecPrice", assetEnabled("zec") && !!zecPrice,
        formatFiat(zecPrice) + " " + fiatCurrency)

    if (lastPriceFetch && !scanning) {
        document.getElementById("lastUpdated").innerText = new Date(lastPriceFetch).toLocaleTimeString()
    }

}

function setLine(id, show, text) {
    const el = document.getElementById(id)
    if (!el) return
    el.innerText = show ? text : ""
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

function setBtcUnit(next) {
    if (next !== "btc" && next !== "mbtc" && next !== "sats") return
    if (next === btcUnit) return
    btcUnit = next
    localStorage.setItem("sovbalance-btc-unit", next)
    applyDisplay()
}

function setXmrUnit(next) {
    if (next !== "xmr" && next !== "piconero") return
    if (next === xmrUnit) return
    xmrUnit = next
    localStorage.setItem("sovbalance-xmr-unit", next)
    applyDisplay()
}

function setZecUnit(next) {
    if (next !== "zec" && next !== "zats") return
    if (next === zecUnit) return
    zecUnit = next
    localStorage.setItem("sovbalance-zec-unit", next)
    applyDisplay()
}

function toggleAsset(asset) {
    if (!ASSETS.includes(asset)) return
    if (enabledAssets[asset] && enabledAssetList().length === 1) return
    enabledAssets[asset] = !enabledAssets[asset]
    saveAssetFlags("sovbalance-assets", enabledAssets)
    applyDisplay()
}

function syncSettingsTabs() {
    document.querySelectorAll("[data-setting]").forEach(btn => {
        const on = (btn.dataset.setting === "fiat" && btn.dataset.value === fiatCurrency)
            || (btn.dataset.setting === "asset" && enabledAssets[btn.dataset.value])
            || (btn.dataset.setting === "btcUnit" && btn.dataset.value === btcUnit)
            || (btn.dataset.setting === "xmrUnit" && btn.dataset.value === xmrUnit)
            || (btn.dataset.setting === "zecUnit" && btn.dataset.value === zecUnit)
        btn.classList.toggle("active", on)
        btn.setAttribute("aria-pressed", on ? "true" : "false")
    })
    document.querySelectorAll("[data-asset-row]").forEach(row => {
        row.hidden = !assetEnabled(row.dataset.assetRow)
    })
}

function openSettings() {
    Swal.fire({
        title: "Settings",
        customClass: { popup: "settings-popup" },
        confirmButtonText: "Done",
        html: `
<div class="settings-section">
  <div class="settings-label">Currencies</div>
  <div class="asset-tabs">
    <button type="button" class="asset-tab" data-setting="asset" data-value="btc" data-asset="btc">BTC</button>
    <button type="button" class="asset-tab" data-setting="asset" data-value="xmr" data-asset="xmr">XMR</button>
    <button type="button" class="asset-tab" data-setting="asset" data-value="zec" data-asset="zec">ZEC</button>
  </div>
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
  <div class="settings-row" data-asset-row="btc">
    <div class="settings-row-label btc">BTC</div>
    <div class="asset-tabs">
      <button type="button" class="asset-tab" data-setting="btcUnit" data-value="btc">BTC</button>
      <button type="button" class="asset-tab" data-setting="btcUnit" data-value="mbtc">mBTC</button>
      <button type="button" class="asset-tab" data-setting="btcUnit" data-value="sats">sats</button>
    </div>
  </div>
  <div class="settings-row" data-asset-row="xmr">
    <div class="settings-row-label xmr">XMR</div>
    <div class="asset-tabs">
      <button type="button" class="asset-tab" data-setting="xmrUnit" data-value="xmr">XMR</button>
      <button type="button" class="asset-tab" data-setting="xmrUnit" data-value="piconero">piconeros</button>
    </div>
  </div>
  <div class="settings-row" data-asset-row="zec">
    <div class="settings-row-label zec">ZEC</div>
    <div class="asset-tabs">
      <button type="button" class="asset-tab" data-setting="zecUnit" data-value="zec">ZEC</button>
      <button type="button" class="asset-tab" data-setting="zecUnit" data-value="zats">zats</button>
    </div>
  </div>
</div>
`,
        willOpen: () => {
            syncSettingsTabs()
            document.querySelectorAll("[data-setting]").forEach(btn => {
                btn.addEventListener("click", () => {
                    if (btn.dataset.setting === "fiat") setFiat(btn.dataset.value)
                    else if (btn.dataset.setting === "asset") toggleAsset(btn.dataset.value)
                    else if (btn.dataset.setting === "btcUnit") setBtcUnit(btn.dataset.value)
                    else if (btn.dataset.setting === "xmrUnit") setXmrUnit(btn.dataset.value)
                    else if (btn.dataset.setting === "zecUnit") setZecUnit(btn.dataset.value)
                    syncSettingsTabs()
                })
            })
        }
    })
}

async function updatePrices() {

    await loadPrices()
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


function renderWallets(wallets) {

    walletsCache = wallets
    stopScanIndicator()
    paintPrices()

    const visible = visibleWallets(wallets)

    if (visible.length === 0) {
        if (chart) chart.destroy()
        document.querySelector("#t tbody").innerHTML = `
        <tr>
          <td colspan="4">${wallets.length ? "No wallets for the selected currencies" : "ℹ️ No wallets configured yet"}</td>
        </tr>`
        return
    }

    const mixed = new Set(visible.map(walletAsset)).size > 1
    const useFiat = mixed && totalFiat > 0

    let rows = ""
    const labels = []
    const values = []

    for (const w of visible) {

        const asset = walletAsset(w)
        const fiat = walletFiat(w)
        const share = useFiat
            ? (totalFiat > 0 ? (fiat / totalFiat) * 100 : 0)
            : asset === "xmr"
                ? (totalXMR > 0 ? (w.balance / totalXMR) * 100 : 0)
                : asset === "zec"
                    ? (totalZEC > 0 ? (w.balance / totalZEC) * 100 : 0)
                    : (totalBTC > 0 ? (w.balance / totalBTC) * 100 : 0)

        const perc = share.toFixed(1)

        labels.push(w.wallet)
        values.push(useFiat ? fiat : w.balance)

        const error = w.error
            ? `<div class="wallet-error">${w.error}</div>`
            : ""

        rows += `
<tr onclick="editWallet(${w.id})">
<td class="walletName">${w.wallet}<span class="coin-badge ${asset}">${asset.toUpperCase()}</span>${error}</td>
<td class="percentage">${perc}%</td>
<td class="balance" title="${amountTitle(w)}">${formatAmount(w)}</td>
<td class="chevron">›</td>
</tr>`
    }

    document.querySelector("#t tbody").innerHTML = rows

    requestAnimationFrame(() => {
        renderChart(labels, values, useFiat)
    })

}


async function load(rescan = true) {

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

    updatePrices()

    if (!rescan) return

    document.getElementById("lastUpdated").innerText = "Scanning…"

    try {
        renderWallets(await fetchWallets(true))
    } catch (e) {
        console.error(e)
        document.getElementById("lastUpdated").innerText = e.message || "Scan failed"
        return
    } finally {
        scanning = false
    }

    if (lastPriceFetch) {
        document.getElementById("lastUpdated").innerText = new Date(lastPriceFetch).toLocaleTimeString()
    }

}


function clearTable() {
    document.querySelector("#t tbody").innerHTML = ""
    document.getElementById("totalTop").innerText = "-"
    setLine("totalBTC", false, "")
    setLine("totalXMR", false, "")
    setLine("totalZEC", false, "")
    if (chart) chart.destroy()
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


const dimOthers = {
    id: "dimOthers",

    beforeDatasetsDraw(chart) {

        const active = chart.getActiveElements()

        if (!active.length) return

        const { ctx } = chart
        const meta = chart.getDatasetMeta(0)

        const activeIndex = active[0].index

        ctx.save()

        meta.data.forEach((arc, i) => {

            if (i === activeIndex) return

            const { x, y, innerRadius, outerRadius, startAngle, endAngle } = arc

            ctx.beginPath()
            ctx.arc(x, y, outerRadius, startAngle, endAngle)
            ctx.arc(x, y, innerRadius, endAngle, startAngle, true)
            ctx.closePath()

            ctx.fillStyle = "rgba(0,0,0,0.35)"
            ctx.fill()

        })

        ctx.restore()
    }
}



function renderChart(labels, data, useFiat = false) {

    const canvas = document.getElementById("chart").getContext("2d")

    if (chart) chart.destroy()

    chart = new Chart(canvas, {

        type: "doughnut",

        data: {
            labels,
            datasets: [{
                data: [],
                backgroundColor: [
                    "#f7931a",
                    "#ff6600",
                    "#f4b728",
                    "#ffffff",
                    "#c2410c",
                    "#fdba74",
                    "#737373"
                ],
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

                            const wallet = visibleWallets()[ctx.dataIndex]
                            if (!wallet) return ""
                            const perc = useFiat
                                ? (totalFiat > 0 ? ((ctx.raw / totalFiat) * 100).toFixed(2) : "0.00")
                                : walletAsset(wallet) === "xmr"
                                    ? (totalXMR > 0 ? ((wallet.balance / totalXMR) * 100).toFixed(2) : "0.00")
                                    : walletAsset(wallet) === "zec"
                                        ? (totalZEC > 0 ? ((wallet.balance / totalZEC) * 100).toFixed(2) : "0.00")
                                        : (totalBTC > 0 ? ((wallet.balance / totalBTC) * 100).toFixed(2) : "0.00")

                            if (useFiat) {
                                return `${perc}%   •   ${formatAmount(wallet)}   •   ${formatFiat(ctx.raw)} ${fiatCurrency}`
                            }

                            return `${perc}%   •   ${formatAmount(wallet)}`
                        }
                    }
                }

            }

        }

    })

    setTimeout(() => {

        chart.data.datasets[0].data = data
        chart.update()

    }, 50)

}


async function saveWalletRequest(url, body) {

    try {

        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })

        const data = await r.json().catch(() => ({}))

        if (!r.ok) {
            await Swal.fire({
                icon: "error",
                title: data.error || ("Request failed (" + r.status + ")")
            })
            return false
        }

        return true

    } catch (e) {

        await Swal.fire({
            icon: "error",
            title: e.message || "Request failed"
        })
        return false

    }

}


async function openWalletModal() {

    const enabled = enabledAssetList()
    if (!enabled.length) return

    const tabsHtml = enabled.map((asset, i) =>
        `<button type="button" class="asset-tab${i === 0 ? " active" : ""}" data-asset="${asset}">${ASSET_NAMES[asset]}</button>`
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
<div class="wallet-hint">View-only wallets can see received outputs, including subaddresses. Spent funds still count until you import key images from the spend wallet (Edit Wallet after a spend). Use a restore height from around when the wallet was created to avoid a full-chain scan.</div>
</div>

<div id="zec-fields" style="display:none">
<textarea id="swal-zec-address"
class="swal2-textarea"
rows="2"
maxlength="35"
placeholder="Transparent address (t1… or t3…)"
spellcheck="false"></textarea>
<div class="wallet-hint">Requires the Zcash Node app. Transparent mainnet addresses only (t1 or t3). Shielded viewing keys are not supported yet.</div>
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
                    btn.disabled = !(wallet && /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(address))
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
                zecAddress: document.getElementById("swal-zec-address").value.trim()
            }
        }

    })

    if (!result.isConfirmed) return

    const { type, wallet, xpub, address, viewKey, restoreHeight, zecAddress } = result.value

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
        ok = await saveWalletRequest("/wallet", {
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

    const wallet = walletsCache.find(w => w.id === id)

    if (!wallet) return

    const isXmr = walletAsset(wallet) === "xmr"
    const isZec = walletAsset(wallet) === "zec"

    const result = await Swal.fire({

        title: "Edit Wallet",

        customClass: { popup: "wallet-popup" },

        html: isXmr ? `
<input id="swal-wallet" class="swal2-input" value="${wallet.wallet}">
<textarea id="swal-address" class="swal2-textarea" rows="2">${wallet.address || ""}</textarea>
<textarea id="swal-viewkey" class="swal2-textarea" rows="2">${wallet.viewKey || ""}</textarea>
<input id="swal-restore" class="swal2-input" value="${wallet.restoreHeight || 0}" inputmode="numeric">
<div class="wallet-hint">After you spend, export key images from the wallet that has the spend key (Monero GUI: Settings → Wallet → Export key images; Feather: File → Export → Key images) and attach that file here. Incoming funds do not need this.</div>
<input id="swal-keyimages" class="keyimages-file" type="file">
<textarea id="swal-keyimages-text" class="swal2-textarea" rows="3" placeholder="Or paste key images JSON" spellcheck="false"></textarea>
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
                })
            }).then(r => r.json().then(data => ({ ok: r.ok, data }))).catch(() => ({ ok: false, data: {} }))

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
        } else if (totalXMR && !totalBTC && !totalZEC) {
            const { value, unit } = splitAmountLabel(formatXmrAmount(totalXMR))
            ctx.fillText(value, x, y - 8)
            ctx.fillStyle = "#ff6600"
            ctx.font = "400 14px system-ui"
            ctx.fillText(unit, x, y + 14)
        } else if (totalZEC && !totalBTC && !totalXMR) {
            const { value, unit } = splitAmountLabel(formatZecAmount(totalZEC))
            ctx.fillText(value, x, y - 8)
            ctx.fillStyle = "#f4b728"
            ctx.font = "400 14px system-ui"
            ctx.fillText(unit, x, y + 14)
        } else {
            const { value, unit } = splitAmountLabel(formatBtcAmount(totalBTC))
            ctx.fillText(value, x, y - 8)
            ctx.fillStyle = "#f7931a"
            ctx.font = "400 14px system-ui"
            ctx.fillText(unit || "BTC", x, y + 14)
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


document.addEventListener('DOMContentLoaded', async function () {

    await new Promise(resolve => setTimeout(resolve, 500))

    const appVersion = await fetch("/appversion")
        .then(res => res.json())
        .then(data => data.appversion)
        .catch(() => "1.0.0")

    document.title = `sovBalance ${appVersion}`
    document.getElementById("app_version").innerText = appVersion

    document.getElementById("donateBtn").addEventListener("click", donateModal)

    load(false)

    setInterval(updatePrices, 60 * 1000)

})
