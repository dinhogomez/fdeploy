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

// ── Servidor Geral — Caminhos locais (origem) ──
const SOURCE_DEBUG_DIR = 'C:\\Net-Sql\\Todos\\DEBUG';
const SOURCE_REPORTS_DIR = 'C:\\Net-Sql\\Todos\\WebPrint\\reports';

// ── Servidor Geral — Caminhos remotos (destino) ──
const REMOTE_WEBFRIGO = 'C:\\f\\Webfrigo';
const REMOTE_REPORTS_DIR = 'C:\\f\\WebPrint\\reports';

// ── Servidor Geral — Dados ──
const VERSAO_GERAL_PATH = path.join(DATA_DIR, 'versao_geral.json');
const DEPLOY_LOG_GERAL_PATH = path.join(DATA_DIR, 'deploy_log_geral.json');
const VERSOES_GERAL_DIR = path.join(DATA_DIR, 'versoes_geral');

if (!fs.existsSync(VERSOES_GERAL_DIR)) fs.mkdirSync(VERSOES_GERAL_DIR, { recursive: true });

// ── Scripts SQL ──
const SCRIPTS_INDEX_PATH = path.join(DATA_DIR, 'scripts_index.json');
const DEFAULT_SCRIPTS_ROOT = 'C:\\Net-Sql\\Todos\\Scripts';
const PASTA_SCRIPTS_PATTERN = /^Scripts \d{4}$/i;

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
  if (!fs.existsSync(VERSAO_PATH)) return { ativa: null, versoes: [], descricoes: {} };
  try {
    const data = JSON.parse(fs.readFileSync(VERSAO_PATH, 'utf8'));
    // Migrar formato antigo { versao: "x" } → { ativa: "x", versoes: ["x"] }
    if (data.versao && !data.ativa) {
      return { ativa: data.versao, versoes: [data.versao], descricoes: data.descricoes || {} };
    }
    return { ativa: data.ativa || null, versoes: data.versoes || [], descricoes: data.descricoes || {} };
  } catch (_) { return { ativa: null, versoes: [], descricoes: {} }; }
}

function lerVersao() {
  return lerVersaoData().ativa;
}

