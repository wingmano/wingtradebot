import sqlite3 from "sqlite3"
import { open } from "sqlite"
import { logError } from "./utils/logger"

// Database connection
let db: any

function getPipValuee(symbol: string): number {
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

export async function initializeDatabase() {
  if (!db) {
    db = await open({
      filename: "./sfx_historical_orders.db",
      driver: sqlite3.Database,
    })

    await db.exec(`
      CREATE TABLE IF NOT EXISTS sfx_historical_orders (
        order_id TEXT PRIMARY KEY,
        login TEXT,
        symbol TEXT,
        side TEXT,
        volume REAL,
        open_price REAL,
        close_price REAL,
        take_profit REAL,
        stop_loss REAL,
        open_time INTEGER,
        close_time INTEGER,
        profit REAL,
        swap REAL,
        commission REAL,
        reality TEXT,
        leverage INTEGER,
        margin REAL,
        margin_rate REAL,
        request_id TEXT,
        is_fifo INTEGER,
        ob_reference_price REAL,
        real_sl_pips REAL,
        real_tp_pips REAL,
        bid_at_open REAL,
        ask_at_open REAL,
        spread_at_open REAL,
        consider_ob_reference INTEGER,
        max_size REAL,
        duration_in_minutes INTEGER,
        last_update_time INTEGER,
        alert_id TEXT,
        maxobalert INTEGER DEFAULT NULL,
        alert_threshold REAL,
        diff_op_ob REAL,
        timeframe TEXT,
        exchange TEXT,
        findObType TEXT,
        filterFvgs INTEGER,
        fvgDistance REAL,
        lineHeight TEXT,
        filterFractal TEXT
      );
    `);

    // Create account_settings table if it doesn't exist
    await db.exec(`
      CREATE TABLE IF NOT EXISTS account_settings (
        login INTEGER PRIMARY KEY,
        trading_mode TEXT NOT NULL DEFAULT 'NORMAL',
        asia_session INTEGER DEFAULT 1,
        london_session INTEGER DEFAULT 1,
        new_york_session INTEGER DEFAULT 1,
        limbo_session INTEGER DEFAULT 1,
        exclusive_mode INTEGER DEFAULT 0,
        last_updated INTEGER NOT NULL
      );
    `)

    // Create processed_webhook_ids table for permanent duplicate detection
    await db.exec(`
      CREATE TABLE IF NOT EXISTS processed_webhook_ids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        processed_at INTEGER NOT NULL,
        UNIQUE(alert_id, account_number)
      );
    `)

    // Create index for faster duplicate lookups
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_processed_webhook_ids_lookup 
      ON processed_webhook_ids(alert_id, account_number);
    `)

    // Run schema validation and migrations after initializing the database
    console.log('🔍 Validating database schema...')
    const validation = await validateDatabaseSchema()
    
    if (!validation.isValid) {
      console.log('🔧 Running database migrations to fix schema...')
      await runDatabaseMigrations()
    } else {
      console.log('✅ Database schema validation passed')
    }
    
    // Run legacy migrations for account settings
    await migrateAccountSettings()
    await migrateMaxobalertColumn()
  }
  return db
}

// Add a migration function to ensure existing accounts have session columns
export async function migrateAccountSettings() {
  try {
    // Check if we need to add session columns
    const tableInfo = await db.all("PRAGMA table_info(account_settings);")
    const hasAsiaSession = tableInfo.some((col: any) => col.name === "asia_session")

    if (!hasAsiaSession) {
      // Add session columns if they don't exist
      await db.exec(`
        ALTER TABLE account_settings ADD COLUMN asia_session INTEGER DEFAULT 1;
        ALTER TABLE account_settings ADD COLUMN london_session INTEGER DEFAULT 1;
        ALTER TABLE account_settings ADD COLUMN new_york_session INTEGER DEFAULT 1;
        ALTER TABLE account_settings ADD COLUMN limbo_session INTEGER DEFAULT 1;
      `)
    }

    // Check if we need to add exclusive_mode column
    const hasExclusiveMode = tableInfo.some((col: any) => col.name === "exclusive_mode")

    if (!hasExclusiveMode) {
      // Add exclusive_mode column if it doesn't exist
      await db.exec(`
        ALTER TABLE account_settings ADD COLUMN exclusive_mode INTEGER DEFAULT 0;
      `)
    }

    return true
  } catch (error) {
    logError.system('database_migration', (error as Error).message)
    return false
  }
}

/**
 * Add a missing column to a table safely
 * Requirements: 2.2 - Add individual columns with proper error handling
 */
export async function addMissingColumn(
  tableName: string, 
  columnName: string, 
  columnType: string, 
  defaultValue: string | null = null
): Promise<{success: boolean, error?: string}> {
  try {
    // Check if column already exists
    const exists = await columnExists(tableName, columnName)
    if (exists) {
      console.log(`✓ Column ${columnName} already exists in ${tableName}`)
      return { success: true }
    }

    // Build ALTER TABLE statement
    const defaultClause = defaultValue ? `DEFAULT ${defaultValue}` : ''
    const sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType} ${defaultClause}`.trim()
    
    await db.exec(sql)
    console.log(`✓ Successfully added column ${columnName} to ${tableName}`)
    
    return { success: true }
  } catch (error) {
    const errorMessage = `Failed to add column ${columnName} to ${tableName}: ${(error as Error).message}`
    logError.system('addMissingColumn', errorMessage)
    return { success: false, error: errorMessage }
  }
}

/**
 * Run all database migrations to ensure schema is up to date
 * Requirements: 2.1, 2.3 - Orchestrate migrations with logging
 */
export async function runDatabaseMigrations(): Promise<{success: boolean, results: Array<{column: string, success: boolean, error?: string}>}> {
  console.log('🔄 Starting database migrations...')
  
  try {
    // First validate current schema
    const validation = await validateDatabaseSchema()
    
    if (validation.isValid) {
      console.log('✓ Database schema is already up to date')
      return { success: true, results: [] }
    }

    console.log(`📋 Found ${validation.missingColumns.length} missing columns to migrate`)
    
    // Get expected columns to know types and defaults
    const expectedColumns = getExpectedColumns()
    const results: Array<{column: string, success: boolean, error?: string}> = []
    
    // Add each missing column
    for (const missingColumnName of validation.missingColumns) {
      const expectedCol = expectedColumns.find(col => col.name === missingColumnName)
      
      if (!expectedCol) {
        const error = `Unknown column ${missingColumnName} - not in expected schema`
        console.log(`✗ ${error}`)
        results.push({ column: missingColumnName, success: false, error })
        continue
      }

      console.log(`🔧 Adding missing column: ${missingColumnName}`)
      const result = await addMissingColumn(
        'sfx_historical_orders',
        expectedCol.name,
        expectedCol.type,
        expectedCol.defaultValue
      )
      
      results.push({
        column: missingColumnName,
        success: result.success,
        error: result.error
      })
    }

    // Check final results
    const successCount = results.filter(r => r.success).length
    const failureCount = results.filter(r => !r.success).length
    
    console.log(`📊 Migration completed: ${successCount} successful, ${failureCount} failed`)
    
    if (failureCount > 0) {
      console.log('❌ Some migrations failed:')
      results.filter(r => !r.success).forEach(r => {
        console.log(`  - ${r.column}: ${r.error}`)
      })
    }

    // Final validation
    const finalValidation = await validateDatabaseSchema()
    const overallSuccess = finalValidation.isValid
    
    if (overallSuccess) {
      console.log('✅ All database migrations completed successfully')
      logError.system('runDatabaseMigrations', `Migration completed successfully: ${successCount} columns added`)
    } else {
      console.log('⚠️  Some columns are still missing after migration')
      logError.system('runDatabaseMigrations', `Migration partially failed: ${failureCount} columns failed, remaining missing: ${finalValidation.missingColumns.join(', ')}`)
    }

    return { success: overallSuccess, results }
    
  } catch (error) {
    const errorMessage = `Migration process failed: ${(error as Error).message}`
    logError.system('runDatabaseMigrations', errorMessage)
    console.log(`❌ ${errorMessage}`)
    return { success: false, results: [] }
  }
}

// Migration function to add maxobalert column to sfx_historical_orders table
export async function migrateMaxobalertColumn() {
  try {
    // Check if maxobalert column exists
    const hasMaxobalert = await columnExists('sfx_historical_orders', 'maxobalert')
    
    if (!hasMaxobalert) {
      // Add maxobalert column with INTEGER type and DEFAULT NULL
      await db.exec(`
        ALTER TABLE sfx_historical_orders ADD COLUMN maxobalert INTEGER DEFAULT NULL;
      `)
      console.log('Successfully added maxobalert column to sfx_historical_orders table')
      return true
    } else {
      console.log('maxobalert column already exists in sfx_historical_orders table')
      return true
    }
  } catch (error) {
    logError.system('migrateMaxobalertColumn', `Failed to add maxobalert column: ${(error as Error).message}`)
    return false
  }
}

export async function getOrderById(orderId: number) {
  const sql = `SELECT * FROM sfx_historical_orders WHERE order_id = ?`;
  try {
    const order = await db.get(sql, [Number(orderId)]); // Convert to number explicitly
    if (!order) {
      console.warn(`Order ${orderId} not found in database.`);
    }
    return order;
  } catch (error) {
    console.error(`Error fetching order ${orderId}:`, error);
    return null;
  }
}

export async function updateClosedOrder(orderId: string, closePrice: number, closeTime: number, profit: number) {
  const sql = `
    UPDATE sfx_historical_orders
    SET close_price = ?, close_time = ?, profit = ?, duration_in_minutes = ?
    WHERE order_id = ?
  `

  try {
    const order = await getOrderById(Number(orderId))
    if (!order) {
      throw new Error(`Order ${orderId} not found`)
    }

    const durationInMinutes = Math.round((closeTime - order.open_time) / 60000)

    await db.run(sql, [closePrice, closeTime, profit, durationInMinutes, orderId])
  } catch (error) {
    logError.system('updateClosedOrder', (error as Error).message)
    throw error
  }
}

export async function getRecentOrders(loginNumber: string, limit = 50) {
  const sql = `
    SELECT * FROM sfx_historical_orders
    WHERE login = ?
    ORDER BY open_time DESC
    LIMIT ?
  `

  try {
    const orders = await db.all(sql, [loginNumber, limit])
    return orders
  } catch (error) {
    logError.system('getRecentOrders', (error as Error).message)
    return []
  }
}

export async function updateMaxSize(loginNumber: string, max_Size: number) {
  const sql = `
    UPDATE sfx_historical_orders
    SET max_size = ?
    WHERE login = ? AND (max_size IS NULL OR max_size != ?)
  `

  try {
    await db.run(sql, [max_Size, loginNumber, max_Size])
  } catch (error) {
    logError.system('updateMaxSize', (error as Error).message)
    throw error
  }
}

export async function upsertOrder(orderData: any) {
  //logger.debug(`Upserting order: ${JSON.stringify(orderData, null, 2)}`);

  // Calculate duration_in_minutes if both open_time and close_time are present and valid
  let duration_in_minutes = null;
  if (
    orderData.openTime &&
    orderData.closeTime &&
    orderData.openTime > 0 &&
    orderData.closeTime > 0 &&
    orderData.closeTime > orderData.openTime
  ) {
    duration_in_minutes = Math.round((orderData.closeTime - orderData.openTime) / 60000);
  }

  // Get pip value for the symbol
  const pipValue = getPipValuee(orderData.symbol);

  // Calculate TP and SL pips if not provided
  let real_tp_pips = orderData.realTpPips;
  let real_sl_pips = orderData.realSlPips;

  if (orderData.takeProfit && orderData.openPrice && !real_tp_pips) {
    real_tp_pips = Math.abs(orderData.takeProfit - orderData.openPrice) / pipValue;
  }

  if (orderData.stopLoss && orderData.openPrice && !real_sl_pips) {
    real_sl_pips = Math.abs(orderData.stopLoss - orderData.openPrice) / pipValue;
  }

  let diff_op_ob = null;
  if (orderData.openPrice && orderData.obReferencePrice) {
    diff_op_ob = Math.abs(orderData.openPrice - orderData.obReferencePrice) / pipValue;
  }

  // Rest of the function remains unchanged
  const sql = `
    INSERT INTO sfx_historical_orders (
      order_id, login, symbol, side, volume, open_price, close_price, take_profit, stop_loss,
      open_time, close_time, profit, swap, commission, reality, leverage, margin, margin_rate,
      request_id, is_fifo, ob_reference_price, real_sl_pips, real_tp_pips, bid_at_open,
      ask_at_open, spread_at_open, consider_ob_reference, max_size, duration_in_minutes, last_update_time,
      alert_id, maxobalert, diff_op_ob, timeframe, exchange, findObType, filterFvgs, fvgDistance, lineHeight, filterFractal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      login = excluded.login,
      symbol = excluded.symbol,
      side = excluded.side,
      volume = excluded.volume,
      open_price = excluded.open_price,
      close_price = COALESCE(excluded.close_price, close_price),
      take_profit = COALESCE(excluded.take_profit, take_profit),
      stop_loss = COALESCE(excluded.stop_loss, stop_loss),
      open_time = excluded.open_time,
      close_time = COALESCE(excluded.close_time, close_time),
      profit = COALESCE(excluded.profit, profit),
      swap = COALESCE(excluded.swap, swap),
      commission = COALESCE(excluded.commission, commission),
      reality = excluded.reality,
      leverage = COALESCE(excluded.leverage, leverage),
      margin = COALESCE(excluded.margin, margin),
      margin_rate = COALESCE(excluded.margin_rate, margin_rate),
      request_id = COALESCE(excluded.request_id, request_id),
      is_fifo = COALESCE(excluded.is_fifo, is_fifo),
      ob_reference_price = COALESCE(excluded.ob_reference_price, ob_reference_price),
      real_sl_pips = COALESCE(excluded.real_sl_pips, real_sl_pips),
      real_tp_pips = COALESCE(excluded.real_tp_pips, real_tp_pips),
      bid_at_open = COALESCE(excluded.bid_at_open, bid_at_open),
      ask_at_open = COALESCE(excluded.ask_at_open, ask_at_open),
      spread_at_open = COALESCE(excluded.spread_at_open, spread_at_open),
      consider_ob_reference = COALESCE(excluded.consider_ob_reference, consider_ob_reference),
      max_size = COALESCE(excluded.max_size, max_size),
      duration_in_minutes = COALESCE(excluded.duration_in_minutes, duration_in_minutes),
      last_update_time = excluded.last_update_time,
      alert_id = COALESCE(excluded.alert_id, alert_id),
      maxobalert = COALESCE(excluded.maxobalert, maxobalert),
      diff_op_ob = COALESCE(excluded.diff_op_ob, diff_op_ob),
      timeframe = COALESCE(excluded.timeframe, timeframe),
      exchange = COALESCE(excluded.exchange, exchange),
      findObType = COALESCE(excluded.findObType, findObType),
      filterFvgs = COALESCE(excluded.filterFvgs, filterFvgs),
      fvgDistance = COALESCE(excluded.fvgDistance, fvgDistance),
      lineHeight = COALESCE(excluded.lineHeight, lineHeight),
      filterFractal = COALESCE(excluded.filterFractal, filterFractal)
  `;

  const params = [
    Number(orderData.id),
    orderData.login,
    orderData.symbol,
    orderData.side,
    orderData.volume,
    orderData.openPrice,
    orderData.closePrice,
    orderData.takeProfit,
    orderData.stopLoss,
    orderData.openTime,
    orderData.closeTime,
    orderData.profit,
    orderData.swap,
    orderData.commission || 0,
    orderData.reality,
    orderData.leverage,
    orderData.margin,
    orderData.marginRate,
    orderData.requestId,
    orderData.isFIFO ? 1 : 0,
    orderData.obReferencePrice || null,
    real_sl_pips,
    real_tp_pips,
    orderData.bidAtOpen || null,
    orderData.askAtOpen || null,
    orderData.spreadAtOpen || null,
    orderData.considerObReference ? 1 : 0,
    orderData.max_Size || null,
    duration_in_minutes,
    Date.now(),
    orderData.alertId || null,
    orderData.maxobalert || null,
    diff_op_ob,
    orderData.timeframe || null,
    orderData.exchange || 'simplefx',
    orderData.findObType || null,
    orderData.filterFvgs ? 1 : 0,
    orderData.fvgDistance || null,
    orderData.lineHeight || null,
    orderData.filterFractal || null
  ];

  try {
    await db.run(sql, params);
    //logger.debug(`Order ${orderData.id} upserted in the database.`);
  } catch (error) {
    //logger.error(`Error upserting order ${orderData.id} in the database:`, error);
    throw error;
  }
}

export async function updateExistingOrders() {
  const sql = `
    UPDATE sfx_historical_orders
    SET exchange = COALESCE(exchange, 'simplefx')
    WHERE exchange IS NULL
  `

  try {
    const result = await db.run(sql)
  } catch (error) {
    logError.system('updateExistingOrders', (error as Error).message)
    throw error
  }
}

export async function getOrderStatistics(accountId: string, startDate: string, endDate: string): Promise<any> {
  const db = await initializeDatabase()

  // Convert dates to timestamps
  const startTimestamp = new Date(startDate).getTime()
  const endTimestamp = new Date(endDate).getTime()

  const sql = `
    SELECT 
      COUNT(*) as total_trades,
      SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as winning_trades,
      SUM(CASE WHEN profit < 0 THEN 1 ELSE 0 END) as losing_trades,
      SUM(profit) as total_profit,
      AVG(CASE WHEN profit > 0 THEN profit ELSE NULL END) as avg_win,
      AVG(CASE WHEN profit < 0 THEN profit ELSE NULL END) as avg_loss,
      AVG(duration_in_minutes) as avg_duration
    FROM sfx_historical_orders
    WHERE login = ? AND open_time >= ? AND open_time <= ? AND close_time IS NOT NULL
  `

  try {
    const stats = await db.get(sql, [accountId, startTimestamp, endTimestamp])
    return stats
  } catch (error) {
    logError.system('getOrderStatistics', (error as Error).message)
    return null
  }
}

export async function setAccountTradingMode(loginNumber: string, tradingMode: string): Promise<boolean> {
  try {
    const db = await initializeDatabase()

    // Check if settings exist for this account
    const settings = await db.get(`SELECT * FROM account_settings WHERE login = ?`, [loginNumber])

    if (!settings) {
      // If no settings exist, create new record with default session settings
      await db.run(
        `INSERT INTO account_settings (login, trading_mode, asia_session, london_session, new_york_session, limbo_session, exclusive_mode, last_updated)
         VALUES (?, ?, 1, 1, 1, 1, 0, ?)`,
        [loginNumber, tradingMode, Date.now()],
      )
    } else {
      // Update existing record
      await db.run(`UPDATE account_settings SET trading_mode = ?, last_updated = ? WHERE login = ?`, [
        tradingMode,
        Date.now(),
        loginNumber,
      ])
    }

    return true
  } catch (error) {
    logError.system('setAccountTradingMode', (error as Error).message)
    return false
  }
}

export async function updateExclusiveMode(loginNumber: string, enabled: boolean): Promise<boolean> {
  try {
    const db = await initializeDatabase()

    // Check if settings exist for this account
    const settings = await db.get(`SELECT * FROM account_settings WHERE login = ?`, [loginNumber])

    if (!settings) {
      // If no settings exist, create new record with default session settings
      await db.run(
        `INSERT INTO account_settings (login, trading_mode, asia_session, london_session, new_york_session, limbo_session, exclusive_mode, last_updated)
         VALUES (?, 'NORMAL', 1, 1, 1, 1, ?, ?)`,
        [loginNumber, enabled ? 1 : 0, Date.now()],
      )
    } else {
      // Update existing record
      await db.run(`UPDATE account_settings SET exclusive_mode = ?, last_updated = ? WHERE login = ?`, [
        enabled ? 1 : 0,
        Date.now(),
        loginNumber,
      ])
    }

    return true
  } catch (error) {
    logError.system('updateExclusiveMode', (error as Error).message)
    return false
  }
}

export async function getAllAccountSettings() {
  try {
    const settings = await db.all(`SELECT * FROM account_settings`)
    return settings
  } catch (error) {
    logError.system('getAllAccountSettings', (error as Error).message)
    return []
  }
}

export async function getAccountSettings(loginNumber: string) {
  try {
    // Check if the account has settings
    const settings = await db.get(`SELECT * FROM account_settings WHERE login = ?`, [loginNumber])

    // If no settings found, create default settings
    if (!settings) {
      await setAccountTradingMode(loginNumber, "NORMAL")
      return {
        login: loginNumber,
        trading_mode: "NORMAL",
        asia_session: 1,
        london_session: 1,
        new_york_session: 1,
        limbo_session: 1,
        exclusive_mode: 0,
        last_updated: Date.now(),
      }
    }

    return settings
  } catch (error) {
    logError.system('getAccountSettings', `Error for ${loginNumber}: ${(error as Error).message}`)
    // Return default settings in case of error
    return {
      login: loginNumber,
      trading_mode: "NORMAL",
      asia_session: 1,
      london_session: 1,
      new_york_session: 1,
      limbo_session: 1,
      exclusive_mode: 0,
      last_updated: Date.now(),
    }
  }
}

export async function updateSessionSettings(
  loginNumber: string,
  sessionSettings: {
    asia_session?: number
    london_session?: number
    new_york_session?: number
    limbo_session?: number
  },
) {
  try {
    // Get current settings
    const currentSettings = await getAccountSettings(loginNumber)

    // Prepare update fields
    const updates = []
    const params = []

    if (sessionSettings.asia_session !== undefined) {
      updates.push("asia_session = ?")
      params.push(sessionSettings.asia_session)
    }

    if (sessionSettings.london_session !== undefined) {
      updates.push("london_session = ?")
      params.push(sessionSettings.london_session)
    }

    if (sessionSettings.new_york_session !== undefined) {
      updates.push("new_york_session = ?")
      params.push(sessionSettings.new_york_session)
    }

    if (sessionSettings.limbo_session !== undefined) {
      updates.push("limbo_session = ?")
      params.push(sessionSettings.limbo_session)
    }

    // Add last_updated and login
    updates.push("last_updated = ?")
    params.push(Date.now())
    params.push(loginNumber)

    // Update the settings
    if (updates.length > 0) {
      const sql = `UPDATE account_settings SET ${updates.join(", ")} WHERE login = ?`
      await db.run(sql, params)
    }

    return true
  } catch (error) {
    logError.system('updateSessionSettings', `Error for ${loginNumber}: ${(error as Error).message}`)
    return false
  }
}

export function getCurrentTradingSession(): string | null {
  const now = new Date()
  const utcHour = now.getUTCHours()
  
  // London session: 06:00-14:00 UTC (03:00-11:00 BRT)
  if (utcHour >= 6 && utcHour < 14) {
    return "london_session"
  }
  
  // New York session: 12:00-20:00 UTC (09:00-17:00 BRT)
  if (utcHour >= 12 && utcHour < 20) {
    return "new_york_session"
  }
  
  // Limbo session: 02:00-08:00 UTC (23:00-05:00 BRT)
  if ((utcHour >= 2 && utcHour < 8)) {
      return "limbo_session"
  }
  
  // Asia session: 22:00-06:00 UTC (17:00-03:00 BRT) - cruza meia-noite
  if (utcHour >= 22 || utcHour < 6) {
    return "asia_session"
  }
  
  return null
}

export async function getOrders(loginNumber: string) {
  const sql = `
    SELECT * FROM sfx_historical_orders
    WHERE login = ?
    ORDER BY open_time DESC
  `

  try {
    const orders = await db.all(sql, [loginNumber])
    return orders
  } catch (error) {
    logError.system('getOrders', `Error for ${loginNumber}: ${(error as Error).message}`)
    return []
  }
}

export async function getTableInfo() {
  try {
    const tableInfo = await db.all("PRAGMA table_info(sfx_historical_orders);")
    console.log("Table structure:", JSON.stringify(tableInfo, null, 2))
    return tableInfo
  } catch (error) {
    console.error("Error fetching table info:", error)
    throw error
  }
}

export async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  try {
    const tableInfo = await db.all(`PRAGMA table_info(${tableName});`)
    return tableInfo.some((col: any) => col.name === columnName)
  } catch (error) {
    logError.system('columnExists', `Error checking column ${columnName} in ${tableName}: ${(error as Error).message}`)
    return false
  }
}

