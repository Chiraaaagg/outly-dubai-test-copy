#!/bin/sh
# Local test shop: print the latest phone verification code (scripts/shop/README.md).
grep -o '"devOtpCode":"[0-9]*"' /tmp/outly-shop/server.log 2>/dev/null | tail -1 | grep -o '[0-9][0-9]*' || echo "No code yet: press Pay in the shop first."
