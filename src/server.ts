import express from "express"
import bodyParser from "body-parser"
import path from "path"
import { config, DEFAULT_ACCOUNT_NUMBER, DEFAULT_ACCOUNT_NUMBER2, SECONDARY_API_ACCOUNTS, ALL_MONITORED_ACCOUNTS } from "./config"
import { logger, logTrade, logError, logApp } from "./utils/logger"
import { webhookLogger } from "./utils/webhookLogger"

// Create a tradeLogger compatibility function for existing code
const tradeLogger = {
  info: (message: string) => {
    // Extract basic info from message for clean logging
    console.log(`TRADE: ${message}`);
  },
  warn: (message: string) => {
    console.log(`TRADE_WARN: ${message}`);
  },
  error: (message: string) => {
    console.log(`TRADE_ERROR: ${message}`);
  },
  debug: (message: string) => { } // No-op for debug
}
import { webSocketManager } from "./utils/webSocketManager"
import { setTimeout as setTimeoutPromise } from "timers/promises"
import { getActiveOrders, getClosedOrders, getAccountStatus, placeTrade, getDepositHistory, getAccessToken as getSimpleFXAccessToken } from "./services/simplefx"
import {
  initializeDatabase,
  upsertOrder,
  getOrders,
  getRecentOrders,
  updateMaxSize,
  getAccountSettings,
  setAccountTradingMode,
  updateSessionSettings,
  getCurrentTradingSession,
  updateExclusiveMode,
  orderExistsWithAlertId,
  getWebhookOutcomes,
  db
} from "./database"
import basicAuth from "express-basic-auth"
import https from "https"
import fs from "fs"
import WebSocket from "ws"
import cron from "node-cron"
import axios from "axios"
import { Mutex } from "async-mutex"
import { Readable } from 'stream';
import { webhookQueue } from "./utils/webhookQueue"

const pendingOrders = new Map<string, Set<string>>()
const MIN_SL_DISTANCE = 0.0002 // 2 pips minimum distance
const loginMutexes = new Map<string, Mutex>()

function getPipValue(symbol: string): number {
  const cleanSymbol = symbol.replace(/^[A-Z]+:/, '').toUpperCase(); // Remove exchange prefix

  // Index symbols use 1 point = 1 pip
  if (cleanSymbol.includes('US100') || cleanSymbol.includes('US500') || cleanSymbol.includes('US30') ||
    cleanSymbol.includes('GER40') || cleanSymbol.includes('UK100') || cleanSymbol.includes('NAS100') ||
    cleanSymbol.includes('SPX500') || cleanSymbol.includes('TECH100')) {
    return 1;
  }

  // JPY pairs use 0.01
  if (cleanSymbol.includes('JPY')) {
    return 0.01;
  }

  // Default forex pairs use 0.0001
  return 0.0001;
}

function getMutex(loginNumber: string): Mutex {
  if (!loginMutexes.has(loginNumber)) {
    loginMutexes.set(loginNumber, new Mutex())
  }
  return loginMutexes.get(loginNumber)!
}

// Helper function to determine if an account is LIVE
function isLiveAccount(loginNumber: string | number | undefined): boolean {
  if (loginNumber === undefined || loginNumber === null) {
    return false // or handle this case as appropriate for your application
  }
  const loginString = loginNumber.toString()
  return ["3979960", "247341", "3979937"].includes(loginString)
}

async function getTotalOpenVolume(loginNumber: string): Promise<number> {
  try {
    const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(loginNumber)
    const activeOrders = await getActiveOrders(
      loginNumber,
      isLiveAccount(loginNumber) ? "LIVE" : "DEMO",
      useSecondaryApi,
    )
    return activeOrders.data.marketOrders.reduce((sum: number, order: any) => {
      return sum + (order.volume || 0)
    }, 0)
  } catch (error: any) {
    // REMOVED DANGEROUS FALLBACK: Never switch accounts for trading volume checks
    // Each webhook must only operate on its specified account
    logError.api('getTotalOpenVolume', `Failed for account ${loginNumber}: ${error.message}`, loginNumber);
    throw error
  }
}

async function getOrdersCountBySide(loginNumber: string, side: string): Promise<number> {
  try {
    const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(loginNumber)
    const activeOrders = await getActiveOrders(
      loginNumber,
      isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
      useSecondaryApi,
    )

    const normalizedTargetSide = side === "S" ? "SELL" : side === "B" ? "BUY" : side.toUpperCase()
    const matchingOrders = activeOrders.data.marketOrders.filter((order: any) => {
      const orderSide = order.side ? order.side.toUpperCase() : ""
      return orderSide === normalizedTargetSide
    })

    return matchingOrders.length
  } catch (error: any) {
    // REMOVED DANGEROUS FALLBACK: Never switch accounts for trading order checks
    // Each webhook must only operate on its specified account
    logError.api('getOrdersCountBySide', `Failed for account ${loginNumber}: ${error.message}`, loginNumber);
    throw error
  }
}

// Helper function to get the total number of open orders
async function getTotalOpenOrdersCount(loginNumber: string): Promise<number> {
  try {
    const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(loginNumber)
    const activeOrders = await getActiveOrders(
      loginNumber,
      isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
      useSecondaryApi,
    )
    return activeOrders.data.marketOrders.length
  } catch (error: any) {
    // REMOVED DANGEROUS FALLBACK: Never switch accounts for trading order checks
    // Each webhook must only operate on its specified account
    logError.api('getTotalOpenOrdersCount', `Failed for account ${loginNumber}: ${error.message}`, loginNumber);
    throw error
  }
}

async function getTotalSideVolume(loginNumber: string, side: string): Promise<number> {
  try {
    const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(loginNumber)
    const activeOrders = await getActiveOrders(
      loginNumber,
      isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
      useSecondaryApi,
    )
    return activeOrders.data.marketOrders.reduce((sum: number, order: any) => {
      const orderSide = order.side ? order.side.toUpperCase() : ""
      const targetSide = side.toUpperCase()
      return orderSide === targetSide ? sum + (order.volume || 0) : sum
    }, 0)
  } catch (error: any) {
    // REMOVED DANGEROUS FALLBACK: Never switch accounts for trading volume checks
    // Each webhook must only operate on its specified account
    logError.api('getTotalSideVolume', `Failed for account ${loginNumber}: ${error.message}`, loginNumber);
    throw error
  }
}

// Function to calculate duration in minutes
function calculateDurationInMinutes(openTime: number, closeTime: number): number {
  return Math.round((closeTime - openTime) / (1000 * 60))
}

function calculateStopLoss(
  action: string,
  marketPrice: number,
  stopLossPips: number,
  obReferencePrice: number | null,
  considerObReference: boolean,
  symbol: string,
): number {
  const basePrice = considerObReference && obReferencePrice !== null ? obReferencePrice : marketPrice;
  const pipValue = getPipValue(symbol);

  // For US100, ensure minimum distance is at least 10 points
  const minDistance = symbol.includes('US100') ? 10 : (pipValue === 1 ? 5 : MIN_SL_DISTANCE);

  let rawStopLoss = action === "B"
    ? basePrice - (stopLossPips * pipValue)
    : basePrice + (stopLossPips * pipValue);

  // Ensure minimum distance from market price
  if (action === "B") {
    rawStopLoss = Math.min(rawStopLoss, marketPrice - minDistance);
  } else {
    rawStopLoss = Math.max(rawStopLoss, marketPrice + minDistance);
  }

  // For indices like US100, use 2 decimal places
  const decimals = pipValue === 1 ? 2 : 5;
  return Number(rawStopLoss.toFixed(decimals));
}

function roundPrice(price: number, decimals = 5): number {
  return Number(price.toFixed(decimals))
}

function isOrderPending(loginNumber: string, side: string): boolean {
  const key = `${loginNumber}`
  const pendingSides = pendingOrders.get(key)
  return pendingSides ? pendingSides.has(side.toUpperCase()) : false
}

function addPendingOrder(loginNumber: string, side: string): void {
  const key = `${loginNumber}`
  if (!pendingOrders.has(key)) {
    pendingOrders.set(key, new Set())
  }
  pendingOrders.get(key)!.add(side.toUpperCase())
}

function removePendingOrder(loginNumber: string, side: string): void {
  const key = `${loginNumber}`
  const pendingSides = pendingOrders.get(key)
  if (pendingSides) {
    pendingSides.delete(side.toUpperCase())
    if (pendingSides.size === 0) {
      pendingOrders.delete(key)
    }
  }
}

