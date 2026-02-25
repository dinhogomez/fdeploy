#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then
  echo "Instalando dependencias..."
  npm install
fi
echo "Iniciando FDeploy em http://localhost:3500"
node server.js &
sleep 2
open http://localhost:3500
