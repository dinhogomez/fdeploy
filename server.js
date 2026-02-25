const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { NodeSSH } = require('node-ssh');

const app = express();
const PORT = 3500;

// ── Caminhos ──
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SERVIDORES_PATH = path.join(DATA_DIR, 'servidores.json');
const DEPLOY_LOG_PATH = path.join(DATA_DIR, 'deploy_log.json');

// ── Caminhos remotos (Windows) ──
const REMOTE_EXE = 'C:\\f\\Fvendas2.0\\Fvendas2.0.exe';
const REMOTE_BAK = 'C:\\f\\Fvendas2.0\\Fvendas2.0.exe.bak';
const REMOTE_DIR = 'C:\\f\\Fvendas2.0';
const REMOTE_PKG = 'C:\\f\\Fvendas2.0\\package.json';
const SERVICE_NAME = 'Fvendas2.0';

// ── Criptografia AES ──
const CRYPTO_KEY = crypto.scryptSync('fdeploy-secret-2026', 'salt', 32);
const CRYPTO_IV = Buffer.alloc(16, 0);

function encrypt(text) {
  const cipher = crypto.createCipheriv('aes-256-cbc', CRYPTO_KEY, CRYPTO_IV);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decrypt(text) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', CRYPTO_KEY, CRYPTO_IV);
  let decrypted = decipher.update(text, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ── Helpers ──
function lerServidores() {
  if (!fs.existsSync(SERVIDORES_PATH)) return [];
  return JSON.parse(fs.readFileSync(SERVIDORES_PATH, 'utf8'));
}

function salvarServidores(lista) {
  fs.writeFileSync(SERVIDORES_PATH, JSON.stringify(lista, null, 2), 'utf8');
}

function lerDeployLog() {
  if (!fs.existsSync(DEPLOY_LOG_PATH)) return [];
  return JSON.parse(fs.readFileSync(DEPLOY_LOG_PATH, 'utf8'));
}

function salvarDeployLog(entry) {
  const logs = lerDeployLog();
  logs.unshift(entry);
  if (logs.length > 50) logs.length = 50;
  fs.writeFileSync(DEPLOY_LOG_PATH, JSON.stringify(logs, null, 2), 'utf8');
}

async function conectarSSH(servidor) {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: servidor.ip,
    port: servidor.porta || 22,
    username: servidor.usuario,
    password: decrypt(servidor.senha),
    readyTimeout: 15000,
  });
  return ssh;
}

async function obterVersaoRemota(ssh) {
  try {
    const result = await ssh.execCommand(`type "${REMOTE_PKG}"`);
    if (result.code === 0 && result.stdout) {
      const pkg = JSON.parse(result.stdout);
      return pkg.version || null;
    }
  } catch (_) {}
  return null;
}

async function obterStatusServico(ssh) {
  try {
    const result = await ssh.execCommand(`sc query ${SERVICE_NAME}`);
    if (result.stdout.includes('RUNNING')) return 'rodando';
    if (result.stdout.includes('STOPPED')) return 'parado';
    return 'desconhecido';
  } catch (_) {
    return 'erro';
  }
}

// ── Middlewares ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Upload ──
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, 'Fvendas2.0.exe'),
});
const upload = multer({ storage });

// ══════════════════════════════════════════
// ROTAS — SERVIDORES
// ══════════════════════════════════════════

app.get('/api/servidores', (req, res) => {
  const servidores = lerServidores().map(s => ({
    ...s,
    senha: undefined,
    temSenha: !!s.senha,
  }));
  res.json(servidores);
});

app.post('/api/servidores', (req, res) => {
  const { nome, ip, porta, usuario, senha, descricao } = req.body;
  if (!nome || !ip || !usuario || !senha) {
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, ip, usuario, senha' });
  }
  const servidores = lerServidores();
  const novo = {
    id: Date.now().toString(),
    nome,
    ip,
    porta: porta || 22,
    usuario,
    senha: encrypt(senha),
    descricao: descricao || '',
    criadoEm: new Date().toISOString(),
  };
  servidores.push(novo);
  salvarServidores(servidores);
  res.json({ ok: true, id: novo.id });
});

app.put('/api/servidores/:id', (req, res) => {
  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Servidor não encontrado' });

  const { nome, ip, porta, usuario, senha, descricao } = req.body;
  if (nome) servidores[idx].nome = nome;
  if (ip) servidores[idx].ip = ip;
  if (porta !== undefined) servidores[idx].porta = porta;
  if (usuario) servidores[idx].usuario = usuario;
  if (senha) servidores[idx].senha = encrypt(senha);
  if (descricao !== undefined) servidores[idx].descricao = descricao;

  salvarServidores(servidores);
  res.json({ ok: true });
});

app.delete('/api/servidores/:id', (req, res) => {
  let servidores = lerServidores();
  servidores = servidores.filter(s => s.id !== req.params.id);
  salvarServidores(servidores);
  res.json({ ok: true });
});

// ══════════════════════════════════════════
// ROTAS — UPLOAD
// ══════════════════════════════════════════

app.post('/api/upload', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  res.json({ ok: true, tamanho: req.file.size, nome: req.file.originalname });
});

app.get('/api/upload/status', (req, res) => {
  const exePath = path.join(UPLOADS_DIR, 'Fvendas2.0.exe');
  if (!fs.existsSync(exePath)) {
    return res.json({ disponivel: false });
  }
  const stats = fs.statSync(exePath);
  res.json({
    disponivel: true,
    arquivo: 'Fvendas2.0.exe',
    tamanho_mb: (stats.size / 1024 / 1024).toFixed(1),
    modificado_em: stats.mtime.toISOString(),
  });
});

