#!/bin/bash

echo 'MHQ_EXTRACT_BACKEND_DEPENDENCIES'
if [ -f /opt/venv.tar.gz ]; then
    mkdir -p /opt/venv
    tar xzf /opt/venv.tar.gz -C /opt/venv --strip-components=2
    rm -rf /opt/venv.tar.gz
else
    echo "Tar file /opt/venv.tar.gz does not exist. Skipping extraction."
fi

echo 'MHQ_EXTRACT_FRONTEND'
if [ -f /app/web-server.tar.gz ]; then
    mkdir -p /app/web-server
    tar xzf /app/web-server.tar.gz -C /app/web-server --strip-components=2
    rm -rf /app/web-server.tar.gz
else
    echo "Tar file /app/web-server.tar.gz does not exist. Skipping extraction."
fi

echo 'MHQ_STARTING SUPERVISOR'

if [ -f "/app/backend/analytics_server/mhq/config/config.ini" ]; then
  echo "config.ini found. Setting environment variables from config.ini..."
    # CLUSTOX: `export`, not an un-exported `KEY=value` appended to ~/.bashrc.
    # The old line wrote plain assignments, so `source ~/.bashrc` set shell
    # variables that died in this script -- supervisord and every child
    # (including the Next.js server) never saw SECRET_PUBLIC_KEY, and linking
    # any integration failed with a 400 ("first argument must be ... Received
    # undefined" from Buffer.from(undefined)).
    #
    # The bug only bites from the SECOND boot onward: the first boot takes the
    # else-branch below, whose generate script writes `export` lines. That is
    # why integrations linked fine on a fresh install and broke after any
    # container recreate -- config.ini persists in the keys volume, so every
    # redeploy lands here.
    while IFS='=' read -r key value; do
        if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && ! -z "$value" ]]; then
            export "$key"="$value"
        fi
    done < "../backend/analytics_server/mhq/config/config.ini"
else
    echo "config.ini not found. Running generate_config_ini.sh..."
    /app/setup_utils/generate_config_ini.sh -t /app/backend/analytics_server/mhq/config
fi

source ~/.bashrc

/usr/bin/supervisord -c "/etc/supervisord.conf"
