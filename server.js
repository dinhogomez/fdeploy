const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { NodeSSH } = require('node-ssh');

const app = express();
const PORT = 3500;

// Prevenir crash por erros não tratados em conexões SSH
process.on('uncaughtException', (err) => {
  console.error('[ERRO] Excecao nao tratada:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[ERRO] Promise rejeitada:', err?.message || err);
});

// ── Caminhos ──
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SERVIDORES_PATH = path.join(DATA_DIR, 'servidores.json');
const DEPLOY_LOG_PATH = path.join(DATA_DIR, 'deploy_log.json');

// ── Garantir que diretórios existam ──
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
    readyTimeout: 30000,
    keepaliveInterval: 10000,
    keepaliveCountMax: 30,
  });
  // Prevenir crash por ECONNRESET
  if (ssh.connection) {
    ssh.connection.on('error', (err) => {
      console.log(`[SSH] Conexao perdida com ${servidor.ip}: ${err.message}`);
    });
  }
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

// ── Compactação gzip ──
function compactarArquivo(origem, destino) {
  return new Promise((resolve, reject) => {
    const src = fs.createReadStream(origem);
    const dst = fs.createWriteStream(destino);
    const gz = zlib.createGzip({ level: 6 });
    src.pipe(gz).pipe(dst);
    dst.on('finish', () => {
      const origSize = fs.statSync(origem).size;
      const compSize = fs.statSync(destino).size;
      resolve({ origSize, compSize });
    });
    src.on('error', reject);
    dst.on('error', reject);
  });
}

// ── SFTP com progresso ──
function enviarArquivoSFTP(ssh, localPath, remotePath, onProgress) {
  return new Promise((resolve, reject) => {
    ssh.requestSFTP().then(sftp => {
      const fileSize = fs.statSync(localPath).size;
      sftp.fastPut(localPath, remotePath, {
        step: (transferred, _chunk, _total) => {
          if (onProgress) onProgress(transferred, fileSize);
        }
      }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }).catch(reject);
  });
}

const PS_DECOMPRESS = (gzPath, exePath) => `powershell -Command "` +
  `$inp = [System.IO.File]::OpenRead('${gzPath}'); ` +
  `$out = [System.IO.File]::Create('${exePath}'); ` +
  `$gz = New-Object System.IO.Compression.GZipStream($inp, [System.IO.Compression.CompressionMode]::Decompress); ` +
  `$gz.CopyTo($out); $gz.Close(); $out.Close(); $inp.Close(); ` +
  `Write-Host 'OK'"`;

// ── Middlewares ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Upload ──
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, 'Fvendas2.0.exe'),
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500 MB

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

app.post('/api/upload', (req, res) => {
  req.setTimeout(10 * 60 * 1000);
  res.setTimeout(10 * 60 * 1000);

  upload.single('arquivo')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Arquivo excede o limite de 500 MB'
        : err.message;
      return res.status(400).json({ erro: msg });
    }
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    res.json({ ok: true, tamanho: req.file.size, nome: req.file.originalname });
  });
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
// ROTAS — SERVICO (iniciar / parar)
// ══════════════════════════════════════════

app.post('/api/servico/:id/iniciar', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  let ssh;
  try {
    ssh = await conectarSSH(servidor);
    const result = await ssh.execCommand(`net start ${SERVICE_NAME}`);
    await new Promise(r => setTimeout(r, 2000));
    const status = await obterStatusServico(ssh);
    ssh.dispose();

    if (status !== 'rodando') {
      const msg = result.stderr || result.stdout || 'Servico nao iniciou';
      return res.json({ ok: false, status, erro: msg });
    }
    res.json({ ok: true, status });
  } catch (err) {
    if (ssh) ssh.dispose();
    res.json({ ok: false, erro: err.message });
  }
});

