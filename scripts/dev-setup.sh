#!/bin/bash
# Development environment setup script

echo "🚀 Setting up Lidifin development environment..."

# Check if .env exists
if [ ! -f backend/.env ]; then
    echo "📝 Creating backend/.env from .env.example..."
    cp .env.example backend/.env
    echo "⚠️  Please update backend/.env with your configuration"
fi

# Check PostgreSQL
echo "🔍 Checking PostgreSQL (port 5433)..."
if ! nc -z localhost 5433 2>/dev/null; then
    echo "❌ PostgreSQL not running on port 5433"
    echo "   Start with: docker compose -f docker-compose.dev.yml up -d postgres"
    exit 1
fi

# Check Redis
echo "🔍 Checking Redis (port 6380)..."
if ! nc -z localhost 6380 2>/dev/null; then
    echo "❌ Redis not running on port 6380"
    echo "   Start with: docker compose -f docker-compose.dev.yml up -d redis"
    exit 1
fi

echo "✅ All services are running!"
echo "📦 Installing dependencies..."
cd backend && npm install && cd ..

echo "🎉 Setup complete! Start development with: cd backend && npm run dev"