async function getLatestSignalParams(loginNumber: string) {
  try {
    const db = await initializeDatabase();
    const result = await db.get(`
      SELECT
        symbol, 
        timeframe, 
        volume as size, 
        max_size as maxSize,
        real_tp_pips as takeProfit, 
        real_sl_pips as stopLoss, 
        maxobalert as maxObAlert, 
        filterFractal as fractal, 
        fvgDistance as fvgDistance,
        findObType as findObType,
        filterFvgs as filterFvgs,
        ob_reference_price as obReferencePrice,
        consider_ob_reference as considerObReference,
        alert_id as alertId,
        lineHeight as lineHeight,
        exchange as exchange,
        reality as reality
      FROM sfx_historical_orders 
      WHERE login = ? AND open_time IS NOT NULL
      ORDER BY open_time DESC 
      LIMIT 1
    `, loginNumber);

    return result || null;
  } catch (error) {
    logError.system('getLatestSignalParams', `Error for account ${loginNumber}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Places a trade with retry logic
 * @param side The trade side (BUY or SELL)
 * @param amount The trade amount
 * @param loginNumber The account login number
 * @param takeProfitPips The take profit in pips
 * @param stopLossPips The stop loss in pips
 * @param obReferencePrice The order block reference price
 * @param considerObReference Whether to use the OB reference price
 * @param reality Whether the account is LIVE or DEMO
 * @param symbol The trading symbol
 * @param exchange The exchange (e.g., simplefx)
 * @param useSecondaryApi Whether to use the secondary API key
 * @param maxRetries Number of retry attempts
 * @returns The trade result
 */
export async function placeTradeWithRetry(
  side: string,
  amount: number,
  loginNumber: string,
  takeProfitPips: number,
  stopLossPips: number | null,
  obReferencePrice: number,
  considerObReference: boolean,
  reality: string,
  symbol: string,
  exchange: string,
  useSecondaryApi: boolean,
  maxRetries: number = 3,
): Promise<any> {
  const instrumentSpecs = getInstrumentSpecs(symbol);
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Get fresh market data using WebSocketManager with retry logic
      const marketData = await webSocketManager.getMarketDataWithRetry(symbol);

      if (marketData.isStale) {
        throw new Error(`Market price too old for ${symbol} (age: ${(Date.now() - marketData.timestamp) / 1000}s) - WebSocket may be disconnected`);
      }

      // Calculate entry price
      const entryPrice = (side === "BUY" || side === "B") ? marketData.ask : marketData.bid;

      // Log market data and calculation inputs
      const marketLog = `MARKET_DATA: ${symbol} | Bid: ${marketData.bid} | Ask: ${marketData.ask} | Entry: ${entryPrice} | Side: ${side} | TP_Pips: ${takeProfitPips} | SL_Pips: ${stopLossPips} | Account: ${loginNumber}`;
      logTrade.placed('CALC', symbol, side, amount, entryPrice, loginNumber);
      tradeLogger.info(marketLog);

      // Calculate TP/SL prices
      const { takeProfitPrice, stopLossPrice } = calculatePriceLevels(
        side,
        entryPrice,
        takeProfitPips,
        stopLossPips,
        instrumentSpecs,
      );

      // Log calculated price levels
      const priceLog = `PRICE_CALC: ${symbol} | Entry: ${entryPrice} | TP_Price: ${takeProfitPrice} | SL_Price: ${stopLossPrice} | TP_Distance: ${Math.abs(takeProfitPrice - entryPrice) / instrumentSpecs.pipValue} ${instrumentSpecs.type === 'index' ? 'points' : 'pips'} | SL_Distance: ${stopLossPrice ? Math.abs(stopLossPrice - entryPrice) / instrumentSpecs.pipValue : 'N/A'} ${instrumentSpecs.type === 'index' ? 'points' : 'pips'} | Account: ${loginNumber}`;
      tradeLogger.info(priceLog);

      // Detailed price calculation data for debugging
      const priceCalculationData = {
        marketData: {
          bid: marketData.bid,
          ask: marketData.ask,
          spread: marketData.ask - marketData.bid,
          entryPrice: entryPrice
        },
        originalPips: {
          takeProfit: takeProfitPips,
          stopLoss: stopLossPips
        },
        calculatedPrices: {
          takeProfitPrice: takeProfitPrice,
          stopLossPrice: stopLossPrice
        },
        instrumentSpecs: instrumentSpecs,
        side: side
      };
      logTrade.priceCalculation(symbol, loginNumber, priceCalculationData);

      // Validate price levels
      const validation = validatePriceLevels(side, entryPrice, takeProfitPrice, stopLossPrice, instrumentSpecs);
      if (!validation.valid) {
        logError.trade(symbol, side, `Price validation failed: ${validation.error}`, loginNumber);
        throw new Error(`Invalid price levels: ${validation.error}`);
      }

      // Place trade
      const result = await placeTrade(
        side,
        amount,
        loginNumber,
        takeProfitPrice,
        stopLossPrice,
        reality,
        symbol,
        useSecondaryApi,
      );

      return result;
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = attempt * 2000;
        await setTimeoutPromise(delay);
      }
    }
  }

  logError.trade(symbol, side, lastError.message, loginNumber);
  throw lastError;
}

export function getInstrumentSpecs(symbol: string) {
  // Clean symbol from exchange prefix (e.g., "SIMPLEFX:US100" -> "US100")
  const cleanSymbol = symbol.replace(/^[A-Z]+:/, '').toUpperCase();

  const forexPairs = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY"];
  const indices = ["US100", "US30", "NAS100", "SPX500", "GER40", "UK100", "JPN225", "US500", "TECH100"];

  if (indices.includes(cleanSymbol)) {
    return {
      type: "index",
      pipValue: 1,
      minDistance: 20,     // Increased from 5 to 20 points for indices
      decimals: 1,         // SimpleFX uses 1 decimal for indices
      minTPDistance: 20,   // Minimum TP distance in points
      minSLDistance: 20,   // Minimum SL distance in points
    };
  } else if (forexPairs.includes(cleanSymbol)) {
    const isJPYPair = cleanSymbol.includes("JPY");
    return {
      type: "forex",
      pipValue: isJPYPair ? 0.01 : 0.0001,
      minDistance: isJPYPair ? 0.1 : 0.001,  // 10 pips minimum
      decimals: isJPYPair ? 3 : 5,
      minTPDistance: 10,   // Minimum 10 pips
      minSLDistance: 10,   // Minimum 10 pips
    };
  } else {
    // Default to forex
    return {
      type: "forex",
      pipValue: 0.0001,
      minDistance: 0.001,
      decimals: 5,
      minTPDistance: 10,
      minSLDistance: 10,
    };
  }
}

function calculatePriceLevels(
  side: string,
  entryPrice: number,
  takeProfitPips: number,
  stopLossPips: number | null,
  specs: any,
) {
  const isBuy = side === "BUY" || side === "B";

  // Calculate TP/SL prices directly from entry price
  let takeProfitPrice: number;
  let stopLossPrice: number | null = null;

  if (isBuy) {
    takeProfitPrice = entryPrice + (takeProfitPips * specs.pipValue);
    if (stopLossPips) {
      stopLossPrice = entryPrice - (stopLossPips * specs.pipValue);
    }
  } else {
    takeProfitPrice = entryPrice - (takeProfitPips * specs.pipValue);
    if (stopLossPips) {
      stopLossPrice = entryPrice + (stopLossPips * specs.pipValue);
    }
  }

  // Format prices properly
  if (specs.type === "index") {
    takeProfitPrice = Math.round(takeProfitPrice * 10) / 10;
    if (stopLossPrice) stopLossPrice = Math.round(stopLossPrice * 10) / 10;
  } else {
    takeProfitPrice = Number(takeProfitPrice.toFixed(specs.decimals));
    if (stopLossPrice) stopLossPrice = Number(stopLossPrice.toFixed(specs.decimals));
  }

  return { takeProfitPrice, stopLossPrice };
}

function validatePriceLevels(
  side: string,
  entryPrice: number,
  takeProfitPrice: number,
  stopLossPrice: number | null,
  specs: any
): { valid: boolean; error?: string } {
  const isBuy = side === "BUY" || side === "B";

  // Calculate distances in pips/points
  const tpDistance = Math.abs(takeProfitPrice - entryPrice) / specs.pipValue;
  const slDistance = stopLossPrice ? Math.abs(stopLossPrice - entryPrice) / specs.pipValue : null;

  // Check minimum distances
  const minRequired = specs.type === "index" ? 20 : 10;

  if (tpDistance < minRequired) {
    return {
      valid: false,
      error: `TP distance (${tpDistance.toFixed(1)} ${specs.type === 'index' ? 'points' : 'pips'}) is below minimum ${minRequired}`
    };
  }

  if (slDistance !== null && slDistance < minRequired) {
    return {
      valid: false,
      error: `SL distance (${slDistance.toFixed(1)} ${specs.type === 'index' ? 'points' : 'pips'}) is below minimum ${minRequired}`
    };
  }

  // Validate direction
  if (isBuy) {
    if (takeProfitPrice <= entryPrice) {
      return { valid: false, error: "BUY TP must be above entry price" };
    }
    if (stopLossPrice && stopLossPrice >= entryPrice) {
      return { valid: false, error: "BUY SL must be below entry price" };
    }
  } else {
    if (takeProfitPrice >= entryPrice) {
      return { valid: false, error: "SELL TP must be below entry price" };
    }
    if (stopLossPrice && stopLossPrice <= entryPrice) {
      return { valid: false, error: "SELL SL must be above entry price" };
    }
  }

  return { valid: true };
}



const app = express()

// Middleware
app.use(bodyParser.json())
app.use(bodyParser.text())

// Set proper MIME types for static files
app.use(
  express.static(path.join(__dirname, "../public"), {
    setHeaders: (res, path) => {
      if (path.endsWith(".js")) {
        res.setHeader("Content-Type", "application/javascript")
      }
    },
  }),
)

// Novo middleware global
app.use((req, res, next) => {
  console.log(`Requisição recebida: ${req.method} ${req.url}`)
  next() // Chama o próximo middleware ou rota
})

// Basic authentication middleware
const MainAuth = basicAuth({
  users: { [config.STATUS_AUTH.USERNAME]: config.STATUS_AUTH.PASSWORD },
  challenge: true,
  realm: "WingTradeBot Status",
})

const SecondaryAuth = basicAuth({
  users: { [config.STATUS_AUTH2.USERNAME]: config.STATUS_AUTH2.PASSWORD },
  challenge: true,
  realm: "WingTradeBot Status (Secondary)",
})

// WebSocket connection is now managed on-demand by WebSocketManager
// No persistent connection needed

// Initialize database
initializeDatabase()

// Serve index.html for the root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"))
})

// Serve index2 for /status2 route - uses MainAuth and primary API key
app.get("/status2", MainAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index2.html"))
})

// Serve index.html for /status route - uses SecondaryAuth and secondary API key
app.get(["/status", "/status/:loginNumber"], SecondaryAuth, (req, res) => {
  const indexPath = path.join(__dirname, "../public/index.html")
  res.sendFile(indexPath, (err) => {
    if (err) {
      logError.system('serve_file', `Error sending index.html: ${err.message}`)
      res.status(500).send("Internal Server Error")
    }
  })
})

// API endpoint to list all accounts accessible by each API key
app.get("/api/list-accounts", async (req, res) => {
  try {
    // Test primary API key
    let primaryAccounts = []
    try {
      const primaryToken = await getAccessToken(false)
      const response = await axios.get(`${config.SIMPLEFX_API_URL}/accounts`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${primaryToken}`,
        },
      })
      primaryAccounts = response.data.data.accounts
    } catch (error: any) {
      logError.api('accounts', error.message)
    }

    // Test secondary API key
    let secondaryAccounts = []
    try {
      const secondaryToken = await getAccessToken(true)
      const response = await axios.get(`${config.SIMPLEFX_API_URL}/accounts`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secondaryToken}`,
        },
      })
      secondaryAccounts = response.data.data.accounts
    } catch (error: any) {
      logError.api('accounts', error.message)
    }

    res.json({
      primaryApiAccounts: primaryAccounts,
      secondaryApiAccounts: secondaryAccounts,
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// Test endpoint to verify API keys
app.get("/api/test-keys", async (req, res) => {
  try {
    // Test primary API key
    let primaryResult: any
    try {
      const primaryResponse = await axios.post(`${config.SIMPLEFX_API_URL}/auth/key`, {
        clientId: config.SIMPLEFX_API_KEY,
        clientSecret: config.SIMPLEFX_API_SECRET,
      })
      primaryResult = { success: true, token: primaryResponse.data.data.token.substring(0, 10) + "..." }
    } catch (error: any) {
      primaryResult = { success: false, error: error.message }
    }

    // Test secondary API key
    let secondaryResult: any
    try {
      const secondaryResponse = await axios.post(`${config.SIMPLEFX_API_URL}/auth/key`, {
        clientId: config.SIMPLEFX_API_KEY2,
        clientSecret: config.SIMPLEFX_API_SECRET2,
      })
      secondaryResult = { success: true, token: secondaryResponse.data.data.token.substring(0, 10) + "..." }
    } catch (error: any) {
      secondaryResult = { success: false, error: error.message }
    }

    res.json({
      primary: primaryResult,
      secondary: secondaryResult,
    })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// Test endpoint to verify account access
app.get("/api/test-accounts", async (req, res) => {
  try {
    // Define the type for results to allow string indexing
    const results: {
      [key: string]: {
        success: boolean
        ordersCount?: number
        error?: string
        api: string
      }
    } = {}

    const accounts = ALL_MONITORED_ACCOUNTS

    for (const account of accounts) {
      const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(account)
      try {
        const response = await getActiveOrders(account, isLiveAccount(account) ? "LIVE" : "DEMO", useSecondaryApi)
        results[account] = {
          success: true,
          ordersCount: response.data.marketOrders.length,
          api: useSecondaryApi ? "secondary" : "primary",
        }
      } catch (error: any) {
        results[account] = {
          success: false,
          error: error.message,
          api: useSecondaryApi ? "secondary" : "primary",
        }
      }
    }

    res.json(results)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// New API endpoint for account settings
app.get("/api/account-settings/:loginNumber", SecondaryAuth, async (req, res) => {
  try {
    const loginNumber = req.params.loginNumber
    if (!loginNumber) {
      return res.status(400).json({ error: "Login number is required" })
    }

    const settings = await getAccountSettings(loginNumber)
    res.json(settings)
  } catch (error: any) {
    logError.system('getAccountSettings', error.message)
    res.status(500).json({ error: "Internal server error" })
  }
})

app.post("/api/account-settings/:loginNumber", SecondaryAuth, async (req, res) => {
  try {
    const { loginNumber } = req.params
    const { tradingMode, exclusive_mode, asia_session, london_session, new_york_session, limbo_session } = req.body

    if (!loginNumber) {
      return res.status(400).json({ error: "Login number is required" })
    }

    const updatedSettings = null

    // Handle trading mode update if provided
    if (tradingMode) {
      if (!["NORMAL", "BUY_ONLY", "SELL_ONLY"].includes(tradingMode)) {
        return res.status(400).json({ error: "Invalid trading mode. Must be NORMAL, BUY_ONLY, or SELL_ONLY" })
      }

      const success = await setAccountTradingMode(loginNumber, tradingMode)

      if (!success) {
        return res.status(500).json({ error: "Failed to update trading mode" })
      }

      logApp.modeChange(loginNumber, tradingMode)
    }

    // Handle exclusive mode update if provided
    if (exclusive_mode !== undefined) {
      const success = await updateExclusiveMode(loginNumber, exclusive_mode === 1 || exclusive_mode === true)

      if (!success) {
        return res.status(500).json({ error: "Failed to update exclusive mode" })
      }

      logApp.modeChange(loginNumber, `exclusive_mode_${exclusive_mode ? 'enabled' : 'disabled'}`)
    }

    // Handle session settings update if any provided
    const sessionSettings: any = {}
    if (asia_session !== undefined) sessionSettings.asia_session = asia_session ? 1 : 0
    if (london_session !== undefined) sessionSettings.london_session = london_session ? 1 : 0
    if (new_york_session !== undefined) sessionSettings.new_york_session = new_york_session ? 1 : 0
    if (limbo_session !== undefined) sessionSettings.limbo_session = limbo_session ? 1 : 0

    if (Object.keys(sessionSettings).length > 0) {
      const updatedSettings = await updateSessionSettings(loginNumber, sessionSettings)
      logApp.modeChange(loginNumber, 'session_settings_updated')
    }

    // Return updated settings
    const settings = await getAccountSettings(loginNumber)
    res.json(settings)
  } catch (error: any) {
    logError.system('updateAccountSettings', error.message)
    res.status(500).json({ error: "Internal server error" })
  }
})

app.get("/api/statistics/:accountId", async (req, res) => {
  try {
    const accountId = req.params.accountId
    const { startDate, endDate } = req.query
    const db = await initializeDatabase()

    // First try to get account from accounts table
    const account = await db.get("SELECT * FROM account_settings WHERE login = ?", accountId)

    // If account is not found, create default settings
    let accountType = "DEMO"
    let useSecondaryApi = false

    if (account) {
      console.log(`Account settings for ${accountId}:`, account)
      accountType = account.account_type || "DEMO"
      useSecondaryApi = account.use_secondary_api === 1
    } else {
      console.log(`No account found for ID ${accountId}, using default settings`)
      // For specific live accounts, set appropriate values
      if (isLiveAccount(accountId)) {
        accountType = "LIVE"
      }
      if (SECONDARY_API_ACCOUNTS.includes(accountId)) {
        useSecondaryApi = true
      }
    }

    // Declare statistics and monthlyData variables
    const statistics: any = {
      asia: {
        pnl: 0,
        orders: 0,
        wins: 0,
        losses: 0,
        totalProfit: 0,
        totalLoss: 0,
        totalDuration: 0,
        avgDuration: 0,
        winRate: 0,
        avgProfitPerTrade: 0,
        avgLossPerTrade: 0,
        riskRewardRatio: 0,
        label: "Asia Session (21:00-05:00 BRT)",
      },
      london: {
        pnl: 0,
        orders: 0,
        wins: 0,
        losses: 0,
        totalProfit: 0,
        totalLoss: 0,
        totalDuration: 0,
        avgDuration: 0,
        winRate: 0,
        avgProfitPerTrade: 0,
        avgLossPerTrade: 0,
        riskRewardRatio: 0,
        label: "London Session (05:00-10:00 BRT)",
      },
      newYork: {
        pnl: 0,
        orders: 0,
        wins: 0,
        losses: 0,
        totalProfit: 0,
        totalLoss: 0,
        totalDuration: 0,
        avgDuration: 0,
        winRate: 0,
        avgProfitPerTrade: 0,
        avgLossPerTrade: 0,
        riskRewardRatio: 0,
        label: "New York Session (10:00-18:00 BRT)",
      },
      limbo: {
        pnl: 0,
        orders: 0,
        wins: 0,
        losses: 0,
        totalProfit: 0,
        totalLoss: 0,
        totalDuration: 0,
        avgDuration: 0,
        winRate: 0,
        avgProfitPerTrade: 0,
        avgLossPerTrade: 0,
        riskRewardRatio: 0,
        label: "Limbo Session (18:00-21:00 BRT)",
      },
      total: {
        pnl: 0,
        orders: 0,
        wins: 0,
        losses: 0,
        totalProfit: 0,
        totalLoss: 0,
        totalDuration: 0,
        avgDuration: 0,
        winRate: 0,
        avgProfitPerTrade: 0,
        avgLossPerTrade: 0,
        riskRewardRatio: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        stdDeviation: 0,
        ulcerIndex: 0,
        upi: 0,
      },
    }

    const monthlyData: { [key: string]: { pnl: number; orders: number; wins: number; winRate: number } } = {}

    // Initialize variables
    const profits: number[] = []
    let balance = 0
    let maxBalance = 0
    let maxDrawdown = 0

    // We'll need to handle pagination to get all orders
    let allOrders: any[] = []
    let page = 1
    let hasMoreOrders = true
    const processedOrderIds = new Set() // Add this to track processed orders

    console.log(
      `Fetching closed orders for account ${accountId} (${accountType}) using ${useSecondaryApi ? "secondary" : "primary"} API`,
    )

    while (hasMoreOrders) {
      try {
        const closedOrdersResponse = await getClosedOrders(
          accountId,
          accountType,
          useSecondaryApi,
          page,
          100, // Fetch 100 orders per page
        )

        const orders = closedOrdersResponse.data.marketOrders || []
        console.log(`Received ${orders.length} orders on page ${page}`)

        if (orders.length === 0) {
          hasMoreOrders = false
        } else {
          // Filter orders by date if needed and check for duplicates
          const filteredOrders = orders.filter((order: any) => {
            if (!order.closeTime || processedOrderIds.has(order.id.toString())) return false

            // Add this order ID to processed set
            processedOrderIds.add(order.id.toString())

            const orderCloseTime = order.closeTime

            if (startDate && orderCloseTime < new Date(startDate as string).getTime()) {
              return false
            }

            if (endDate) {
              const endDateTime = new Date(endDate as string)
              endDateTime.setDate(endDateTime.getDate() + 1)
              if (orderCloseTime > endDateTime.getTime()) {
                return false
              }
            }

            return true
          })

          console.log(`Filtered to ${filteredOrders.length} orders within date range`)
          allOrders = [...allOrders, ...filteredOrders]
          page++

          // If we got fewer orders than requested, we've reached the end
          if (orders.length < 100) {
            hasMoreOrders = false
          }
        }
      } catch (error) {
        logger.error(`Error fetching page ${page} of closed orders:`, error)
        hasMoreOrders = false // Stop on error
      }
    }

    console.log(`Fetched ${allOrders.length} closed orders for account ${accountId}`)

    // Helper function to calculate duration in minutes
    const calculateDurationInMinutes = (openTime: number, closeTime: number): number => {
      const durationMs = closeTime - openTime
      return Math.round(durationMs / (60 * 1000))
    }

    // Helper function to determine trading session based on timestamp (BRT)
    const getTradingSessionForTimestamp = (timestamp: number): string => {
      const date = new Date(timestamp)
      const hours = date.getUTCHours() - 3 // BRT offset

      // Adjust hours to be within 0-23 range
      const adjustedHours = hours < 0 ? hours + 24 : hours

      if (adjustedHours >= 21 || adjustedHours < 5) {
        return "asia_session"
      } else if (adjustedHours >= 5 && adjustedHours < 10) {
        return "london_session"
      } else if (adjustedHours >= 10 && adjustedHours < 18) {
        return "new_york_session"
      } else if (adjustedHours >= 18 && adjustedHours < 21) {
        return "limbo_session"
      } else {
        return "unknown_session"
      }
    }

    // Process orders for statistics
    allOrders.forEach((order: any) => {
      // Skip orders without close time or price
      if (!order.closeTime || !order.closePrice) return

      // Calculate profit
      const profit = Number.parseFloat(order.profit) || 0
      profits.push(profit)

      // Update balance and track drawdown
      balance += profit
      if (balance > maxBalance) {
        maxBalance = balance
      } else {
        const currentDrawdown = maxBalance - balance
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown
        }
      }

      // Calculate duration
      const duration =
        order.openTime && order.closeTime ? calculateDurationInMinutes(order.openTime, order.closeTime) : 0

      // Determine which session the order belongs to based on open time
      const session = getTradingSessionForTimestamp(order.openTime)

      // Update session statistics - ONLY if the session is valid
      let sessionStats
      if (session === "asia_session") {
        sessionStats = statistics.asia
      } else if (session === "london_session") {
        sessionStats = statistics.london
      } else if (session === "new_york_session") {
        sessionStats = statistics.newYork
      } else if (session === "limbo_session") {
        sessionStats = statistics.limbo
      } else {
        // Skip if session can't be determined
        // Update total stats only
        statistics.total.pnl += profit
        statistics.total.orders++
        statistics.total.totalDuration += duration

        if (profit > 0) {
          statistics.total.wins++
          statistics.total.totalProfit += profit
        } else if (profit < 0) {
          statistics.total.losses++
          statistics.total.totalLoss += Math.abs(profit)
        }

        return
      }

      // Update session stats
      sessionStats.pnl += profit
      sessionStats.orders++
      sessionStats.totalDuration += duration

      if (profit > 0) {
        sessionStats.wins++
        sessionStats.totalProfit += profit
      } else if (profit < 0) {
        sessionStats.losses++
        sessionStats.totalLoss += Math.abs(profit)
      }

      // Update total stats
      statistics.total.pnl += profit
      statistics.total.orders++
      statistics.total.totalDuration += duration

      if (profit > 0) {
        statistics.total.wins++
        statistics.total.totalProfit += profit
      } else if (profit < 0) {
        statistics.total.losses++
        statistics.total.totalLoss += Math.abs(profit)
      }

      // Track monthly performance
      const date = new Date(order.closeTime)
      const monthKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}`

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { pnl: 0, orders: 0, wins: 0, winRate: 0 }
      }

      monthlyData[monthKey].pnl += profit
      monthlyData[monthKey].orders++
      if (profit > 0) {
        monthlyData[monthKey].wins++
      }
    })

    // Calculate derived statistics
    // Session statistics
    for (const session of ["asia", "london", "newYork", "limbo", "total"] as const) {
      const stats = statistics[session]

      // Average duration
      stats.avgDuration = stats.orders > 0 ? Math.round(stats.totalDuration / stats.orders) : 0

      // Win rate
      stats.winRate = stats.orders > 0 ? (stats.wins / stats.orders) * 100 : 0

      // Average profit/loss per trade
      stats.avgProfitPerTrade = stats.wins > 0 ? stats.totalProfit / stats.wins : 0
      stats.avgLossPerTrade = stats.losses > 0 ? stats.totalLoss / stats.losses : 0

      // Risk-reward ratio
      stats.riskRewardRatio = stats.avgLossPerTrade > 0 ? stats.avgProfitPerTrade / stats.avgLossPerTrade : 0

      // Profit factor
      stats.profitFactor =
        stats.totalLoss > 0 ? stats.totalProfit / stats.totalLoss : stats.totalProfit > 0 ? Number.POSITIVE_INFINITY : 0
    }

    // Calculate standard deviation of returns
    let stdDeviation = 0
    if (profits.length > 0) {
      const mean = profits.reduce((sum, profit) => sum + profit, 0) / profits.length
      const squaredDifferences = profits.map((profit) => Math.pow(profit - mean, 2))
      const variance = squaredDifferences.reduce((sum, squaredDiff) => sum + squaredDiff, 0) / profits.length
      stdDeviation = Math.sqrt(variance)
    }

    statistics.total.maxDrawdown = maxDrawdown
    statistics.total.stdDeviation = stdDeviation

    // Calculate Ulcer Index and UPI
    let ulcerIndex = 0
    let upi = 0

    if (allOrders.length > 0) {
      // Sort orders by close time
      const sortedOrders = [...allOrders].sort((a, b) => a.closeTime - b.closeTime)

      // Build equity curve
      const equityCurve = []
      let cumulativeBalance = 0

      for (const order of sortedOrders) {
        const profit = Number.parseFloat(order.profit) || 0
        cumulativeBalance += profit
        equityCurve.push({
          time: order.closeTime,
          balance: cumulativeBalance,
        })
      }

      // Calculate drawdowns for each point in the equity curve
      let peakBalance = 0
      const drawdowns = []

      for (const point of equityCurve) {
        if (point.balance > peakBalance) {
          peakBalance = point.balance
        }

        // Calculate percentage drawdown (as a decimal)
        const drawdownPercentage = peakBalance > 0 ? (peakBalance - point.balance) / peakBalance : 0
        drawdowns.push(drawdownPercentage)
      }

      // Calculate Ulcer Index
      if (drawdowns.length > 0) {
        const sumSquaredDrawdowns = drawdowns.reduce((sum, dd) => sum + dd * dd, 0)
        ulcerIndex = Math.sqrt(sumSquaredDrawdowns / drawdowns.length)

        // Calculate UPI (Ulcer Performance Index)
        // Using the formula: (Total Return - Risk-Free Rate) / Ulcer Index
        // For simplicity, we'll use 0 as the risk-free rate

        // Calculate total return as a ratio (not percentage)
        const totalReturn = statistics.total.pnl / Math.max(1, Math.abs(statistics.total.totalLoss || 1))

        // Avoid division by zero
        upi = ulcerIndex > 0.0001 ? totalReturn / ulcerIndex : 0

        console.log("Ulcer Index calculation details:")
        console.log(`- Number of trades: ${sortedOrders.length}`)
        console.log(`- Number of drawdown points: ${drawdowns.length}`)
        console.log(`- Sum of squared drawdowns: ${sumSquaredDrawdowns}`)
        console.log(`- Ulcer Index: ${ulcerIndex}`)
        console.log(`- Total Return: ${totalReturn}`)
        console.log(`- UPI: ${upi}`)
      }
    }

    statistics.total.ulcerIndex = ulcerIndex
    statistics.total.upi = upi

    // Calculate win rates for monthly data
    Object.keys(monthlyData).forEach((month) => {
      const data = monthlyData[month]
      data.winRate = data.orders > 0 ? (data.wins / data.orders) * 100 : 0
    })

    // Sort monthly data by date
    const sortedMonthlyData = Object.entries(monthlyData)
      .sort(([a], [b]) => a.localeCompare(b))
      .reduce(
        (obj, [key, value]) => {
          obj[key] = value
          return obj
        },
        {} as typeof monthlyData,
      )

    // Calculate month-over-month growth
    const monthlyGrowth: { [key: string]: number } = {}
    let previousMonth: string | null = null
    let previousPnl = 0

    Object.entries(sortedMonthlyData).forEach(([month, data]) => {
      if (previousMonth) {
        const growth =
          previousPnl !== 0 ? ((data.pnl - previousPnl) / Math.abs(previousPnl)) * 100 : data.pnl > 0 ? 100 : 0
        monthlyGrowth[month] = growth
      }
      previousMonth = month
      previousPnl = data.pnl
    })

    // Return the statistics
    return res.json({
      total: statistics.total,
      asia: statistics.asia,
      london: statistics.london,
      newYork: statistics.newYork,
      limbo: statistics.limbo,
      monthlyPerformance: Object.entries(sortedMonthlyData).map(([month, data]) => ({
        month,
        pnl: data.pnl,
        orders: data.orders,
        wins: data.wins,
        winRate: data.winRate,
        growth: monthlyGrowth[month] || 0,
      })),
      maxDrawdown,
      stdDeviation,
      ulcerIndex,
      upi: statistics.total.upi,
    })
  } catch (error) {
    // Log the full error details
    logger.error("Error fetching statistics:", error)
    if (error instanceof Error) {
      logger.error(`Error name: ${error.name}, message: ${error.message}`)
      logger.error(`Error stack: ${error.stack}`)

      // Log specific information about the request
      logger.error(`Request accountId: ${req.params.accountId}`)
      logger.error(`Request query params: ${JSON.stringify(req.query)}`)

      // Check for specific error types
      if (error.message.includes("database")) {
        logger.error("Database error detected in statistics endpoint")
      }

      if (error.message.includes("undefined") || error.message.includes("null")) {
        logger.error("Possible null/undefined value error in statistics endpoint")
      }
    }

    // Return a more detailed error response
    return res.status(500).json({
      error: "Failed to fetch statistics",
      details: error instanceof Error ? error.message : String(error),
    })
  }
})

