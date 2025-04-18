#!/bin/bash

# Compile the TypeScript file
echo "Compiling TypeScript..."
npx tsc scripts/typescript/test-stream-chat.ts --esModuleInterop --resolveJsonModule --target es2020 --module commonjs --outDir scripts/dist

# Run the compiled JavaScript file
echo "Running test script..."
NEXT_PUBLIC_STREAM_API_KEY=$(grep NEXT_PUBLIC_STREAM_API_KEY .env | cut -d '=' -f2) \
STREAM_SECRET_KEY=$(grep STREAM_SECRET_KEY .env | cut -d '=' -f2) \
DATABASE_URL=$(grep DATABASE_URL .env | cut -d '=' -f2) \
node scripts/dist/test-stream-chat.js
