#!/bin/bash
# Dev mode: mounts source into container, builds component, runs vite dev server.
# Much faster than full docker build — only rebuilds the JS component.
docker run -it --rm --memory=8g \
  -v "$PWD/ui/linolium/src":/app/ui/src \
  -v "$PWD/ui/linolium/taxonium_component/src":/app/ui/taxonium_component/src \
  -v "$PWD/ui/linolium/taxonium_backend":/app/ui/taxonium_backend \
  -v "$PWD/autolin":/app/autolin \
  -v "$PWD/data":/app/data \
  -v "$PWD":/data \
  -p 3000:3000 -p 8001:8001 \
  linolium bash -c '
    source /opt/conda/etc/profile.d/conda.sh && conda activate taxalin &&
    echo "Building component..." &&
    cd /app/ui/taxonium_component && npm run build 2>&1 | tail -3 &&
    cd /app/ui/taxonium_backend && node server.js --port 8001 &
    sleep 2 &&
    cd /app/ui && npx vite --port 3000 --host 0.0.0.0 &
    wait
  '