// Helper function to determine which trading session a timestamp belongs to
function getTradingSessionForTimestamp(timestamp: number): string | null {
  const date = new Date(timestamp)

  // Convert to ET (Eastern Time)
  // Note: This is a simplified version that assumes the timestamp is in UTC
  const etDate = new Date(date.getTime() - 5 * 60 * 60 * 1000) // UTC-5 for ET
  const hours = etDate.getHours()

  // Check which session the hour falls into
  if (hours >= 17 || hours < 1) {
    return "asia_session"
  } else if (hours >= 1 && hours < 6) {
    return "london_session"
  } else if (hours >= 6 && hours < 14) {
    return "new_york_session"
  } else if (hours >= 14 && hours < 17) {
    return "limbo_session"
  }

  return null // Should never happen if times are defined correctly
}


app.post("/webhook", async (req, res) => {
  const startTime = Date.now();

  try {
    // Parse webhook payload
    let alertData;
    try {
      alertData = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (error) {
      logger.error("WEBHOOK ERROR: Invalid JSON payload", { error: error instanceof Error ? error.message : String(error) });
      return res.status(400).json({ error: "Invalid JSON in request body" });
    }

    // Get login from webhook data
    const login = alertData.l || DEFAULT_ACCOUNT_NUMBER;
    const alertId = alertData.id || `${Date.now()}_${Math.random()}`;

    // IMMEDIATE DUPLICATE CHECK - BEFORE ANY LOGGING OR QUEUE ENTRY
    const exists = await orderExistsWithAlertId(alertId, login);
    if (exists) {
      // Log DUPLICATE status only - no webhook received logging
      const symbol = alertData.sy || "UNKNOWN";
      const action = alertData.a || "UNKNOWN";
      const size = alertData.z || 0;
      webhookLogger.logDuplicate(symbol, action, login, alertId, size);

      return res.status(200).json({
        message: "Alert already processed",
        alertId,
        account: login
      });
    }

    // Check if already in queue (secondary duplicate check)
    const inQueue = webhookQueue.checkForDuplicate(alertData, login);
    if (inQueue) {
      // Log DUPLICATE status only - no webhook received logging
      const symbol = alertData.sy || "UNKNOWN";
      const action = alertData.a || "UNKNOWN";
      const size = alertData.z || 0;
      webhookLogger.logDuplicate(symbol, action, login, alertId, size);

      return res.status(200).json({
        message: "Duplicate webhook detected and ignored",
        account: login
      });
    }

    // Log webhook received at endpoint entry - only once per webhook
    const symbol = alertData.sy || "UNKNOWN";
    const action = alertData.a || "UNKNOWN";
    const size = alertData.z || 0;
    const tp = alertData.t || 0;
    const sl = alertData.s || 0;

    webhookLogger.logWebhookReceived(symbol, action, size, tp, sl, login, alertId);

    // Add to queue - no logging happens in queue anymore
    const jobId = await webhookQueue.add(alertData, login);

    // Return immediately
    const queueStatus = webhookQueue.getQueueStatus();

    res.status(200).json({
      success: true,
      message: "Webhook queued for processing",
      jobId,
      queueStatus,
      processingTime: Date.now() - startTime
    });

  } catch (error: any) {
    logger.error(`Error queueing webhook:`, error);
    res.status(500).json({
      error: "Failed to queue webhook",
      details: error.message
    });
  }
});

// Process webhook from queue
webhookQueue.on('processWebhook', async (job, resolve, reject) => {
  const alertData = job.data;

  try {
    await processWebhookData(alertData);
    resolve();
  } catch (error) {
    reject(error);
  }
});

// This function contains ALL your existing webhook processing logic
async function processWebhookData(alertData: any) {
  const startTime = Date.now();
  let symbol = "UNKNOWN";
  let login = "UNKNOWN";
  let action = "UNKNOWN";

  try {
    // Extract and validate basic parameters
    const {
      a: rawAction,
      t: takeProfit,
      s: stopLoss,
      l: login,
      o: obReference,
      u: considerObReference,
      z: size,
      m: max_Size = 0.01,
      p: maxPerSide = 100,
      r: reality,
      h: maxObCandleAlert,
      sy: rawSymbol = "EURUSD",
      tf: timeframe,
      ft: findObType,
      ff: filterFvgs,
      fd: fvgDistance,
      lh: lineHeight,
      fr: filterFractal,
      id: alertId,
      th: alertThreshold,
    } = alertData;

    // Ensure action is defined
    action = rawAction || "UNKNOWN";

    // Webhook already logged at endpoint entry - no redundant logging here

    // Enhanced symbol parsing with validation
    symbol = rawSymbol;
    if (rawSymbol && rawSymbol.includes(":")) {
      const parts = rawSymbol.split(":");
      symbol = parts[parts.length - 1];
    }

    // Validate and normalize symbol
    symbol = symbol.toUpperCase().trim();

    // Validate required fields
    if (!login) {
      webhookLogger.logError("UNKNOWN", "UNKNOWN", "Missing login number", "UNKNOWN", alertId, size);
      throw new Error("Login number is required");
    }

    if (!symbol || symbol.trim() === "") {
      webhookLogger.logError(rawSymbol || "UNKNOWN", "UNKNOWN", `Invalid symbol "${rawSymbol}"`, login, alertId, size);
      throw new Error("Valid symbol is required");
    }

    // Symbol validation with supported instruments
    const supportedSymbols = [
      "EURUSD",
      "GBPUSD",
      "US100",
      "US500",
    ];

    if (!supportedSymbols.includes(symbol)) {
      const errorMsg = `Unsupported symbol: ${symbol}. Supported symbols: ${supportedSymbols.join(", ")}`;
      webhookLogger.logError(symbol, "UNKNOWN", errorMsg, login, alertId, size);
      throw new Error(errorMsg);
    }

    // Determine instrument type and pip specifications
    const instrumentSpecs = getInstrumentSpecs(symbol);

    // Validate pip values based on instrument type
    const validationResult = validatePipValues(takeProfit, stopLoss, symbol, instrumentSpecs);
    if (!validationResult.valid) {
      const errorMsg = validationResult.error || "Validation failed";
      webhookLogger.logOrderRejected(symbol, action, errorMsg, login, alertId, size);
      throw new Error(errorMsg);
    }

    // Convert TradingView pip values to actual trading values
    const convertedValues = convertTradingViewPips(takeProfit, stopLoss, symbol, instrumentSpecs);

    // Get the mutex for this login number
    const mutex = getMutex(login);

    try {
      // Acquire the lock for this login number
      const release = await mutex.acquire();

      try {
        // Critical section: Perform all checks and operations atomically
        const accountSettings = await getAccountSettings(login);
        const tradingMode = accountSettings.trading_mode;

        // Log trading mode and symbol combination
        logger.info(`Processing ${symbol} trade for account ${login} in ${tradingMode} mode`);
        tradeLogger.info(`Processing ${symbol} trade for account ${login} in ${tradingMode} mode`);

        // Exclusive mode check
        if (accountSettings.exclusive_mode === 1) {
          const totalOpenOrders = await getTotalOpenOrdersCount(login);
          if (totalOpenOrders > 0) {
            const rejectionMessage = `Account ${login} in Exclusive Mode and already have 1 open trade.`;
            webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
            broadcastLog(`Order rejected: ${rejectionMessage}`);
            throw new Error(`Order rejected: ${rejectionMessage}`);
          }
        }

        // Check if the current trading session is enabled
        const currentSession = getCurrentTradingSession();
        if (currentSession) {
          const sessionEnabledKey = `${currentSession}` as keyof typeof accountSettings;
          const sessionEnabled = accountSettings[sessionEnabledKey] === 1;

          if (!sessionEnabled) {
            const rejectionMessage = `${currentSession.replace('_', ' ')} is disabled for account ${login}`;
            webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
            broadcastLog(`Order rejected: ${rejectionMessage}`);
            throw new Error(`Order rejected: ${rejectionMessage}`);
          }
        }

        // Trading mode check
        if (tradingMode === "BUY_ONLY" && action !== "B") {
          const rejectionMessage = `Account ${login} is in BUY_ONLY mode, cannot place SELL orders for ${symbol}`;
          webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
          broadcastLog(`Order rejected: ${rejectionMessage}`);
          throw new Error(`Order rejected: ${rejectionMessage}`);
        }

        if (tradingMode === "SELL_ONLY" && action !== "S") {
          const rejectionMessage = `Account ${login} is in SELL_ONLY mode, cannot place BUY orders for ${symbol}`;
          webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
          broadcastLog(`Order rejected: ${rejectionMessage}`);
          throw new Error(`Order rejected: ${rejectionMessage}`);
        }

        // Check for duplicate based on alert ID
        const orderExists = await orderExistsWithAlertId(alertId, login);
        if (orderExists) {
          const rejectionMessage = `Alert ID ${alertId} already processed for account ${login}`;
          webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
          broadcastLog(`Order rejected: ${rejectionMessage}`);
          throw new Error("Order already processed with this alert ID");
        }

        // Determine which API to use based on the account number
        const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(login);

        const totalOpenVolume = await getTotalOpenVolume(login);
        const newTotalVolume = totalOpenVolume + size;

        logger.info(`Current open volume for account ${login}: ${totalOpenVolume}`);
        logger.info(`Attempting to add volume: ${size}`);
        logger.info(`New total volume would be: ${newTotalVolume}`);
        logger.info(`Max allowed volume: ${max_Size}`);

        logger.info(`Checking order limits for ${symbol} (${action}) in account ${login}`);

        if (isOrderPending(login, action)) {
          const rejectionMessage = `Cannot place trade in Account: ${login}. Order is already being processed.`;
          webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
          broadcastLog(rejectionMessage);
          throw new Error("Order already being processed");
        }

        if (newTotalVolume > max_Size) {
          const rejectionMessage = `Max limit reached for ${symbol}. Cannot place trade in Account: ${login}. Opened Volume: ${totalOpenVolume}, Attempted size: ${size}, Max size: ${max_Size}`;
          webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
          broadcastLog(rejectionMessage);
          throw new Error("Max limit reached");
        }

        const ordersOnSameSide = await getOrdersCountBySide(login, action);
        if (ordersOnSameSide > 0) {
          const rejectionMessage = `Order limit reached for ${action} ${symbol}. Cannot place trade in Account: ${login}. Already have ${ordersOnSameSide} ${action} order(s) open.`;
          webhookLogger.logOrderRejected(symbol, action, rejectionMessage, login, alertId, size);
          broadcastLog(rejectionMessage);
          throw new Error("Only one order per side allowed");
        }

        // Mark order as pending
        addPendingOrder(login, action);

        const exchange = "simplefx";

        // Enhanced logging for trade attempt with converted values
        const tradeAttemptLog = `Attempting to place ${action} order for ${symbol} (${instrumentSpecs.type}) on ${exchange} | Account: ${login} | Size: ${size} | TP: ${convertedValues.takeProfit} | SL: ${convertedValues.stopLoss} | Original TP: ${takeProfit} | Original SL: ${stopLoss}`;
        logger.info(tradeAttemptLog);
        tradeLogger.info(tradeAttemptLog);
        broadcastLog(tradeAttemptLog);

        // Place the trade with converted pip values
        const tradeResult = await placeTradeWithRetry(
          action,
          size,
          login,
          convertedValues.takeProfit,
          convertedValues.stopLoss,
          Number.parseFloat(obReference),
          considerObReference === "1",
          reality === 1 ? "LIVE" : "DEMO",
          symbol,
          exchange,
          useSecondaryApi,
        );

        const order = tradeResult.data.marketOrders[0].order;

        // Calculate spread using instrument-specific multiplier
        const spreadDisplay =
          instrumentSpecs.type === "index"
            ? (tradeResult.spreadAtOpen * 1).toFixed(1) + " points"
            : (tradeResult.spreadAtOpen * 10).toFixed(1) + " pips";

        // Log successful trade placement with TP/SL values using the new concise format
        webhookLogger.logOrderPlaced(
          symbol,
          action,
          size,
          order.openPrice,
          order.takeProfit || 0,
          order.stopLoss || 0,
          login,
          order.id.toString(),
          alertId
        );
        broadcastLog(`Trade placed successfully for ${symbol}: OrderID ${order.id}`);

        const orderId = order.id.toString();
        const lastQuote = webSocketManager.getQuoteForSymbol(symbol);
        if (!lastQuote) {
          const errorMsg = "No current market price available";
          webhookLogger.logError(symbol, action, errorMsg, login, alertId, size);
          broadcastLog(`${errorMsg} for ${symbol}`);
          removePendingOrder(login, action);
          throw new Error(errorMsg);
        }

        // Calculate real pip values using instrument specifications
        const realTpPips = Math.abs(order.takeProfit - order.openPrice) / instrumentSpecs.pipValue;
        const realSlPips = order.stopLoss ? Math.abs(order.stopLoss - order.openPrice) / instrumentSpecs.pipValue : null;
        const spread = (lastQuote.ask - lastQuote.bid) / instrumentSpecs.pipValue;

        const orderData = {
          id: orderId,
          login: Number.parseInt(login),
          symbol: order.symbol,
          side: order.side,
          volume: order.volume,
          openPrice: order.openPrice,
          closePrice: null,
          takeProfit: order.takeProfit,
          stopLoss: order.stopLoss,
          openTime: order.openTime,
          closeTime: null,
          profit: order.profit,
          swap: order.swaps,
          commission: 0,
          reality: order.reality,
          leverage: order.leverage,
          margin: order.margin,
          marginRate: order.marginRate,
          requestId: order.requestId || "",
          isFIFO: order.isFIFO || false,
          obReferencePrice: Number.parseFloat(obReference),
          realSlPips: realSlPips ? Number(realSlPips.toFixed(2)) : null,
          realTpPips: Number(realTpPips.toFixed(2)),
          bidAtOpen: lastQuote.bid,
          askAtOpen: lastQuote.ask,
          spreadAtOpen: tradeResult.spreadAtOpen,
          considerObReference: considerObReference === "1",
          max_Size: Number.parseFloat(max_Size),
          durationInMinutes: null,
          alertId: `${alertId}_${login}`,
          alertThreshold: alertThreshold,
          filterFractal: filterFractal,
          fvgDistance: fvgDistance,
          findObType: findObType,
          maxobalert: maxObCandleAlert ? Number.parseInt(maxObCandleAlert) : null,
          timeframe: timeframe,
          exchange: exchange,
          lineHeight: rawSymbol,
          instrumentType: instrumentSpecs.type,
          originalTpPips: takeProfit,
          originalSlPips: stopLoss,
        };

        logger.debug(`Preparing to upsert order for ${symbol}: ${JSON.stringify(orderData, null, 2)}`);
        await upsertOrder(orderData);
        logger.debug(`Order data inserted into database for ${symbol}: ${JSON.stringify(orderData)}`);
        await updateMaxSize(login, Number.parseFloat(max_Size));
        logger.info(`Updated max size for account ${login}: ${max_Size}`);

        removePendingOrder(login, action);

        // Store processed ID after successful processing to prevent future duplicates
        await webhookQueue.storeProcessedId(alertId, login);

        // Success - webhook processed successfully
        logger.info(`Webhook processed successfully for ${symbol} in ${Date.now() - startTime}ms`);

      } catch (error: any) {
        removePendingOrder(login, action);
        throw error;
      } finally {
        release();
      }
    } catch (error: any) {
      // Enhanced error logging with full context
      const errorContext = {
        symbol,
        login,
        action,
        takeProfit,
        stopLoss,
        size,
        reality,
        alertId,
        timeframe,
        webhookPayload: alertData
      };

      let errorMessage = "Internal server error";
      if (error.response && error.response.status === 409) {
        errorMessage = "Trading Bad Prices - Consider adjusting SL/TP";
        logError.api('409_ERROR', `Bad prices from SimpleFX for ${symbol}. Suggestion: Adjust SL/TP values`, login);
      } else if (error.message) {
        errorMessage = error.message;
      }

      // Use centralized webhook logger for error logging
      webhookLogger.logError(symbol, action, errorMessage, login, alertId, size);

      // Use the new detailed error logging for additional context
      logError.detailed(`WEBHOOK_PROCESSING_${symbol}`, error, errorContext);

      broadcastLog(`Error processing webhook for ${symbol}: ${errorMessage}`);
      throw error;
    }
  } catch (error: any) {
    const executionTime = Date.now() - startTime;
    logger.error(`Webhook processing failed for ${symbol} after ${executionTime}ms:`, error);
    throw error;
  }
}

// Set up webhook processor - right after the webhook endpoint
webhookQueue.on('processWebhook', async (job, resolve, reject) => {
  const { data } = job;

  try {
    await processWebhookData(data);
    resolve();
  } catch (error) {
    reject(error);
  }
});

function validatePipValues(takeProfit: number, stopLoss: number, symbol: string, specs: any) {
  if (!takeProfit || takeProfit <= 0) {
    return { valid: false, error: `Invalid take profit value: ${takeProfit}` };
  }

  if (stopLoss !== null && stopLoss !== undefined && stopLoss <= 0) {
    return { valid: false, error: `Invalid stop loss value: ${stopLoss}` };
  }

  // Stricter minimum for US100 (10 points)
  const minPips = symbol === "US100" ? 10 : specs.type === "index" ? 10 : 5;

  if (takeProfit < minPips) {
    return {
      valid: false,
      error: `Take profit too small for ${symbol}. Minimum: ${minPips} ${specs.type === "index" ? "points" : "pips"}`,
    };
  }

  if (stopLoss && stopLoss < minPips) {
    return {
      valid: false,
      error: `Stop loss too small for ${symbol}. Minimum: ${minPips} ${specs.type === "index" ? "points" : "pips"}`,
    };
  }

  return { valid: true };
}

function convertTradingViewPips(takeProfit: number, stopLoss: number, symbol: string, specs: any) {
  // For TradingView alerts:
  // - Forex pairs: TradingView sends actual pips (e.g., 50 pips = 50 pips)
  // - Indices: TradingView sends points as "pips" (e.g., 100 "pips" = 100 points)

  if (specs.type === "index") {
    // For indices, TradingView "pips" are actually points
    // No conversion needed - pass through directly
    return {
      takeProfit: takeProfit,
      stopLoss: stopLoss,
    }
  } else {
    // For forex, TradingView sends actual pips
    // No conversion needed - pass through directly
    return {
      takeProfit: takeProfit,
      stopLoss: stopLoss,
    }
  }
}

// API endpoint for status data
app.get("/api/status/:loginNumber?", async (req, res) => {
  try {
    // Get the login number from the request
    const requestedLoginNumber = req.params.loginNumber;

    // Determine which API to use based on the account number
    // Accounts in SECONDARY_API_ACCOUNTS should ALWAYS use the secondary API
    const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(requestedLoginNumber || '') || req.query.useSecondaryApi === "true";

    // Use the appropriate default account number based on which API we're using
    const defaultAccount = useSecondaryApi ? DEFAULT_ACCOUNT_NUMBER2 : DEFAULT_ACCOUNT_NUMBER;
    const loginNumber = requestedLoginNumber || defaultAccount;

    //logger.info(`API request for account ${loginNumber}, using ${useSecondaryApi ? "secondary" : "primary"} API`);

    if (isNaN(Number(loginNumber)) || Number(loginNumber) <= 0) {
      return res.status(400).json({ error: "Invalid login number" });
    }

    try {
      const lastQuote = webSocketManager.getQuoteForSymbol("EURUSD");

      // Log the API request details
      logger.debug(
        `Fetching active orders for account ${loginNumber} (${isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO"}) using ${useSecondaryApi ? "secondary" : "primary"} API`,
      );
      const activeOrders = await getActiveOrders(
        loginNumber,
        isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
        useSecondaryApi,
      );
      logger.debug(`Received ${activeOrders.data.marketOrders.length} active orders for account ${loginNumber}`);

      logger.debug(
        `Fetching closed orders for account ${loginNumber} (${isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO"}) using ${useSecondaryApi ? "secondary" : "primary"} API`,
      );
      const closedOrders = await getClosedOrders(
        loginNumber,
        isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
        useSecondaryApi,
      );
      logger.debug(`Received ${closedOrders.data.marketOrders.length} closed orders for account ${loginNumber}`);

      logger.debug(
        `Fetching account status for account ${loginNumber} (${isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO"}) using ${useSecondaryApi ? "secondary" : "primary"} API`,
      );
      const accountStatus = await getAccountStatus(
        loginNumber,
        isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
        useSecondaryApi,
      );

      const dbOrders = await getOrders(loginNumber);

      // Fetch the latest signal parameters from the database
      const db = await initializeDatabase();
      const latestSignalParams = await getLatestSignalParams(loginNumber);

      // Get the account trading mode
      const accountSettings = await getAccountSettings(loginNumber);

      const mergeOrderWithDbData = (order: any, dbOrders: any[]) => {
        logger.debug(`Order ID from API: ${order.id} (type: ${typeof order.id})`);
        logger.debug(`DB Orders: ${JSON.stringify(dbOrders.map(o => o.order_id))}`);
        const dbOrder = dbOrders.find((o: any) => Number(o.order_id) === Number(order.id));
        if (dbOrder) {
          logger.debug(`Merging order ${order.id} with database data`);
          return {
            ...order,
            ob_reference_price: dbOrder.ob_reference_price,
            real_sl_pips: dbOrder.real_sl_pips,
            real_tp_pips: dbOrder.real_tp_pips,
            spread_at_open: dbOrder.spread_at_open,
            consider_ob_reference: dbOrder.consider_ob_reference === 1,
            max_size: dbOrder.max_size,
            bid_at_open: dbOrder.bid_at_open,
            askAtOpen: dbOrder.ask_at_open,
            duration_in_minutes: dbOrder.duration_in_minutes,
            alert_id: dbOrder.alert_id,
            maxobalert: dbOrder.maxobalert,
            filterFractal: dbOrder.filterfractal,
            findObType: dbOrder.findObType,
            fvgDistance: dbOrder.fvgdistance,
          };
        } else {
          logger.warn(`No database data found for order ${order.id}. Syncing order to database.`);
          syncMissingOrder(order);
          return order;
        }
      };

      // Ensure we have arrays to map over, even if empty
      const activeOrdersData = activeOrders.data.marketOrders || [];
      const closedOrdersData = closedOrders.data.marketOrders || [];

      const mergedActiveOrders = activeOrdersData.map((order: any) => mergeOrderWithDbData(order, dbOrders));
      const mergedClosedOrders = closedOrdersData.map((order: any) => mergeOrderWithDbData(order, dbOrders));

      const buyVolume = mergedActiveOrders
        .filter((order: any) => order.side === "BUY")
        .reduce((sum: number, order: any) => sum + order.volume, 0);
      const sellVolume = mergedActiveOrders
        .filter((order: any) => order.side === "SELL")
        .reduce((sum: number, order: any) => sum + order.volume, 0);

      const responseData = {
        loginNumber,
        accountType: isLiveAccount(loginNumber) ? "LIVE" : "DEMO",
        currentPrice: lastQuote
          ? {
            bid: lastQuote.bid.toFixed(5),
            ask: lastQuote.ask.toFixed(5),
            timestamp: lastQuote.timestamp,
          }
          : null,
        activeOrders: { ...activeOrders, data: { ...activeOrders.data, marketOrders: mergedActiveOrders } },
        closedOrders: { ...closedOrders, data: { ...closedOrders.data, marketOrders: mergedClosedOrders } },
        accountStatus: { ...accountStatus },
        tradingMode: accountSettings.trading_mode,
        serverTime: new Date().toISOString(),
        orderCounts: { buyVolume, sellVolume },
        accountSettings: accountSettings,
        latestSignalParams: latestSignalParams,
      };

      logger.debug(
        `Sending response with ${mergedActiveOrders.length} active orders and ${mergedClosedOrders.length} closed orders`,
      );
      res.json(responseData);
    } catch (apiError: any) {
      // If we get an INVALID_TRADEACCOUNT error and we're not already using the secondary API,
      // try again with the secondary API
      if (apiError.response?.data?.code === 1405 && !useSecondaryApi) {
        logger.warn(`Got INVALID_TRADEACCOUNT error, retrying with secondary API for account ${loginNumber}`);

        try {
          const lastQuote = webSocketManager.getQuoteForSymbol("EURUSD");

          // Log the API request details for the retry
          logger.debug(
            `Retrying with secondary API - Fetching active orders for account ${loginNumber} (${isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO"})`,
          );
          const activeOrders = await getActiveOrders(
            loginNumber,
            isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
            true,
          );
          logger.debug(
            `Retry received ${activeOrders.data.marketOrders.length} active orders for account ${loginNumber}`,
          );

          logger.debug(
            `Retrying with secondary API - Fetching closed orders for account ${loginNumber} (${isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO"})`,
          );
          const closedOrders = await getClosedOrders(
            loginNumber,
            isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
            true,
          );
          logger.debug(
            `Retry received ${closedOrders.data.marketOrders.length} closed orders for account ${loginNumber}`,
          );

          logger.debug(
            `Retrying with secondary API - Fetching account status for account ${loginNumber} (${isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO"})`,
          );
          const accountStatus = await getAccountStatus(
            loginNumber,
            isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
            true,
          );

          const dbOrders = await getOrders(loginNumber);

          // Fetch the latest signal parameters from the database
          const db = await initializeDatabase();
          // Fetch the latest signal parameters from the database
          const latestSignalParams = await getLatestSignalParams(loginNumber);

          // Get the account trading mode
          const accountSettings = await getAccountSettings(loginNumber);

          const mergeOrderWithDbData = (order: any, dbOrders: any[]) => {
            const dbOrder = dbOrders.find((o: any) => o.order_id.toString() === order.id.toString());
            if (dbOrder) {
              return {
                ...order,
                ob_reference_price: dbOrder.ob_reference_price,
                real_sl_pips: dbOrder.real_sl_pips,
                real_tp_pips: dbOrder.real_tp_pips,
                spread_at_open: dbOrder.spread_at_open,
                consider_ob_reference: dbOrder.consider_ob_reference === 1,
                max_size: dbOrder.max_size,
                bid_at_open: dbOrder.bid_at_open,
                askAtOpen: dbOrder.askAtOpen,
                duration_in_minutes: dbOrder.duration_in_minutes,
                alert_id: dbOrder.alert_id,
                alert_threshold: dbOrder.alert_threshold,
                maxobalert: dbOrder.maxobalert,
                filterFractal: dbOrder.filterfractal,
                findObType: dbOrder.filterfractal,
                fvgDistance: dbOrder.fvgdistance
              };
            } else {
              logger.warn(`No database data found for order ${order.id}. Syncing order to database.`);
              syncMissingOrder(order);
              return order;
            }
          };

          // Ensure we have arrays to map over, even if empty
          const activeOrdersData = activeOrders.data.marketOrders || [];
          const closedOrdersData = closedOrders.data.marketOrders || [];

          const mergedActiveOrders = activeOrdersData.map((order: any) => mergeOrderWithDbData(order, dbOrders));
          const mergedClosedOrders = closedOrdersData.map((order: any) => mergeOrderWithDbData(order, dbOrders));

          const buyVolume = mergedActiveOrders
            .filter((order: any) => order.side === "BUY")
            .reduce((sum: number, order: any) => sum + order.volume, 0);
          const sellVolume = mergedActiveOrders
            .filter((order: any) => order.side === "SELL")
            .reduce((sum: number, order: any) => sum + order.volume, 0);

          const responseData = {
            loginNumber,
            accountType: isLiveAccount(loginNumber) ? "LIVE" : "DEMO",
            currentPrice: lastQuote
              ? {
                bid: lastQuote.bid.toFixed(5),
                ask: lastQuote.ask.toFixed(5),
                timestamp: lastQuote.timestamp,
              }
              : null,
            activeOrders: { ...activeOrders, data: { ...activeOrders.data, marketOrders: mergedActiveOrders } },
            closedOrders: { ...closedOrders, data: { ...closedOrders.data, marketOrders: mergedClosedOrders } },
            accountStatus: { ...accountStatus },
            latestSignalParams: latestSignalParams,
            tradingMode: accountSettings.trading_mode,
            serverTime: new Date().toISOString(),
            orderCounts: { buyVolume, sellVolume },
            accountSettings: accountSettings,
          };

          logger.debug(
            `Retry sending response with ${mergedActiveOrders.length} active orders and ${mergedClosedOrders.length} closed orders`,
          );
          res.json(responseData);
          return;
        } catch (retryError) {
          logger.error(`Retry with secondary API also failed for account ${loginNumber}:`, retryError);
          throw retryError;
        }
      }

      // If it's not an INVALID_TRADEACCOUNT error or we're already using the secondary API, log and throw the error
      logError.detailed(`API_ERROR_${loginNumber}`, apiError, {
        loginNumber,
        operation: 'getActiveOrders',
        timestamp: new Date().toISOString()
      });
      throw apiError;
    }
  } catch (error: unknown) {
    logger.error("Error fetching status:", error);
    broadcastLog(`Error fetching status: ${error instanceof Error ? error.message : String(error)}`);
    res
      .status(500)
      .json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) });
  }
});

