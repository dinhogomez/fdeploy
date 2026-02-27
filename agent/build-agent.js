const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist');

// Garantir que dist/ exista
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

// Buildar agent
console.log('Empacotando FDeploy Agent...');
execSync('npx @yao-pkg/pkg . --compress GZip', { stdio: 'inherit', cwd: __dirname });

// Verificar resultado
const exePath = path.join(DIST_DIR, 'fdeploy-agent.exe');
if (fs.existsSync(exePath)) {
  const size = fs.statSync(exePath).size;
  const mb = (size / 1024 / 1024).toFixed(1);
  console.log(`\nAgent build concluido: dist/fdeploy-agent.exe (${mb} MB)`);
} else {
  console.error('\nErro: fdeploy-agent.exe nao foi gerado.');
  process.exit(1);
}
