#!/bin/bash
# ─── EC2 First-Time Setup Script ──────────────────────────────────────────────
# Run this ONCE on a fresh Ubuntu 22.04 EC2 instance:
#   chmod +x scripts/ec2-setup.sh
#   ./scripts/ec2-setup.sh
#
# Prerequisites:
#   - EC2: Ubuntu 22.04, t3.micro or larger
#   - Security group: inbound TCP 22 (SSH), 80 (HTTP), 443 (HTTPS)
#   - Your repo URL set below

set -e  # exit on any error

REPO_URL="${REPO_URL:-}"
APP_DIR="/home/ubuntu/daily-planner-agent"
NODE_VERSION="20"

if [ -z "$REPO_URL" ]; then
  echo "ERROR: REPO_URL is not set."
  echo "Usage: REPO_URL=https://github.com/you/daily-planner-agent.git ./scripts/ec2-setup.sh"
  exit 1
fi

echo "========================================"
echo "  Daily Planner Agent — EC2 Setup"
echo "========================================"

# ─── 1. System updates ────────────────────────────────────────────────────────
echo ""
echo "▶ Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y

# ─── 2. Install Node.js via nvm ───────────────────────────────────────────────
echo ""
echo "▶ Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v
npm -v

# ─── 3. Install PM2 globally ──────────────────────────────────────────────────
echo ""
echo "▶ Installing PM2..."
sudo npm install -g pm2

# ─── 4. Install Nginx ─────────────────────────────────────────────────────────
echo ""
echo "▶ Installing Nginx..."
sudo apt-get install -y nginx

# ─── 5. Install Certbot for HTTPS (Twilio requires HTTPS) ─────────────────────
echo ""
echo "▶ Installing Certbot..."
sudo apt-get install -y certbot python3-certbot-nginx

# ─── 6. Clone repository ──────────────────────────────────────────────────────
echo ""
echo "▶ Cloning repository..."
if [ -d "$APP_DIR" ]; then
  echo "   Directory exists, pulling latest..."
  cd "$APP_DIR" && git pull
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# ─── 7. Install dependencies (prod only, no build — dist/ is committed) ─────
echo ""
echo "▶ Installing production dependencies..."
cd "$APP_DIR"
npm install --omit=dev

# ─── 8. Create directories ────────────────────────────────────────────────────
mkdir -p "$APP_DIR/logs"
mkdir -p "$APP_DIR/tokens"

# ─── 9. Configure Nginx reverse proxy ────────────────────────────────────────
echo ""
echo "▶ Configuring Nginx..."
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/planner
sudo ln -sf /etc/nginx/sites-available/planner /etc/nginx/sites-enabled/planner
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# ─── 10. Set up PM2 to start on reboot ───────────────────────────────────────
echo ""
echo "▶ Configuring PM2 startup..."
pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 | sudo bash || true

echo ""
echo "========================================"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Copy your .env file:"
echo "     scp -i ~/.ssh/planner-key.pem .env ubuntu@YOUR_EC2_IP:$APP_DIR/.env"
echo ""
echo "  2. Upload your Google OAuth tokens:"
echo "     scp -i ~/.ssh/planner-key.pem -r tokens/ ubuntu@YOUR_EC2_IP:$APP_DIR/tokens/"
echo ""
echo "  3. Start the app:"
echo "     ssh ubuntu@YOUR_EC2_IP 'cd $APP_DIR && pm2 start ecosystem.config.cjs && pm2 save'"
echo ""
echo "  4. (Optional) Add HTTPS with your domain:"
echo "     sudo certbot --nginx -d yourdomain.com"
echo ""
echo "  5. (Optional) Password-protect — uncomment auth_basic in deploy/nginx.conf"
echo "     sudo apt-get install -y apache2-utils"
echo "     sudo htpasswd -c /etc/nginx/.htpasswd yourname"
echo "========================================"
echo ""
echo "  4. Start the agent:"
echo "     cd $APP_DIR && pm2 start ecosystem.config.cjs"
echo "     pm2 save"
echo "========================================"
