#!/bin/bash

# LinuxServer.io style PUID/PGID entrypoint

PUID=${PUID:-1000}
PGID=${PGID:-1000}

echo "----------------------------------------------------"
echo "  Starting rcCommander with LS.io style IDs"
echo "  User UID: $PUID"
echo "  User GID: $PGID"
echo "----------------------------------------------------"

# Update node user to match PUID/PGID
groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node

# Ensure directories have correct ownership
# We only chown /config if it exists to avoid errors
if [ -d "/config" ]; then
    chown -R node:node /config
fi

# Point RCLONE_CONFIG to the neutral path if not set, 
# and ensure node user has a proper home for rclone to work
export HOME=/home/node
export RCLONE_CONFIG=${RCLONE_CONFIG:-/config/rclone.conf}

# Switch to the node user and execute the command
exec gosu node "$@"
