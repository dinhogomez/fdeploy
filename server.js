const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
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
const VERSAO_PATH = path.join(DATA_DIR, 'versao.json');
const VERSOES_DIR = path.join(DATA_DIR, 'versoes');

// ── Garantir que diretórios existam ──
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(VERSOES_DIR)) fs.mkdirSync(VERSOES_DIR, { recursive: true });

// ── Caminhos remotos (Windows) ──
const REMOTE_EXE = 'C:\\f\\Fvendas2.0\\Fvendas2.0.exe';
const REMOTE_BAK = 'C:\\f\\Fvendas2.0\\Fvendas2.0Old.exe';
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

function lerVersaoData() {
  if (!fs.existsSync(VERSAO_PATH)) return { ativa: null, versoes: [] };
  try {
    const data = JSON.parse(fs.readFileSync(VERSAO_PATH, 'utf8'));
    // Migrar formato antigo { versao: "x" } → { ativa: "x", versoes: ["x"] }
    if (data.versao && !data.ativa) {
      return { ativa: data.versao, versoes: [data.versao] };
    }
    return { ativa: data.ativa || null, versoes: data.versoes || [] };
  } catch (_) { return { ativa: null, versoes: [] }; }
}

function lerVersao() {
  return lerVersaoData().ativa;
}

function salvarVersaoData(data) {
  fs.writeFileSync(VERSAO_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function salvarVersao(versao) {
  const data = lerVersaoData();
  data.ativa = versao;
  if (!data.versoes.includes(versao)) data.versoes.push(versao);
  salvarVersaoData(data);
}

function compararVersoes(a, b) {
  if (!a || !b) return 0;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
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

// ── Executar script PowerShell local (non-blocking, via arquivo temp) ──
function executarPowerShell(script, timeout = 120000) {
  const tmpFile = path.join(UPLOADS_DIR, `_ps_${Date.now()}.ps1`);
  fs.writeFileSync(tmpFile, script, 'utf8');

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile]);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { ps.kill(); try { fs.unlinkSync(tmpFile); } catch (_) {} reject(new Error('PowerShell timeout')); }, timeout);
    ps.stdout.on('data', d => { stdout += d.toString(); });
    ps.stderr.on('data', d => { stderr += d.toString(); });
    ps.on('close', code => { clearTimeout(timer); try { fs.unlinkSync(tmpFile); } catch (_) {} resolve({ code, stdout, stderr }); });
    ps.on('error', err => { clearTimeout(timer); try { fs.unlinkSync(tmpFile); } catch (_) {} reject(err); });
  });
}