function salvarVersaoData(data) {
  fs.writeFileSync(VERSAO_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function salvarVersao(versao, descricao) {
  const data = lerVersaoData();
  data.ativa = versao;
  if (!data.versoes.includes(versao)) data.versoes.push(versao);
  if (descricao) data.descricoes[versao] = descricao;
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

// ── Helpers — Servidor Geral ──
function lerVersaoGeralData() {
  if (!fs.existsSync(VERSAO_GERAL_PATH)) return { ativa: null, versoes: [], descricoes: {} };
  try {
    const data = JSON.parse(fs.readFileSync(VERSAO_GERAL_PATH, 'utf8'));
    return { ativa: data.ativa || null, versoes: data.versoes || [], descricoes: data.descricoes || {} };
  } catch (_) { return { ativa: null, versoes: [], descricoes: {} }; }
}

function lerVersaoGeral() {
  return lerVersaoGeralData().ativa;
}

function salvarVersaoGeralData(data) {
  fs.writeFileSync(VERSAO_GERAL_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function salvarVersaoGeral(versao, descricao) {
  const data = lerVersaoGeralData();
  data.ativa = versao;
  if (!data.versoes.includes(versao)) data.versoes.push(versao);
  if (descricao) data.descricoes[versao] = descricao;
  salvarVersaoGeralData(data);
}

function lerDeployLogGeral() {
  if (!fs.existsSync(DEPLOY_LOG_GERAL_PATH)) return [];
  return JSON.parse(fs.readFileSync(DEPLOY_LOG_GERAL_PATH, 'utf8'));
}

function salvarDeployLogGeral(entry) {
  const logs = lerDeployLogGeral();
  logs.unshift(entry);
  if (logs.length > 50) logs.length = 50;
  fs.writeFileSync(DEPLOY_LOG_GERAL_PATH, JSON.stringify(logs, null, 2), 'utf8');
}

// ── Helpers — Scripts SQL ──
function lerScriptsIndex() {
  if (!fs.existsSync(SCRIPTS_INDEX_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SCRIPTS_INDEX_PATH, 'utf8'));
  } catch (_) { return null; }
}

function salvarScriptsIndex(data) {
  fs.writeFileSync(SCRIPTS_INDEX_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function extrairVersaoScript(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/set\s+versao_bd\s*=\s*(\d+)/i);
    if (match) return parseInt(match[1]);
  } catch (_) {}
  return null;
}

function indexarScripts(forceFullScan = false) {
  const index = !forceFullScan ? lerScriptsIndex() : null;
  const pastaRaiz = (index && index.pastaRaiz) || DEFAULT_SCRIPTS_ROOT;

  if (!fs.existsSync(pastaRaiz)) {
    return { pastaRaiz, ultimaVarredura: new Date().toISOString(), pastasDetectadas: [], scripts: [], erro: 'Pasta raiz nao encontrada' };
  }

  // Filtrar subpastas com padrao "Scripts YYYY"
  const subdirs = fs.readdirSync(pastaRaiz, { withFileTypes: true })
    .filter(d => d.isDirectory() && PASTA_SCRIPTS_PATTERN.test(d.name))
    .map(d => d.name)
    .sort();

  // Set de arquivos ja indexados (para scan incremental)
  const indexedFiles = new Set();
  const existingScripts = [];
  if (index && index.scripts && !forceFullScan) {
    for (const s of index.scripts) {
      indexedFiles.add(s.arquivo);
      existingScripts.push(s);
    }
  }

  // Varrer cada subpasta valida
  const newScripts = [];
  for (const subdir of subdirs) {
    const fullDir = path.join(pastaRaiz, subdir);
    try {
      const files = fs.readdirSync(fullDir).filter(f => f.toLowerCase().endsWith('.txt'));
      for (const file of files) {
        const relPath = subdir + '\\' + file;
        if (!indexedFiles.has(relPath)) {
          const versao = extrairVersaoScript(path.join(fullDir, file));
          if (versao !== null) {
            newScripts.push({ versao, arquivo: relPath });
          }
        }
      }
    } catch (_) {}
  }

  // Merge e ordenar
  const allScripts = [...existingScripts, ...newScripts];
  allScripts.sort((a, b) => a.versao - b.versao);

  const result = {
    pastaRaiz,
    ultimaVarredura: new Date().toISOString(),
    pastasDetectadas: subdirs,
    scripts: allScripts,
  };

  salvarScriptsIndex(result);
  return result;
}

// ── Executar Scripts SQL pendentes via SSH + psql ──
async function executarScriptsSQL(ssh, servidor, scriptsIndex, emit, logMsg, operador) {
  if (!servidor.temPostgreSQL || !servidor.pgBanco || !servidor.pgSenha) {
    logMsg('PostgreSQL nao configurado — pulando scripts SQL', 'info');
    return { sucesso: true, executados: 0, pulado: true };
  }

  // Verificar psql
  logMsg('Verificando disponibilidade do psql...', 'progresso');
  const psqlCheck = await ssh.execCommand('where psql 2>nul');
  const psqlVersion = await ssh.execCommand('psql --version 2>nul');
  if (psqlCheck.code !== 0 && !(psqlVersion.stdout || '').includes('psql')) {
    logMsg('psql nao encontrado no servidor — pulando scripts SQL', 'erro');
    return { sucesso: true, executados: 0, pulado: true, aviso: 'psql nao encontrado' };
  }
  logMsg('psql disponivel', 'sucesso');

  // Consultar versao_bd
  const pgPass = decrypt(servidor.pgSenha);
  const pgUser = servidor.pgUsuario || 'frigo';
  const pgDb = servidor.pgBanco;
  const pgPort = servidor.pgPorta || 5432;
  const pgHost = servidor.pgHost || '127.0.0.1';
  const pgRemoto = servidor.pgHost && servidor.pgHost !== servidor.ip;
  const pgLabel = pgRemoto ? `${pgDb} (remoto: ${pgHost})` : pgDb;

  logMsg(`Consultando versao do banco "${pgLabel}"...`, 'progresso');
  const versionCmd = `set "PGPASSWORD=${pgPass}"&& psql -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} -t -A -c "SELECT versao_bd FROM re.servidor"`;
  const versionResult = await ssh.execCommand(versionCmd);

  const versaoBDStr = (versionResult.stdout || '').trim();
  const versaoBD = parseInt(versaoBDStr);

  if (isNaN(versaoBD)) {
    logMsg(`Nao foi possivel obter versao_bd: ${versionResult.stderr || versionResult.stdout || 'sem resposta'}`, 'erro');
    return { sucesso: false, executados: 0, erro: 'Nao foi possivel obter versao_bd' };
  }

  logMsg(`Versao atual do banco: ${versaoBD}`, 'sucesso');

  // Filtrar scripts pendentes
  const pendentes = (scriptsIndex.scripts || []).filter(s => s.versao > versaoBD);
  pendentes.sort((a, b) => a.versao - b.versao);

  if (pendentes.length === 0) {
    logMsg('Nenhum script SQL pendente', 'sucesso');
    return { sucesso: true, executados: 0 };
  }

  logMsg(`${pendentes.length} script(s) pendente(s) (v${pendentes[0].versao} a v${pendentes[pendentes.length - 1].versao})`, 'progresso');

  // Emitir dados para o modal de scripts
  const scriptsInfo = pendentes.map((s, i) => ({
    versao: s.versao,
    arquivo: s.arquivo,
    indice: i,
    status: 'aguardando',
  }));

  if (emit) emit({ evento: 'scripts_inicio', scripts: scriptsInfo, totalPendentes: pendentes.length, versaoBD });

  // Executar sequencialmente
  let executados = 0;
  let currentVersaoBD = versaoBD;

  // Garantir pasta temp no servidor
  await ssh.execCommand('if not exist "C:\\temp" mkdir "C:\\temp"');

  for (let i = 0; i < pendentes.length; i++) {
    const script = pendentes[i];

    // Verificar ordem sequencial
    if (script.versao !== currentVersaoBD + 1) {
      const erroMsg = `Script v${script.versao} pula da v${currentVersaoBD} — esperado v${currentVersaoBD + 1}`;
      logMsg(erroMsg, 'erro');
      if (emit) emit({ evento: 'script_erro', versao: script.versao, indice: i, erro: erroMsg });
      if (emit) emit({ evento: 'scripts_concluido', sucesso: false, executados, totalPendentes: pendentes.length });
      return { sucesso: false, executados, erro: erroMsg, versaoInicial: versaoBD, versaoFinal: currentVersaoBD };
    }

    if (emit) emit({ evento: 'script_executando', versao: script.versao, arquivo: script.arquivo, indice: i });
    logMsg(`Executando script v${script.versao} no banco "${pgLabel}": ${script.arquivo} (${i + 1}/${pendentes.length})`, 'progresso');

    // Upload script via SFTP
    const localScriptPath = path.join(scriptsIndex.pastaRaiz, script.arquivo);
    if (!fs.existsSync(localScriptPath)) {
      const erroMsg = `Arquivo nao encontrado: ${script.arquivo}`;
      logMsg(erroMsg, 'erro');
      if (emit) emit({ evento: 'script_erro', versao: script.versao, indice: i, erro: erroMsg });
      if (emit) emit({ evento: 'scripts_concluido', sucesso: false, executados, totalPendentes: pendentes.length });
      return { sucesso: false, executados, erro: erroMsg, versaoInicial: versaoBD, versaoFinal: currentVersaoBD };
    }

    const remoteScriptPath = `C:\\temp\\fdeploy_script_v${script.versao}.txt`;

    try {
      await ssh.putFile(localScriptPath, remoteScriptPath);

      // Executar com psql --single-transaction
      const execCmd = `set "PGPASSWORD=${pgPass}"&& psql -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} --single-transaction -f "${remoteScriptPath}" 2>&1`;
      const execResult = await ssh.execCommand(execCmd);

      const output = (execResult.stdout || '').trim();

      // Verificar erros
      if (execResult.code !== 0 || /^ERROR:/m.test(output)) {
        logMsg(`ERRO no script v${script.versao}`, 'erro');
        if (emit) emit({ evento: 'script_erro', versao: script.versao, indice: i, erro: output });
        if (emit) emit({ evento: 'scripts_concluido', sucesso: false, executados, totalPendentes: pendentes.length });
        await ssh.execCommand(`del "${remoteScriptPath}" 2>nul`);
        return { sucesso: false, executados, erro: `Erro no script v${script.versao}`, erroDetalhe: output, versaoInicial: versaoBD, versaoFinal: currentVersaoBD };
      }

      executados++;
      currentVersaoBD = script.versao;
      logMsg(`Script v${script.versao} executado com sucesso`, 'sucesso');
      if (emit) emit({ evento: 'script_sucesso', versao: script.versao, indice: i });

      // Atualizar arquivo .txt original com nome do operador e data
      if (operador) {
        atualizarScriptOriginal(localScriptPath, pgDb, operador, servidor.nome);
      }

    } catch (err) {
      logMsg(`Erro ao executar script v${script.versao}: ${err.message}`, 'erro');
      if (emit) emit({ evento: 'script_erro', versao: script.versao, indice: i, erro: err.message });
      if (emit) emit({ evento: 'scripts_concluido', sucesso: false, executados, totalPendentes: pendentes.length });
      return { sucesso: false, executados, erro: err.message, versaoInicial: versaoBD, versaoFinal: currentVersaoBD };
    } finally {
      try { await ssh.execCommand(`del "${remoteScriptPath}" 2>nul`); } catch (_) {}
    }
  }

  logMsg(`Todos os ${executados} script(s) executados com sucesso!`, 'sucesso');
  if (emit) emit({ evento: 'scripts_concluido', sucesso: true, executados, totalPendentes: pendentes.length });

  // Atualizar versaoScriptBD no servidor
  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === servidor.id);
  if (idx !== -1) {
    servidores[idx].versaoScriptBD = currentVersaoBD;
    salvarServidores(servidores);
  }

  return { sucesso: true, executados, versaoInicial: versaoBD, versaoFinal: currentVersaoBD };
}

function atualizarScriptOriginal(filePath, pgBanco, operador, nomeServidor) {
  try {
    if (!fs.existsSync(filePath)) return;
    let conteudo = fs.readFileSync(filePath, 'utf8');

    const dataHoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const nomeArquivo = path.basename(filePath);

    // Procurar linha com COMMENT ON DATABASE "{pgBanco}"
    const escapedBanco = pgBanco.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(COMMENT ON DATABASE\\s+"${escapedBanco}".*?)________-\\s*__________`, 'i');
    const match = conteudo.match(regex);

    if (match) {
      // Encontrou o banco com placeholder — substituir
      conteudo = conteudo.replace(regex, `$1${operador} - ${dataHoje}`);
      fs.writeFileSync(filePath, conteudo, 'utf8');
      console.log(`[Script] Atualizado ${nomeArquivo}: ${pgBanco} -> ${operador} - ${dataHoje}`);
    } else if (conteudo.includes(`"${pgBanco}"`)) {
      // Banco existe mas sem placeholder (ja atualizado) — nao sobrescrever
      console.log(`[Script] ${nomeArquivo}: ${pgBanco} ja atualizado, ignorando`);
    } else {
      // Banco NAO encontrado — adicionar nova linha antes do fechamento do bloco
      // Construir linha no padrao: COMMENT ON DATABASE "banco"      IS 'Identificacao       - Operador - DD/MM/YYYY Script nome.txt';
      const prefixo = `COMMENT ON DATABASE "${pgBanco}"`;
      const colunaIS = 38;
      const espacosIS = Math.max(1, colunaIS - prefixo.length);
      const identificacao = (nomeServidor || pgBanco).substring(0, 19).padEnd(19);
      const novaLinha = `${prefixo}${' '.repeat(espacosIS)}IS '${identificacao} - ${operador} - ${dataHoje} Script ${nomeArquivo}';`;

      // Procurar fechamento do bloco de comentarios (*/)
      const fechamentoIdx = conteudo.lastIndexOf('*/');
      if (fechamentoIdx !== -1) {
        // Encontrar o inicio da linha que contem */
        let inicioLinha = conteudo.lastIndexOf('\n', fechamentoIdx - 1);
        if (inicioLinha === -1) inicioLinha = 0;
        else inicioLinha += 1;

        // Inserir a nova linha ANTES da linha que contem */ (e o ###)
        const antes = conteudo.substring(0, inicioLinha);
        const depois = conteudo.substring(inicioLinha);
        const nl = antes.length > 0 && !antes.endsWith('\n') ? '\n' : '';
        conteudo = antes + nl + novaLinha + '\n' + depois;
        fs.writeFileSync(filePath, conteudo, 'utf8');
        console.log(`[Script] Adicionado ${pgBanco} em ${nomeArquivo}: ${nomeServidor} - ${operador} - ${dataHoje}`);
      }
    }
  } catch (err) {
    console.error(`[Script] Erro ao atualizar ${filePath}: ${err.message}`);
  }
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

// ── Remover regra de firewall SSH via conexao SSH ativa ──
async function removerFirewallSSH(ssh, logMsg) {
  try {
    logMsg('Removendo regra de firewall SSH (porta 22)...', 'progresso');
    await ssh.execCommand('netsh advfirewall firewall delete rule name=sshd');
    logMsg('Regra de firewall SSH removida', 'sucesso');
  } catch (err) {
    logMsg(`Aviso: nao foi possivel remover regra de firewall: ${err.message}`, 'progresso');
  }
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
          // Firewall — abrir porta 22 temporariamente
          logMsg('Adicionando regra de firewall (porta 22)...', 'progresso');
          await cimExec('firewall-install', `
$fwCmd = 'netsh advfirewall firewall add rule name=sshd dir=in action=allow protocol=TCP localport=22 profile=any'
Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="cmd.exe /c $fwCmd"} | Out-Null
`);
          logMsg('Regra de firewall criada', 'sucesso');
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
$svc = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter "Name='sshd'"
Invoke-CimMethod -InputObject $svc -MethodName ChangeStartMode -Arguments @{StartMode='Automatic'} | Out-Null
Invoke-CimMethod -InputObject $svc -MethodName StartService | Out-Null
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
      logMsg('Adicionando regra de firewall (porta 22)...', 'progresso');
      await cimExec('firewall', `
$fwCmd = 'netsh advfirewall firewall add rule name=sshd dir=in action=allow protocol=TCP localport=22 profile=any'
Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="cmd.exe /c $fwCmd"} | Out-Null
`);
      logMsg('Regra de firewall criada', 'sucesso');
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

// ── Detectar servico Apache no servidor remoto ──
async function detectarApache(ssh) {
  const candidates = ['Apache2.4', 'Apache2.2', 'httpd', 'apache2', 'Apache'];
  let parado = null;
  for (const name of candidates) {
    const result = await ssh.execCommand(`sc query "${name}" 2>nul`);
    const out = result.stdout || '';
    if (out && (out.includes('SERVICE_NAME') || out.includes('NOME_DO_SERVI'))) {
      if (out.includes('RUNNING')) return name;
      if (!parado) parado = name;
    }
  }
  if (parado) return parado;
  // Fallback: buscar qualquer servico com apache ou httpd no nome
  const searchResult = await ssh.execCommand(
    `powershell -NoProfile -Command "Get-Service | Where-Object { $_.Name -match 'apache|httpd' } | Select-Object -First 1 -ExpandProperty Name"`
  );
  const found = (searchResult.stdout || '').trim();
  if (found && !found.toLowerCase().includes('error') && !found.includes('Cannot find')) return found;
  return null;
}

// ── Criar ZIP local usando PowerShell ──
async function criarZipLocal(sourceDir, pattern, destZip) {
  const srcEscaped = sourceDir.replace(/\\/g, '\\\\');
  const destEscaped = destZip.replace(/\\/g, '\\\\');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  if (Test-Path '${destEscaped}') { Remove-Item '${destEscaped}' -Force }
  $files = Get-ChildItem -Path '${srcEscaped}' -Filter '${pattern}' -File -ErrorAction Stop
  if ($files.Count -eq 0) { Write-Host "VAZIO:0:0"; exit 0 }
  Add-Type -Assembly 'System.IO.Compression.FileSystem'
  $zip = [System.IO.Compression.ZipFile]::Open('${destEscaped}', 'Create')
  foreach ($f in $files) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $f.Name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
  $zip.Dispose()
  $zipSize = (Get-Item '${destEscaped}').Length
  Write-Host "OK:$($files.Count):$zipSize"
} catch {
  Write-Host "ERRO:$($_.Exception.Message)"
}`;
  const result = await executarPowerShell(script, 300000);
  const output = (result.stdout || '').trim();
  if (output.startsWith('VAZIO')) return { count: 0, size: 0 };
  if (output.startsWith('OK:')) {
    const parts = output.split(':');
    return { count: parseInt(parts[1]), size: parseInt(parts[2]) };
  }
  throw new Error(`Falha ao criar ZIP: ${output} ${(result.stderr || '').trim()}`);
}

// ── Criar ZIP de todos os arquivos de um diretorio ──
async function criarZipDiretorio(sourceDir, destZip) {
  const srcEscaped = sourceDir.replace(/\\/g, '\\\\');
  const destEscaped = destZip.replace(/\\/g, '\\\\');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  if (Test-Path '${destEscaped}') { Remove-Item '${destEscaped}' -Force }
  $files = Get-ChildItem -Path '${srcEscaped}' -File -Recurse -ErrorAction Stop
  if ($files.Count -eq 0) { Write-Host "VAZIO:0:0"; exit 0 }
  Add-Type -Assembly 'System.IO.Compression.FileSystem'
  $zip = [System.IO.Compression.ZipFile]::Open('${destEscaped}', 'Create')
  $basePath = (Resolve-Path '${srcEscaped}').Path
  foreach ($f in $files) {
    $relativePath = $f.FullName.Substring($basePath.Length + 1)
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $relativePath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
  $zip.Dispose()
  $zipSize = (Get-Item '${destEscaped}').Length
  Write-Host "OK:$($files.Count):$zipSize"
} catch {
  Write-Host "ERRO:$($_.Exception.Message)"
}`;
  const result = await executarPowerShell(script, 300000);
  const output = (result.stdout || '').trim();
  if (output.startsWith('VAZIO')) return { count: 0, size: 0 };
  if (output.startsWith('OK:')) {
    const parts = output.split(':');
    return { count: parseInt(parts[1]), size: parseInt(parts[2]) };
  }
  throw new Error(`Falha ao criar ZIP: ${output} ${(result.stderr || '').trim()}`);
}

// ── Enviar ZIP e extrair no servidor remoto ──
async function enviarEExtrairZip(ssh, localZip, remoteFileName, remoteDestDir, emit, logMsg) {
  const remoteZip = `${remoteDestDir}\\${remoteFileName}`;

  // Garantir que diretorio destino exista
  await ssh.execCommand(`if not exist "${remoteDestDir}" mkdir "${remoteDestDir}"`);

  // Upload SFTP com progresso
  const fileSize = fs.statSync(localZip).size;
  if (emit) emit({ evento: 'transferencia_inicio', total: fileSize });

  let ultimoPct = -1;
  await enviarArquivoSFTP(ssh, localZip, remoteZip, (transferido, total) => {
    const pct = Math.round((transferido / total) * 100);
    if (emit && pct !== ultimoPct) {
      ultimoPct = pct;
      emit({ evento: 'transferencia_progresso', transferido, total, percentual: pct });
    }
  });

  if (emit) emit({ evento: 'transferencia_fim' });
  logMsg(`Arquivo enviado (${formatMB(fileSize)} MB)`, 'sucesso');

  // Extrair no servidor remoto
  logMsg('Descompactando no servidor...', 'progresso');
  const extractResult = await ssh.execCommand(
    `powershell -NoProfile -Command "Expand-Archive -Path '${remoteZip}' -DestinationPath '${remoteDestDir}' -Force"`
  );
  if (extractResult.code !== 0) {
    const errMsg = extractResult.stderr || extractResult.stdout || 'Erro desconhecido';
    throw new Error(`Falha ao descompactar: ${errMsg}`);
  }
  logMsg('Descompactado com sucesso', 'sucesso');

  // Limpar ZIP remoto
  await ssh.execCommand(`del "${remoteZip}" 2>nul`);
}

// ── Deploy Servidor Geral ──
async function executarDeployGeral(servidor, emit, operador) {
  const inicio = Date.now();
  const log = [];
  let ssh;
  let sucesso = false;
  let scriptsResult = null;
  let firewallAberta = false;

  function logMsg(msg, tipo = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    const entry = { ts, msg, tipo };
    log.push(entry);
    console.log(`[Geral ${servidor.nome}] [${tipo}] ${msg}`);
    if (emit) emit({ evento: 'log', ...entry });
  }

  function emitEtapa(etapaId) {
    if (emit) emit({ evento: 'etapa', etapa: etapaId });
  }

  const versaoAtual = lerVersaoGeral();
  if (!versaoAtual) {
    logMsg('Nenhuma versao definida para Servidor Geral', 'erro');
    const entry = { servidor: servidor.nome, ip: servidor.ip, sucesso: false, duracao: '0s', data: new Date().toISOString(), log };
    salvarDeployLogGeral(entry);
    return entry;
  }

  const exesZip = path.join(VERSOES_GERAL_DIR, `${versaoAtual}_exes.zip`);
  const dllsZip = path.join(VERSOES_GERAL_DIR, `${versaoAtual}_dlls.zip`);
  const reportsZip = path.join(VERSOES_GERAL_DIR, `${versaoAtual}_reports.zip`);

  const faltando = [];
  if (!fs.existsSync(exesZip)) faltando.push('EXEs');
  if (!fs.existsSync(dllsZip)) faltando.push('DLLs');
  if (!fs.existsSync(reportsZip)) faltando.push('Reports');
  if (faltando.length > 0) {
    logMsg(`Cache da versao ${versaoAtual} incompleto (faltam: ${faltando.join(', ')})`, 'erro');
    const entry = { servidor: servidor.nome, ip: servidor.ip, sucesso: false, duracao: '0s', data: new Date().toISOString(), log };
    salvarDeployLogGeral(entry);
    return entry;
  }

  logMsg(`Versao ${versaoAtual} — EXEs: ${formatMB(fs.statSync(exesZip).size)} MB, DLLs: ${formatMB(fs.statSync(dllsZip).size)} MB, Reports: ${formatMB(fs.statSync(reportsZip).size)} MB`, 'sucesso');

  try {
    // Conectar SSH
    logMsg('Conectando via SSH...', 'progresso');
    try {
      ssh = await conectarSSH(servidor);
    } catch (sshErr) {
      logMsg(`Falha na conexao SSH: ${sshErr.message}`, 'erro');
      const instalou = await instalarSSHRemoto(servidor, logMsg);
      if (instalou) {
        logMsg('Tentando conectar via SSH novamente...', 'progresso');
        ssh = await conectarSSH(servidor);
        firewallAberta = true;
      } else {
        logMsg('Verifique se o login e senha do Windows estao corretos nas configuracoes do servidor', 'erro');
        throw sshErr;
      }
    }
    logMsg('Conectado!', 'sucesso');

    // Detectar Apache
    logMsg('Detectando servico Apache...', 'progresso');
    const apacheName = await detectarApache(ssh);
    if (apacheName) {
      logMsg(`Apache detectado: ${apacheName}`, 'sucesso');
    } else {
      logMsg('Servico Apache nao encontrado — continuando sem controle do Apache', 'erro');
    }

    // Etapa 1: Parar Apache
    emitEtapa('parando_apache');
    if (apacheName) {
      logMsg(`Parando servico ${apacheName}...`, 'progresso');
      const stopResult = await ssh.execCommand(`net stop "${apacheName}"`);
      if (stopResult.code !== 0) {
        const msg = (stopResult.stderr || '').trim();
        if (msg.includes('not been started') || msg.includes('is not started')) {
          logMsg('Apache ja estava parado', 'sucesso');
        } else {
          logMsg(`Aviso ao parar Apache: ${msg}`, 'progresso');
        }
      } else {
        logMsg('Apache parado', 'sucesso');
      }
    }

    // Etapa 2: Enviar EXEs
    emitEtapa('enviando_exes');
    logMsg('Enviando EXEs para C:\\f\\Webfrigo...', 'progresso');
    await enviarEExtrairZip(ssh, exesZip, 'exes_update.zip', REMOTE_WEBFRIGO, emit, logMsg);

    // Etapa 3: Enviar DLLs
    emitEtapa('enviando_dlls');
    logMsg('Enviando DLLs para C:\\f\\Webfrigo...', 'progresso');
    await enviarEExtrairZip(ssh, dllsZip, 'dlls_update.zip', REMOTE_WEBFRIGO, emit, logMsg);

    // Etapa 4: Enviar Reports
    emitEtapa('enviando_reports');
    logMsg('Enviando Reports para C:\\f\\WebPrint\\reports...', 'progresso');
    await enviarEExtrairZip(ssh, reportsZip, 'reports_update.zip', REMOTE_REPORTS_DIR, emit, logMsg);

    // Etapa 5: Executar Scripts SQL (com varredura incremental para detectar novos)
    emitEtapa('executando_scripts');
    const scriptsIndex = indexarScripts(false);
    if (servidor.temPostgreSQL && servidor.pgBanco && servidor.pgSenha) {
      if (scriptsIndex && scriptsIndex.scripts && scriptsIndex.scripts.length > 0) {
        scriptsResult = await executarScriptsSQL(ssh, servidor, scriptsIndex, emit, logMsg, operador);
      } else {
        logMsg('Indice de scripts vazio ou nao configurado — pulando', 'info');
      }
    } else {
      logMsg('PostgreSQL nao configurado — pulando scripts SQL', 'info');
    }

    // Etapa 6: Iniciar Apache
    emitEtapa('iniciando_apache');
    if (apacheName) {
      logMsg(`Iniciando servico ${apacheName}...`, 'progresso');
      await ssh.execCommand(`net start "${apacheName}"`);
      await new Promise(r => setTimeout(r, 3000));

      const checkResult = await ssh.execCommand(`sc query "${apacheName}"`);
      if (checkResult.stdout && checkResult.stdout.includes('RUNNING')) {
        logMsg(`${apacheName} rodando!`, 'sucesso');
      } else {
        logMsg(`AVISO: ${apacheName} pode nao ter iniciado corretamente`, 'erro');
      }
    }

    // Etapa 7: Concluido
    emitEtapa('concluido');
    sucesso = true;
    logMsg('Atualizacao concluida com sucesso!', 'sucesso');

    // Rastrear versao deployada
    const servidores = lerServidores();
    const idx = servidores.findIndex(s => s.id === servidor.id);
    if (idx !== -1) {
      servidores[idx].versaoGeralDeployada = versaoAtual;
      servidores[idx].ultimaAtualizacaoGeral = new Date().toISOString();
      salvarServidores(servidores);
    }
  } catch (err) {
    logMsg(`ERRO: ${err.message}`, 'erro');
  } finally {
    if (firewallAberta && ssh) await removerFirewallSSH(ssh, logMsg);
    if (ssh) ssh.dispose();
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
    scripts: scriptsResult ? {
      executados: scriptsResult.executados || 0,
      sucesso: scriptsResult.sucesso,
      erro: scriptsResult.erro || null,
      versaoInicial: scriptsResult.versaoInicial,
      versaoFinal: scriptsResult.versaoFinal,
    } : null,
  };
  salvarDeployLogGeral(entry);

  return entry;
}

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
    pgSenha: undefined,
    temSenha: !!s.senha,
    temPgSenha: !!s.pgSenha,
    versaoDeployada: s.versaoDeployada || null,
    versaoGeralDeployada: s.versaoGeralDeployada || null,
    ultimaAtualizacaoGeral: s.ultimaAtualizacaoGeral || null,
    temPostgreSQL: s.temPostgreSQL || false,
    pgBanco: s.pgBanco || '',
    pgPorta: s.pgPorta || 5432,
    pgUsuario: s.pgUsuario || 'frigo',
    pgHost: s.pgHost || '',
    versaoScriptBD: s.versaoScriptBD || null,
    grupoReplicacao: s.grupoReplicacao || null,
  }));
  res.json(servidores);
});

app.post('/api/servidores', (req, res) => {
  const { nome, ip, porta, usuario, senha, descricao, temPostgreSQL, pgBanco, pgPorta, pgUsuario, pgSenha, pgHost } = req.body;
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
    temPostgreSQL: temPostgreSQL || false,
    pgBanco: pgBanco || '',
    pgPorta: pgPorta || 5432,
    pgUsuario: pgUsuario || 'frigo',
    pgSenha: pgSenha ? encrypt(pgSenha) : '',
    pgHost: pgHost || '',
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

  const { nome, ip, porta, usuario, senha, descricao, temPostgreSQL, pgBanco, pgPorta, pgUsuario, pgSenha, pgHost } = req.body;
  if (nome) servidores[idx].nome = nome;
  if (ip) servidores[idx].ip = ip;
  if (porta !== undefined) servidores[idx].porta = porta;
  if (usuario) servidores[idx].usuario = usuario;
  if (senha) servidores[idx].senha = encrypt(senha);
  if (descricao !== undefined) servidores[idx].descricao = descricao;
  if (temPostgreSQL !== undefined) servidores[idx].temPostgreSQL = temPostgreSQL;
  if (pgBanco !== undefined) servidores[idx].pgBanco = pgBanco;
  if (pgPorta !== undefined) servidores[idx].pgPorta = pgPorta;
  if (pgUsuario !== undefined) servidores[idx].pgUsuario = pgUsuario;
  if (pgSenha) servidores[idx].pgSenha = encrypt(pgSenha);
  if (pgHost !== undefined) servidores[idx].pgHost = pgHost;

  salvarServidores(servidores);
  res.json({ ok: true });
});

// ── Grupo de Replicacao: vincular dois servidores ──
app.post('/api/servidores/grupo-replicacao', (req, res) => {
  const { servidorIdA, servidorIdB } = req.body;
  if (!servidorIdA || !servidorIdB) return res.status(400).json({ erro: 'servidorIdA e servidorIdB sao obrigatorios' });
  if (servidorIdA === servidorIdB) return res.status(400).json({ erro: 'Nao pode vincular um servidor a ele mesmo' });

  const servidores = lerServidores();
  const idxA = servidores.findIndex(s => s.id === servidorIdA);
  const idxB = servidores.findIndex(s => s.id === servidorIdB);
  if (idxA === -1 || idxB === -1) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  const grupoA = servidores[idxA].grupoReplicacao || null;
  const grupoB = servidores[idxB].grupoReplicacao || null;

  if (grupoA && grupoB && grupoA === grupoB) {
    return res.json({ ok: true, grupo: grupoA, msg: 'Ja estao no mesmo grupo' });
  }

  let grupoFinal;
  if (!grupoA && !grupoB) {
    grupoFinal = 'grp_' + Date.now();
    servidores[idxA].grupoReplicacao = grupoFinal;
    servidores[idxB].grupoReplicacao = grupoFinal;
  } else if (grupoA && !grupoB) {
    grupoFinal = grupoA;
    servidores[idxB].grupoReplicacao = grupoFinal;
  } else if (!grupoA && grupoB) {
    grupoFinal = grupoB;
    servidores[idxA].grupoReplicacao = grupoFinal;
  } else {
    // Ambos tem grupo diferente: migrar todos de B para grupo de A
    grupoFinal = grupoA;
    for (const s of servidores) {
      if (s.grupoReplicacao === grupoB) s.grupoReplicacao = grupoFinal;
    }
  }

  salvarServidores(servidores);
  res.json({ ok: true, grupo: grupoFinal });
});

// ── Grupo de Replicacao: remover servidor do grupo ──
app.post('/api/servidores/grupo-replicacao/remover', (req, res) => {
  const { servidorId } = req.body;
  if (!servidorId) return res.status(400).json({ erro: 'servidorId e obrigatorio' });

  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === servidorId);
  if (idx === -1) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  const grupo = servidores[idx].grupoReplicacao;
  if (!grupo) return res.json({ ok: true, msg: 'Servidor nao esta em nenhum grupo' });

  // Remover do grupo
  delete servidores[idx].grupoReplicacao;

  // Se restar apenas 1 membro no grupo, limpar tambem
  const restantes = servidores.filter(s => s.grupoReplicacao === grupo);
  if (restantes.length === 1) {
    delete restantes[0].grupoReplicacao;
  }

  salvarServidores(servidores);
  res.json({ ok: true });
});

app.delete('/api/servidores/:id', (req, res) => {
  let servidores = lerServidores();
  const removido = servidores.find(s => s.id === req.params.id);
  const grupoRemovido = removido ? removido.grupoReplicacao : null;

  servidores = servidores.filter(s => s.id !== req.params.id);

  // Se o grupo ficou com apenas 1 membro, limpar
  if (grupoRemovido) {
    const restantes = servidores.filter(s => s.grupoReplicacao === grupoRemovido);
    if (restantes.length === 1) {
      delete restantes[0].grupoReplicacao;
    }
  }

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

  const result = { disponivel: true, versao: vData.ativa, versoes, descricoes: vData.descricoes || {} };
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
  const { versao, descricao } = req.body;
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

  salvarVersao(versao, descricao);
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
    let firewallAberta = false;
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
          firewallAberta = true;
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
      if (firewallAberta) await removerFirewallSSH(ssh, logEtapa);
      ssh.dispose();
      logEtapa(`Servico: ${servico_status} | Versao: ${versao_atual || '?'}`, 'sucesso');
      emit({ evento: 'resultado', conectou: true, servico_status, versao_atual });
    } catch (err) {
      if (firewallAberta && ssh) await removerFirewallSSH(ssh, logEtapa);
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
  let firewallAberta = false;

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
        firewallAberta = true;
      } else {
        logMsg('Verifique se o login e senha do Windows estao corretos nas configuracoes do servidor', 'erro');
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
    if (firewallAberta && ssh) await removerFirewallSSH(ssh, logMsg);
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

// ══════════════════════════════════════════
// ROTAS — SERVIDOR GERAL
// ══════════════════════════════════════════

// ── Status dos arquivos fonte ──
app.get('/api/geral/status', (req, res) => {
  const vData = lerVersaoGeralData();

  // Verificar diretorios fonte
  const debugExists = fs.existsSync(SOURCE_DEBUG_DIR);
  const reportsExists = fs.existsSync(SOURCE_REPORTS_DIR);

  let exeCount = 0, dllCount = 0, reportCount = 0;
  if (debugExists) {
    try {
      const files = fs.readdirSync(SOURCE_DEBUG_DIR);
      exeCount = files.filter(f => f.toLowerCase().endsWith('.exe')).length;
      dllCount = files.filter(f => f.toLowerCase().endsWith('.dll')).length;
    } catch (_) {}
  }
  if (reportsExists) {
    try {
      const countFiles = (dir) => {
        let count = 0;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.isFile()) count++;
          else if (item.isDirectory()) count += countFiles(path.join(dir, item.name));
        }
        return count;
      };
      reportCount = countFiles(SOURCE_REPORTS_DIR);
    } catch (_) {}
  }

  // Listar versoes do cache
  const versoes = [];
  if (fs.existsSync(VERSOES_GERAL_DIR)) {
    const files = fs.readdirSync(VERSOES_GERAL_DIR).filter(f => f.endsWith('.zip'));
    const versSet = new Set();
    for (const f of files) {
      const match = f.match(/^(.+?)_(exes|dlls|reports)\.zip$/);
      if (match) versSet.add(match[1]);
    }
    // Verificar quais versoes tem os 3 ZIPs
    for (const v of versSet) {
      const hasAll = fs.existsSync(path.join(VERSOES_GERAL_DIR, `${v}_exes.zip`)) &&
                     fs.existsSync(path.join(VERSOES_GERAL_DIR, `${v}_dlls.zip`)) &&
                     fs.existsSync(path.join(VERSOES_GERAL_DIR, `${v}_reports.zip`));
      if (hasAll) versoes.push(v);
    }
  }
  versoes.sort((a, b) => compararVersoes(b, a));

  res.json({
    debugDir: SOURCE_DEBUG_DIR,
    reportsDir: SOURCE_REPORTS_DIR,
    debugExists,
    reportsExists,
    exeCount,
    dllCount,
    reportCount,
    versao: vData.ativa,
    versoes,
    descricoes: vData.descricoes || {},
  });
});

// ── Criar versao (empacotar ZIPs) ──
app.post('/api/geral/versao', async (req, res) => {
  const { versao, descricao } = req.body;
  if (!versao) return res.status(400).json({ erro: 'Versao e obrigatoria' });

  if (!fs.existsSync(SOURCE_DEBUG_DIR)) {
    return res.status(400).json({ erro: `Diretorio fonte nao encontrado: ${SOURCE_DEBUG_DIR}` });
  }

  const exesZip = path.join(VERSOES_GERAL_DIR, `${versao}_exes.zip`);
  const dllsZip = path.join(VERSOES_GERAL_DIR, `${versao}_dlls.zip`);
  const reportsZip = path.join(VERSOES_GERAL_DIR, `${versao}_reports.zip`);

  try {
    console.log(`[Geral] Criando versao ${versao}...`);

    // EXEs
    const exeResult = await criarZipLocal(SOURCE_DEBUG_DIR, '*.exe', exesZip);
    console.log(`[Geral] EXEs: ${exeResult.count} arquivos, ${formatMB(exeResult.size)} MB`);

    // DLLs
    const dllResult = await criarZipLocal(SOURCE_DEBUG_DIR, '*.dll', dllsZip);
    console.log(`[Geral] DLLs: ${dllResult.count} arquivos, ${formatMB(dllResult.size)} MB`);

    // Reports
    if (fs.existsSync(SOURCE_REPORTS_DIR)) {
      const repResult = await criarZipDiretorio(SOURCE_REPORTS_DIR, reportsZip);
      console.log(`[Geral] Reports: ${repResult.count} arquivos, ${formatMB(repResult.size)} MB`);
    } else {
      // Criar ZIP vazio de reports se diretorio nao existe
      const script = `
Add-Type -Assembly 'System.IO.Compression.FileSystem'
$zip = [System.IO.Compression.ZipFile]::Open('${reportsZip.replace(/\\/g, '\\\\')}', 'Create')
$zip.Dispose()
Write-Host "OK:0:0"`;
      await executarPowerShell(script);
      console.log(`[Geral] Reports: diretorio nao existe, ZIP vazio criado`);
    }

    salvarVersaoGeral(versao, descricao);
    res.json({
      ok: true,
      versao,
      exes: exeResult.count,
      dlls: dllResult.count,
    });
  } catch (err) {
    console.error(`[Geral] Erro ao criar versao: ${err.message}`);
    // Limpar ZIPs parciais
    try { if (fs.existsSync(exesZip)) fs.unlinkSync(exesZip); } catch (_) {}
    try { if (fs.existsSync(dllsZip)) fs.unlinkSync(dllsZip); } catch (_) {}
    try { if (fs.existsSync(reportsZip)) fs.unlinkSync(reportsZip); } catch (_) {}
    res.status(500).json({ erro: err.message });
  }
});

// ── Listar versoes Geral ──
app.get('/api/geral/versoes', (req, res) => {
  const data = lerVersaoGeralData();
  const versoes = [];
  if (fs.existsSync(VERSOES_GERAL_DIR)) {
    const files = fs.readdirSync(VERSOES_GERAL_DIR).filter(f => f.endsWith('.zip'));
    const versMap = {};
    for (const f of files) {
      const match = f.match(/^(.+?)_(exes|dlls|reports)\.zip$/);
      if (match) {
        if (!versMap[match[1]]) versMap[match[1]] = { exes: 0, dlls: 0, reports: 0 };
        versMap[match[1]][match[2]] = fs.statSync(path.join(VERSOES_GERAL_DIR, f)).size;
      }
    }
    for (const [ver, sizes] of Object.entries(versMap)) {
      if (sizes.exes && sizes.dlls) {
        const total = sizes.exes + sizes.dlls + (sizes.reports || 0);
        versoes.push({ versao: ver, tamanho: total, tamanho_mb: formatMB(total) });
      }
    }
  }
  versoes.sort((a, b) => compararVersoes(b.versao, a.versao));
  res.json({ ativa: data.ativa, versoes });
});

// ── Selecionar versao existente Geral ──
app.post('/api/geral/versao/selecionar', (req, res) => {
  const { versao } = req.body;
  if (!versao) return res.status(400).json({ erro: 'Versao e obrigatoria' });

  const exesZip = path.join(VERSOES_GERAL_DIR, `${versao}_exes.zip`);
  if (!fs.existsSync(exesZip)) {
    return res.status(404).json({ erro: `Versao ${versao} nao encontrada no cache` });
  }

  const data = lerVersaoGeralData();
  data.ativa = versao;
  if (!data.versoes.includes(versao)) data.versoes.push(versao);
  salvarVersaoGeralData(data);

  res.json({ ok: true, versao });
});

// ── SSE: Deploy Geral de todos os servidores ──
// IMPORTANTE: esta rota deve vir ANTES de /:id/stream para nao ser capturada como id="todos"
app.get('/api/geral/deploy/todos/stream', (req, res) => {
  req.setTimeout(120 * 60 * 1000);
  res.setTimeout(120 * 60 * 1000);

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

  const operador = req.query.operador || '';
  (async () => {
    const versaoAtiva = lerVersaoGeral();
    const resultados = [];
    const deployedIds = new Set();

    // Separar em grupos e standalone
    const grupos = {};
    const standalone = [];
    for (const s of servidores) {
      if (s.grupoReplicacao) {
        if (!grupos[s.grupoReplicacao]) grupos[s.grupoReplicacao] = [];
        grupos[s.grupoReplicacao].push(s);
      } else {
        standalone.push(s);
      }
    }

    // Processar grupos: se ALGUM membro precisa atualizar, deploy de TODOS sequencialmente
    for (const grupoId of Object.keys(grupos)) {
      const membros = grupos[grupoId];
      const algumPrecisa = membros.some(s => !(versaoAtiva && s.versaoGeralDeployada && s.versaoGeralDeployada === versaoAtiva));

      if (!algumPrecisa) {
        // Todos ja atualizados — pular grupo inteiro
        for (const s of membros) {
          if (!deployedIds.has(s.id)) {
            emit(s.id, { evento: 'deploy_pulado', versao: versaoAtiva });
            resultados.push({ servidorId: s.id, sucesso: true, pulado: true });
            deployedIds.add(s.id);
          }
        }
        continue;
      }

      // Deploy sequencial de todos os membros do grupo
      for (const s of membros) {
        if (deployedIds.has(s.id)) continue;
        deployedIds.add(s.id);

        emit(s.id, { evento: 'deploy_iniciando' });
        try {
          const result = await executarDeployGeral(s, (data) => emit(s.id, data), operador);
          emit(s.id, { evento: 'concluido', sucesso: result.sucesso, log: result.log, duracao: result.duracao });
          resultados.push({ servidorId: s.id, ...result });
        } catch (err) {
          emit(s.id, { evento: 'concluido', sucesso: false, erro: err.message });
          resultados.push({ servidorId: s.id, erro: err.message });
        }
      }
    }

    // Processar standalone
    for (const s of standalone) {
      if (deployedIds.has(s.id)) continue;
      deployedIds.add(s.id);

      // Pular servidores ja na versao ativa
      if (versaoAtiva && s.versaoGeralDeployada && s.versaoGeralDeployada === versaoAtiva) {
        emit(s.id, { evento: 'deploy_pulado', versao: versaoAtiva });
        resultados.push({ servidorId: s.id, sucesso: true, pulado: true });
        continue;
      }

      emit(s.id, { evento: 'deploy_iniciando' });
      try {
        const result = await executarDeployGeral(s, (data) => emit(s.id, data), operador);
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

// ── SSE: Deploy Geral de um servidor ──
app.get('/api/geral/deploy/:id/stream', (req, res) => {
  req.setTimeout(30 * 60 * 1000);
  res.setTimeout(30 * 60 * 1000);

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

  const operador = req.query.operador || '';
  executarDeployGeral(servidor, emit, operador).then(result => {
    emit({ evento: 'concluido', sucesso: result.sucesso, log: result.log, duracao: result.duracao });
    res.end();
  }).catch(err => {
    emit({ evento: 'erro', msg: err.message });
    res.end();
  });

  req.on('close', () => {});
});

// ── Historico Geral ──
app.get('/api/geral/historico', (req, res) => {
  res.json(lerDeployLogGeral());
});

// ── Verificar replicacao de um servidor via psql ──
app.get('/api/geral/verificar-replicacao/:id', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  if (!servidor.temPostgreSQL || !servidor.pgBanco || !servidor.pgSenha) {
    return res.json({ temReplicacao: false });
  }

  let ssh;
  try {
    ssh = await conectarSSH(servidor);
    const pgPass = decrypt(servidor.pgSenha);
    const pgUser = servidor.pgUsuario || 'frigo';
    const pgDb = servidor.pgBanco;
    const pgPort = servidor.pgPorta || 5432;
    const pgHost = servidor.pgHost || '127.0.0.1';

    const cmd = `set "PGPASSWORD=${pgPass}"&& psql -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} -t -A -c "SELECT replica FROM replicacao.servidor" 2>&1`;
    const result = await ssh.execCommand(cmd);
    ssh.dispose();

    const output = (result.stdout || '').trim();
    // Se retornou algum valor (nao vazio, nao erro), tem replicacao
    if (output && !output.includes('ERROR') && !output.includes('does not exist') && !output.includes('relation')) {
      return res.json({ temReplicacao: true });
    }
    return res.json({ temReplicacao: false });
  } catch (err) {
    if (ssh) ssh.dispose();
    return res.json({ temReplicacao: false });
  }
});

// ══════════════════════════════════════════
// ROTAS — SCRIPTS SQL
// ══════════════════════════════════════════

// ── Status dos scripts (indice) — com varredura incremental automatica ──
app.get('/api/geral/scripts/status', (req, res) => {
  let index = lerScriptsIndex();
  if (!index) {
    // Primeira execucao: varredura completa
    index = indexarScripts(true);
  } else {
    // Varredura incremental: detecta novos arquivos sem reler os existentes
    index = indexarScripts(false);
  }

  const totalScripts = index.scripts ? index.scripts.length : 0;
  const versaoMaisRecente = totalScripts > 0 ? index.scripts[totalScripts - 1].versao : null;

  res.json({
    pastaRaiz: index.pastaRaiz,
    pastasDetectadas: index.pastasDetectadas || [],
    totalScripts,
    versaoMaisRecente,
    ultimaVarredura: index.ultimaVarredura,
    erro: index.erro || null,
  });
});

// ── Configurar pasta raiz dos scripts ──
app.post('/api/geral/scripts/config', (req, res) => {
  const { pastaRaiz } = req.body;
  if (!pastaRaiz) return res.status(400).json({ erro: 'pastaRaiz e obrigatoria' });

  if (!fs.existsSync(pastaRaiz)) {
    return res.status(400).json({ erro: `Pasta nao encontrada: ${pastaRaiz}` });
  }

  // Salvar config e reindexar
  const index = lerScriptsIndex() || {};
  index.pastaRaiz = pastaRaiz;
  salvarScriptsIndex(index);

  // Reindexar com a nova pasta
  const result = indexarScripts(true);
  res.json({ ok: true, ...result });
});

// ── Reindexar scripts (varredura completa) ──
app.post('/api/geral/scripts/reindexar', (req, res) => {
  const result = indexarScripts(true);
  const totalScripts = result.scripts ? result.scripts.length : 0;
  const versaoMaisRecente = totalScripts > 0 ? result.scripts[totalScripts - 1].versao : null;

  res.json({
    ok: true,
    pastaRaiz: result.pastaRaiz,
    pastasDetectadas: result.pastasDetectadas || [],
    totalScripts,
    versaoMaisRecente,
    ultimaVarredura: result.ultimaVarredura,
    erro: result.erro || null,
  });
});

// ── Verificar versao do banco em um servidor ──
app.get('/api/geral/scripts/versao/:id', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  if (!servidor.temPostgreSQL || !servidor.pgBanco || !servidor.pgSenha) {
    return res.json({ versaoBD: null, erro: 'PostgreSQL nao configurado' });
  }

  let ssh;
  try {
    ssh = await conectarSSH(servidor);

    const pgPass = decrypt(servidor.pgSenha);
    const pgUser = servidor.pgUsuario || 'frigo';
    const pgDb = servidor.pgBanco;
    const pgPort = servidor.pgPorta || 5432;
    const pgHost = servidor.pgHost || '127.0.0.1';

    const cmd = `set "PGPASSWORD=${pgPass}"&& psql -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} -t -A -c "SELECT versao_bd FROM re.servidor"`;
    const result = await ssh.execCommand(cmd);

    const versaoBD = parseInt((result.stdout || '').trim());
    ssh.dispose();

    if (isNaN(versaoBD)) {
      return res.json({ versaoBD: null, erro: result.stderr || result.stdout || 'Nao foi possivel obter versao_bd' });
    }

    // Calcular pendentes
    const index = lerScriptsIndex();
    let pendentes = 0;
    if (index && index.scripts) {
      pendentes = index.scripts.filter(s => s.versao > versaoBD).length;
    }

    // Salvar versaoScriptBD
    const idx = servidores.findIndex(s => s.id === req.params.id);
    if (idx !== -1) {
      servidores[idx].versaoScriptBD = versaoBD;
      salvarServidores(servidores);
    }

    res.json({ versaoBD, pendentes });
  } catch (err) {
    if (ssh) ssh.dispose();
    res.json({ versaoBD: null, erro: err.message });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`FDeploy rodando em http://localhost:${PORT}`);
});
