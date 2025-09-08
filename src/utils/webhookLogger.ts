import { logTrade, logError } from './logger';
import { storeWebhookOutcome } from '../database';
import winston from 'winston';

// Create a dedicated winston logger for trades.log to ensure ERROR messages go there
const tradesLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'DD/MM/YYYY, HH:mm:ss'
    }),
    winston.format.printf(({ timestamp, message }) => `${timestamp} | ${message}`)
  ),
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

/**
 * Centralized webhook logging controller
 * Ensures consistent log format and single log entry per processing stage
 * Requirements: 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 5.3, 5.4, 5.5
 */
export class WebhookLogger {
  private static instance: WebhookLogger;
  
  private constructor() {}
  
  public static getInstance(): WebhookLogger {
    if (!WebhookLogger.instance) {
      WebhookLogger.instance = new WebhookLogger();
    }
    return WebhookLogger.instance;
  }

  /**
   * Log webhook received - called only once when webhook enters the system
   * Format: "WEBHOOK: {symbol} {action} {size} TP:{tp} SL:{sl} | Acc:{account} | ID:{alertId}"
   * Requirement: 5.1
   */
  logWebhookReceived(
    symbol: string, 
    action: string, 
    size: number, 
    tp: number, 
    sl: number, 
    account: string, 
    alertId: string
  ): void {
    logTrade.webhookReceived(symbol, action, size, tp, sl, account, alertId);
  }

  /**
   * Log order successfully placed
   * Format: "PLACED: {symbol} {action} {size} @ {price} TP:{tp} SL:{sl} | Acc:{account} | Order:{orderId}"
   * Requirement: 5.2, 3.1
   */
  logOrderPlaced(
    symbol: string, 
    action: string, 
    size: number, 
    price: number, 
    tp: number, 
    sl: number, 
    account: string, 
    orderId: string, 
    alertId: string
  ): void {
    logTrade.placed('ORDER', symbol, action, size, price, account);
    
    // Store outcome in database (requirement 4.1, 4.2)
    storeWebhookOutcome(alertId, account, symbol, action, size, 'PLACED', undefined, orderId)
      .catch(error => logError.system('webhookLogger', `Failed to store PLACED outcome: ${error.message}`));
  }

  /**
   * Log order rejected for business rules
   * Format: "REJECTED: {symbol} {action} | {reason} | Acc:{account} | ID:{alertId}"
   * Requirement: 5.3, 3.2, 4.3
   */
  logOrderRejected(
    symbol: string, 
    action: string, 
    reason: string, 
    account: string, 
    alertId: string,
    size: number = 0
  ): void {
    const message = `REJECTED: ${symbol} ${action} | ${reason} | Acc:${account} | ID:${alertId}`;
    tradesLogger.info(message);
    
    // Store outcome in database (requirement 4.1, 4.2)
    storeWebhookOutcome(alertId, account, symbol, action, size, 'REJECTED', reason)
      .catch(error => logError.system('webhookLogger', `Failed to store REJECTED outcome: ${error.message}`));
  }

  /**
   * Log duplicate webhook detected
   * Format: "DUPLICATE: {symbol} {action} | Acc:{account} | ID:{alertId}"
   * Requirement: 5.4, 3.4
   */
  logDuplicate(
    symbol: string, 
    action: string, 
    account: string, 
    alertId: string,
    size: number = 0
  ): void {
    logTrade.duplicate(symbol, action, account, alertId);
    
    // Store outcome in database (requirement 4.1, 4.2)
    storeWebhookOutcome(alertId, account, symbol, action, size, 'DUPLICATE', 'Duplicate webhook detected')
      .catch(error => logError.system('webhookLogger', `Failed to store DUPLICATE outcome: ${error.message}`));
  }

  /**
   * Log processing error
   * Format: "ERROR: {symbol} {action} | {errorMessage} | Acc:{account} | ID:{alertId}"
   * Requirement: 5.5, 3.3, 4.6 - Log to both trades.log and error.log
   */
  logError(
    symbol: string, 
    action: string, 
    error: string, 
    account: string, 
    alertId: string,
    size: number = 0
  ): void {
    const message = `ERROR: ${symbol} ${action} | ${error} | Acc:${account} | ID:${alertId}`;
    
    // Log to trades.log with ERROR format (requirement 3.3, 4.6)
    tradesLogger.info(message);
    
    // Also log to error.log for system monitoring (requirement 4.6)
    logError.trade(symbol, action, error, account);
    
    // Store outcome in database (requirement 4.1, 4.2)
    storeWebhookOutcome(alertId, account, symbol, action, size, 'ERROR', error)
      .catch(err => logError.system('webhookLogger', `Failed to store ERROR outcome: ${err.message}`));
  }
}

// Export singleton instance
export const webhookLogger = WebhookLogger.getInstance();