#!/bin/bash

# Taxonium Production Runner
# Usage: ./run-prod.sh [path-to-data-file]
# Examples: 
#   ./run-prod.sh                                    # Uses default data
#   ./run-prod.sh ./mtb.4.8.autolin.jsonl.gz  # Custom file
#   ./run-prod.sh /absolute/path/to/data.jsonl.gz    # Absolute path

set -e

DATA_FILE=${1:-"./XFG.pangoonly.jsonl.gz"}

echo "🔧 Starting Taxonium Production Server"
echo "📊 Data file: $DATA_FILE"
echo "🌐 Frontend will be available at: http://localhost:3000"
echo "🔌 Backend will be available at: http://localhost:8001"
echo ""

# Check if data file exists (handle both relative and absolute paths)
if [[ "$DATA_FILE" == /* ]]; then
    # Absolute path
    if [ ! -f "$DATA_FILE" ]; then
        echo "❌ Error: Data file '$DATA_FILE' not found!"
        echo "Please provide a valid absolute path to a .jsonl.gz file"
        exit 1
    fi
    BACKEND_DATA_FILE="$DATA_FILE"
else
    # Relative path - check from current directory
    if [ ! -f "$DATA_FILE" ]; then
        echo "❌ Error: Data file '$DATA_FILE' not found!"
        echo "Please provide a valid path to a .jsonl.gz file"
        echo "Usage: $0 [path-to-data-file]"
        exit 1
    fi
    BACKEND_DATA_FILE="../$DATA_FILE"
fi

echo "✅ Data file found: $DATA_FILE"
echo "🚀 Starting servers..."

# Start backend with custom data file
cd taxonium_backend
npm install
echo "🔄 Starting backend on port 8001..."
node server.js --port 8001 --data_file "$BACKEND_DATA_FILE" &
BACKEND_PID=$!

# Wait a bit for backend to start
sleep 2

# Start frontend server
cd ..
echo "🔄 Starting frontend on port 3000..."
npx serve dist -l 3000 &
FRONTEND_PID=$!

echo ""
echo "🎉 Both servers started successfully!"
echo "📱 Open http://localhost:3000 in your browser"
echo "🛑 Press Ctrl+C to stop both servers"

# Function to cleanup processes on exit
cleanup() {
    echo ""
    echo "🛑 Stopping servers..."
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    exit 0
}

# Set trap to cleanup on script exit
trap cleanup SIGINT SIGTERM

# Wait for processes
wait