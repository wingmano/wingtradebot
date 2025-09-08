import WebSocket from "ws"
import { logger } from "./logger"
import { EventEmitter } from "events"

interface MarketData {
  symbol: string
  bid: number
  ask: number
  timestamp: number
  isStale: boolean
}

interface ConnectionInfo {
  ws: WebSocket
  symbols: Set<string>
  lastActivity: number
  requestId: number
  quotes: Map<string, { bid: number; ask: number; timestamp: number }>
  disconnectTimer?: NodeJS.Timeout
  createdAt: number
  reconnectCount: number
}

interface ConnectionStats {
  totalConnections: number
  activeConnections: number
  totalReconnects: number
  averageConnectionAge: number
  symbolsTracked: string[]
  lastQuoteUpdate: number
}

export class WebSocketManager extends EventEmitter {
  private connections: Map<string, ConnectionInfo> = new Map()
  private readonly CONNECTION_TIMEOUT = 30000 // 30 seconds
  private readonly PRICE_STALE_THRESHOLD = 10000 // 10 seconds
  private readonly WS_URL = "wss://web-quotes-core.simplefx.com/websocket/quotes"
  private readonly MAX_CONNECTION_RETRIES = 3
  private readonly MAX_ORDER_RETRIES = 3
  private readonly CONNECTION_RETRY_DELAY_BASE = 1000 // 1 second base delay
  private readonly QUOTE_TIMEOUT = 8000 // 8 seconds
  private totalReconnects = 0

  constructor() {
    super()
  }

  /**
   * Get market data for order placement - establishes connection if needed with retry logic
   */
  public async connectForOrder(symbol: string, maxRetries: number = this.MAX_ORDER_RETRIES): Promise<MarketData> {
    let lastError: Error | null = null
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`WebSocketManager: Attempting to get market data for ${symbol} (attempt ${attempt}/${maxRetries})`)
        
        const connectionKey = this.getConnectionKey([symbol])
        let connection = this.connections.get(connectionKey)

        // Check if we need a new connection
        if (!connection || !this.isConnectionHealthy(connection)) {
          logger.info(`WebSocketManager: Creating new connection for ${symbol}`)
          
          // Clean up old connection if it exists
          if (connection) {
            this.closeConnection(connection)
            this.connections.delete(connectionKey)
          }
          
          connection = await this.createConnection([symbol])
          this.connections.set(connectionKey, connection)
        }

        // Ensure symbol is subscribed
        if (!connection.symbols.has(symbol)) {
          this.subscribeToSymbol(connection, symbol)
        }

        // Check if we have a recent quote first
        const existingQuote = connection.quotes.get(symbol)
        if (existingQuote && !this.isQuoteStale(existingQuote.timestamp)) {
          logger.info(`WebSocketManager: Using existing fresh quote for ${symbol}`)
          this.resetDisconnectTimer(connection)
          return {
            symbol,
            bid: existingQuote.bid,
            ask: existingQuote.ask,
            timestamp: existingQuote.timestamp,
            isStale: false
          }
        }

        // Wait for fresh quote with timeout
        const quote = await this.waitForQuote(connection, symbol, this.QUOTE_TIMEOUT)
        
        // Double-check quote freshness after receiving it
        if (this.isQuoteStale(quote.timestamp)) {
          throw new Error(`Received stale quote for ${symbol} (age: ${(Date.now() - quote.timestamp) / 1000}s)`)
        }
        
        // Reset disconnect timer since connection is being used
        this.resetDisconnectTimer(connection)