// ── Instalar OpenSSH remotamente via WMI/DCOM (porta 135) ──
async function instalarSSHRemoto(servidor, logMsg) {
  const ip = servidor.ip;
  const usuario = servidor.usuario;
  const senha = decrypt(servidor.senha);
  const senhaEscaped = senha.replace(/'/g, "''");

  // Debug: salvar cada script num arquivo para inspecao
  const debugFile = path.join(__dirname, 'debug_wmi.txt');
  let debugIdx = 0;

  // Helper: executa script PS com sessao CIM e retorna stdout
  async function cimExec(label, body) {
    const script = `
try {
  $ErrorActionPreference = 'Stop'
  $secPass = ConvertTo-SecureString '${senhaEscaped}' -AsPlainText -Force
  $cred = New-Object System.Management.Automation.PSCredential('${usuario}', $secPass)
  $so = New-CimSessionOption -Protocol Dcom
  $session = New-CimSession -ComputerName '${ip}' -Credential $cred -SessionOption $so -OperationTimeoutSec 30
  ${body}
  Remove-CimSession $session
} catch {
  Write-Host "ERRO:$($_.Exception.Message)"
}
`;
    // Salvar script no debug
    debugIdx++;
    const separator = `\n${'='.repeat(60)}\n[${debugIdx}] ${label}\n${'='.repeat(60)}\n`;
    fs.appendFileSync(debugFile, separator + script + '\n', 'utf8');

    const result = await executarPowerShell(script);
    const out = (result.stdout || '').trim();
    const err = (result.stderr || '').trim();

    // Salvar resultado no debug
    fs.appendFileSync(debugFile, `--- RESULTADO [${label}] ---\nstdout: ${out}\nstderr: ${err}\ncode: ${result.code}\n\n`, 'utf8');

    console.log(`[WMI ${ip}] ${label}: stdout=${out}${err ? ' | stderr=' + err : ''}`);
    return out;
  }

  logMsg('Conexao SSH falhou neste servidor', 'erro');
  logMsg(`Verificando OpenSSH via WMI/DCOM (${ip})...`, 'progresso');

  try {
    // ── Passo 1: Verificar se servico sshd existe ──
    logMsg('Conectando via WMI (porta 135)...', 'progresso');
    const check = await cimExec('check-sshd', `
$svc = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue
if ($svc) { Write-Host "SSHD:$($svc.State)" } else { Write-Host "SSHD:NAO_EXISTE" }
`);

    if (check.includes('ERRO:')) {
      logMsg(`Erro ao conectar via WMI: ${check.split('ERRO:').pop()}`, 'erro');
      return false;
    }

    // ── Passo 2: Instalar se nao existe ──
    if (check.includes('SSHD:NAO_EXISTE')) {
      logMsg('OpenSSH Server NAO esta instalado', 'erro');

      // Instalar via schtasks (tarefa agendada com /rl HIGHEST para elevacao real)
      logMsg('Criando tarefa agendada para instalar OpenSSH com privilegios elevados...', 'progresso');
      const installScript = `
$taskName = 'FDeploy_InstallSSH'
$dismCmd = 'dism.exe /Online /Add-Capability /CapabilityName:OpenSSH.Server~~~~0.0.1.0'
schtasks /create /s '${ip}' /u '${usuario}' /p '${senha}' /tn $taskName /tr $dismCmd /sc once /st 00:00 /f /rl HIGHEST 2>&1
$createResult = $LASTEXITCODE
if ($createResult -ne 0) { Write-Host "TASK_ERRO_CREATE:$createResult"; return }
Write-Host 'TASK_CRIADA'
schtasks /run /s '${ip}' /u '${usuario}' /p '${senha}' /tn $taskName 2>&1
$runResult = $LASTEXITCODE
if ($runResult -ne 0) { Write-Host "TASK_ERRO_RUN:$runResult"; return }
Write-Host 'TASK_EXECUTANDO'
`;
      const install = await executarPowerShell(installScript);
      const installOut = (install.stdout || '').trim();
      const installErr = (install.stderr || '').trim();

      // Debug
      debugIdx++;
      fs.appendFileSync(debugFile, `\n${'='.repeat(60)}\n[${debugIdx}] schtasks-install\n${'='.repeat(60)}\n${installScript}\n--- RESULTADO ---\nstdout: ${installOut}\nstderr: ${installErr}\ncode: ${install.code}\n\n`, 'utf8');
      console.log(`[SCHTASKS ${ip}] stdout: ${installOut}`);
      if (installErr) console.log(`[SCHTASKS ${ip}] stderr: ${installErr}`);

      if (!installOut.includes('TASK_EXECUTANDO')) {
        logMsg(`Falha ao criar/executar tarefa: ${installOut} ${installErr}`, 'erro');
        return false;
      }
      logMsg('Tarefa de instalacao executando com privilegios elevados!', 'sucesso');

      // Monitorar status do servico sshd ate ficar Running
      logMsg('Monitorando instalacao...', 'progresso');
      let sshdOk = false;
      for (let i = 1; i <= 80; i++) {
        await new Promise(r => setTimeout(r, 15000));
        const status = await cimExec(`poll-${i}`, `
$svc = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue
if ($svc) { Write-Host "SSHD:$($svc.State)" } else {
  $dism = Get-CimInstance -CimSession $session -ClassName Win32_Process -Filter "Name='dism.exe'" -ErrorAction SilentlyContinue
  $tiw = Get-CimInstance -CimSession $session -ClassName Win32_Process -Filter "Name='TiWorker.exe'" -ErrorAction SilentlyContinue
  if ($dism -or $tiw) { Write-Host "SSHD:INSTALANDO" } else { Write-Host "SSHD:NAO_EXISTE" }
}
`);
        if (status.includes('SSHD:Running')) {
          logMsg(`Servico sshd rodando! (${i * 15}s)`, 'sucesso');
          sshdOk = true;
          break;
        } else if (status.includes('SSHD:Stopped')) {
          logMsg(`Servico sshd instalado mas parado (${i * 15}s). Configurando e iniciando...`, 'progresso');
          await cimExec('configure-start-sshd', `
$svc = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter "Name='sshd'"
Invoke-CimMethod -InputObject $svc -MethodName ChangeStartMode -Arguments @{StartMode='Automatic'} | Out-Null
Invoke-CimMethod -InputObject $svc -MethodName StartService | Out-Null
`)
          // Firewall via processo remoto
          await cimExec('firewall-install', `
$fwCmd = 'netsh advfirewall firewall add rule name=sshd dir=in action=allow protocol=TCP localport=22 profile=any'
Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="cmd.exe /c $fwCmd"} | Out-Null
`);
        } else if (status.includes('SSHD:INSTALANDO')) {
          logMsg(`DISM instalando... (${i * 15}s)`, 'progresso');
        } else if (status.includes('SSHD:NAO_EXISTE')) {
          logMsg(`Aguardando instalacao... sshd ainda nao existe (${i * 15}s)`, 'progresso');
        } else {
          logMsg(`Status sshd: ${status} (${i * 15}s)`, 'progresso');
        }
      }
      if (!sshdOk) {
        logMsg('Servico sshd nao iniciou apos 20 minutos', 'erro');
        return false;
      }

    } else if (check.includes('SSHD:Stopped')) {
      // ── sshd existe mas parado ──
      logMsg('Servico sshd existe mas esta PARADO', 'progresso');
      logMsg('Iniciando servico sshd...', 'progresso');
      const start = await cimExec('start-sshd', `
Invoke-CimMethod -CimSession $session -ClassName Win32_Service -Filter "Name='sshd'" -MethodName StartService | Out-Null
Start-Sleep -Seconds 5
$svc = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter "Name='sshd'"
Write-Host "SSHD:$($svc.State)"
`);
      if (start.includes('SSHD:Running')) {
        logMsg('Servico sshd iniciado!', 'sucesso');
      } else {
        logMsg(`Falha ao iniciar sshd: ${start}`, 'erro');
        return false;
      }

    } else if (check.includes('SSHD:Running')) {
      // ── sshd ja rodando — problema pode ser firewall ──
      logMsg('Servico sshd ja esta rodando', 'sucesso');
      logMsg('Adicionando regra de firewall (porta 22, todos os perfis)...', 'progresso');
      await cimExec('firewall', `
$cmd = 'powershell.exe -NoProfile -Command "if (!(Get-NetFirewallRule -Name sshd -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name sshd -DisplayName OpenSSH-Server -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any | Out-Null; Write-Host CRIADA } else { Write-Host EXISTE }"'
Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd} | Out-Null
Write-Host 'FW_OK'
`);
      logMsg('Regra de firewall verificada', 'sucesso');
    }

    // ── Passo 3: Testar conexao SSH ──
    logMsg('Testando conexao SSH...', 'progresso');
    for (let i = 1; i <= 4; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const testSSH = new NodeSSH();
        await testSSH.connect({
          host: ip,
          port: servidor.porta || 22,
          username: usuario,
          password: senha,
          readyTimeout: 15000,
        });
        testSSH.dispose();
        logMsg('Conexao SSH estabelecida com sucesso!', 'sucesso');
        return true;
      } catch (sshErr) {
        logMsg(`Tentativa SSH ${i}/4 falhou: ${sshErr.message}`, i < 4 ? 'progresso' : 'erro');
      }
    }

    logMsg('SSH nao ficou acessivel. Verifique firewall e rede', 'erro');
    return false;
  } catch (err) {
    logMsg(`Erro na comunicacao WMI: ${err.message}`, 'erro');
    return false;
  }
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
    versaoDeployada: s.versaoDeployada || null,
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
  const vData = lerVersaoData();

  // Listar versoes do cache
  const versoes = [];
  if (fs.existsSync(VERSOES_DIR)) {
    const files = fs.readdirSync(VERSOES_DIR).filter(f => f.endsWith('.gz'));
    for (const f of files) {
      versoes.push(f.replace('.gz', ''));
    }
  }
  versoes.sort((a, b) => compararVersoes(b, a));

  if (!fs.existsSync(exePath) && versoes.length === 0) {
    return res.json({ disponivel: false, versoes: [] });
  }

  const result = { disponivel: true, versao: vData.ativa, versoes };
  if (fs.existsSync(exePath)) {
    const stats = fs.statSync(exePath);
    result.arquivo = 'Fvendas2.0.exe';
    result.tamanho_mb = (stats.size / 1024 / 1024).toFixed(1);
    result.modificado_em = stats.mtime.toISOString();
  }
  res.json(result);
});

