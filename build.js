const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, 'dist');
const AGENT_DIR = path.join(__dirname, 'agent');

// 1. Limpar dist/ anterior
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true });
  console.log('Pasta dist/ removida.');
}

// 2. Gravar versao do agent para producao
const agentPkg = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, 'package.json'), 'utf8'));
const agentVersionFile = path.join(__dirname, 'data', 'agent-version.txt');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.writeFileSync(agentVersionFile, agentPkg.version, 'utf8');
console.log(`Versao do Agent gravada: ${agentPkg.version} → data/agent-version.txt`);

// 3. Empacotar FDeploy
console.log('Empacotando FDeploy...');
execSync('npx @yao-pkg/pkg . --compress GZip', { stdio: 'inherit' });

// 3. Verificar fdeploy.exe
const exePath = path.join(DIST_DIR, 'fdeploy.exe');
if (fs.existsSync(exePath)) {
  const size = fs.statSync(exePath).size;
  const mb = (size / 1024 / 1024).toFixed(1);
  console.log(`FDeploy: dist/fdeploy.exe (${mb} MB)`);
} else {
  console.error('\nErro: fdeploy.exe nao foi gerado.');
  process.exit(1);
}

// 4. Empacotar Agent
if (fs.existsSync(path.join(AGENT_DIR, 'agent.js'))) {
  console.log('\nEmpacotando FDeploy Agent...');
  execSync('npx @yao-pkg/pkg . --compress GZip', { stdio: 'inherit', cwd: AGENT_DIR });

  const agentPath = path.join(DIST_DIR, 'fdeploy-agent.exe');
  if (fs.existsSync(agentPath)) {
    const size = fs.statSync(agentPath).size;
    const mb = (size / 1024 / 1024).toFixed(1);
    console.log(`Agent: dist/fdeploy-agent.exe (${mb} MB)`);
  } else {
    console.error('Aviso: fdeploy-agent.exe nao foi gerado.');
  }
} else {
  console.log('\nAviso: agent/agent.js nao encontrado, pulando build do agent.');
}

console.log('\nBuild concluido!');
