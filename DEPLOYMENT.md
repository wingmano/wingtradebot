# Deployment Guide

This guide covers deploying WingTradeBot on a Linux server for production use.

## Server Requirements

- Ubuntu 20.04+ or similar Linux distribution
- Node.js 16+ and npm
- PM2 process manager
- SSL certificate for HTTPS
- Minimum 1GB RAM, 10GB disk space

## Initial Server Setup

1. **Update system packages:**
```bash
sudo apt update && sudo apt upgrade -y
```

2. **Install Node.js and npm:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

3. **Install PM2 globally:**
```bash
sudo npm install -g pm2
```

4. **Create application user:**
```bash
sudo useradd -m -s /bin/bash wingtradebot
sudo usermod -aG sudo wingtradebot
```

## Application Deployment

1. **Clone or upload application files:**
```bash
sudo -u wingtradebot -i
cd /home/wingtradebot
# Upload your application files here
```

2. **Install dependencies:**
```bash
npm install
```

3. **Configure the application:**
```bash
nano src/config.ts
# Configure all required API keys and settings
```

4. **Build the application:**
```bash
npm run build
```

## SSL Certificate Setup

### Option 1: Let's Encrypt (Recommended)

1. **Install Certbot:**
```bash
sudo apt install certbot
```

2. **Generate certificate:**
```bash
sudo certbot certonly --standalone -d your-domain.com
```

3. **Copy certificates:**
```bash
sudo mkdir -p /home/wingtradebot/ssl
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem /home/wingtradebot/ssl/cert.pem
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem /home/wingtradebot/ssl/key.pem
sudo chown wingtradebot:wingtradebot /home/wingtradebot/ssl/*
```

### Option 2: Self-Signed Certificate

```bash
mkdir ssl
openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes
```

## Firewall Configuration

```bash
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## Process Management

1. **Start the application:**
```bash
npm start
```

2. **Configure PM2 startup:**
```bash
pm2 startup
pm2 save
```

3. **Monitor the application:**
```bash
pm2 status
pm2 logs wingtradebot
pm2 monit
```

## Database Management

The SQLite database is automatically created on first run. For backup:

```bash
# Create backup
cp sfx_historical_orders.db sfx_historical_orders.db.backup

# Restore from backup
cp sfx_historical_orders.db.backup sfx_historical_orders.db
```

## Log Management

Configure log rotation to prevent disk space issues:

```bash
sudo nano /etc/logrotate.d/wingtradebot
```

Add the following configuration:
```
/home/wingtradebot/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    copytruncate
}
```

## Monitoring and Maintenance

### Health Checks

Create a simple health check script:

```bash
#!/bin/bash
# health-check.sh
curl -k https://localhost:443/api/test-keys
if [ $? -eq 0 ]; then
    echo "Service is healthy"
else
    echo "Service is down, restarting..."
    pm2 restart wingtradebot
fi
```

### Automated Updates

For automated deployment updates:

```bash
#!/bin/bash
# update.sh
cd /home/wingtradebot
git pull origin main
npm install
npm run build
pm2 restart wingtradebot
```

### System Monitoring

Monitor key metrics:
- CPU and memory usage
- Disk space
- Network connectivity
- Application logs
- Database size

## Security Considerations

1. **Keep system updated:**
```bash
sudo apt update && sudo apt upgrade -y
```

2. **Configure fail2ban:**
```bash
sudo apt install fail2ban
sudo systemctl enable fail2ban
```

3. **Regular security audits:**
```bash
npm audit
npm audit fix
```

4. **Backup strategy:**
- Daily database backups
- Weekly full application backups
- Off-site backup storage

## Troubleshooting

### Common Issues

1. **Port 443 already in use:**
```bash
sudo lsof -i :443
sudo systemctl stop apache2  # or nginx
```

2. **Permission errors:**
```bash
sudo chown -R wingtradebot:wingtradebot /home/wingtradebot
```

3. **SSL certificate errors:**
```bash
openssl x509 -in ssl/cert.pem -text -noout
```

4. **Database locked errors:**
```bash
pm2 stop wingtradebot
rm -f sfx_historical_orders.db-wal sfx_historical_orders.db-shm
pm2 start wingtradebot
```

### Log Analysis

Check application logs:
```bash
pm2 logs wingtradebot --lines 100
tail -f trades.log
tail -f error.log
```

### Performance Optimization

1. **Enable Node.js clustering:**
```bash
# In PM2 ecosystem file
instances: "max"
exec_mode: "cluster"
```

2. **Database optimization:**
```bash
sqlite3 sfx_historical_orders.db "VACUUM;"
sqlite3 sfx_historical_orders.db "ANALYZE;"
```

## Maintenance Schedule

- **Daily**: Check logs and system health
- **Weekly**: Review trading performance and update dependencies
- **Monthly**: Full system backup and security updates
- **Quarterly**: SSL certificate renewal (if not automated)