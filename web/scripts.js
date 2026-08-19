let chart
let walletsCache = []
var totalBTC = 0
var totalXMR = 0
var totalUSD = 0
var btcPriceUSD = 0
var xmrPriceUSD = 0
var lastPriceFetch = 0

let scanCounter = 0
let scanInterval
let scanning = false



function btcToSats(btc) {
    return Number(BigInt(Math.round(btc * 1e8)))
}

function walletAsset(w) {
    return w.type === "xmr" ? "xmr" : "btc"
}

function walletUsd(w) {
    return walletAsset(w) === "xmr"
        ? w.balance * xmrPriceUSD
        : w.balance * btcPriceUSD
}

function formatAmount(w) {
    if (walletAsset(w) === "xmr") {
        return Number(w.balance).toFixed(6) + " XMR"
    }
    return Number(w.balance).toFixed(8) + " BTC"
}

function amountTitle(w) {
    if (walletAsset(w) === "xmr") {
        return "View-only incoming balance. Spent outputs still count until key images are imported."
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

async function loadPrices() {

    const now = Date.now()

    if ((btcPriceUSD || xmrPriceUSD) && now - lastPriceFetch < 300000) {
        return
    }

    try {

        const data = await fetchJson("/prices", 15000)

        btcPriceUSD = Number(data.btc) || 0
        xmrPriceUSD = Number(data.xmr) || 0
        if (btcPriceUSD || xmrPriceUSD) {
            lastPriceFetch = Date.now()
        }

    } catch (e) {

        console.error("price error", e)

    }

}

function coinTotals(wallets) {

    let btc = 0
    let xmr = 0

    for (const w of wallets) {
        if (walletAsset(w) === "xmr") xmr += w.balance
        else btc += w.balance
    }

    return { btc, xmr }

}

function paintPrices() {

    const { btc, xmr } = coinTotals(walletsCache)
    const usd = btc * btcPriceUSD + xmr * xmrPriceUSD

    totalBTC = btc
    totalXMR = xmr
    totalUSD = usd

    const parts = []
    if (btc) parts.push(btc.toFixed(8) + " BTC")
    if (xmr) parts.push(xmr.toFixed(6) + " XMR")
    if (!parts.length) parts.push("0.00000000 BTC")

    if (usd > 0) {
        document.getElementById("totalTop").innerText = "$" + usd.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " USD"
        document.getElementById("totalUSD").innerText = parts.join("  ·  ")
    } else {
        document.getElementById("totalTop").innerText = parts.join("  ·  ")
        document.getElementById("totalUSD").innerText = ""
    }

    document.getElementById("btcPrice").innerText = btcPriceUSD
        ? "1 BTC = $" + btcPriceUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : ""

    document.getElementById("xmrPrice").innerText = xmrPriceUSD
        ? "1 XMR = $" + xmrPriceUSD.toLocaleString(undefined, { maximumFractionDigits: 2 })
        : ""

    if (lastPriceFetch && !scanning) {
        document.getElementById("lastUpdated").innerText = new Date(lastPriceFetch).toLocaleTimeString()
    }

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

    if (wallets.length === 0) {
        document.querySelector("#t tbody").innerHTML = `
        <tr>
          <td colspan="4">ℹ️ No wallets configured yet</td>
        </tr>`
        return
    }

    const mixed = wallets.some(w => walletAsset(w) === "xmr") && wallets.some(w => walletAsset(w) === "btc")
    const useUsd = mixed && totalUSD > 0

    let rows = ""
    const labels = []
    const values = []

    for (const w of wallets) {

        const asset = walletAsset(w)
        const usd = walletUsd(w)
        const share = useUsd
            ? (totalUSD > 0 ? (usd / totalUSD) * 100 : 0)
            : asset === "xmr"
                ? (totalXMR > 0 ? (w.balance / totalXMR) * 100 : 0)
                : (totalBTC > 0 ? (w.balance / totalBTC) * 100 : 0)

        const perc = share.toFixed(1)

        labels.push(w.wallet)
        values.push(useUsd ? usd : w.balance)

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
        renderChart(labels, values, useUsd)
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
    document.getElementById("totalUSD").innerText = ""
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



function renderChart(labels, data, useUsd = false) {

    const canvas = document.getElementById("chart").getContext("2d")

    if (chart) chart.destroy()

    chart = new Chart(canvas, {

        type: "doughnut",

        data: {
            labels,
            datasets: [{
                data: [],
                backgroundColor: [
                    "#3b82f6",
                    "#22c55e",
                    "#f59e0b",
                    "#ef4444",
                    "#a855f7",
                    "#14b8a6"
                ],
                borderColor: "rgba(0,0,0,0.15)",
                borderWidth: 1,

                hoverBorderColor: "#0f1115",
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

                legend: { position: "bottom" },

                tooltip: {
                    callbacks: {
                        label: (ctx) => {

                            const wallet = walletsCache[ctx.dataIndex]
                            const perc = useUsd
                                ? (totalUSD > 0 ? ((ctx.raw / totalUSD) * 100).toFixed(2) : "0.00")
                                : walletAsset(wallet) === "xmr"
                                    ? (totalXMR > 0 ? ((wallet.balance / totalXMR) * 100).toFixed(2) : "0.00")
                                    : (totalBTC > 0 ? ((wallet.balance / totalBTC) * 100).toFixed(2) : "0.00")

                            if (useUsd) {
                                return `${perc}%   •   ${formatAmount(wallet)}   •   $${ctx.raw.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
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

    const result = await Swal.fire({

        title: "Add Wallet",

        customClass: { popup: "wallet-popup" },

        html: `
<div class="asset-tabs">
  <button type="button" class="asset-tab active" data-asset="btc">Bitcoin</button>
  <button type="button" class="asset-tab" data-asset="xmr">Monero</button>
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
`,

        showCancelButton: true,
        confirmButtonText: "Save",

        willOpen: () => {

            const walletInput = document.getElementById("swal-wallet")
            const xpubInput = document.getElementById("swal-xpub")
            const addressInput = document.getElementById("swal-address")
            const viewKeyInput = document.getElementById("swal-viewkey")
            const restoreInput = document.getElementById("swal-restore")
            const label = document.getElementById("wallet-type")
            const btcFields = document.getElementById("btc-fields")
            const xmrFields = document.getElementById("xmr-fields")
            const tabs = document.querySelectorAll(".asset-tab")
            const btn = Swal.getConfirmButton()

            let asset = "btc"
            btn.disabled = true

            function setAsset(next) {
                asset = next
                btcFields.style.display = asset === "btc" ? "" : "none"
                xmrFields.style.display = asset === "xmr" ? "" : "none"
                tabs.forEach(tab => tab.classList.toggle("active", tab.dataset.asset === asset))
                validate()
            }

            function validate() {

                const wallet = cleanInput(walletInput.value)

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

        },

        preConfirm: () => {
            const type = document.querySelector(".asset-tab.active")
                ? document.querySelector(".asset-tab.active").dataset.asset
                : "btc"

            return {
                type,
                wallet: cleanInput(document.getElementById("swal-wallet").value),
                xpub: document.getElementById("swal-xpub").value.trim(),
                address: document.getElementById("swal-address").value.trim(),
                viewKey: document.getElementById("swal-viewkey").value.trim(),
                restoreHeight: document.getElementById("swal-restore").value.trim() || 0
            }
        }

    })

    if (!result.isConfirmed) return

    const { type, wallet, xpub, address, viewKey, restoreHeight } = result.value

    let ok = false

    if (type === "xmr") {
        ok = await saveWalletRequest("/wallet", {
            wallet,
            type: "xmr",
            address,
            viewKey,
            restoreHeight
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

        ctx.fillStyle = "#e6e6e6"
        ctx.font = "600 18px system-ui"

        if (totalUSD > 0) {
            ctx.fillText("$" + totalUSD.toLocaleString(undefined, { maximumFractionDigits: 0 }), x, y - 8)
            ctx.fillStyle = "#9ca3af"
            ctx.font = "400 14px system-ui"
            ctx.fillText("USD", x, y + 14)
        } else if (totalXMR && !totalBTC) {
            ctx.fillText(totalXMR.toFixed(4), x, y - 8)
            ctx.fillStyle = "#9ca3af"
            ctx.font = "400 14px system-ui"
            ctx.fillText("XMR", x, y + 14)
        } else {
            ctx.fillText(totalBTC.toFixed(8), x, y - 8)
            ctx.fillStyle = "#9ca3af"
            ctx.font = "400 14px system-ui"
            ctx.fillText("BTC", x, y + 14)
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


    load(false)

    document.getElementById("donateBtn").addEventListener("click", donateModal)

    setInterval(updatePrices, 60 * 1000)

})
