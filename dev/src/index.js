import {storage, system, utils, wallet} from './lnbits-sdk.js'

const EXTENSION_ID = 'paywallwasm'
const PAYWALLS_TABLE = 'paywalls'
const UNLOCKS_TABLE = 'unlocks'
const PAYWALL_SEARCH_FIELDS = ['memo', 'description', 'wallet_name']
const MAX_URL_LENGTH = 2048
const PAYMENT_HASH_PATTERN = /^[0-9a-f]{64}$/

// Authenticated exports: the paywall owner manages their paywalls.

export function createPaywall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const timestamp = system.now()
    const paywall = {
      id: system.id('pw'),
      ...paywallFields(request),
      created_at: timestamp,
      updated_at: timestamp
    }
    storage.set(PAYWALLS_TABLE, paywall)
    return {paywall: privatePaywall(paywall)}
  })
}

export function updatePaywall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const existing = getPaywall(requiredText(request.paywallId, 'paywallId', 128))
    const paywall = {
      ...existing,
      ...paywallFields(request),
      id: existing.id,
      created_at: existing.created_at,
      updated_at: system.now()
    }
    storage.set(PAYWALLS_TABLE, paywall)
    return {paywall: privatePaywall(paywall)}
  })
}

export function listPaywalls(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const pageSize = normalizePageSize(request.limit)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(PAYWALLS_TABLE, {
      search: cleanText(request.search, 120),
      searchFields: PAYWALL_SEARCH_FIELDS,
      sortBy: 'created_at',
      descending: true,
      limit: pageSize,
      offset: (page - 1) * pageSize
    })
    return {
      paywalls: response.data.map(privatePaywall),
      total: response.total,
      page,
      limit: pageSize
    }
  })
}

export function deletePaywall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const paywall = getPaywall(requiredText(request.paywallId, 'paywallId', 128))
    // Unlock rows are only reachable through their paywall, so leftovers are
    // harmless; remove what fits in this invocation's storage budget.
    const unlocks = storage.getPaginated(UNLOCKS_TABLE, {
      filters: {paywall_id: paywall.id},
      limit: 90
    })
    for (const unlock of unlocks.data) {
      storage.delete(UNLOCKS_TABLE, unlock.id)
    }
    storage.delete(PAYWALLS_TABLE, paywall.id)
    return {deleted: true, paywallId: paywall.id}
  })
}

export function listPaywallPayments(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const paywall = getPaywall(requiredText(request.paywallId, 'paywallId', 128))
    const pageSize = normalizePageSize(request.limit)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(UNLOCKS_TABLE, {
      filters: {paywall_id: paywall.id},
      sortBy: 'paid_at',
      descending: true,
      limit: pageSize,
      offset: (page - 1) * pageSize
    })
    return {
      payments: response.data.map(unlock => ({
        paymentHash: unlock.payment_hash,
        amountSat: Math.trunc(Number(unlock.amount_msat || 0) / 1000),
        paidAt: unlock.paid_at
      })),
      total: response.total,
      page,
      limit: pageSize
    }
  })
}

export function listWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function listCurrencies(_requestJson) {
  return runJson(() => ({currencies: safeCurrencies()}))
}

// Public exports: visitors see the price, never the protected URL.

export function getPublicPaywall(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const paywallId = requiredText(request.paywallId, 'paywallId', 128)
    const paywall = storage.getPublic(PAYWALLS_TABLE, paywallId)
    if (!paywall) throw new Error('Paywall not found.')
    return {paywall: publicPaywall(paywall)}
  })
}

// Runs with the paywall owner's context (ownerContext route), but the caller
// is an anonymous visitor: only the configured price can be invoiced.
export function createPaywallInvoice(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const paywall = getPaywall(requiredText(request.paywallId, 'paywallId', 128))
    const amount =
      request.amount === undefined || request.amount === null || request.amount === ''
        ? paywall.amount
        : normalizeAmount(request.amount, paywall.currency)
    if (amount < paywall.amount) {
      throw new Error(`Minimum amount is ${paywall.amount} ${paywall.currency}.`)
    }

    const invoice = wallet.createInvoicePublic({
      sourceId: paywall.id,
      amount,
      currency: paywall.currency,
      memo: paywall.memo,
      // The issued price travels with the invoice, so recordPayment can check
      // it without depending on the current price.
      extra: {paywallId: paywall.id, amount, currency: paywall.currency}
    })
    return {
      paymentHash: invoice.paymentHash,
      paymentRequest: invoice.paymentRequest,
      amount,
      currency: paywall.currency
    }
  })
}