// API endpoint for database orders
app.get("/api/db-orders/:loginNumber", SecondaryAuth, async (req, res) => {
  try {
    const loginNumber = req.params.loginNumber

    if (isNaN(Number(loginNumber)) || Number(loginNumber) <= 0) {
      return res.status(400).json({ error: "Invalid login number" })
    }

    const dbOrders = await getOrders(loginNumber)
    res.json(dbOrders)
  } catch (error: unknown) {
    logger.error("Error fetching database orders:", error)
    broadcastLog(`Error fetching database orders: ${error instanceof Error ? error.message : String(error)}`)
    res
      .status(500)
      .json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) })
  }
})


// API endpoint for recent database orders
app.get("/api/recent-db-orders/:loginNumber", SecondaryAuth, async (req, res) => {
  try {
    const loginNumber = req.params.loginNumber

    if (isNaN(Number(loginNumber)) || Number(loginNumber) <= 0) {
      return res.status(400).json({ error: "Invalid login number" })
    }

    // Fetch recent orders from the database
    const recentOrders = await getRecentOrders(loginNumber)

    // Determine which API to use based on the account number
    const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(loginNumber)

    // Fetch all orders from SimpleFX API
    const activeOrders = await getActiveOrders(
      loginNumber,
      isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
      useSecondaryApi,
    )
    const closedOrders = await getClosedOrders(
      loginNumber,
      isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
      useSecondaryApi,
    )
    const allApiOrders = [...activeOrders.data.marketOrders, ...closedOrders.data.marketOrders]

    // Merge DB orders with API data
    const mergedOrders = recentOrders.map((dbOrder: any) => {
      const apiOrder = allApiOrders.find((o: any) => o.id.toString() === dbOrder.order_id)
      return {
        ...dbOrder,
        id: dbOrder.order_id,
        symbol: dbOrder.symbol,
        side: dbOrder.side,
        volume: dbOrder.volume,
        openPrice: dbOrder.open_price,
        closePrice: apiOrder ? apiOrder.closePrice : dbOrder.close_price,
        takeProfit: dbOrder.take_profit,
        stopLoss: dbOrder.stop_loss,
        openTime: dbOrder.open_time,
        closeTime: apiOrder ? apiOrder.closeTime : dbOrder.close_time,
        profit: apiOrder ? apiOrder.profit : dbOrder.profit,
        ob_reference_price: dbOrder.ob_reference_price,
        real_sl_pips: dbOrder.real_sl_pips,
        real_tp_pips: dbOrder.real_tp_pips,
        spread_at_open: dbOrder.spread_at_open ? Math.round(dbOrder.spread_at_open * 100) : null, // Convert to pipets
        max_size: dbOrder.max_size,
        durationInMinutes: dbOrder.duration_in_minutes,
        alert_id: dbOrder.alert_id,
        alert_threshold: dbOrder.alert_threshold,
      }
    })

    res.json(mergedOrders)
  } catch (error: unknown) {
    logger.error("Error fetching recent database orders:", error)
    broadcastLog(`Error fetching recent database orders: ${error instanceof Error ? error.message : String(error)}`)
    res
      .status(500)
      .json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) })
  }
})

