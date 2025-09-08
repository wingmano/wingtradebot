import winston from "winston";
import { config } from "../config";

// Ultra-lightweight format - single line, essential info only
const cleanFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'DD/MM/YYYY, HH:mm:ss'
  }),
  winston.format.printf(({ timestamp, message }) => `${timestamp} | ${message}`)
);

// Console format (production: errors only)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
);

// Main logger - ONLY critical errors and server events
const mainLogger = winston.createLogger({
  level: 'error', // Only errors in production
  format: cleanFormat,
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.NODE_ENV === 'production' ? 'error' : 'warn'
    }),
    // Error log - size-based rotation, max 2 files
    new winston.transports.File({
      filename: 'error.log',
      level: 'error',
      maxsize: 2000000, // 2MB
      maxFiles: 2,
      tailable: true
    })
  ]
});

// Trade logger - size-based rotation, max 3 files
const winstonTradeLogger = winston.createLogger({
  level: 'info',
  format: cleanFormat,
  transports: [
    new winston.transports.File({
      filename: 'trades.log',
      level: 'info',
      maxsize: 3000000, // 3MB
      maxFiles: 3,
      tailable: true
    })
  ]
});

// Clean trade logging functions
export const logTrade = {
  placed: (type: string, symbol: string, side: string, amount: number, price: number, account: string) => {
    winstonTradeLogger.info(`TRADE_${type}: ${side} ${symbol} | ${amount} @ ${price} | Acc:${account}`);
  },
  priceCalculation: (symbol: string, account: string, data: any) => {
    winstonTradeLogger.info(`PRICE_CALC: ${symbol} | ${JSON.stringify(data)} | Acc:${account}`);
  },
  webhookReceived: (symbol: string, action: string, size: number, tp: number, sl: number, account: string, alertId: string) => {
    winstonTradeLogger.info(`WEBHOOK_RECEIVED: ${action} ${symbol} | Size:${size} TP:${tp} SL:${sl} | Acc:${account} | ID:${alertId}`);
  },
  apiRequest: (symbol: string, account: string, endpoint: string, data: any) => {
    winstonTradeLogger.info(`API_REQUEST: ${endpoint} | ${symbol} | Acc:${account} | Data:${JSON.stringify(data)}`);
  },
  duplicate: (symbol: string, action: string, account: string, alertId: string) => {
    winstonTradeLogger.info(`DUPLICATE: ${action} ${symbol} | Acc:${account} | ID:${alertId}`);
  }
};

export const logError = {
  trade: (symbol: string, side: string, message: string, account: string) => {
    const errorMsg = `TRADE_ERROR: ${side} ${symbol} | ${message} | Acc:${account}`;
    mainLogger.error(errorMsg);
    winstonTradeLogger.error(errorMsg);
  },
  api: (operation: string, message: string, account?: string) => {
    const errorMsg = `API_ERROR: ${operation} | ${message}${account ? ` | Acc:${account}` : ''}`;
    mainLogger.error(errorMsg);
  },
  system: (operation: string, message: string) => {
    mainLogger.error(`ERROR: ${operation} | ${message}`);
  },
  detailed: (operation: string, error: any, context?: any) => {
    const contextStr = context ? ` | Context:${JSON.stringify(context)}` : '';
    const errorMsg = `ERROR: ${operation} | ${error.message || error}${contextStr}`;
    mainLogger.error(errorMsg);
  }
};

export const logApp = {
  modeChange: (account: string, mode: string) => {
    mainLogger.info(`MODE_CHANGE: ${account} | ${mode}`);
  }
};

export const logQuote = (symbol: string, bid: number, ask: number) => {
  // Minimal quote logging
};

export const logger = mainLogger;
export const tradeLogger = winstonTradeLogger;
export const quoteLogger = mainLogger;