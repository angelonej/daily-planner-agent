#!/bin/bash
# ─── Deploy Script ─────────────────────────────────────────────────────────────
# Pulls latest code, rebuilds, and restarts PM2 on your EC2 instance.
#
# Usage (from your local machine):
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# Required env vars (set in your local shell or .env.deploy):
#   EC2_HOST  — your EC2 public IP or domain, e.g. 54.123.45.67
#   EC2_KEY   — path to your .pem key file, e.g. ~/.ssh/planner-key.pem
#   EC2_USER  — usually "ubuntu" for Ubuntu AMIs

set -e

EC2_HOST="${EC2_HOST:-}"
EC2_KEY="${EC2_KEY:-~/.ssh/planner-key.pem}"
EC2_USER="${EC2_USER:-ubuntu}"
APP_DIR="/home/ubuntu/daily-planner-agent"

if [ -z "$EC2_HOST" ]; then
  echo "ERROR: EC2_HOST is not set."
  echo "Usage: EC2_HOST=54.x.x.x EC2_KEY=~/.ssh/key.pem ./scripts/deploy.sh"
  exit 1
fi

echo ""
echo "▶ Deploying to ${EC2_USER}@${EC2_HOST}..."

ssh -i "$EC2_KEY" -o StrictHostKeyChecking=no "${EC2_USER}@${EC2_HOST}" << EOF
  set -e
  cd $APP_DIR

  echo "  → Pulling latest code..."
  git pull

  echo "  → Installing dependencies..."
  npm install --production=false

  echo "  → Building TypeScript..."
  npm run build

  echo "  → Restarting PM2..."
  pm2 restart planner || pm2 start ecosystem.config.cjs
  pm2 save

  echo "  → Status:"
  pm2 list
EOF

echo ""
echo "✅ Deploy complete!"
echo "   Logs: ssh -i $EC2_KEY ${EC2_USER}@${EC2_HOST} 'pm2 logs planner --lines 50'"
