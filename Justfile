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
    [ -f apps/translate/src/pkjs/secrets.js ] || cp apps/translate/src/pkjs/secrets.example.js apps/translate/src/pkjs/secrets.js
    echo "Created apps/server/.env + secrets.js for watch & translate — now fill them in."

# install all dependencies (npm workspaces)
install:
    npm install

# connect your Notion account via OAuth (one-time browser login)
setup-notion:
    npm --workspace apps/server run auth:notion

# connect your Slack workspace via OAuth (needs a Slack app; one-time browser login)
setup-slack:
    npm --workspace apps/server run auth:slack

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

# --- translate app (apps/translate) ---

# build the Translate watch app
translate-build:
    cd apps/translate && pebble build

# build + install the Translate app via CloudPebble
translate-install:
    cd apps/translate && pebble build && pebble install --cloudpebble

# build + install Translate to a phone by IP, e.g. `just translate-phone 192.168.1.42`
translate-phone ip:
    cd apps/translate && pebble build && pebble install --phone {{ip}}

# build + run Translate in the emulator (emery = Pebble Time 2 resolution)
translate-emu:
    cd apps/translate && pebble build && pebble install --emulator emery

# --- all watch apps ---

# build + install every watch app via CloudPebble
apps-install: watch-install translate-install

# build + install every watch app to a phone by IP, e.g. `just apps-phone 192.168.1.42`
apps-phone ip: (watch-phone ip) (translate-phone ip)

# build + install every watch app into the emulator
apps-emu: watch-emu translate-emu

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

# translate text via the prod backend, e.g. `just translate "καλημέρα, τι κάνεις;"`
translate text:
    #!/usr/bin/env bash
    set -euo pipefail
    token=$(grep '^ASSISTANT_TOKEN=' apps/server/.env | cut -d= -f2-)
    curl -s {{prod_url}}/translate \
      -H 'content-type: application/json' \
      -H "x-assistant-token: $token" \
      --data "$(printf '{"text":"%s"}' '{{text}}')"
    echo
