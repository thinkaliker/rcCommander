#!/bin/bash

# Source user profiles in case node is managed by nvm or similar tools in interactive shells
source ~/.bash_profile 2>/dev/null
source ~/.zshrc 2>/dev/null
source ~/.bashrc 2>/dev/null

# 1. Check & Install Node.js Locally
if ! command -v node &> /dev/null; then
    echo "Node.js is not found globally. Attempting to fetch it locally..."
    NODE_VERSION="v22.14.0" # Vite requires 22.12+
    OS="$(uname -s | awk '{print tolower($0)}')"
    ARCH="$(uname -m)"
    
    # Normalize architecture string
    if [ "$ARCH" = "x86_64" ]; then
        N_ARCH="x64"
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        N_ARCH="arm64"
    else
        echo "Unsupported architecture: $ARCH"
        exit 1
    fi

    # Determine tarball name based on OS
    if [ "$OS" = "darwin" ]; then
        NODE_TAR="node-$NODE_VERSION-darwin-$N_ARCH.tar.gz"
    else
        NODE_TAR="node-$NODE_VERSION-linux-$N_ARCH.tar.gz"
    fi
    NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_TAR"
    NODE_DIR="$PWD/.node"

    if [ ! -d "$NODE_DIR" ]; then
        echo "Downloading $NODE_TAR to local directory..."
        mkdir -p "$NODE_DIR"
        if command -v curl &> /dev/null; then
            curl -sL "$NODE_URL" | tar xz -C "$NODE_DIR" --strip-components=1
        elif command -v wget &> /dev/null; then
            wget -qO- "$NODE_URL" | tar xz -C "$NODE_DIR" --strip-components=1
        else
            echo "Error: Neither curl nor wget found. Cannot download Node.js!"
            exit 1
        fi
    fi
    
    export PATH="$NODE_DIR/bin:$PATH"
    echo "Using local Node.js: $(node -v)"
else
    echo "Node.js is found: $(command -v node) (Version: $(node -v))"
fi

# 2. Check & Install Dependencies
echo "Ensuring frontend dependencies are installed..."
cd frontend
if [ ! -d "node_modules" ]; then
    npm install
fi
cd ..

echo "Ensuring server dependencies are installed..."
cd server
if [ ! -d "node_modules" ]; then
    npm install
fi
cd ..

# 3. Start Both Services
echo "Starting Express backend on port 3001..."
cd server
npm run dev &
SERVER_PID=$!
cd ..

echo "Starting Vite frontend on port 5173 (all interfaces)..."
cd frontend
npm run dev -- --host 0.0.0.0 &
FRONTEND_PID=$!
cd ..

# 4. Graceful Shutdown
# Trap Ctrl+C (SIGINT) to kill both the background server and frontend gracefully
trap "echo -e '\nShutting down both servers...'; kill $SERVER_PID; kill $FRONTEND_PID; exit 0" SIGINT SIGTERM

echo "================================================="
echo "rcCommander is running!"
echo "Backend active at  -> http://localhost:3001"
echo "Frontend active at -> http://localhost:5173"
echo "Press Ctrl+C to stop both servers."
echo "================================================="

# Wait indefinitely until interrupted
wait