// API endpoint for webhook outcomes - Requirements: 4.4, 4.5
app.get("/api/webhook-outcomes/:loginNumber", SecondaryAuth, async (req, res) => {
  try {
    const loginNumber = req.params.loginNumber

    if (isNaN(Number(loginNumber)) || Number(loginNumber) <= 0) {
      return res.status(400).json({ error: "Invalid login number" })
    }

    // Get query parameters for filtering
    const limit = parseInt(req.query.limit as string) || 100
    const includeOutcomes = req.query.outcomes
      ? (req.query.outcomes as string).split(',')
      : ['PLACED', 'REJECTED', 'ERROR', 'DUPLICATE']

    // Fetch webhook outcomes from database
    const outcomes = await getWebhookOutcomes(loginNumber, limit, includeOutcomes)

    res.json(outcomes)
  } catch (error: unknown) {
    logger.error("Error fetching webhook outcomes:", error)
    broadcastLog(`Error fetching webhook outcomes: ${error instanceof Error ? error.message : String(error)}`)
    res
      .status(500)
      .json({ error: "Internal server error", details: error instanceof Error ? error.message : String(error) })
  }
})

app.get("/api/deposits/:loginNumber", SecondaryAuth, async (req, res) => {
  try {
    const loginNumber = req.params.loginNumber
    if (!loginNumber) {
      return res.status(400).json({ error: "No account specified" })
    }

    // Only process LIVE accounts
    if (!isLiveAccount(loginNumber)) {
      return res.json({ totalDeposits: 0 })
    }

    // Determine which API to use based on the account number
    const useSecondaryApi = SECONDARY_API_ACCOUNTS.includes(loginNumber)

    try {
      const depositHistory = await getDepositHistory(loginNumber, "LIVE", useSecondaryApi)
      const deposits = depositHistory.data.deposits || []
      const totalDeposits = deposits.reduce((sum: number, deposit: any) => sum + deposit.amount, 0)

      res.json({ totalDeposits })
    } catch (error: any) {
      logger.error(`Error fetching deposits for account ${loginNumber}:`, error.message)
      res.json({ totalDeposits: 0 })
    }
  } catch (error: unknown) {
    logger.error("Error fetching deposits:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// This function is still useful to determine if a file is gzipped
function isGzipFile(filePath: string): boolean {
  try {
    // Check if file exists first
    if (!fs.existsSync(filePath)) {
      console.debug(`File not found: ${filePath}`);
      return false;
    }

    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(2); // Read first 2 bytes

    // Make sure we can read at least 2 bytes
    const bytesRead = fs.readSync(fd, buffer, 0, 2, 0);
    fs.closeSync(fd);

    if (bytesRead < 2) {
      console.warn(`File too small to determine type: ${filePath}`);
      return false;
    }

    // Gzip files start with 0x1f 0x8b
    return buffer[0] === 0x1f && buffer[1] === 0x8b;
  } catch (error) {
    if (error instanceof Error) {
      console.warn(`Error checking file type for ${filePath}: ${error.message}`);
    } else {
      console.warn(`Error checking file type for ${filePath}: Unknown error`);
    }
    return false; // Assume it's not gzip if we can't read it
  }
}

app.get("/api/recent-logs", async (req, res) => {
  try {
    const accountNumber = req.query.account as string;
    const logType = (req.query.type as string) || 'trades';
    const limit = parseInt(req.query.limit as string) || 50;

    const logDir = path.join(__dirname, "../");
    const recentLogs: { time: string; message: string; level?: string; account?: string }[] = [];

    // Use new non-dated log files
    let logFilesToRead: string[] = [];
    switch (logType) {
      case 'trades': logFilesToRead = ['trades.log']; break;
      case 'errors': logFilesToRead = ['error.log']; break;
      case 'app': logFilesToRead = ['app.log']; break;
      default: logFilesToRead = ['trades.log', 'error.log', 'app.log'];
    }

    for (const logFile of logFilesToRead) {
      const fullPath = path.join(logDir, logFile);

      if (!fs.existsSync(fullPath)) continue;

      const data = fs.readFileSync(fullPath, 'utf8');
      const lines = data.split('\n').filter(line => line.trim());
      
      // Take the last 1000 lines to ensure we get recent entries
      const recentLines = lines.slice(-1000);

      for (const line of recentLines) {
        if (!line.trim()) continue;

        // Parse new format: "DD/MM/YYYY, HH:mm:ss | message"
        const match = line.match(/^(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}) \| (.+)$/);
        if (!match) continue;

        const [, timestamp, message] = match;

        // Extract account number from message
        const accountMatch = message.match(/Acc:(\d+)/) ||
          message.match(/Account[:\s]+(\d+)/) ||
          message.match(/account[:\s]+(\d+)/i) ||
          message.match(/(\d{7})/);
        const logAccount = accountMatch ? accountMatch[1] : '';

        // Filter by account if specified
        if (accountNumber && accountNumber !== 'all') {
          if (!message.includes(accountNumber) && logAccount !== accountNumber) {
            continue;
          }
        }

        recentLogs.push({
          time: timestamp,
          message: message,
          level: logFile.includes('error') ? 'error' : logFile.includes('app') ? 'info' : 'trade',
          account: logAccount
        });
      }
    }

    // Sort by timestamp (newest first) and limit results
    recentLogs.sort((a, b) => {
      // Parse DD/MM/YYYY, HH:mm:ss format properly
      const parseLogDate = (timeStr: string) => {
        const [datePart, timePart] = timeStr.split(', ');
        const [day, month, year] = datePart.split('/');
        // Convert to ISO format: YYYY-MM-DD HH:mm:ss
        return new Date(`${year}-${month}-${day} ${timePart}`).getTime();
      };

      return parseLogDate(b.time) - parseLogDate(a.time); // Changed to descending order (newest first)
    });

    res.json(recentLogs.slice(0, limit));
  } catch (error) {
    console.error("Error reading logs:", error);
    res.status(500).json({ error: "Error processing log files" });
  }
});

app.get("/api/test-order-counts/:loginNumber", SecondaryAuth, async (req, res) => {
  try {
    const loginNumber = req.params.loginNumber

    if (isNaN(Number(loginNumber)) || Number(loginNumber) <= 0) {
      return res.status(400).json({ error: "Invalid login number" })
    }

    // Use the secondary API only for account 3979937
    const useSecondaryApi = loginNumber === "3979937"

    // Get active orders
    const activeOrders = await getActiveOrders(
      loginNumber,
      isLiveAccount(loginNumber.toString()) ? "LIVE" : "DEMO",
      useSecondaryApi,
    )

    // Count orders by side
    const buyOrders = activeOrders.data.marketOrders.filter((order: any) => order.side.toUpperCase() === "BUY")

    const sellOrders = activeOrders.data.marketOrders.filter((order: any) => order.side.toUpperCase() === "SELL")

    // Calculate volumes
    const buyVolume = buyOrders.reduce((sum: number, order: any) => sum + order.volume, 0)
    const sellVolume = sellOrders.reduce((sum: number, order: any) => sum + order.volume, 0)

    res.json({
      buyOrders: {
        count: buyOrders.length,
        orders: buyOrders,
        volume: buyVolume,
      },
      sellOrders: {
        count: sellOrders.length,
        orders: sellOrders,
        volume: sellVolume,
      },
      totalOrders: activeOrders.data.marketOrders.length,
      totalVolume: buyVolume + sellVolume,
    })
  } catch (error: unknown) {
    logger.error("Error fetching order counts:", error)
    res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    })
  }
})

app.get("/api/chart-data", SecondaryAuth, async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || "EURUSD"
    const timeframe = (req.query.timeframe as string) || "1h"

    logger.info(`Fetching chart data for ${symbol} on ${timeframe} timeframe`)

    // Try to get data from WebSocketManager if available
    const currentQuote = webSocketManager.getQuoteForSymbol(symbol);
    if (symbol === "EURUSD" && currentQuote) {
      try {
        // Generate historical candles based on the current price
        const candles = generateHistoricalCandles(
          currentQuote.bid,
          currentQuote.ask,
          timeframe,
        )

        return res.json(candles)
      } catch (wsError) {
        logger.error(
          `Error generating candles from WebSocket data: ${wsError instanceof Error ? wsError.message : String(wsError)}`,
        )
      }
    }

    // Fallback to generating sample data
    const candles = generateSampleCandles(symbol, timeframe)
    res.json(candles)
  } catch (error) {
    logger.error(`Error fetching chart data: ${error instanceof Error ? error.message : String(error)}`)
    res.status(500).json({ error: "Failed to fetch chart data" })
  }
})