// Also an ownerContext route. Knowing a paid payment hash for this paywall is
// the visitor's proof of purchase, like in the original Paywall extension.
export function checkPaywallPayment(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const paywall = getPaywall(requiredText(request.paywallId, 'paywallId', 128))
    const paymentHash = normalizePaymentHash(request.paymentHash)
    const unlock = storage.get(UNLOCKS_TABLE, unlockId(paymentHash))
    if (!unlock || unlock.paywall_id !== paywall.id || unlock.paid !== true) {
      return {paid: false}
    }
    return {paid: true, url: paywall.url, remembers: paywall.remembers === true}
  })
}

// Event export: core only dispatches invoices created by this extension's
// create_invoice_public call, bound to the paywall row and its owner.
export function recordPayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    if (event.extension !== EXTENSION_ID) {
      return {recorded: false, reason: 'not a paywall invoice'}
    }
    if (event.pending === true || (event.status && event.status !== 'success')) {
      return {recorded: false, reason: 'payment not settled'}
    }

    const paymentHash = normalizePaymentHash(event.paymentHash)
    const extra = objectValue(event.extra) || {}
    const paywallId = requiredText(extra.source_id, 'source_id', 128)
    const invoiceExtra = objectValue(extra[`extra_${EXTENSION_ID}`]) || {}
    if (invoiceExtra.paywallId && invoiceExtra.paywallId !== paywallId) {
      return {recorded: false, reason: 'paywall mismatch'}
    }

    const paywall = storage.get(PAYWALLS_TABLE, paywallId)
    if (!paywall) {
      return {recorded: false, reason: 'paywall not found'}
    }

    // Defence in depth: core already binds the event to this paywall's owner
    // context, but a host regression should not unlock on the wrong wallet or
    // on less than the invoiced price.
    if (event.walletId && event.walletId !== paywall.wallet_id) {
      return {recorded: false, reason: 'wallet mismatch'}
    }
    const amountMsat = Math.abs(Math.trunc(Number(event.amount || 0)))
    const shortfall = issuedAmountShortfall(invoiceExtra, extra, amountMsat)
    if (shortfall) {
      system.log(`${EXTENSION_ID}: payment for ${paywall.id} rejected: ${shortfall}`, 'warning')
      return {recorded: false, reason: shortfall}
    }

    const id = unlockId(paymentHash)
    const existing = storage.get(UNLOCKS_TABLE, id)
    if (existing && existing.paid === true) {
      return {recorded: true, alreadyRecorded: true}
    }

    // The id is derived from the payment hash, so duplicate events overwrite
    // the same row instead of creating a second unlock.
    storage.set(UNLOCKS_TABLE, {
      id,
      paywall_id: paywall.id,
      payment_hash: paymentHash,
      amount_msat: amountMsat,
      paid: true,
      paid_at: system.now()
    })
    system.log(`${EXTENSION_ID}: unlocked paywall ${paywall.id}`)
    return {recorded: true}
  })
}

// Compares the payment with the price stored on the invoice at issue time.
// Invoices issued by v0.1.x carry no price and are accepted as before.
function issuedAmountShortfall(invoiceExtra, paymentExtra, amountMsat) {
  const issued = Number(invoiceExtra.amount)
  if (invoiceExtra.amount === undefined || !Number.isFinite(issued)) return ''
  if (issued <= 0) return 'invoice amount is zero'
  const currency = cleanText(invoiceExtra.currency, 8) || 'sat'
  if (currency === 'sat') {
    return amountMsat >= Math.round(issued * 1000) ? '' : 'amount below invoice'
  }
  // Core (calculate_fiat_amounts) records fiat_currency/fiat_amount when the
  // invoice currency differs from the wallet's, otherwise only
  // wallet_fiat_currency/wallet_fiat_amount, both rounded to 3 decimals.
  let recordedCurrency = paymentExtra.fiat_currency
  let recordedAmount = paymentExtra.fiat_amount
  if (recordedCurrency === undefined) {
    if (sameCurrency(paymentExtra.wallet_fiat_currency, currency)) {
      recordedCurrency = paymentExtra.wallet_fiat_currency
      recordedAmount = paymentExtra.wallet_fiat_amount
    } else {
      return ''
    }
  }
  if (!sameCurrency(recordedCurrency, currency)) return 'currency mismatch'
  return Number(recordedAmount) >= issued - 0.0005 ? '' : 'amount below invoice'
}