// ── Versao ──
app.post('/api/versao', async (req, res) => {
  const { versao } = req.body;
  if (!versao) return res.status(400).json({ erro: 'Versao e obrigatoria' });

  const exePath = path.join(UPLOADS_DIR, 'Fvendas2.0.exe');
  const gzDest = path.join(VERSOES_DIR, `${versao}.gz`);

  // Compactar e salvar no cache de versoes
  if (fs.existsSync(exePath)) {
    try {
      await compactarArquivo(exePath, gzDest);
      console.log(`[Versao] Compactado e salvo: ${gzDest}`);
    } catch (err) {
      console.error(`[Versao] Erro ao compactar: ${err.message}`);
      return res.status(500).json({ erro: 'Falha ao compactar arquivo' });
    }
  }

  salvarVersao(versao);
  res.json({ ok: true, versao });
});

// ── Listar versoes ──
app.get('/api/versoes', (req, res) => {
  const data = lerVersaoData();
  const versoes = [];
  if (fs.existsSync(VERSOES_DIR)) {
    const files = fs.readdirSync(VERSOES_DIR).filter(f => f.endsWith('.gz'));
    for (const f of files) {
      const ver = f.replace('.gz', '');
      const stats = fs.statSync(path.join(VERSOES_DIR, f));
      versoes.push({ versao: ver, tamanho: stats.size, tamanho_mb: (stats.size / 1024 / 1024).toFixed(1) });
    }
  }
  // Ordenar por versao decrescente
  versoes.sort((a, b) => compararVersoes(b.versao, a.versao));
  res.json({ ativa: data.ativa, versoes });
});

