# Technology Stack & Build System

## Tech Stack

- **Runtime**: Node.js 16+
- **Language**: TypeScript 5.1.6
- **Framework**: Express.js 4.18.2
- **Database**: SQLite3 5.1.6 with async wrapper
- **WebSocket**: ws 8.13.0 for real-time market data
- **HTTP Client**: Axios 1.4.0 for API calls
- **Process Management**: PM2 for production deployment
- **Authentication**: express-basic-auth 1.2.1
- **Logging**: Winston 3.10.0 with daily rotate file
- **Task Scheduling**: node-cron 3.0.2
- **Concurrency**: async-mutex 0.4.0 for trade execution synchronization

## Build System

TypeScript compilation with standard configuration:
- Target: ES6
- Module: CommonJS
- Output: `./dist` directory
- Source: `./src` directory

## Common Commands

```bash
# Development
npm run dev          # Start with ts-node and auto-reload
npm install          # Install dependencies
npm run build        # Compile TypeScript to JavaScript

# Production (PM2)
npm start            # Start with PM2
npm stop             # Stop PM2 process
npm restart          # Restart PM2 process
npm run logs         # View PM2 logs

# Git Security Setup (Required)
./scripts/setup-git.sh   # Configure GPG signing with Yubikey
```

## Configuration

- **Environment**: Use `.env` file or environment variables
- **Config Files**: `src/config.ts` (excluded from version control)
- **SSL Certificates**: Place in `ssl/` directory (`cert.pem`, `key.pem`)
- **Database**: SQLite file `sfx_historical_orders.db` in project root

## API Integration

- **SimpleFX API**: REST API with dual key support
- **WebSocket**: Real-time market data feeds
- **TradingView**: Webhook receiver endpoints
- **Rate Limiting**: Built-in circuit breaker and request throttling