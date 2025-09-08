import { EventEmitter } from 'events';
import { logger, logTrade } from './logger';
import { initializeDatabase } from '../database';

interface WebhookJob {
  id: string;
  data: any;
  timestamp: number;
  retries: number;
  accountNumber: string;
}

class WebhookQueue extends EventEmitter {
  private queue: WebhookJob[] = [];
  private processing = false;
  private processedIds = new Set<string>();
  private maxRetries = 3;
  private retryDelay = 2000; // 2 seconds
  private duplicateWindow = 30000; // 30 seconds to detect duplicates

  constructor() {
    super();
    // Load existing processed IDs from database on startup
    this.loadProcessedIdsFromDatabase();
    // Clean up old processed IDs every 5 minutes
    setInterval(() => this.cleanupProcessedIds(), 300000);
  }

  private async loadProcessedIdsFromDatabase(): Promise<void> {
    try {
      const db = await initializeDatabase();
      const rows = await db.all(`SELECT alert_id, account_number FROM processed_webhook_ids`);
      this.processedIds = new Set(rows.map((row: any) => `${row.alert_id}_${row.account_number}`));
      logger.debug(`Loaded ${this.processedIds.size} processed webhook IDs from database`);
    } catch (error: any) {
      logger.error('Failed to load processed IDs from database:', error);
      // Continue with empty set if database load fails
      this.processedIds = new Set();
    }
  }

  async add(data: any, accountNumber: string): Promise<string> {
    const jobId = `${data.id || Date.now()}_${accountNumber}_${Date.now()}`;
    
    const job: WebhookJob = {
      id: jobId,
      data,
      timestamp: Date.now(),
      retries: 0,
      accountNumber
    };

    this.queue.push(job);
    
    // Webhook logging is handled in server.ts to avoid duplicates
    // const symbol = data.sy || "UNKNOWN";
    // const action = data.a || "UNKNOWN";
    // const size = data.z || 0;
    // const tp = data.t || 0;
    // const sl = data.s || 0;
    // 
    // logTrade.webhookReceived(symbol, action, size, tp, sl, accountNumber, data.id || jobId);

    logger.debug(`Webhook queued: ${jobId}`, {
      queueLength: this.queue.length,
      account: accountNumber
    });

    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }

    return jobId;
  }

  checkForDuplicate(data: any, accountNumber: string): boolean {
    const now = Date.now();
    
    // First check: Already processed this exact alert ID (permanent check)
    if (data.id) {
      const alertKey = `${data.id}_${accountNumber}`;
      if (this.processedIds.has(alertKey)) {
        console.log(`Duplicate webhook detected by processed ID: ${alertKey}`);
        return true;
      }
    }
    
    // Second check: Same alert ID in current queue (most specific - definite duplicate)
    for (const job of this.queue) {
      if (job.data.id === data.id && 
          job.accountNumber === accountNumber &&
          (now - job.timestamp) < this.duplicateWindow) {
        return true; // Same alert ID = definite duplicate
      }
    }
    
    // Third check: Same trade parameters (fallback for missing/different alert IDs)
    for (const job of this.queue) {
      if (job.accountNumber === accountNumber &&
          job.data.sy === data.sy &&
          job.data.a === data.a &&
          job.data.z === data.z &&
          (now - job.timestamp) < this.duplicateWindow) {
        return true;
      }
    }
    
    return false;
  }

  async storeProcessedId(alertId: string, accountNumber: string): Promise<void> {
    try {
      const db = await initializeDatabase();
      const alertKey = `${alertId}_${accountNumber}`;
      
      // Store in memory for immediate access
      this.processedIds.add(alertKey);
      
      // Store in database for permanent persistence
      await db.run(
        `INSERT OR IGNORE INTO processed_webhook_ids (alert_id, account_number, processed_at) VALUES (?, ?, ?)`,
        [alertId, accountNumber, Date.now()]
      );
      
      // Cleanup old entries if we have more than 1000
      if (this.processedIds.size > 1000) {
        await this.cleanupOldProcessedIds();
      }
    } catch (error: any) {
      logger.error(`Failed to store processed ID ${alertId} for account ${accountNumber}:`, error);
      // Don't throw - we don't want to block webhook processing for storage issues
    }
  }

  private async cleanupOldProcessedIds(): Promise<void> {
    try {
      const db = await initializeDatabase();
      
      // Keep only the most recent 500 entries in database
      await db.run(`
        DELETE FROM processed_webhook_ids 
        WHERE rowid NOT IN (
          SELECT rowid FROM processed_webhook_ids 
          ORDER BY processed_at DESC 
          LIMIT 500
        )
      `);
      
      // Reload processed IDs from database to sync memory with database
      const rows = await db.all(`SELECT alert_id, account_number FROM processed_webhook_ids`);
      this.processedIds = new Set(rows.map((row: any) => `${row.alert_id}_${row.account_number}`));
      
    } catch (error: any) {
      logger.error('Failed to cleanup old processed IDs:', error);
    }
  }

  private async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      
      try {
        logger.debug(`Processing webhook job: ${job.id}`);
        await this.processJob(job);
        this.processedIds.add(job.id);
      } catch (error: any) {
        logger.error(`Failed to process webhook job: ${job.id}`, {
          error: error.message,
          retries: job.retries
        });

        // Retry logic
        if (job.retries < this.maxRetries) {
          job.retries++;
          // Add back to queue with exponential backoff
          setTimeout(() => {
            this.queue.push(job);
            if (!this.processing) {
              this.processQueue();
            }
          }, this.retryDelay * Math.pow(2, job.retries - 1));
        } else {
          logger.error(`Job ${job.id} failed after ${this.maxRetries} retries`);
          this.emit('jobFailed', job);
        }
      }
    }

    this.processing = false;
  }

  private async processJob(job: WebhookJob) {
    // Store the alert ID in our processed set to prevent future duplicates
    if (job.data.id) {
      const alertKey = `${job.data.id}_${job.accountNumber}`;
      this.processedIds.add(alertKey);
      
      // Limit the size of processedIds to prevent memory leaks
      if (this.processedIds.size > 1000) {
        // Convert to array, remove oldest entries, convert back to set
        const idsArray = Array.from(this.processedIds);
        this.processedIds = new Set(idsArray.slice(-500)); // Keep only the most recent 500
      }
    }
    
    // Emit event for the actual webhook processing
    return new Promise((resolve, reject) => {
      this.emit('processWebhook', job, resolve, reject);
    });
  }

  private async cleanupProcessedIds() {
    try {
      const db = await initializeDatabase();
      
      // Remove entries older than 24 hours from database
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      await db.run(`DELETE FROM processed_webhook_ids WHERE processed_at < ?`, [oneDayAgo]);
      
      // If still too many entries, keep only the most recent 500
      const count = await db.get(`SELECT COUNT(*) as count FROM processed_webhook_ids`);
      if (count.count > 1000) {
        await this.cleanupOldProcessedIds();
      }
      
      // Reload processed IDs from database to sync memory
      await this.loadProcessedIdsFromDatabase();
      
    } catch (error: any) {
      logger.error('Failed to cleanup processed IDs:', error);
    }
  }

  getQueueStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      processedCount: this.processedIds.size
    };
  }
}

export const webhookQueue = new WebhookQueue();