// ══════════════════════════════════════════
// ROTAS — TESTAR / VERSAO
// ══════════════════════════════════════════

app.post('/api/testar/:id', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor não encontrado' });

  let ssh;
  try {
    ssh = await conectarSSH(servidor);
    const servico_status = await obterStatusServico(ssh);
    const versao_atual = await obterVersaoRemota(ssh);
    ssh.dispose();
    res.json({ conectou: true, servico_status, versao_atual });
  } catch (err) {
    if (ssh) ssh.dispose();
    res.json({ conectou: false, erro: err.message });
  }
});

app.get('/api/versao/:id', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor não encontrado' });

  let ssh;
  try {
    ssh = await conectarSSH(servidor);
    const versao = await obterVersaoRemota(ssh);
    ssh.dispose();
    res.json({ versao });
  } catch (err) {
    if (ssh) ssh.dispose();
    res.json({ versao: null, erro: err.message });
  }
});

// ══════════════════════════════════════════
// ROTAS — DEPLOY
// ══════════════════════════════════════════

async function executarDeploy(servidor) {
  const inicio = Date.now();
  const log = [];
  let ssh;
  let sucesso = false;

  function logMsg(msg, tipo = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    log.push({ ts, msg, tipo });
  }

  try {
    const exeLocal = path.join(UPLOADS_DIR, 'Fvendas2.0.exe');
    if (!fs.existsSync(exeLocal)) {
      logMsg('Nenhum .exe disponível em uploads/', 'erro');
      throw new Error('Nenhum .exe disponível');
    }

    logMsg('Conectando via SSH...', 'progresso');
    ssh = await conectarSSH(servidor);
    logMsg('Conectado!', 'sucesso');

    // 1. Parar serviço
    logMsg('Parando serviço...', 'progresso');
    const stopResult = await ssh.execCommand(`net stop ${SERVICE_NAME}`);
    if (stopResult.code !== 0 && !stopResult.stderr.includes('not been started')) {
      logMsg(`Aviso ao parar: ${stopResult.stderr}`, 'progresso');
    }
    logMsg('Serviço parado', 'sucesso');

    // 2. Backup
    logMsg('Fazendo backup do .exe atual...', 'progresso');
    await ssh.execCommand(`del "${REMOTE_BAK}" 2>nul`);
    const renameResult = await ssh.execCommand(`rename "${REMOTE_EXE}" "Fvendas2.0.exe.bak"`);
    if (renameResult.code !== 0 && !renameResult.stderr.includes('cannot find')) {
      logMsg(`Aviso no backup: ${renameResult.stderr}`, 'progresso');
    }
    logMsg('Backup concluído', 'sucesso');

    // 3. Upload SFTP
    logMsg('Enviando novo .exe via SFTP...', 'progresso');
    await ssh.putFile(exeLocal, REMOTE_EXE);
    logMsg('Upload concluído', 'sucesso');

    // 4. Iniciar serviço
    logMsg('Iniciando serviço...', 'progresso');
    const startResult = await ssh.execCommand(`net start ${SERVICE_NAME}`);
    logMsg('Comando net start executado', 'sucesso');

    // 5. Verificar
    logMsg('Verificando serviço...', 'progresso');
    await new Promise(r => setTimeout(r, 3000));
    const status = await obterStatusServico(ssh);

    if (status === 'rodando') {
      const versao = await obterVersaoRemota(ssh);
      logMsg(`Serviço rodando! Versão: ${versao || '?'}`, 'sucesso');
      sucesso = true;
    } else {
      // 6. Rollback
      logMsg(`Serviço NÃO está rodando (status: ${status}). Executando rollback...`, 'erro');
      await ssh.execCommand(`net stop ${SERVICE_NAME} 2>nul`);
      await ssh.execCommand(`del "${REMOTE_EXE}" 2>nul`);
      await ssh.execCommand(`rename "${REMOTE_BAK}" "Fvendas2.0.exe"`);
      await ssh.execCommand(`net start ${SERVICE_NAME}`);
      logMsg('ROLLBACK executado — versão anterior restaurada', 'erro');
    }
  } catch (err) {
    logMsg(`ERRO: ${err.message}`, 'erro');
  } finally {
    if (ssh) ssh.dispose();
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  logMsg(`Duração: ${duracao}s`, 'info');

  const entry = {
    servidor: servidor.nome,
    ip: servidor.ip,
    sucesso,
    duracao: `${duracao}s`,
    data: new Date().toISOString(),
    log,
  };
  salvarDeployLog(entry);

  return entry;
}

app.post('/api/deploy/:id', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor não encontrado' });
  const result = await executarDeploy(servidor);
  res.json(result);
});

app.post('/api/deploy/todos', async (req, res) => {
  const servidores = lerServidores();
  if (servidores.length === 0) return res.json([]);
  const results = await Promise.allSettled(
    servidores.map(s => executarDeploy(s))
  );
  res.json(results.map(r => r.status === 'fulfilled' ? r.value : { erro: r.reason?.message }));
});

// ── Histórico ──
app.get('/api/historico', (req, res) => {
  res.json(lerDeployLog());
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`FDeploy rodando em http://localhost:${PORT}`);
});