// Helper function to generate sample candles
function generateSampleCandles(symbol: string, timeframe: string): any[] {
  const now = Date.now()
  const candles = []

  // Determine parameters based on timeframe - increase the count to provide more historical data
  const timeframeParams: { count: number; interval: number; basePrice: number; volatility: number } = {
    "1m": { count: 1000, interval: 60 * 1000, basePrice: 1.085, volatility: 0.0001 },
    "5m": { count: 800, interval: 5 * 60 * 1000, basePrice: 1.085, volatility: 0.0002 },
    "15m": { count: 600, interval: 15 * 60 * 1000, basePrice: 1.085, volatility: 0.0003 },
    "1h": { count: 400, interval: 60 * 60 * 1000, basePrice: 1.085, volatility: 0.0005 },
    "4h": { count: 300, interval: 4 * 60 * 60 * 1000, basePrice: 1.085, volatility: 0.0008 },
    "1d": { count: 200, interval: 24 * 60 * 60 * 1000, basePrice: 1.085, volatility: 0.0012 },
  }[timeframe] || { count: 400, interval: 60 * 60 * 1000, basePrice: 1.085, volatility: 0.0005 }

  let lastClose = timeframeParams.basePrice

  for (let i = 0; i < timeframeParams.count; i++) {
    const time = now - (timeframeParams.count - i) * timeframeParams.interval

    // Create realistic price movement
    const change = (Math.random() - 0.5) * timeframeParams.volatility
    const open = lastClose
    const close = open + change
    const high = Math.max(open, close) + Math.random() * timeframeParams.volatility * 0.5
    const low = Math.min(open, close) - Math.random() * timeframeParams.volatility * 0.5

    lastClose = close

    candles.push({
      time: Math.floor(time / 1000),
      open: Number.parseFloat(open.toFixed(5)),
      high: Number.parseFloat(high.toFixed(5)),
      low: Number.parseFloat(low.toFixed(5)),
      close: Number.parseFloat(close.toFixed(5)),
    })
  }

  return candles
}

