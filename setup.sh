#!/bin/bash

# Life OS Dashboard Setup Script

echo "🚀 Life OS Dashboard Setup"
echo "=========================="
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Generate password hash
echo ""
echo "🔑 Password Hashing"
echo "Enter your dashboard password (you'll need this for login):"
read -s password

if [ -z "$password" ]; then
    echo "❌ Password cannot be empty"
    exit 1
fi

# Generate bcrypt hash
hash=$(node -e "
const bcrypt = require('bcryptjs');
bcrypt.genSalt(10, (err, salt) => {
  if (err) {
    console.error('Error:', err);
    process.exit(1);
  }
  bcrypt.hash('$password', salt, (err, hash) => {
    if (err) {
      console.error('Error:', err);
      process.exit(1);
    }
    console.log(hash);
  });
});
")

if [ $? -ne 0 ]; then
    echo "❌ Failed to generate password hash"
    exit 1
fi

# Create .env.local
echo ""
echo "📝 Creating .env.local..."
cat > .env.local << EOF
NEXT_PUBLIC_APP_NAME="Life OS"
DASHBOARD_PASSWORD_HASH="$hash"

# Mercury API (optional)
MERCURY_API_KEY=""

# Google Calendar (optional)
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GOOGLE_REFRESH_TOKEN=""
GOOGLE_CALENDAR_ID="primary"

# Fathom (optional)
FATHOM_API_KEY=""

# Monday.com (optional)
MONDAY_API_KEY=""

# Slack (optional)
SLACK_BOT_TOKEN=""
SLACK_USER_ID=""

# Anthropic (optional)
ANTHROPIC_API_KEY=""
EOF

echo "✅ .env.local created successfully"
echo ""
echo "🎯 Next Steps:"
echo "1. Update .env.local with your API keys (optional)"
echo "2. Run: npm run dev"
echo "3. Open: http://localhost:3000/login"
echo "4. Login with your password"
echo ""
echo "📚 For full feature support, add these optional API keys:"
echo "   - MERCURY_API_KEY (banking data)"
echo "   - GOOGLE_* (calendar integration)"
echo "   - FATHOM_API_KEY (meeting summaries)"
echo "   - MONDAY_API_KEY (team tasks)"
echo "   - SLACK_BOT_TOKEN (task sync)"
echo "   - ANTHROPIC_API_KEY (AI briefing)"
echo ""
