# Security Guidelines

Security best practices and requirements for WingTradeBot deployment and operation.

## Configuration Security

### Configuration Files
- **Never commit `src/config.ts`** to version control (it's in `.gitignore`)
- Use strong, unique passwords for all authentication
- Rotate API keys and passwords regularly
- Keep sensitive configuration in `src/config.ts` only

### File Permissions
```bash
# Set proper file permissions
chmod 600 src/config.ts
chmod 600 ssl/key.pem
chmod 644 ssl/cert.pem
chmod 600 sfx_historical_orders.db
```

### Directory Structure
```
/home/wingtradebot/
├── src/config.ts (600) - Contains sensitive data
├── ssl/
│   ├── cert.pem (644)
│   └── key.pem (600)
├── sfx_historical_orders.db (600)
└── logs/ (755)
```

## Network Security

### IP Whitelisting
Configure allowed IPs in `src/config.ts`:
```typescript
ALLOWED_IPS: [
  '52.89.214.238',    // TradingView webhook IPs
  '34.212.75.30',
  '54.218.53.128', 
  '52.32.178.7',
  'your.server.ip',   // Your server IP
  '127.0.0.1'         // Localhost
]
```

### Firewall Configuration
```bash
# Allow only necessary ports
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

### SSL/TLS Configuration
- Use TLS 1.2 or higher
- Implement proper certificate validation
- Regular certificate renewal
- Strong cipher suites only

## Authentication Security

### Basic Authentication
- Use strong, unique passwords (minimum 12 characters)
- Include uppercase, lowercase, numbers, and symbols
- Different passwords for primary and secondary auth
- Regular password rotation (quarterly)

### API Key Management
- Store API keys in `src/config.ts` only
- Use separate API keys for different accounts
- Monitor API key usage and permissions
- Implement key rotation procedures

### Session Management
- No persistent sessions stored
- Authentication required for each request
- Timeout inactive connections

## Application Security

### Input Validation
All webhook inputs are validated:
- Symbol format validation
- Numeric range checks
- Required field validation
- SQL injection prevention

### Database Security
- SQLite database with restricted file permissions
- Parameterized queries only
- Regular database backups
- No direct database access from web interface

### Error Handling
- No sensitive information in error messages
- Proper error logging without exposing internals
- Rate limiting on error responses

## Operational Security

### Logging and Monitoring
- Log all trading activities
- Monitor failed authentication attempts
- Alert on unusual trading patterns
- Regular log review and analysis

### Backup Security
```bash
# Encrypted backup example
tar -czf backup.tar.gz sfx_historical_orders.db .env
gpg --symmetric --cipher-algo AES256 backup.tar.gz
rm backup.tar.gz
```

### Access Control
- Principle of least privilege
- Separate user account for application
- No root access for application processes
- Regular access review

## Development Security

### Code Security
- No hardcoded credentials
- Input sanitization
- Secure coding practices
- Regular dependency updates

### Version Control Security
- `.gitignore` configured properly
- No sensitive data in commits
- **GPG signed commits required** (Yubikey-based)
- Protected main branch with signature verification
- All contributors must use hardware security keys

#### Git Security Requirements
All developers must:
1. **Use Yubikey for commit signing** - Hardware-based GPG keys only
2. **Configure GPG signing** - All commits must be cryptographically signed
3. **Verify commit signatures** - Only signed commits accepted in main branch
4. **Follow security setup** - Complete setup guide in `docs/YUBIKEY_SETUP.md`

#### Git Security Configuration
```bash
# Required Git configuration for all developers
git config --global commit.gpgsign true
git config --global user.signingkey YOUR_GPG_KEY_ID
git config --global gpg.program gpg

# Verify signing works
git commit -S -m "Test signed commit"
```

#### Branch Protection Rules
- Require signed commits on main branch
- Require status checks to pass before merge
- Require branches to be up to date before merge
- Restrict push access to main branch
- Require pull request reviews

### Dependency Management
```bash
# Regular security audits
npm audit
npm audit fix

# Update dependencies
npm update
```

## Incident Response

### Security Incident Procedures
1. **Immediate Response**
   - Stop the application if compromise suspected
   - Isolate affected systems
   - Preserve logs and evidence

2. **Assessment**
   - Determine scope of incident
   - Identify compromised data/systems
   - Document timeline of events

3. **Containment**
   - Change all passwords and API keys
   - Update firewall rules if needed
   - Apply security patches

4. **Recovery**
   - Restore from clean backups
   - Verify system integrity
   - Monitor for continued threats

### Emergency Contacts
- SimpleFX support for API key issues
- Server provider for infrastructure issues
- Security team for incident response

## Compliance and Auditing

### Regular Security Tasks
- **Daily**: Monitor logs for anomalies
- **Weekly**: Review access logs and trading patterns
- **Monthly**: Update dependencies and security patches
- **Quarterly**: Password rotation and access review
- **Annually**: Full security audit

### Security Checklist
- [ ] Environment variables properly configured
- [ ] File permissions set correctly
- [ ] Firewall rules configured
- [ ] SSL certificates valid and current
- [ ] API keys rotated regularly
- [ ] Logs monitored and reviewed
- [ ] Backups tested and verified
- [ ] Dependencies updated
- [ ] Access controls reviewed
- [ ] **Git security configured with Yubikey**
- [ ] **All commits GPG signed**
- [ ] **Branch protection rules enabled**
- [ ] **GPG keys added to GitHub**

## Threat Model

### Identified Threats
1. **Unauthorized webhook access** - Mitigated by IP whitelisting
2. **API key compromise** - Mitigated by environment variables and rotation
3. **Man-in-the-middle attacks** - Mitigated by SSL/TLS
4. **Database access** - Mitigated by file permissions and access controls
5. **Code injection** - Mitigated by input validation and parameterized queries

### Risk Assessment
- **High Risk**: API key exposure, database compromise
- **Medium Risk**: Unauthorized dashboard access, webhook spoofing
- **Low Risk**: Log file access, temporary file exposure

## Security Tools

### Recommended Tools
- **fail2ban**: Intrusion prevention
- **logwatch**: Log monitoring
- **rkhunter**: Rootkit detection
- **nmap**: Network scanning
- **openssl**: Certificate management

### Monitoring Commands
```bash
# Check for suspicious connections
netstat -tulpn | grep :443

# Monitor failed login attempts
grep "Failed" /var/log/auth.log

# Check file integrity
find /home/wingtradebot -type f -exec ls -la {} \;

# Monitor process activity
ps aux | grep wingtradebot
```

## Recovery Procedures

### Backup Restoration
```bash
# Stop application
pm2 stop wingtradebot

# Restore database
cp sfx_historical_orders.db.backup sfx_historical_orders.db

# Restore configuration
cp .env.backup .env

# Restart application
pm2 start wingtradebot
```

### Emergency Shutdown
```bash
# Immediate shutdown
pm2 stop wingtradebot

# Block all traffic
sudo ufw deny 443/tcp

# Revoke API access (contact SimpleFX)
```

This security framework should be reviewed and updated regularly to address new threats and vulnerabilities.