/**
 * Get the expected columns for the sfx_historical_orders table
 * Requirements: 3.1 - Define required schema
 */
export function getExpectedColumns(): Array<{name: string, type: string, defaultValue: string | null}> {
  return [
    { name: 'order_id', type: 'TEXT', defaultValue: null },
    { name: 'login', type: 'TEXT', defaultValue: null },
    { name: 'symbol', type: 'TEXT', defaultValue: null },
    { name: 'side', type: 'TEXT', defaultValue: null },
    { name: 'volume', type: 'REAL', defaultValue: null },
    { name: 'open_price', type: 'REAL', defaultValue: null },
    { name: 'close_price', type: 'REAL', defaultValue: null },
    { name: 'take_profit', type: 'REAL', defaultValue: null },
    { name: 'stop_loss', type: 'REAL', defaultValue: null },
    { name: 'open_time', type: 'INTEGER', defaultValue: null },
    { name: 'close_time', type: 'INTEGER', defaultValue: null },
    { name: 'profit', type: 'REAL', defaultValue: null },
    { name: 'swap', type: 'REAL', defaultValue: null },
    { name: 'commission', type: 'REAL', defaultValue: null },
    { name: 'reality', type: 'TEXT', defaultValue: null },
    { name: 'leverage', type: 'INTEGER', defaultValue: null },
    { name: 'margin', type: 'REAL', defaultValue: null },
    { name: 'margin_rate', type: 'REAL', defaultValue: null },
    { name: 'request_id', type: 'TEXT', defaultValue: null },
    { name: 'is_fifo', type: 'INTEGER', defaultValue: null },
    { name: 'ob_reference_price', type: 'REAL', defaultValue: null },
    { name: 'real_sl_pips', type: 'REAL', defaultValue: null },
    { name: 'real_tp_pips', type: 'REAL', defaultValue: null },
    { name: 'bid_at_open', type: 'REAL', defaultValue: null },
    { name: 'ask_at_open', type: 'REAL', defaultValue: null },
    { name: 'spread_at_open', type: 'REAL', defaultValue: null },
    { name: 'consider_ob_reference', type: 'INTEGER', defaultValue: null },
    { name: 'max_size', type: 'REAL', defaultValue: null },
    { name: 'duration_in_minutes', type: 'INTEGER', defaultValue: null },
    { name: 'last_update_time', type: 'INTEGER', defaultValue: null },
    { name: 'alert_id', type: 'TEXT', defaultValue: null },
    { name: 'maxobalert', type: 'INTEGER', defaultValue: 'NULL' },
    { name: 'alert_threshold', type: 'REAL', defaultValue: null },
    { name: 'diff_op_ob', type: 'REAL', defaultValue: null },
    { name: 'timeframe', type: 'TEXT', defaultValue: null },
    { name: 'exchange', type: 'TEXT', defaultValue: null },
    { name: 'findObType', type: 'TEXT', defaultValue: null },
    { name: 'filterFvgs', type: 'INTEGER', defaultValue: null },
    { name: 'fvgDistance', type: 'REAL', defaultValue: null },
    { name: 'lineHeight', type: 'TEXT', defaultValue: null },
    { name: 'filterFractal', type: 'TEXT', defaultValue: null }
  ]
}