app.post('/api/servico/:id/parar', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  let ssh;
  try {
    ssh = await conectarSSH(servidor);
    const result = await ssh.execCommand(`net stop ${SERVICE_NAME}`);
    await new Promise(r => setTimeout(r, 2000));
    const status = await obterStatusServico(ssh);
    ssh.dispose();
    res.json({ ok: true, status });
  } catch (err) {
    if (ssh) ssh.dispose();
    res.json({ ok: false, erro: err.message });
  }
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
// ROTAS — DEPLOY (com streaming SSE)
// ══════════════════════════════════════════

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function executarDeploy(servidor, emit) {
  const inicio = Date.now();
  const log = [];
  let ssh;
  let sucesso = false;

  function logMsg(msg, tipo = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    const entry = { ts, msg, tipo };
    log.push(entry);
    console.log(`[${servidor.nome}] [${tipo}] ${msg}`);
    if (emit) emit({ evento: 'log', ...entry });
  }

  const gzLocal = path.join(UPLOADS_DIR, 'Fvendas2.0.exe.gz');
  const REMOTE_GZ = REMOTE_EXE + '.gz';

  try {
    const exeLocal = path.join(UPLOADS_DIR, 'Fvendas2.0.exe');
    if (!fs.existsSync(exeLocal)) {
      logMsg('Nenhum .exe disponivel em uploads/', 'erro');
      throw new Error('Nenhum .exe disponivel');
    }

    // 1. Compactar localmente
    logMsg('Compactando arquivo...', 'progresso');
    const { origSize, compSize } = await compactarArquivo(exeLocal, gzLocal);
    const reducao = (100 - (compSize / origSize) * 100).toFixed(0);
    logMsg(`Arquivo compactado: ${formatMB(origSize)} MB → ${formatMB(compSize)} MB (-${reducao}%)`, 'sucesso');

    // 2. Conectar
    logMsg('Conectando via SSH...', 'progresso');
    ssh = await conectarSSH(servidor);
    logMsg('Conectado!', 'sucesso');

    // 3. Parar serviço
    logMsg('Parando servico no servidor de destino...', 'progresso');
    const stopResult = await ssh.execCommand(`net stop ${SERVICE_NAME}`);
    if (stopResult.code !== 0 && !stopResult.stderr.includes('not been started')) {
      logMsg(`Aviso ao parar: ${stopResult.stderr}`, 'progresso');
    }
    logMsg('Servico parado', 'sucesso');

    // 4. Backup
    logMsg('Fazendo backup do .exe atual...', 'progresso');
    await ssh.execCommand(`del "${REMOTE_BAK}" 2>nul`);
    const renameResult = await ssh.execCommand(`rename "${REMOTE_EXE}" "Fvendas2.0.exe.bak"`);
    if (renameResult.code !== 0 && !renameResult.stderr.includes('cannot find')) {
      logMsg(`Aviso no backup: ${renameResult.stderr}`, 'progresso');
    }
    logMsg('Backup concluido', 'sucesso');

    // 5. Upload SFTP com progresso
    logMsg('Copiando arquivo para servidor de destino...', 'progresso');
    if (emit) emit({ evento: 'transferencia_inicio', total: compSize });

    let ultimoPct = -1;
    await enviarArquivoSFTP(ssh, gzLocal, REMOTE_GZ, (transferido, total) => {
      const pct = Math.round((transferido / total) * 100);
      if (emit && pct !== ultimoPct) {
        ultimoPct = pct;
        emit({ evento: 'transferencia_progresso', transferido, total, percentual: pct });
      }
    });

    if (emit) emit({ evento: 'transferencia_fim' });
    logMsg('Arquivo copiado para servidor de destino', 'sucesso');

    // 6. Descompactar no servidor remoto
    logMsg('Descompactando arquivo no servidor de destino...', 'progresso');
    const decompResult = await ssh.execCommand(PS_DECOMPRESS(REMOTE_GZ, REMOTE_EXE));
    if (decompResult.stdout.includes('OK')) {
      logMsg('Arquivo descompactado', 'sucesso');
    } else {
      const errMsg = decompResult.stderr || decompResult.stdout || 'Erro desconhecido';
      throw new Error(`Falha ao descompactar: ${errMsg}`);
    }

    // 7. Limpar .gz remoto
    await ssh.execCommand(`del "${REMOTE_GZ}" 2>nul`);

    // 8. Excluir log.txt antigo
    logMsg('Excluindo log antigo...', 'progresso');
    await ssh.execCommand(`del "${REMOTE_DIR}\\log.txt" 2>nul`);
    logMsg('Log antigo excluido', 'sucesso');

    // 9. Iniciar serviço
    logMsg('Iniciando servico...', 'progresso');
    await ssh.execCommand(`net start ${SERVICE_NAME}`);
    logMsg('Comando net start executado', 'sucesso');

    // 10. Verificar serviço
    logMsg('Verificando servico...', 'progresso');
    await new Promise(r => setTimeout(r, 3000));
    const status = await obterStatusServico(ssh);

    if (status === 'rodando') {
      const versao = await obterVersaoRemota(ssh);
      logMsg(`Servico rodando! Versao: ${versao || '?'}`, 'sucesso');
      sucesso = true;

      // 11. Aguardar log.txt ser gerado e ler conteudo
      logMsg('Aguardando log de inicializacao...', 'progresso');
      let logConteudo = null;
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const logResult = await ssh.execCommand(`type "${REMOTE_DIR}\\log.txt"`);
        if (logResult.code === 0 && logResult.stdout && logResult.stdout.trim().length > 0) {
          logConteudo = logResult.stdout.trim();
          break;
        }
      }

      if (logConteudo) {
        logMsg('--- Log de inicializacao ---', 'info');
        logConteudo.split('\n').forEach(linha => {
          const linhaLimpa = linha.trim();
          if (!linhaLimpa) return;
          const tipo = linhaLimpa.toLowerCase().includes('erro') || linhaLimpa.toLowerCase().includes('error') || linhaLimpa.toLowerCase().includes('falha')
            ? 'erro'
            : linhaLimpa.toLowerCase().includes('conectou') || linhaLimpa.toLowerCase().includes('sucesso') || linhaLimpa.toLowerCase().includes('ok') || linhaLimpa.toLowerCase().includes('started') || linhaLimpa.toLowerCase().includes('connected')
              ? 'sucesso'
              : 'info';
          logMsg(linhaLimpa, tipo);
        });
      } else {
        logMsg('Log de inicializacao nao foi gerado em 20s', 'progresso');
      }
    } else {
      // Rollback
      logMsg(`Servico NAO esta rodando (status: ${status}). Executando rollback...`, 'erro');
      await ssh.execCommand(`net stop ${SERVICE_NAME} 2>nul`);
      await ssh.execCommand(`del "${REMOTE_EXE}" 2>nul`);
      await ssh.execCommand(`rename "${REMOTE_BAK}" "Fvendas2.0.exe"`);
      await ssh.execCommand(`net start ${SERVICE_NAME}`);
      logMsg('ROLLBACK executado — versao anterior restaurada', 'erro');
    }
  } catch (err) {
    logMsg(`ERRO: ${err.message}`, 'erro');
  } finally {
    if (ssh) ssh.dispose();
    try { if (fs.existsSync(gzLocal)) fs.unlinkSync(gzLocal); } catch (_) {}
  }

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  logMsg(`Duracao: ${duracao}s`, 'info');

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

// ── SSE: Deploy de um servidor com streaming ──
app.get('/api/deploy/:id/stream', (req, res) => {
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) {
    res.write(`data: ${JSON.stringify({ evento: 'erro', msg: 'Servidor nao encontrado' })}\n\n`);
    res.end();
    return;
  }

  function emit(data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  executarDeploy(servidor, emit).then(result => {
    emit({ evento: 'concluido', sucesso: result.sucesso, log: result.log, duracao: result.duracao });
    res.end();
  }).catch(err => {
    emit({ evento: 'erro', msg: err.message });
    res.end();
  });

  req.on('close', () => {
    // Cliente desconectou — o deploy continua no backend
  });
});

// ── POST: Deploy (fallback sem streaming) ──
app.post('/api/deploy/:id', async (req, res) => {
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor não encontrado' });
  const result = await executarDeploy(servidor);
  res.json(result);
});

app.post('/api/deploy/todos', async (req, res) => {
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);
  const servidores = lerServidores();
  if (servidores.length === 0) return res.json([]);
  const results = await Promise.allSettled(
    servidores.map(s => executarDeploy(s))
  );
  res.json(results.map(r => r.status === 'fulfilled' ? r.value : { erro: r.reason?.message }));
});

// ── SSE: Deploy de todos com streaming ──
app.get('/api/deploy/todos/stream', (req, res) => {
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const servidores = lerServidores();
  if (servidores.length === 0) {
    res.write(`data: ${JSON.stringify({ evento: 'concluido_todos', resultados: [] })}\n\n`);
    res.end();
    return;
  }

  function emit(servidorId, data) {
    try { res.write(`data: ${JSON.stringify({ servidorId, ...data })}\n\n`); } catch (_) {}
  }

  Promise.allSettled(
    servidores.map(s => executarDeploy(s, (data) => emit(s.id, data)))
  ).then(results => {
    const resultados = results.map((r, i) => ({
      servidorId: servidores[i].id,
      ...(r.status === 'fulfilled' ? r.value : { erro: r.reason?.message }),
    }));
    res.write(`data: ${JSON.stringify({ evento: 'concluido_todos', resultados })}\n\n`);
    res.end();
  });
});

// ── Histórico ──
app.get('/api/historico', (req, res) => {
  res.json(lerDeployLog());
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`FDeploy rodando em http://localhost:${PORT}`);
});
