#!/bin/bash
# ─── Upload .env + tokens to EC2 ─────────────────────────────────────────────
# Usage:
#   EC2_HOST=54.x.x.x EC2_KEY=~/.ssh/planner-key.pem ./scripts/upload-env-tokens.sh
#
# This copies your local .env and tokens/ to the EC2 instance.
# Run this after the first deploy and whenever you rotate tokens.

set -e

EC2_HOST="${EC2_HOST:-}"
EC2_KEY="${EC2_KEY:-~/.ssh/planner-key.pem}"
EC2_USER="${EC2_USER:-ubuntu}"
APP_DIR="/home/ubuntu/daily-planner-agent"

if [ -z "$EC2_HOST" ]; then
  echo "ERROR: EC2_HOST is not set."
  echo "Usage: EC2_HOST=54.x.x.x EC2_KEY=~/.ssh/planner-key.pem ./scripts/upload-env-tokens.sh"
  exit 1
fi

echo "▶ Uploading .env to ${EC2_USER}@${EC2_HOST}..."
scp -i "$EC2_KEY" -o StrictHostKeyChecking=no .env "${EC2_USER}@${EC2_HOST}:${APP_DIR}/.env"

echo "▶ Uploading tokens/ to ${EC2_USER}@${EC2_HOST}..."
scp -i "$EC2_KEY" -o StrictHostKeyChecking=no -r tokens/ "${EC2_USER}@${EC2_HOST}:${APP_DIR}/tokens/"

echo ""
echo "✅ Upload complete! Restart the app to pick up new credentials:"
echo "   ssh -i $EC2_KEY ${EC2_USER}@${EC2_HOST} 'pm2 restart planner'"