/**
 * Validate that the database schema matches expected structure
 * Requirements: 3.1, 3.2 - Check for missing columns and log details
 */
export async function validateDatabaseSchema(): Promise<{isValid: boolean, missingColumns: string[], errors: string[]}> {
  try {
    const expectedColumns = getExpectedColumns()
    const actualColumns = await db.all("PRAGMA table_info(sfx_historical_orders);")
    const missingColumns: string[] = []
    const errors: string[] = []

    // Check for missing columns
    for (const expectedCol of expectedColumns) {
      const actualCol = actualColumns.find((col: any) => col.name === expectedCol.name)
      if (!actualCol) {
        missingColumns.push(expectedCol.name)
      }
    }

    const isValid = missingColumns.length === 0

    if (isValid) {
      console.log('✓ Database schema validation passed - all expected columns exist')
    } else {
      console.log(`✗ Database schema validation failed - missing columns: ${missingColumns.join(', ')}`)
      errors.push(`Missing columns: ${missingColumns.join(', ')}`)
    }

    return {
      isValid,
      missingColumns,
      errors
    }
  } catch (error) {
    const errorMessage = `Schema validation failed: ${(error as Error).message}`
    logError.system('validateDatabaseSchema', errorMessage)
    return {
      isValid: false,
      missingColumns: [],
      errors: [errorMessage]
    }
  }
}

