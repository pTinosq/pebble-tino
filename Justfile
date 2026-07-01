# Pebble Assistant task runner.
# Install `just` with: brew install just
# Run `just` (or `just --list`) to see all recipes.

prod_url := "https://pebble-tino-production.up.railway.app"

# list all recipes
default:
    @just --list

# first-time setup: create .env and secrets.js from templates
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -f apps/server/.env ] || cp apps/server/.env.example apps/server/.env
    [ -f apps/watch/src/pkjs/secrets.js ] || cp apps/watch/src/pkjs/secrets.example.js apps/watch/src/pkjs/secrets.js
    echo "Created apps/server/.env and apps/watch/src/pkjs/secrets.js — now fill them in."

# install all dependencies (npm workspaces)
install:
    npm install

# --- backend (apps/server) ---

# run the backend locally with hot reload
dev:
    npm --workspace apps/server run dev

# type-check + compile the backend
build:
    npm --workspace apps/server run build

# run the compiled backend
start:
    npm --workspace apps/server start

# --- watch app (apps/watch) ---

# build the Pebble watch app
watch-build:
    cd apps/watch && pebble build

# build + install the watch app via CloudPebble
watch-install:
    cd apps/watch && pebble build && pebble install --cloudpebble

# build + install to a phone by IP, e.g. `just watch-phone 192.168.1.42`
watch-phone ip:
    cd apps/watch && pebble build && pebble install --phone {{ip}}

# build + run in the emulator (emery = Pebble Time 2 resolution)
watch-emu:
    cd apps/watch && pebble build && pebble install --emulator emery

# --- prod / Railway ---

# deploy: push to main (Railway auto-deploys apps/server)
deploy:
    git push origin main

# hit the prod health endpoint
health:
    @curl -s {{prod_url}}/ ; echo

# ask the prod backend a question, e.g. `just ask "what is a pebble watch"`
ask question:
    #!/usr/bin/env bash
    set -euo pipefail
    token=$(grep '^ASSISTANT_TOKEN=' apps/server/.env | cut -d= -f2-)
    curl -s {{prod_url}}/ask \
      -H 'content-type: application/json' \
      -H "x-assistant-token: $token" \
      --data "$(printf '{"question":"%s"}' '{{question}}')"
    echo