// ── Selecionar versao existente ──
app.post('/api/versao/selecionar', (req, res) => {
  const { versao } = req.body;
  if (!versao) return res.status(400).json({ erro: 'Versao e obrigatoria' });

  const gzPath = path.join(VERSOES_DIR, `${versao}.gz`);
  if (!fs.existsSync(gzPath)) {
    return res.status(404).json({ erro: `Versao ${versao} nao encontrada no cache` });
  }

  const data = lerVersaoData();
  data.ativa = versao;
  if (!data.versoes.includes(versao)) data.versoes.push(versao);
  salvarVersaoData(data);

  res.json({ ok: true, versao });
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

// ── SSE: Testar servidor com streaming (para acompanhar instalacao SSH) ──
app.get('/api/testar/:id/stream', (req, res) => {
  req.setTimeout(5 * 60 * 1000);
  res.setTimeout(5 * 60 * 1000);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) {
    res.write(`data: ${JSON.stringify({ evento: 'resultado', conectou: false, erro: 'Servidor nao encontrado' })}\n\n`);
    res.end();
    return;
  }

  function emit(data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  function logEtapa(msg, tipo) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    emit({ evento: 'log', ts, msg, tipo: tipo || 'progresso' });
    console.log(`[Testar ${servidor.nome}] ${msg}`);
  }

  (async () => {
    let ssh;
    try {
      logEtapa('Conectando via SSH...', 'progresso');
      ssh = await conectarSSH(servidor);
    } catch (sshErr) {
      logEtapa(`Falha na conexao SSH: ${sshErr.message}`, 'erro');
      const instalou = await instalarSSHRemoto(servidor, logEtapa);
      if (instalou) {
        logEtapa('Reconectando via SSH...', 'progresso');
        try {
          ssh = await conectarSSH(servidor);
          logEtapa('SSH conectado apos instalacao!', 'sucesso');
        } catch (retryErr) {
          logEtapa(`SSH falhou apos instalacao: ${retryErr.message}`, 'erro');
          emit({ evento: 'resultado', conectou: false });
          res.end();
          return;
        }
      } else {
        emit({ evento: 'resultado', conectou: false });
        res.end();
        return;
      }
    }

    try {
      logEtapa('Conectado! Verificando servico...', 'sucesso');
      const servico_status = await obterStatusServico(ssh);
      const versao_atual = await obterVersaoRemota(ssh);
      ssh.dispose();
      logEtapa(`Servico: ${servico_status} | Versao: ${versao_atual || '?'}`, 'sucesso');
      emit({ evento: 'resultado', conectou: true, servico_status, versao_atual });
    } catch (err) {
      if (ssh) ssh.dispose();
      logEtapa(`Erro: ${err.message}`, 'erro');
      emit({ evento: 'resultado', conectou: false });
    }
    res.end();
  })();
});

// ── POST: Testar (fallback sem streaming) ──
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

  const REMOTE_GZ = REMOTE_EXE + '.gz';
  const versaoAtual = lerVersao();
  let gzLocal = null;
  let usouCache = false;

  try {
    // 1. Usar .gz do cache de versoes ou compactar do .exe
    if (versaoAtual) {
      const gzCache = path.join(VERSOES_DIR, `${versaoAtual}.gz`);
      if (fs.existsSync(gzCache)) {
        gzLocal = gzCache;
        usouCache = true;
        const compSize = fs.statSync(gzCache).size;
        logMsg(`Usando cache da versao ${versaoAtual} (${formatMB(compSize)} MB)`, 'sucesso');
      }
    }

    if (!gzLocal) {
      const exeLocal = path.join(UPLOADS_DIR, 'Fvendas2.0.exe');
      if (!fs.existsSync(exeLocal)) {
        logMsg('Nenhum .exe disponivel em uploads/', 'erro');
        throw new Error('Nenhum .exe disponivel');
      }

      gzLocal = path.join(UPLOADS_DIR, 'Fvendas2.0.exe.gz');
      logMsg('Compactando arquivo...', 'progresso');
      const { origSize, compSize } = await compactarArquivo(exeLocal, gzLocal);
      const reducao = (100 - (compSize / origSize) * 100).toFixed(0);
      logMsg(`Arquivo compactado: ${formatMB(origSize)} MB → ${formatMB(compSize)} MB (-${reducao}%)`, 'sucesso');

      // Salvar no cache se tiver versao
      if (versaoAtual) {
        const gzCache = path.join(VERSOES_DIR, `${versaoAtual}.gz`);
        fs.copyFileSync(gzLocal, gzCache);
        logMsg(`Cache salvo para versao ${versaoAtual}`, 'sucesso');
      }
    }

    const compSize = fs.statSync(gzLocal).size;

    // 2. Conectar (com fallback para instalar OpenSSH)
    logMsg('Conectando via SSH...', 'progresso');
    try {
      ssh = await conectarSSH(servidor);
    } catch (sshErr) {
      logMsg(`Falha na conexao SSH: ${sshErr.message}`, 'erro');
      const instalou = await instalarSSHRemoto(servidor, logMsg);
      if (instalou) {
        logMsg('Tentando conectar via SSH novamente...', 'progresso');
        ssh = await conectarSSH(servidor);
      } else {
        throw sshErr;
      }
    }
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
    const renameResult = await ssh.execCommand(`rename "${REMOTE_EXE}" "Fvendas2.0Old.exe"`);
    if (renameResult.code !== 0 && !renameResult.stderr.includes('cannot find')) {
      logMsg(`Aviso no backup: ${renameResult.stderr}`, 'progresso');
    }
    logMsg('Backup concluido', 'sucesso');

    // 5. Garantir que diretório remoto exista
    await ssh.execCommand(`if not exist "${REMOTE_DIR}" mkdir "${REMOTE_DIR}"`);

    // 6. Upload SFTP com progresso
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

    // 7. Criar package.json com versao no servidor remoto
    if (versaoAtual) {
      logMsg(`Gravando versao ${versaoAtual} no servidor...`, 'progresso');
      const pkgCmd = `powershell -NoProfile -Command "@{version='${versaoAtual}'} | ConvertTo-Json -Compress | Set-Content '${REMOTE_PKG}'"`;
      await ssh.execCommand(pkgCmd);
      logMsg(`Versao ${versaoAtual} gravada`, 'sucesso');
    }

    // 8. Limpar .gz remoto
    await ssh.execCommand(`del "${REMOTE_GZ}" 2>nul`);

    // 9. Excluir log.txt antigo
    logMsg('Excluindo log antigo...', 'progresso');
    await ssh.execCommand(`del "${REMOTE_DIR}\\log.txt" 2>nul`);
    logMsg('Log antigo excluido', 'sucesso');

    // 10. Iniciar serviço
    logMsg('Iniciando servico...', 'progresso');
    await ssh.execCommand(`net start ${SERVICE_NAME}`);
    logMsg('Comando net start executado', 'sucesso');

    // 11. Verificar serviço
    logMsg('Verificando servico...', 'progresso');
    await new Promise(r => setTimeout(r, 3000));
    const status = await obterStatusServico(ssh);

    if (status === 'rodando') {
      const versao = await obterVersaoRemota(ssh);
      logMsg(`Servico rodando! Versao: ${versao || '?'}`, 'sucesso');
      sucesso = true;

      // Rastrear versao deployada no servidor
      if (versaoAtual) {
        const servidores = lerServidores();
        const idx = servidores.findIndex(s => s.id === servidor.id);
        if (idx !== -1) {
          servidores[idx].versaoDeployada = versaoAtual;
          salvarServidores(servidores);
        }
      }

      // 12. Aguardar log.txt ser gerado e ler conteudo
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
    // Só apagar .gz temporario (nao apagar o cache de versoes)
    if (!usouCache && gzLocal) {
      try { if (fs.existsSync(gzLocal)) fs.unlinkSync(gzLocal); } catch (_) {}
    }
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

// ── POST: Deploy todos (fallback sem streaming) ──
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

// ── SSE: Deploy de todos com streaming (sequencial) ──
app.get('/api/deploy/todos/stream', (req, res) => {
  req.setTimeout(60 * 60 * 1000);
  res.setTimeout(60 * 60 * 1000);

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

  (async () => {
    const versaoAtiva = lerVersao();
    const resultados = [];
    for (const s of servidores) {
      // Pular servidores ja na versao ativa
      if (versaoAtiva && s.versaoDeployada && s.versaoDeployada === versaoAtiva) {
        emit(s.id, { evento: 'deploy_pulado', versao: versaoAtiva });
        resultados.push({ servidorId: s.id, sucesso: true, pulado: true });
        continue;
      }

      emit(s.id, { evento: 'deploy_iniciando' });
      try {
        const result = await executarDeploy(s, (data) => emit(s.id, data));
        emit(s.id, { evento: 'concluido', sucesso: result.sucesso, log: result.log, duracao: result.duracao });
        resultados.push({ servidorId: s.id, ...result });
      } catch (err) {
        emit(s.id, { evento: 'concluido', sucesso: false, erro: err.message });
        resultados.push({ servidorId: s.id, erro: err.message });
      }
    }
    res.write(`data: ${JSON.stringify({ evento: 'concluido_todos', resultados })}\n\n`);
    res.end();
  })();
});

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

// ── Histórico ──
app.get('/api/historico', (req, res) => {
  res.json(lerDeployLog());
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`FDeploy rodando em http://localhost:${PORT}`);
});
