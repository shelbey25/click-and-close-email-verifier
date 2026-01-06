#!/usr/bin/env sh

# Endpoint
URL="http://localhost:3000/verify"

# Emails to verify
EMAILS=(
  "cotting@consultingshop.co"
)

for EMAIL in "${EMAILS[@]}"; do
  echo "Verifying: $EMAIL"

  curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\"}"

  echo "\n----------------------------------------"
done
