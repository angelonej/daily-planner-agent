#!/bin/bash
# ─── Upload Google OAuth Tokens to EC2 ────────────────────────────────────────
# Run this after completing `npm run auth -- personal` and `npm run auth -- work`
# on your local machine. It SCPs the token files up to the EC2 server.
#
# Usage:
#   chmod +x scripts/upload-tokens.sh
#   EC2_HOST=54.x.x.x EC2_KEY=~/.ssh/key.pem ./scripts/upload-tokens.sh

set -e

EC2_HOST="${EC2_HOST:-}"
EC2_KEY="${EC2_KEY:-~/.ssh/planner-key.pem}"
EC2_USER="${EC2_USER:-ubuntu}"
APP_DIR="/home/ubuntu/daily-planner-agent"
TOKEN_DIR="./tokens"

if [ -z "$EC2_HOST" ]; then
  echo "ERROR: EC2_HOST is not set."
  echo "Usage: EC2_HOST=54.x.x.x EC2_KEY=~/.ssh/key.pem ./scripts/upload-tokens.sh"
  exit 1
fi

if [ ! -d "$TOKEN_DIR" ] || [ -z "$(ls -A $TOKEN_DIR/*.json 2>/dev/null)" ]; then
  echo "ERROR: No token files found in $TOKEN_DIR/"
  echo "Run 'npm run auth -- personal' and 'npm run auth -- work' first."
  exit 1
fi

echo ""
echo "▶ Uploading OAuth tokens to ${EC2_USER}@${EC2_HOST}..."

# Ensure remote tokens directory exists
ssh -i "$EC2_KEY" -o StrictHostKeyChecking=no "${EC2_USER}@${EC2_HOST}" \
  "mkdir -p ${APP_DIR}/tokens && chmod 700 ${APP_DIR}/tokens"

# Upload all token files
scp -i "$EC2_KEY" -o StrictHostKeyChecking=no \
  "$TOKEN_DIR"/*.token.json \
  "${EC2_USER}@${EC2_HOST}:${APP_DIR}/tokens/"

# Also upload .env if it exists and user confirms
if [ -f ".env" ]; then
  read -p "Also upload .env file? (y/N): " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    scp -i "$EC2_KEY" -o StrictHostKeyChecking=no \
      .env "${EC2_USER}@${EC2_HOST}:${APP_DIR}/.env"
    echo "   .env uploaded."
  fi
fi

echo ""
echo "✅ Tokens uploaded successfully!"
echo "   Restart the agent: ssh -i $EC2_KEY ${EC2_USER}@${EC2_HOST} 'pm2 restart planner'"