// Helper function to generate historical candles based on current price
function generateHistoricalCandles(bid: number, ask: number, timeframe: string): any[] {
  const currentPrice = (bid + ask) / 2
  const now = Date.now()
  const candles = []

  // Determine parameters based on timeframe - increase the count to provide more historical data
  const timeframeParams: { count: number; interval: number; volatility: number } = {
    "1m": { count: 1000, interval: 60 * 1000, volatility: 0.0001 },
    "5m": { count: 800, interval: 5 * 60 * 1000, volatility: 0.0002 },
    "15m": { count: 600, interval: 15 * 60 * 1000, volatility: 0.0003 },
    "1h": { count: 400, interval: 60 * 60 * 1000, volatility: 0.0005 },
    "4h": { count: 300, interval: 4 * 60 * 60 * 1000, volatility: 0.0008 },
    "1d": { count: 200, interval: 24 * 60 * 60 * 1000, volatility: 0.0012 },
  }[timeframe] || { count: 400, interval: 60 * 60 * 1000, volatility: 0.0005 }

  // Generate a more realistic price series that ends at the current price
  let lastClose = currentPrice - (Math.random() * 0.005 - 0.0025) // Start with a slight offset from current price

  for (let i = 0; i < timeframeParams.count - 1; i++) {
    const time = now - (timeframeParams.count - i) * timeframeParams.interval

    // Create realistic price movement with trend toward current price
    const targetDiff = currentPrice - lastClose
    const trendFactor = i / (timeframeParams.count - 1) // Increases as we get closer to current time
    const change = (Math.random() - 0.5) * timeframeParams.volatility + targetDiff * trendFactor * 0.1

    const open = lastClose
    const close = open + change
    const high = Math.max(open, close) + Math.random() * timeframeParams.volatility * 0.5
    const low = Math.min(open, close) - Math.random() * timeframeParams.volatility * 0.5

    lastClose = close

    candles.push({
      time: Math.floor(time / 1000),
      open: Number.parseFloat(open.toFixed(5)),
      high: Number.parseFloat(high.toFixed(5)),
      low: Number.parseFloat(low.toFixed(5)),
      close: Number.parseFloat(close.toFixed(5)),
    })
  }

  // Add the final candle with the current price
  candles.push({
    time: Math.floor(now / 1000),
    open: Number.parseFloat(lastClose.toFixed(5)),
    high: Number.parseFloat(Math.max(lastClose, currentPrice).toFixed(5)),
    low: Number.parseFloat(Math.min(lastClose, currentPrice).toFixed(5)),
    close: Number.parseFloat(currentPrice.toFixed(5)),
  })

  return candles
}