        logger.info(`WebSocketManager: Successfully obtained fresh market data for ${symbol}`)
        return {
          symbol,
          bid: quote.bid,
          ask: quote.ask,
          timestamp: quote.timestamp,
          isStale: false
        }
        
      } catch (error: any) {
        lastError = error
        logger.warn(`WebSocketManager: Attempt ${attempt} failed for ${symbol}: ${error.message}`)
        
        // Clean up failed connection
        const connectionKey = this.getConnectionKey([symbol])
        const connection = this.connections.get(connectionKey)
        if (connection) {
          this.closeConnection(connection)
          this.connections.delete(connectionKey)
        }
        
        // If this isn't the last attempt, wait before retrying
        if (attempt < maxRetries) {
          const delay = attempt * this.CONNECTION_RETRY_DELAY_BASE // Progressive delay: 1s, 2s, 3s
          logger.info(`WebSocketManager: Waiting ${delay}ms before retry ${attempt + 1}`)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    
    // All retries failed
    const errorMessage = `Failed to get market data for ${symbol} after ${maxRetries} attempts. Last error: ${lastError?.message}`
    logger.error(`WebSocketManager: ${errorMessage}`)
    throw new Error(errorMessage)
  }

  /**
   * Connect for dashboard updates - limited to every 10 seconds with retry logic
   */
  public async connectForDashboard(symbols: string[] = ["EURUSD", "US100", "GBPUSD"]): Promise<void> {
    try {
      const connectionKey = this.getConnectionKey(symbols)
      let connection = this.connections.get(connectionKey)

      if (!connection || !this.isConnectionHealthy(connection)) {
        logger.info(`WebSocketManager: Creating dashboard connection for symbols: ${symbols.join(", ")}`)
        
        // Clean up old connection if it exists
        if (connection) {
          this.closeConnection(connection)
          this.connections.delete(connectionKey)
        }
        
        connection = await this.createConnection(symbols, 2) // Fewer retries for dashboard
        this.connections.set(connectionKey, connection)
      }

      // Ensure all symbols are subscribed
      for (const symbol of symbols) {
        if (!connection.symbols.has(symbol)) {
          this.subscribeToSymbol(connection, symbol)
        }
      }

      // Reset disconnect timer
      this.resetDisconnectTimer(connection)
      logger.info(`WebSocketManager: Dashboard connection established for ${symbols.length} symbols`)
    } catch (error: any) {
      logger.error(`WebSocketManager: Failed to establish dashboard connection: ${error.message}`)
      throw error
    }
  }

  /**
   * Get quote for a specific symbol from existing connections
   */
  public getQuoteForSymbol(symbol: string): { bid: number; ask: number; timestamp: number } | null {
    for (const connection of this.connections.values()) {
      if (connection.symbols.has(symbol)) {
        const quote = connection.quotes.get(symbol)
        if (quote && !this.isQuoteStale(quote.timestamp)) {
          return quote
        }
      }
    }
    return null
  }

  /**
   * Check if any connection is active
   */
  public isConnected(): boolean {
    for (const connection of this.connections.values()) {
      if (this.isConnectionHealthy(connection)) {
        return true
      }
    }
    return false
  }

  /**
   * Get the timestamp of the last price update across all connections
   */
  public getLastPriceUpdate(): Date {
    let latestTimestamp = 0
    
    for (const connection of this.connections.values()) {
      for (const quote of connection.quotes.values()) {
        if (quote.timestamp > latestTimestamp) {
          latestTimestamp = quote.timestamp
        }
      }
    }
    
    return new Date(latestTimestamp || Date.now())
  }

  /**
   * Disconnect all connections
   */
  public disconnect(): void {
    for (const [key, connection] of this.connections.entries()) {
      this.closeConnection(connection)
      this.connections.delete(key)
    }
    logger.info("WebSocketManager: All connections disconnected")
  }

  /**
   * Create a new WebSocket connection with retry logic
   */
  private async createConnection(symbols: string[], maxRetries: number = 3): Promise<ConnectionInfo> {
    let lastError: Error | null = null
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`WebSocketManager: Creating connection attempt ${attempt}/${maxRetries} for symbols: ${symbols.join(", ")}`)
        
        const connection = await this.establishConnection(symbols)
        logger.info(`WebSocketManager: Connection successfully established on attempt ${attempt}`)
        return connection
        
      } catch (error: any) {
        lastError = error
        logger.warn(`WebSocketManager: Connection attempt ${attempt} failed: ${error.message}`)
        
        if (attempt < maxRetries) {
          const delay = attempt * 2000 // Progressive delay: 2s, 4s, 6s
          logger.info(`WebSocketManager: Waiting ${delay}ms before connection retry ${attempt + 1}`)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    
    const errorMessage = `Failed to establish WebSocket connection after ${maxRetries} attempts. Last error: ${lastError?.message}`
    logger.error(`WebSocketManager: ${errorMessage}`)
    throw new Error(errorMessage)
  }

  /**
   * Establish a single WebSocket connection
   */
  private async establishConnection(symbols: string[]): Promise<ConnectionInfo> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.WS_URL)
      const connection: ConnectionInfo = {
        ws,
        symbols: new Set(),
        lastActivity: Date.now(),
        requestId: 0,
        quotes: new Map(),
        createdAt: Date.now(),
        reconnectCount: 0
      }

      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error("WebSocket connection timeout"))
      }, 10000) // 10 second connection timeout

      ws.on("open", () => {
        clearTimeout(timeout)
        logger.info(`WebSocketManager: Connection established for symbols: ${symbols.join(", ")}`)
        
        // Subscribe to all requested symbols
        for (const symbol of symbols) {
          this.subscribeToSymbol(connection, symbol)
        }

        // Set up disconnect timer
        this.resetDisconnectTimer(connection)
        
        resolve(connection)
      })

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString())
          this.handleMessage(connection, message)
        } catch (error) {
          logger.error("WebSocketManager: Error parsing message:", error)
        }
      })

      ws.on("close", (code, reason) => {
        logger.warn(`WebSocketManager: Connection closed (code: ${code}, reason: ${reason})`)
        this.cleanupConnection(connection)
      })

      ws.on("error", (error) => {
        clearTimeout(timeout)
        logger.error("WebSocketManager: Connection error:", error)
        this.cleanupConnection(connection)
        reject(error)
      })
    })
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(connection: ConnectionInfo, message: any): void {
    connection.lastActivity = Date.now()

    if (message.p === "/quotes/subscribed" || message.p === "/lastprices/list") {
      const quote = message.d[0]
      if (quote && connection.symbols.has(quote.s)) {
        // Convert timestamp to milliseconds if it appears to be in seconds
        let timestamp = quote.t
        if (timestamp && timestamp < 1000000000000) { // If timestamp is less than year 2001 in milliseconds, it's probably in seconds
          timestamp = timestamp * 1000
        }
        
        const quoteData = {
          bid: quote.b,
          ask: quote.a,
          timestamp: timestamp
        }
        
        connection.quotes.set(quote.s, quoteData)
        
        // Emit quote update event
        this.emit("quoteUpdate", {
          symbol: quote.s,
          bid: quote.b,
          ask: quote.a,
          timestamp: timestamp
        })
      }
    }
  }

  /**
   * Subscribe to a symbol on a specific connection
   */
  private subscribeToSymbol(connection: ConnectionInfo, symbol: string): void {
    if (connection.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`WebSocketManager: Cannot subscribe to ${symbol} - connection not open`)
      return
    }

    const request = {
      p: "/subscribe/addList",
      i: ++connection.requestId,
      d: [symbol]
    }

    connection.ws.send(JSON.stringify(request))
    connection.symbols.add(symbol)
    
    // Request last known price
    const lastPriceRequest = {
      p: "/lastprices/list",
      i: ++connection.requestId,
      d: [symbol]
    }
    
    connection.ws.send(JSON.stringify(lastPriceRequest))
    logger.info(`WebSocketManager: Subscribed to ${symbol}`)
  }

  /**
   * Wait for a fresh quote for a specific symbol with enhanced error handling
   */
  private async waitForQuote(connection: ConnectionInfo, symbol: string, timeout: number = 8000): Promise<{ bid: number; ask: number; timestamp: number }> {
    return new Promise((resolve, reject) => {
      // Check if we already have a fresh quote
      const existingQuote = connection.quotes.get(symbol)
      if (existingQuote && !this.isQuoteStale(existingQuote.timestamp)) {
        logger.info(`WebSocketManager: Using existing fresh quote for ${symbol} (age: ${(Date.now() - existingQuote.timestamp) / 1000}s)`)
        resolve(existingQuote)
        return
      }

      // Check connection health before waiting
      if (!this.isConnectionHealthy(connection)) {
        reject(new Error(`Connection is not healthy for ${symbol}`))
        return
      }

      const timeoutId = setTimeout(() => {
        this.removeListener("quoteUpdate", onQuoteUpdate)
        reject(new Error(`Timeout waiting for quote for ${symbol} after ${timeout}ms`))
      }, timeout)

      const onQuoteUpdate = (data: any) => {
        if (data.symbol === symbol) {
          clearTimeout(timeoutId)
          this.removeListener("quoteUpdate", onQuoteUpdate)
          
          // Verify quote is fresh before resolving
          if (this.isQuoteStale(data.timestamp)) {
            reject(new Error(`Received stale quote for ${symbol} (age: ${(Date.now() - data.timestamp) / 1000}s)`))
            return
          }
          
          logger.info(`WebSocketManager: Received fresh quote for ${symbol} (age: ${(Date.now() - data.timestamp) / 1000}s)`)
          resolve({
            bid: data.bid,
            ask: data.ask,
            timestamp: data.timestamp
          })
        }
      }

      this.on("quoteUpdate", onQuoteUpdate)
      
      // Request fresh quote immediately
      this.requestFreshQuote(connection, symbol)
    })
  }

  /**
   * Request a fresh quote for a specific symbol
   */
  private requestFreshQuote(connection: ConnectionInfo, symbol: string): void {
    if (connection.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`WebSocketManager: Cannot request fresh quote for ${symbol} - connection not open`)
      return
    }

    const lastPriceRequest = {
      p: "/lastprices/list",
      i: ++connection.requestId,
      d: [symbol]
    }
    
    connection.ws.send(JSON.stringify(lastPriceRequest))
    logger.info(`WebSocketManager: Requested fresh quote for ${symbol}`)
  }

  /**
   * Check if a connection is healthy
   */
  private isConnectionHealthy(connection: ConnectionInfo): boolean {
    return connection.ws.readyState === WebSocket.OPEN &&
           (Date.now() - connection.lastActivity) < this.CONNECTION_TIMEOUT
  }

  /**
   * Check if a quote is stale
   */
  private isQuoteStale(timestamp: number): boolean {
    return (Date.now() - timestamp) > this.PRICE_STALE_THRESHOLD
  }

  /**
   * Force reconnection for a symbol when price data is stale
   */
  public async forceReconnectForSymbol(symbol: string): Promise<MarketData> {
    logger.info(`WebSocketManager: Force reconnecting for ${symbol} due to stale price data`)
    
    // Remove existing connection for this symbol
    const connectionKey = this.getConnectionKey([symbol])
    const existingConnection = this.connections.get(connectionKey)
    if (existingConnection) {
      existingConnection.reconnectCount++
      this.totalReconnects++
      this.closeConnection(existingConnection)
      this.connections.delete(connectionKey)
    }
    
    // Create fresh connection with retry logic
    return await this.connectForOrder(symbol)
  }

  /**
   * Get market data with automatic stale price detection and reconnection
   */
  public async getMarketDataWithRetry(symbol: string): Promise<MarketData> {
    try {
      // First attempt to get market data
      const marketData = await this.connectForOrder(symbol)
      
      // Validate market data quality
      if (!this.isMarketDataValid(marketData)) {
        logger.warn(`WebSocketManager: Invalid market data for ${symbol}, forcing reconnection`)
        return await this.forceReconnectForSymbol(symbol)
      }
      
      // If data is stale, force reconnection
      if (marketData.isStale || this.isQuoteStale(marketData.timestamp)) {
        logger.warn(`WebSocketManager: Detected stale price for ${symbol} (age: ${(Date.now() - marketData.timestamp) / 1000}s), forcing reconnection`)
        return await this.forceReconnectForSymbol(symbol)
      }
      
      logger.info(`WebSocketManager: Successfully obtained valid market data for ${symbol} (bid: ${marketData.bid}, ask: ${marketData.ask}, age: ${(Date.now() - marketData.timestamp) / 1000}s)`)
      return marketData
    } catch (error: any) {
      logger.error(`WebSocketManager: Failed to get market data for ${symbol}: ${error.message}`)
      throw error
    }
  }

  /**
   * Validate market data quality
   */
  private isMarketDataValid(marketData: MarketData): boolean {
    // Check for valid bid/ask values
    if (!marketData.bid || !marketData.ask || marketData.bid <= 0 || marketData.ask <= 0) {
      return false
    }
    
    // Check for reasonable spread (ask should be higher than bid)
    if (marketData.ask <= marketData.bid) {
      return false
    }
    
    // Check for valid timestamp
    if (!marketData.timestamp || marketData.timestamp <= 0) {
      return false
    }
    
    // Check for extremely wide spreads (might indicate bad data)
    const spread = marketData.ask - marketData.bid
    const midPrice = (marketData.bid + marketData.ask) / 2
    const spreadPercentage = (spread / midPrice) * 100
    
    // If spread is more than 5%, consider it suspicious
    if (spreadPercentage > 5) {
      logger.warn(`WebSocketManager: Suspicious spread for ${marketData.symbol}: ${spreadPercentage.toFixed(2)}%`)
      return false
    }
    
    return true
  }

  /**
   * Generate connection key based on symbols
   */
  private getConnectionKey(symbols: string[]): string {
    return symbols.sort().join(",")
  }

  /**
   * Reset the disconnect timer for a connection
   */
  private resetDisconnectTimer(connection: ConnectionInfo): void {
    if (connection.disconnectTimer) {
      clearTimeout(connection.disconnectTimer)
    }

    connection.disconnectTimer = setTimeout(() => {
      logger.info("WebSocketManager: Auto-disconnecting idle connection")
      this.closeConnection(connection)
      
      // Remove from connections map
      for (const [key, conn] of this.connections.entries()) {
        if (conn === connection) {
          this.connections.delete(key)
          break
        }
      }
    }, this.CONNECTION_TIMEOUT)
  }

  /**
   * Close a specific connection
   */
  private closeConnection(connection: ConnectionInfo): void {
    if (connection.disconnectTimer) {
      clearTimeout(connection.disconnectTimer)
    }
    
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close()
    }
    
    this.cleanupConnection(connection)
  }

  /**
   * Clean up connection resources
   */
  private cleanupConnection(connection: ConnectionInfo): void {
    if (connection.disconnectTimer) {
      clearTimeout(connection.disconnectTimer)
    }
    connection.symbols.clear()
    connection.quotes.clear()
  }

  /**
   * Get connection statistics for monitoring
   */
  public getConnectionStats(): ConnectionStats {
    const activeConnections = Array.from(this.connections.values()).filter(conn => 
      this.isConnectionHealthy(conn)
    )
    
    const allSymbols = new Set<string>()
    let latestQuoteTimestamp = 0
    let totalConnectionAge = 0
    
    for (const connection of this.connections.values()) {
      connection.symbols.forEach(symbol => allSymbols.add(symbol))
      totalConnectionAge += Date.now() - connection.createdAt
      
      for (const quote of connection.quotes.values()) {
        if (quote.timestamp > latestQuoteTimestamp) {
          latestQuoteTimestamp = quote.timestamp
        }
      }
    }
    
    return {
      totalConnections: this.connections.size,
      activeConnections: activeConnections.length,
      totalReconnects: this.totalReconnects,
      averageConnectionAge: this.connections.size > 0 ? totalConnectionAge / this.connections.size : 0,
      symbolsTracked: Array.from(allSymbols),
      lastQuoteUpdate: latestQuoteTimestamp
    }
  }

  /**
   * Check if price data is available and fresh for a symbol
   */
  public isPriceDataFresh(symbol: string): boolean {
    const quote = this.getQuoteForSymbol(symbol)
    return quote !== null && !this.isQuoteStale(quote.timestamp)
  }

  /**
   * Get age of price data for a symbol in seconds
   */
  public getPriceDataAge(symbol: string): number | null {
    const quote = this.getQuoteForSymbol(symbol)
    if (!quote) return null
    return (Date.now() - quote.timestamp) / 1000
  }
}

// Export singleton instance
export const webSocketManager = new WebSocketManager()