/**
 * Store webhook processing outcome in database
 * Requirements: 4.1, 4.2 - Store REJECTED and ERROR orders with reasons
 */
export async function storeWebhookOutcome(
  alertId: string,
  accountNumber: string,
  symbol: string,
  action: string,
  size: number,
  outcome: string,
  reason?: string,
  orderId?: string
): Promise<void> {
  try {
    const database = await initializeDatabase();
    await database.run(`
      INSERT INTO webhook_outcomes (
        alert_id, account_number, symbol, action, size, outcome, reason, order_id, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      alertId,
      accountNumber,
      symbol,
      action,
      size,
      outcome,
      reason || null,
      orderId || null,
      Date.now()
    ]);
  } catch (error: any) {
    console.error(`Failed to store webhook outcome: ${error.message}`);
  }
}

/**
 * Get webhook outcomes for dashboard display
 * Requirements: 4.4, 4.5 - Show rejection/error reasons in dashboard
 */
export async function getWebhookOutcomes(
  accountNumber: string,
  limit: number = 100,
  includeOutcomes: string[] = ['PLACED', 'REJECTED', 'ERROR']
): Promise<any[]> {
  try {
    const database = await initializeDatabase();
    const placeholders = includeOutcomes.map(() => '?').join(',');
    const sql = `
      SELECT * FROM webhook_outcomes 
      WHERE account_number = ? AND outcome IN (${placeholders})
      ORDER BY processed_at DESC 
      LIMIT ?
    `;
    const params = [accountNumber, ...includeOutcomes, limit];
    const outcomes = await database.all(sql, params);
    return outcomes;
  } catch (error: any) {
    console.error(`Error fetching webhook outcomes for ${accountNumber}: ${error.message}`);
    return [];
  }
}

// Enhanced function to check both processed IDs and historical orders for duplicates
export async function orderExistsWithAlertId(alertId: string, loginNumber: string): Promise<boolean> {
  try {
    const db = await initializeDatabase();
    
    // First check: Look in processed_webhook_ids table (permanent storage)
    const processedId = await db.get(
      `SELECT * FROM processed_webhook_ids WHERE alert_id = ? AND account_number = ?`,
      [alertId, loginNumber]
    );
    
    if (processedId) {
      return true; // Already processed
    }
    
    // Second check: Look in historical orders (fallback for existing data)
    const order = await db.get(
      `SELECT * FROM sfx_historical_orders WHERE alert_id = ? AND login = ?`,
      [alertId, loginNumber]
    );
    
    return !!order; // Returns true if an order with this alert ID exists for this account
  } catch (error) {
    logError.system('orderExistsWithAlertId', `Error checking alert ID ${alertId} for account ${loginNumber}: ${(error as Error).message}`);
    return false; // Default to false on error to avoid blocking trades
  }
}

export { db }