// Cron job to update all orders
cron.schedule("*/10 * * * *", async () => {
  //logger.info('Starting cron job to update all orders');
  let totalOrdersUpdated = 0
  let totalClosedOrdersUpdated = 0
  let totalMissingOrdersSynced = 0
  try {
    const loginNumbers = ["3028761", "3979960", "247341", "3979937"]
    for (const loginNumber of loginNumbers) {
      const accountType = isLiveAccount(loginNumber) ? "LIVE" : "DEMO"
      const useSecondaryApi = loginNumber === "3979937"
      const activeOrders = await getActiveOrders(loginNumber, accountType, useSecondaryApi)
      const closedOrders = await getClosedOrders(loginNumber, accountType, useSecondaryApi)
      const allApiOrders = [...activeOrders.data.marketOrders, ...closedOrders.data.marketOrders]

      const dbOrders = await getOrders(loginNumber)

      let updatedOrdersCount = 0
      let updatedClosedOrdersCount = 0
      let missingOrdersSyncedCount = 0

      for (const apiOrder of allApiOrders) {
        const dbOrder = dbOrders.find((o: any) => o.order_id === apiOrder.id.toString())
        let durationInMinutes = null

        if (apiOrder.openTime && apiOrder.closeTime) {
          durationInMinutes = calculateDurationInMinutes(apiOrder.openTime, apiOrder.closeTime)
        }

        if (!dbOrder) {
          await syncMissingOrder(apiOrder)
          missingOrdersSyncedCount++
        }

        const pipValue = getPipValue(apiOrder.symbol);
        const realTpPips = apiOrder.takeProfit && apiOrder.openPrice ? Math.abs(apiOrder.takeProfit - apiOrder.openPrice) / pipValue : null;
        const realSlPips = apiOrder.stopLoss && apiOrder.openPrice ? Math.abs(apiOrder.stopLoss - apiOrder.openPrice) / pipValue : null;

        await upsertOrder({
          ...apiOrder,
          id: apiOrder.id.toString(),
          login: Number.parseInt(loginNumber),
          reality: accountType,
          obReferencePrice: dbOrder ? dbOrder.ob_reference_price : null,
          realSlPips: realSlPips || (dbOrder ? dbOrder.real_sl_pips : null), // Fixed typo
          realTpPips: realTpPips || (dbOrder ? dbOrder.real_tp_pips : null),
          spreadAtOpen: dbOrder ? dbOrder.spread_at_open : apiOrder.spreadAtOpen,
          considerObReference: dbOrder ? dbOrder.consider_ob_reference : false,
          bidAtOpen: dbOrder ? dbOrder.bid_at_open : null,
          askAtOpen: dbOrder ? dbOrder.ask_at_open : null,
          closeTime: apiOrder.closeTime,
          durationInMinutes: durationInMinutes,
          alertId: dbOrder ? dbOrder.alert_id : null,
          alertThreshold: dbOrder ? dbOrder.alert_threshold : null,
          maxobalert: dbOrder ? dbOrder.maxobalert : (apiOrder.maxobalert || null),
          max_size: dbOrder ? dbOrder.max_size : (apiOrder.max_size || null),
          filterFractal: dbOrder ? dbOrder.filterFractal : (apiOrder.filterFractal || null),
          findObType: dbOrder ? dbOrder.findObType : (apiOrder.findObType || null),
          fvgDistance: dbOrder ? dbOrder.fvgDistance : (apiOrder.fvgDistance || null),
        });

        updatedOrdersCount++
        if (durationInMinutes !== null) {
          updatedClosedOrdersCount++
        }
      }

      totalOrdersUpdated += updatedOrdersCount
      totalClosedOrdersUpdated += updatedClosedOrdersCount
      totalMissingOrdersSynced += missingOrdersSyncedCount

    }
  } catch (error: unknown) {
    logError.detailed('UPDATE_ORDERS', error as any, {
      operation: 'updateOrders',
      timestamp: new Date().toISOString()
    });
    broadcastLog(`Error updating orders: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
  }
})

// Weekly log cleanup cron job - runs every Sunday at 2 AM
cron.schedule("0 2 * * 0", async () => {
  try {
    logger.info('LOG_CLEANUP: Starting weekly log cleanup');

    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Clean system journal logs older than 7 days
    await execAsync('journalctl --vacuum-time=7d');

    // Clean old auth logs (keep current ones)
    await execAsync('find /var/log -name "auth.log.*" -mtime +7 -delete 2>/dev/null || true');
    await execAsync('find /var/log -name "btmp.*" -mtime +7 -delete 2>/dev/null || true');
    await execAsync('find /var/log -name "syslog.*" -mtime +7 -delete 2>/dev/null || true');

    // Check disk usage after cleanup
    const { stdout } = await execAsync('df -h / | tail -1 | awk \'{print $5}\'');
    const diskUsage = stdout.trim();

    logger.info(`LOG_CLEANUP: Weekly cleanup completed. Disk usage: ${diskUsage}`);
  } catch (error: any) {
    logError.system('LOG_CLEANUP', `Weekly cleanup failed: ${error.message}`);
  }
});

// WebSocket server setup
// Dashboard WebSocket connection sharing
let dashboardConnectionTimer: NodeJS.Timeout | null = null
let lastDashboardUpdate = 0
const DASHBOARD_UPDATE_INTERVAL = 10000 // 10 seconds

const wss = new WebSocket.Server({ noServer: true })

// Shared dashboard update function
async function updateDashboardClients() {
  const now = Date.now()

  // Only update if enough time has passed (10 seconds)
  if (now - lastDashboardUpdate < DASHBOARD_UPDATE_INTERVAL) {
    return
  }

  try {
    // Single shared connection for all dashboard clients
    await webSocketManager.connectForDashboard(["EURUSD", "US100", "GBPUSD"])
    lastDashboardUpdate = now

    // Get quotes for all symbols with error handling
    const quotes = {
      EURUSD: webSocketManager.getQuoteForSymbol("EURUSD"),
      US100: webSocketManager.getQuoteForSymbol("US100"),
      GBPUSD: webSocketManager.getQuoteForSymbol("GBPUSD"),
      connectionStatus: {
        connected: webSocketManager.isConnected(),
        lastUpdate: webSocketManager.getLastPriceUpdate(),
        stats: webSocketManager.getConnectionStats()
      }
    }

    // Broadcast to all connected dashboard clients with error handling
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify(quotes))
        } catch (sendError: any) {
          logger.warn(`Failed to send dashboard update to client: ${sendError.message}`)
        }
      }
    })

    // Log successful dashboard update
    logger.debug(`Dashboard updated successfully for ${wss.clients.size} clients`)

  } catch (error: any) {
    logger.error(`Dashboard WebSocket update failed: ${error.message}`)
    logError.system('dashboard_websocket', `Dashboard update error: ${error.message}`)

    // Send error status to clients
    const errorStatus = {
      error: true,
      message: "WebSocket connection failed",
      timestamp: now,
      connectionStatus: {
        connected: false,
        lastUpdate: webSocketManager.getLastPriceUpdate(),
        stats: webSocketManager.getConnectionStats()
      }
    }

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify(errorStatus))
        } catch (sendError: any) {
          logger.warn(`Failed to send error status to dashboard client: ${sendError.message}`)
        }
      }
    })
  }
}

wss.on("connection", (ws) => {
  logger.info(`Dashboard WebSocket client connected. Total clients: ${wss.clients.size}`)

  // Send initial data immediately with error handling
  updateDashboardClients().catch(error => {
    logger.error(`Failed to send initial dashboard data: ${error.message}`)
  })

  // Start shared timer if this is the first client
  if (wss.clients.size === 1 && !dashboardConnectionTimer) {
    dashboardConnectionTimer = setInterval(() => {
      updateDashboardClients().catch(error => {
        logger.error(`Dashboard timer update failed: ${error.message}`)
      })
    }, DASHBOARD_UPDATE_INTERVAL)
    logger.info("Dashboard WebSocket timer started")
  }

  ws.on("close", (code, reason) => {
    logger.info(`Dashboard WebSocket client disconnected (code: ${code}, reason: ${reason}). Remaining clients: ${wss.clients.size - 1}`)

    // Stop shared timer if no more clients
    if (wss.clients.size <= 1 && dashboardConnectionTimer) {
      clearInterval(dashboardConnectionTimer)
      dashboardConnectionTimer = null
      logger.info("Dashboard WebSocket timer stopped - no more clients")
    }
  })

  ws.on("error", (error) => {
    logger.error(`Dashboard WebSocket client error: ${error.message}`)
    logError.system('dashboard_websocket_client', `Client connection error: ${error.message}`)
  })
})

function broadcastLog(message: string) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "log", message }))
    }
  })
}

async function syncMissingOrder(order: any, retryCount = 0) {
  const maxRetries = 3;

  try {
    let diff_op_ob = null
    if (order.openPrice && order.obReferencePrice) {
      diff_op_ob = Math.abs(order.openPrice - order.obReferencePrice) * 10000
    }

    const orderData = {
      id: Number(order.id),
      login: order.login,
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      openPrice: order.openPrice,
      closePrice: order.closePrice,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss,
      openTime: order.openTime,
      closeTime: order.closeTime,
      profit: order.profit,
      swap: order.swaps,
      commission: 0,
      reality: order.reality,
      leverage: order.leverage,
      margin: order.margin,
      marginRate: order.marginRate,
      requestId: order.requestId || "",
      isFIFO: order.isFIFO || false,
      obReferencePrice: order.obReferencePrice || null,
      realSlPips: null,
      realTpPips: null,
      bidAtOpen: null,
      askAtOpen: null,
      spreadAtOpen: null,
      considerObReference: false,
      max_Size: order.max_size || null,
      maxobalert: order.maxobalert || order.maxObCandleAlert || null,
      filterFractal: order.filterfractal || null,
      findObType: order.findObType || null,
      fvgDistance: order.fvgDistance || null,
      durationInMinutes: order.closeTime ? calculateDurationInMinutes(order.openTime, order.closeTime) : null,
      diff_op_ob: diff_op_ob,
      timeframe: order.timeframe || null,
      exchange: order.exchange || "simplefx",
    }

    await upsertOrder(orderData)

    // Log successful sync if it was a retry
    if (retryCount > 0) {
      logger.info(`Successfully synced order ${order.id} after ${retryCount} retries`)
    }

  } catch (error) {
    const errorMessage = (error as Error).message;

    // Check if it's a schema-related error
    if (errorMessage.includes('no such column') || errorMessage.includes('has no column named')) {
      logger.warn(`Schema error detected for order ${order.id}, running database validation...`)

      try {
        // Import database functions
        const { validateDatabaseSchema, runDatabaseMigrations } = await import('./database')

        // Validate schema and run migrations if needed
        const validation = await validateDatabaseSchema()
        if (!validation.isValid) {
          logger.info(`Running database migrations for missing columns: ${validation.missingColumns.join(', ')}`)
          await runDatabaseMigrations()
        }

        // Retry the operation after schema fix
        if (retryCount < maxRetries) {
          logger.info(`Retrying order sync for ${order.id} after schema validation (attempt ${retryCount + 1}/${maxRetries})`)
          await setTimeoutPromise(1000 * (retryCount + 1)) // Exponential backoff
          return await syncMissingOrder(order, retryCount + 1)
        }
      } catch (migrationError) {
        logger.error(`Failed to run database migration for order ${order.id}:`, migrationError)
      }
    }

    // For other errors or if max retries reached
    if (retryCount < maxRetries && !errorMessage.includes('UNIQUE constraint failed')) {
      logger.warn(`Retrying order sync for ${order.id} (attempt ${retryCount + 1}/${maxRetries}): ${errorMessage}`)
      await setTimeoutPromise(1000 * (retryCount + 1)) // Exponential backoff
      return await syncMissingOrder(order, retryCount + 1)
    }

    // Log final error after all retries exhausted
    logger.error(`Error syncing missing order ${order.id} to database after ${retryCount} retries:`, error)
  }
}

// Helper function for getAccessToken
async function getAccessToken(useSecondaryApi = false): Promise<string> {
  try {
    if (useSecondaryApi) {
      const response = await axios.post(`${config.SIMPLEFX_API_URL}/auth/key`, {
        clientId: config.SIMPLEFX_API_KEY2,
        clientSecret: config.SIMPLEFX_API_SECRET2,
      })
      return response.data.data.token
    } else {
      const response = await axios.post(`${config.SIMPLEFX_API_URL}/auth/key`, {
        clientId: config.SIMPLEFX_API_KEY,
        clientSecret: config.SIMPLEFX_API_SECRET,
      })
      return response.data.data.token
    }
  } catch (error: any) {
    logger.error(`Error obtaining access token (${useSecondaryApi ? "secondary" : "primary"}):`, error.message)
    throw error
  }
}

// SSL certificate options
const options = {
  key: fs.readFileSync(path.join(__dirname, "../ssl/key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "../ssl/cert.pem")),
}

const httpsServer = https.createServer(options, app)

const port = config.PORT || 443

httpsServer
  .listen(port, "0.0.0.0", () => {
    logger.info(`HTTPS server listening at https://${config.SERVER_IP}:${port}`)
    broadcastLog(`HTTPS server listening at https://${config.SERVER_IP}:${port}`)
  })
  .on("error", (e: NodeJS.ErrnoException) => {
    logger.error(`Failed to start HTTPS server on port ${port}:`, e)
    broadcastLog(`Failed to start HTTPS server on port ${port}: ${e.message}`)
  })

httpsServer.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request)
  })
})

// Graceful shutdown
function gracefulShutdown(signal: string) {
  logger.info(`${signal} received. Starting graceful shutdown...`)
  broadcastLog(`${signal} received. Starting graceful shutdown...`)
  httpsServer.close(() => {
    logger.info("HTTPS server closed.")
    broadcastLog("HTTPS server closed.")
    webSocketManager.disconnect()
    logger.info("WebSocket connections closed.")
    broadcastLog("WebSocket connections closed.")
    process.exit(0)
  })
}

process.on("SIGINT", () => {
  logger.info("SIGINT received, but ignoring for now.")
})

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))

// Start the Bybit data sync
//startBybitDataSync();

logger.info("Server initialization complete.")
broadcastLog("Server initialization complete.")

// Add this new API endpoint for historical chart data from SimpleFX
app.get("/api/simplefx-chart-data", SecondaryAuth, async (req, res) => {
  try {
    const symbol = (req.query.symbol as string) || "EURUSD"
    const timeframe = (req.query.timeframe as string) || "1h"
    const loginNumber = (req.query.account as string) || "3979937"

    logger.info(`Fetching SimpleFX historical data for ${symbol} on ${timeframe} timeframe`)

    // Determine which API to use based on the account number
    const useSecondaryApi = loginNumber === "3979937"

    try {
      // Get access token
      const token = await getAccessToken(useSecondaryApi)

      // Convert timeframe to SimpleFX format
      const sfxTimeframe = convertTimeframeToSimpleFX(timeframe)

      // Calculate time range based on timeframe
      const now = Date.now()
      const from = now - getTimeframeMilliseconds(timeframe) * 200 // Get 200 candles worth of history

      // Make request to SimpleFX API for historical data
      const response = await axios.get(`${config.SIMPLEFX_API_URL}/market/candles/${symbol}/${sfxTimeframe}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        params: {
          from: Math.floor(from / 1000),
          to: Math.floor(now / 1000),
        },
      })

      if (response.data && response.data.data && Array.isArray(response.data.data.candles)) {
        // Transform the data to the format expected by the chart
        const candles = response.data.data.candles.map((candle: any) => ({
          time: candle.timestamp,
          open: Number.parseFloat(candle.open.toFixed(5)),
          high: Number.parseFloat(candle.high.toFixed(5)),
          low: Number.parseFloat(candle.low.toFixed(5)),
          close: Number.parseFloat(candle.close.toFixed(5)),
        }))

        logger.info(`Successfully fetched ${candles.length} candles from SimpleFX API`)
        return res.json(candles)
      } else {
        throw new Error("Invalid response format from SimpleFX API")
      }
    } catch (apiError: any) {
      logger.error(`Error fetching data from SimpleFX API: ${apiError.message}`)
      logger.error("Falling back to generated sample data")

      // Fallback to generated sample data
      const candles = generateSampleCandles(symbol, timeframe)
      res.json(candles)
    }
  } catch (error) {
    logger.error(`Error in /api/simplefx-chart-data: ${error instanceof Error ? error.message : String(error)}`)
    res.status(500).json({ error: "Failed to fetch chart data" })
  }
})

// Helper function to convert our timeframe format to SimpleFX format
function convertTimeframeToSimpleFX(timeframe: string): string {
  switch (timeframe) {
    case "1m":
      return "M1"
    case "5m":
      return "M5"
    case "15m":
      return "M15"
    case "1h":
      return "H1"
    case "4h":
      return "H4"
    case "1d":
      return "D1"
    default:
      return "H1"
  }
}

// Helper function to get milliseconds for a timeframe
function getTimeframeMilliseconds(timeframe: string): number {
  switch (timeframe) {
    case "1m":
      return 60 * 1000
    case "5m":
      return 5 * 60 * 1000
    case "15m":
      return 15 * 60 * 1000
    case "1h":
      return 60 * 60 * 1000
    case "4h":
      return 4 * 60 * 60 * 1000
    case "1d":
      return 24 * 60 * 60 * 1000
    default:
      return 60 * 60 * 1000
  }
}

export { app }