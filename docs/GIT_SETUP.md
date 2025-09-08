# Git Setup Guide

Simple git configuration for the TradingView webhook server project.

## Basic Git Configuration

Set up your git identity:
```bash
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

The repository is already configured with optimal settings:
- `core.autocrlf false` - Prevents line ending issues
- `core.filemode false` - Ignores file permission changes
- `pull.rebase true` - Uses rebase instead of merge for pulls
- `init.defaultBranch main` - Uses main as default branch

## Pre-commit Hook

The repository includes a lightweight pre-commit hook that quickly checks for sensitive files:
- `.env` files
- `.key` and `.pem` files  
- `.db` and `.log` files
- `config.ts` files

This runs in ~0.025 seconds and prevents accidental commits of sensitive data.

## Quick Start

1. Clone the repository:
```bash
git clone <repository-url>
cd wingtradebot
```

2. Set your git identity:
```bash
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

3. Make commits normally:
```bash
git add .
git commit -m "Your commit message"
git push
```

The pre-commit hook will automatically check for sensitive files before each commit.

## Troubleshooting

### Pre-commit Hook Issues

If the pre-commit hook fails, check that you haven't accidentally staged sensitive files:
```bash
git status
git diff --cached --name-only
```

Unstage any sensitive files:
```bash
git reset HEAD <filename>
```

### Git Configuration Issues

Check your current git configuration:
```bash
git config --list --local
```

Reset to recommended settings if needed:
```bash
git config core.autocrlf false
git config core.filemode false
git config pull.rebase true
```