function sameCurrency(a, b) {
  return typeof a === 'string' && a.toUpperCase() === String(b).toUpperCase()
}

function paywallFields(request) {
  const walletId = requiredText(request.walletId, 'walletId', 128)
  const userWallet = wallet.listUserWallets().find(item => item.id === walletId)
  if (!userWallet) throw new Error('Wallet not found.')

  const currency = normalizeCurrency(request.currency)
  return {
    wallet_id: userWallet.id,
    wallet_name: cleanText(userWallet.name, 120),
    url: normalizeUrl(request.url),
    memo: requiredText(request.memo, 'memo', 200),
    description: cleanText(request.description, 2000),
    amount: normalizeAmount(request.amount, currency),
    currency,
    remembers: request.remembers === true
  }
}

function getPaywall(paywallId) {
  const paywall = storage.get(PAYWALLS_TABLE, paywallId)
  if (!paywall) throw new Error('Paywall not found.')
  return paywall
}

function privatePaywall(paywall) {
  return {
    ...publicPaywall(paywall),
    walletId: paywall.wallet_id,
    walletName: paywall.wallet_name,
    url: paywall.url,
    createdAt: paywall.created_at,
    updatedAt: paywall.updated_at
  }
}

function publicPaywall(paywall) {
  return {
    id: paywall.id,
    memo: paywall.memo,
    description: paywall.description || '',
    amount: Number(paywall.amount),
    currency: paywall.currency,
    remembers: paywall.remembers === true
  }
}

function unlockId(paymentHash) {
  return `unl_${paymentHash}`
}

function normalizePaymentHash(value) {
  const paymentHash = cleanText(value, 64).toLowerCase()
  if (!PAYMENT_HASH_PATTERN.test(paymentHash)) {
    throw new Error('paymentHash must be a 64 character hex string.')
  }
  return paymentHash
}

function normalizeUrl(value) {
  const url = requiredText(value, 'url', MAX_URL_LENGTH)
  if (!/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url)) {
    throw new Error('url must start with http:// or https://.')
  }
  return url
}

function normalizeAmount(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be greater than zero.')
  }
  if (currency === 'sat') {
    if (!Number.isInteger(amount)) throw new Error('sat amounts must be whole numbers.')
    return amount
  }
  const rounded = Math.round(amount * 100) / 100
  if (rounded <= 0) throw new Error('amount must be at least 0.01.')
  return rounded
}

function normalizeCurrency(value) {
  const currency = cleanText(value, 8) || 'sat'
  if (currency === 'sat') return currency
  const upper = currency.toUpperCase()
  if (!safeCurrencies().includes(upper)) {
    throw new Error(`Unsupported currency: ${currency}.`)
  }
  return upper
}

function safeCurrencies() {
  try {
    return utils.currencies.list()
  } catch (error) {
    system.log(`${EXTENSION_ID}: currency list unavailable: ${error}`, 'warning')
    return ['sat']
  }
}

function normalizePageSize(value) {
  const size = Math.trunc(Number(value) || 25)
  return Math.min(Math.max(size, 1), 100)
}

function normalizePage(value) {
  const page = Math.trunc(Number(value) || 1)
  return Math.max(page, 1)
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    system.log(`${EXTENSION_ID}: ${message}`, 'warning')
    return JSON.stringify({ok: false, error: message})
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.')
  }
  return parsed
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return ''
  return String(value).trim().slice(0, maxLength)
}

function requiredText(value, field, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(`${field} is required.`)
  return text
}
