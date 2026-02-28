const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');
const { spawn, exec } = require('child_process');
const { NodeSSH } = require('node-ssh');

// Quando empacotado com pkg, __dirname aponta para o filesystem virtual.
// Dados (data/, uploads/) ficam ao lado do .exe.
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;

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
const DATA_DIR = path.join(APP_ROOT, 'data');
const UPLOADS_DIR = path.join(APP_ROOT, 'uploads');
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

// ── psql Client ──
const PSQL_CACHE_PATH = path.join(DATA_DIR, 'psql_client.zip');
const PSQL_REMOTE_DIR = 'C:\\f\\pgsql';

// ── Agent ──
const AGENT_EXE_PATH = path.join(APP_ROOT, 'dist', 'fdeploy-agent.exe');
const AGENT_NSSM_PATH = path.join(APP_ROOT, 'nssm', 'nssm.exe');
const AGENT_REMOTE_DIR = 'C:\\f\\FDeploy Agent';
const AGENT_SERVICE_NAME = 'FDeployAgent';
const AGENT_DEFAULT_PORT = 3501;

// ── Versao esperada do Agent ──
const AGENT_EXPECTED_VERSION = (() => {
  try {
    // Dev: ler de agent/package.json
    const agentPkg = path.join(__dirname, 'agent', 'package.json');
    if (fs.existsSync(agentPkg)) return JSON.parse(fs.readFileSync(agentPkg, 'utf8')).version || '0.0.0';
    // Producao (pkg): ler de data/agent-version.txt
    const versionFile = path.join(APP_ROOT, 'data', 'agent-version.txt');
    if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, 'utf8').trim();
    return '0.0.0';
  } catch (_) { return '0.0.0'; }
})();

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

  // Verificar psql (com fallback para C:\f\pgsql\psql.exe)
  logMsg('Verificando disponibilidade do psql...', 'progresso');
  const psqlCmd = await resolverPsqlRemoto(ssh);
  if (!psqlCmd) {
    logMsg('psql nao encontrado no servidor — pulando scripts SQL', 'erro');
    return { sucesso: true, executados: 0, pulado: true, aviso: 'psql nao encontrado' };
  }
  logMsg(psqlCmd === 'psql' ? 'psql disponivel no PATH' : `psql encontrado em ${PSQL_REMOTE_DIR}`, 'sucesso');

  // Consultar versao_bd
  const pgPass = decrypt(servidor.pgSenha);
  const pgUser = servidor.pgUsuario || 'frigo';
  const pgDb = servidor.pgBanco;
  const pgPort = servidor.pgPorta || 5432;
  const pgHost = servidor.pgHost || '127.0.0.1';
  const pgRemoto = servidor.pgHost && servidor.pgHost !== servidor.ip;
  const pgLabel = pgRemoto ? `${pgDb} (remoto: ${pgHost})` : pgDb;

  logMsg(`Consultando versao do banco "${pgLabel}"...`, 'progresso');
  const versionCmd = `set "PGPASSWORD=${pgPass}"&& ${psqlCmd} -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} -t -A -c "SELECT versao_bd FROM re.servidor"`;
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
      const execCmd = `set "PGPASSWORD=${pgPass}"&& ${psqlCmd} -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} --single-transaction -f "${remoteScriptPath}" 2>&1`;
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

// ── Resolver caminho do psql no servidor remoto (retorna 'psql' ou caminho completo) ──
async function resolverPsqlRemoto(ssh) {
  const check = await ssh.execCommand('where psql 2>nul');
  if (check.code === 0 && (check.stdout || '').trim()) return 'psql';
  const fallback = await ssh.execCommand(`"${PSQL_REMOTE_DIR}\\psql.exe" --version 2>nul`);
  if ((fallback.stdout || '').includes('psql')) return `"${PSQL_REMOTE_DIR}\\psql.exe"`;
  return null;
}

// ── Criar ZIP com binarios minimos do psql ──
async function criarZipPsql() {
  // Se cache existe, retorna direto
  if (fs.existsSync(PSQL_CACHE_PATH)) {
    console.log('[psql] Usando cache existente:', PSQL_CACHE_PATH);
    return PSQL_CACHE_PATH;
  }

  // Procurar PostgreSQL local (18 ate 12)
  let pgBinDir = null;
  for (let v = 18; v >= 12; v--) {
    const dir = `C:\\Program Files\\PostgreSQL\\${v}\\bin`;
    if (fs.existsSync(path.join(dir, 'psql.exe'))) {
      pgBinDir = dir;
      break;
    }
  }
  if (!pgBinDir) {
    throw new Error('PostgreSQL nao encontrado localmente (C:\\Program Files\\PostgreSQL\\{18..12}\\bin)');
  }
  console.log('[psql] PostgreSQL encontrado em:', pgBinDir);

  // Arquivos minimos necessarios
  const arquivosExatos = [
    'psql.exe', 'libpq.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll',
    'libiconv-2.dll', 'libintl-9.dll', 'zlib1.dll', 'libwinpthread-1.dll',
  ];
  const arquivosWildcard = ['icudt', 'icuuc', 'icuin'];

  // Coletar lista de arquivos
  const arquivos = [];
  for (const nome of arquivosExatos) {
    const full = path.join(pgBinDir, nome);
    if (fs.existsSync(full)) {
      arquivos.push(full);
    } else {
      console.log(`[psql] Aviso: ${nome} nao encontrado, pulando`);
    }
  }

  // Wildcards (icudt*.dll, icuuc*.dll, icuin*.dll)
  const allFiles = fs.readdirSync(pgBinDir);
  for (const prefix of arquivosWildcard) {
    const match = allFiles.find(f => f.toLowerCase().startsWith(prefix) && f.toLowerCase().endsWith('.dll'));
    if (match) {
      arquivos.push(path.join(pgBinDir, match));
    } else {
      console.log(`[psql] Aviso: ${prefix}*.dll nao encontrado, pulando`);
    }
  }

  if (!arquivos.find(f => f.endsWith('psql.exe'))) {
    throw new Error('psql.exe nao encontrado em ' + pgBinDir);
  }

  console.log(`[psql] Empacotando ${arquivos.length} arquivos...`);

  // Criar ZIP via PowerShell
  const tmpDir = path.join(UPLOADS_DIR, `_psql_tmp_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Copiar arquivos para pasta temp
  for (const arq of arquivos) {
    fs.copyFileSync(arq, path.join(tmpDir, path.basename(arq)));
  }

  // Criar ZIP
  const psScript = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path "${PSQL_CACHE_PATH.replace(/\\/g, '\\\\')}") { Remove-Item "${PSQL_CACHE_PATH.replace(/\\/g, '\\\\')}" -Force }
    [System.IO.Compression.ZipFile]::CreateFromDirectory("${tmpDir.replace(/\\/g, '\\\\')}", "${PSQL_CACHE_PATH.replace(/\\/g, '\\\\')}")
  `;
  const result = await executarPowerShell(psScript, 60000);

  // Limpar pasta temp
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  if (!fs.existsSync(PSQL_CACHE_PATH)) {
    throw new Error('Falha ao criar ZIP do psql: ' + (result.stderr || 'arquivo nao gerado'));
  }

  const size = (fs.statSync(PSQL_CACHE_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`[psql] ZIP criado: ${PSQL_CACHE_PATH} (${size} MB)`);
  return PSQL_CACHE_PATH;
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

// ══════════════════════════════════════════
// HELPERS — AGENT
// ══════════════════════════════════════════

function verificarAgent(servidor) {
  const port = servidor.agentPort || AGENT_DEFAULT_PORT;
  const url = `http://${servidor.ip}:${port}/ping`;
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ online: true, ...json });
        } catch (_) {
          resolve({ online: false });
        }
      });
    });
    req.on('error', () => resolve({ online: false }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false }); });
  });
}

function chamarAgent(servidor, method, path, body, timeoutMs) {
  const port = servidor.agentPort || AGENT_DEFAULT_PORT;
  const token = servidor.agentToken ? decrypt(servidor.agentToken) : '';
  const url = new URL(`http://${servidor.ip}:${port}${path}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      timeout: timeoutMs || 60000,
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    };

    let bodyData = null;
    if (body) {
      if (Buffer.isBuffer(body)) {
        options.headers['Content-Type'] = 'application/octet-stream';
        options.headers['Content-Length'] = body.length;
        bodyData = body;
      } else {
        bodyData = JSON.stringify(body);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(bodyData);
      }
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve({ ok: false, erro: 'Resposta invalida do agent' });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Agent timeout')); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ── Validar Agent antes de permitir deploy ──
async function validarAgentParaDeploy(servidor) {
  if (!servidor.agentToken) {
    return { ok: false, motivo: 'Agent nao instalado', codigo: 'sem_agent' };
  }
  const status = await verificarAgent(servidor);
  if (!status.online) {
    return { ok: false, motivo: 'Agent offline', codigo: 'agent_offline' };
  }
  const versaoRemota = status.version || '0.0.0';
  if (versaoRemota !== AGENT_EXPECTED_VERSION) {
    return { ok: false, motivo: `Agent desatualizado (${versaoRemota} → ${AGENT_EXPECTED_VERSION})`, codigo: 'agent_desatualizado' };
  }
  return { ok: true };
}

// ── Preparar servidor para deploy via Agent (temporario) ──
// Diagnostica, salva estado original, habilita UAC + firewall 22 + sshd
// Retorna { ok, mudancas: { uac, firewall22, sshd } } para reverter depois
async function prepararDeployViaAgent(servidor, logMsg) {
  const mudancas = { uac: false, firewall22: false, sshd: false };
  try {
    const status = await verificarAgent(servidor);
    if (!status.online) return { ok: false, mudancas };

    logMsg('Agent detectado! Preparando servidor para deploy...', 'progresso');
    const diag = await chamarAgent(servidor, 'GET', '/diagnostico');

    // UAC — habilitar se bloqueado
    if (diag.uac && diag.uac.status !== 'ok') {
      logMsg('Habilitando UAC temporariamente (LocalAccountTokenFilterPolicy)...', 'progresso');
      const fix = await chamarAgent(servidor, 'POST', '/fix/uac');
      if (fix.ok) {
        mudancas.uac = true;
        logMsg('UAC habilitado (sera revertido apos deploy)', 'sucesso');
      } else {
        logMsg(`Falha ao habilitar UAC: ${fix.erro}`, 'erro');
      }
    }

    // OpenSSH — instalar se ausente, iniciar se parado
    if (diag.openssh && diag.openssh.status !== 'ok') {
      if (!diag.openssh.instalado) {
        logMsg('Instalando OpenSSH via Agent...', 'progresso');
        const fix = await chamarAgent(servidor, 'POST', '/fix/openssh/instalar');
        if (fix.ok) {
          logMsg('OpenSSH instalado', 'sucesso');
          // Apos instalar, sshd inicia automaticamente — marcar para parar depois
          mudancas.sshd = true;
        } else {
          logMsg(`Falha ao instalar OpenSSH: ${fix.erro}`, 'erro');
        }
      } else if (diag.openssh.servico !== 'running') {
        logMsg('Iniciando servico sshd temporariamente via Agent...', 'progresso');
        const fix = await chamarAgent(servidor, 'POST', '/fix/servico/iniciar', { nome: 'sshd' });
        if (fix.ok) {
          mudancas.sshd = true;
          logMsg('sshd iniciado (sera parado apos deploy)', 'sucesso');
        } else {
          logMsg(`Falha ao iniciar sshd: ${fix.erro}`, 'erro');
        }
      }
    }
    // Se sshd ja estava running, nao marcar para parar (nao mudamos nada)

    // Firewall porta 22 — abrir se fechada
    if (diag.firewall && diag.firewall.portas && diag.firewall.portas[22] && diag.firewall.portas[22].status !== 'ok') {
      logMsg('Abrindo firewall porta 22 temporariamente via Agent...', 'progresso');
      const fix = await chamarAgent(servidor, 'POST', '/fix/firewall', { porta: 22, nome: 'FDeploy SSH Temp' });
      if (fix.ok) {
        mudancas.firewall22 = true;
        logMsg('Firewall porta 22 aberta (sera fechada apos deploy)', 'sucesso');
      } else {
        logMsg(`Falha ao abrir firewall: ${fix.erro}`, 'erro');
      }
    }

    return { ok: true, mudancas };
  } catch (err) {
    logMsg(`Agent preparacao: ${err.message}`, 'erro');
    return { ok: false, mudancas };
  }
}

// ── Reverter preparacao do servidor apos deploy via Agent ──
// Desfaz somente o que foi alterado em prepararDeployViaAgent
// Chamado APOS ssh.dispose() — tudo via Agent (porta 3501, independe do SSH)
async function reverterDeployViaAgent(servidor, mudancas, logMsg) {
  if (!mudancas || (!mudancas.uac && !mudancas.firewall22 && !mudancas.sshd)) return;

  try {
    const status = await verificarAgent(servidor);
    if (!status.online) {
      logMsg('Agent offline — nao foi possivel reverter preparacao', 'erro');
      return;
    }

    logMsg('Revertendo preparacao temporaria do Agent...', 'progresso');

    // 1. Reverter UAC (se habilitamos) — fazer ANTES de parar sshd
    if (mudancas.uac) {
      logMsg('Revertendo UAC (LocalAccountTokenFilterPolicy = 0)...', 'progresso');
      const fix = await chamarAgent(servidor, 'POST', '/fix/uac/revert');
      logMsg(fix.ok ? 'UAC revertido' : `Aviso ao reverter UAC: ${fix.erro || 'erro'}`, fix.ok ? 'sucesso' : 'progresso');
    }

    // 2. Fechar firewall porta 22 (se abrimos)
    if (mudancas.firewall22) {
      logMsg('Fechando firewall porta 22...', 'progresso');
      const fix = await chamarAgent(servidor, 'POST', '/fix/firewall/remover', { nome: 'FDeploy SSH Temp' });
      logMsg(fix.ok ? 'Firewall porta 22 fechada' : `Aviso ao fechar firewall: ${fix.erro || 'erro'}`, fix.ok ? 'sucesso' : 'progresso');
    }

    // 3. Parar sshd (se iniciamos) — por ultimo, pois nao afeta Agent
    if (mudancas.sshd) {
      logMsg('Parando servico sshd...', 'progresso');
      const fix = await chamarAgent(servidor, 'POST', '/fix/servico/parar', { nome: 'sshd' });
      logMsg(fix.ok ? 'sshd parado' : `Aviso ao parar sshd: ${fix.erro || 'erro'}`, fix.ok ? 'sucesso' : 'progresso');
    }

    logMsg('Preparacao temporaria revertida', 'sucesso');
  } catch (err) {
    logMsg(`Aviso ao reverter preparacao: ${err.message}`, 'progresso');
  }
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
  const debugFile = path.join(APP_ROOT, 'debug_wmi.txt');
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
      const erroWmi = check.split('ERRO:').pop().trim();
      logMsg(`Erro ao conectar via WMI: ${erroWmi}`, 'erro');
      if (/acesso negado|access.denied/i.test(erroWmi)) {
        logMsg('--- DIAGNOSTICO ---', 'erro');
        logMsg('O servidor bloqueou o acesso remoto via WMI (porta 135).', 'erro');
        logMsg('Isso ocorre quando o UAC impede administradores locais de acessar remotamente.', 'erro');
        logMsg('', 'erro');
        logMsg('SOLUCAO: Acesse o servidor via TS/Radmin e execute como Administrador:', 'erro');
        logMsg('  1. Liberar UAC para acesso remoto:', 'erro');
        logMsg('     reg add HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f', 'erro');
        logMsg('  2. Liberar firewall WMI (se necessario):', 'erro');
        logMsg('     netsh advfirewall firewall set rule group="Windows Management Instrumentation (WMI)" new enable=yes', 'erro');
        logMsg('  3. Verificar se o usuario esta no grupo Administradores:', 'erro');
        logMsg('     net localgroup Administrators', 'erro');
        logMsg('', 'erro');
        logMsg('Apos executar os comandos, tente novamente.', 'erro');
      } else if (/timeout|tempo/i.test(erroWmi)) {
        logMsg('--- DIAGNOSTICO ---', 'erro');
        logMsg('Servidor inacessivel — nenhuma porta respondeu (SSH 22 e WMI 135).', 'erro');
        logMsg('', 'erro');
        logMsg('SOLUCAO: Acesse o servidor via TS/Radmin e execute como Administrador:', 'erro');
        logMsg('  1. Verificar se o servidor esta online e conectado na VPN (Radmin)', 'erro');
        logMsg('  2. Liberar portas no firewall:', 'erro');
        logMsg('     netsh advfirewall firewall add rule name="WMI-DCOM" dir=in action=allow protocol=TCP localport=135 profile=any', 'erro');
        logMsg('     netsh advfirewall firewall set rule group="Windows Management Instrumentation (WMI)" new enable=yes', 'erro');
        logMsg('  3. Liberar UAC para acesso remoto:', 'erro');
        logMsg('     reg add HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f', 'erro');
        logMsg('', 'erro');
        logMsg('Apos executar os comandos, tente novamente.', 'erro');
      } else {
        logMsg('Verifique as configuracoes de rede, credenciais e permissoes do servidor.', 'erro');
      }
      return false;
    }

    // ── Passo 2: Instalar se nao existe ──
    if (check.includes('SSHD:NAO_EXISTE')) {
      logMsg('OpenSSH Server NAO esta instalado', 'erro');

      // Instalar via WMI: cria tarefa agendada como SYSTEM (requer privilegio elevado para DISM)
      logMsg('Instalando OpenSSH via WMI (tarefa SYSTEM)...', 'progresso');
      const dismCmd = 'dism.exe /Online /Add-Capability /CapabilityName:OpenSSH.Server~~~~0.0.1.0';
      const installResult = await cimExec('dism-install', `
$createCmd = 'schtasks /create /tn FDeploy_InstallSSH /tr "${dismCmd}" /sc once /st 00:00 /f /rl HIGHEST /ru SYSTEM'
$r1 = Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="cmd.exe /c $createCmd"}
Start-Sleep -Seconds 3
$runCmd = 'schtasks /run /tn FDeploy_InstallSSH'
$r2 = Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="cmd.exe /c $runCmd"}
if ($r2.ReturnValue -eq 0) { Write-Host "DISM_INICIADO:PID=$($r2.ProcessId)" } else { Write-Host "DISM_ERRO:$($r2.ReturnValue)" }
`);

      // Debug
      debugIdx++;
      fs.appendFileSync(debugFile, `\n${'='.repeat(60)}\n[${debugIdx}] dism-install\n${'='.repeat(60)}\nResultado: ${installResult}\n\n`, 'utf8');
      console.log(`[DISM ${ip}] ${installResult}`);

      if (!installResult.includes('DISM_INICIADO')) {
        logMsg(`Falha ao iniciar DISM: ${installResult}`, 'erro');
        return false;
      }
      logMsg('DISM iniciado como SYSTEM! Aguardando instalacao...', 'sucesso');

      // Monitorar status do servico sshd ate ficar Running
      logMsg('Monitorando instalacao...', 'progresso');
      let sshdOk = false;
      for (let i = 1; i <= 20; i++) {
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
        logMsg('--- DIAGNOSTICO ---', 'erro');
        logMsg('A instalacao do OpenSSH via DISM nao foi concluida em 5 minutos.', 'erro');
        logMsg('', 'erro');
        logMsg('SOLUCAO: Acesse o servidor via TS/Radmin e execute como Administrador:', 'erro');
        logMsg('  1. Instalar OpenSSH manualmente:', 'erro');
        logMsg('     dism /Online /Add-Capability /CapabilityName:OpenSSH.Server~~~~0.0.1.0', 'erro');
        logMsg('  2. Iniciar o servico:', 'erro');
        logMsg('     sc config sshd start=auto && net start sshd', 'erro');
        logMsg('  3. Liberar porta 22 no firewall:', 'erro');
        logMsg('     netsh advfirewall firewall add rule name=sshd dir=in action=allow protocol=TCP localport=22', 'erro');
        logMsg('', 'erro');
        logMsg('Apos executar os comandos, tente novamente.', 'erro');
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

    logMsg('--- DIAGNOSTICO ---', 'erro');
    logMsg('O OpenSSH foi instalado mas a conexao SSH nao ficou acessivel.', 'erro');
    logMsg('', 'erro');
    logMsg('SOLUCAO: Acesse o servidor via TS/Radmin e execute como Administrador:', 'erro');
    logMsg('  1. Verificar se o sshd esta rodando:', 'erro');
    logMsg('     sc query sshd', 'erro');
    logMsg('  2. Iniciar se estiver parado:', 'erro');
    logMsg('     net start sshd', 'erro');
    logMsg('  3. Liberar porta 22 no firewall:', 'erro');
    logMsg('     netsh advfirewall firewall add rule name=sshd dir=in action=allow protocol=TCP localport=22', 'erro');
    logMsg('', 'erro');
    logMsg('Apos executar os comandos, tente novamente.', 'erro');
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
    if (result.stdout.includes('START_PENDING')) return 'iniciando';
    if (result.stdout.includes('STOP_PENDING')) return 'parando';
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

  // Extrair no servidor remoto (Expand-Archive PS5+ com fallback .NET 4.5 para Server 2012 R2)
  logMsg('Descompactando no servidor...', 'progresso');
  const psExtract = `$ErrorActionPreference='Stop'; try { Expand-Archive -Path '${remoteZip}' -DestinationPath '${remoteDestDir}' -Force } catch { Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead('${remoteZip}'); foreach($e in $zip.Entries){ $d=Join-Path '${remoteDestDir}' $e.FullName; $dir=Split-Path $d; if(!(Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}; if($e.Name){ [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$d,$true) } }; $zip.Dispose() }`;
  const extractResult = await ssh.execCommand(`powershell -NoProfile -Command "${psExtract}"`);
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
  let agentMudancas = null; // rastreia o que o Agent preparou temporariamente

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

  // Validar Agent antes do deploy
  const validacao = await validarAgentParaDeploy(servidor);
  if (!validacao.ok) {
    logMsg(`Deploy bloqueado: ${validacao.motivo}`, 'erro');
    const entry = { servidor: servidor.nome, ip: servidor.ip, sucesso: false, duracao: '0s', data: new Date().toISOString(), log, bloqueadoPorAgent: true };
    salvarDeployLogGeral(entry);
    return entry;
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
    // Conectar SSH (com fallback Agent prepare → WMI)
    logMsg('Conectando via SSH...', 'progresso');
    try {
      ssh = await conectarSSH(servidor);
    } catch (sshErr) {
      logMsg(`Falha na conexao SSH: ${sshErr.message}`, 'erro');

      // Camada 2: Preparar via Agent (temporario — sera revertido no finally)
      const resultado = await prepararDeployViaAgent(servidor, logMsg);
      agentMudancas = resultado.mudancas;
      if (resultado.ok) {
        try {
          logMsg('Tentando conectar via SSH apos preparacao do Agent...', 'progresso');
          ssh = await conectarSSH(servidor);
        } catch (_) {
          // Agent preparou mas SSH ainda falha — tentar WMI
          logMsg('SSH ainda falha apos Agent — tentando WMI...', 'progresso');
          const instalou = await instalarSSHRemoto(servidor, logMsg);
          if (instalou) {
            logMsg('Tentando conectar via SSH novamente...', 'progresso');
            ssh = await conectarSSH(servidor);
            firewallAberta = true;
          } else {
            throw sshErr;
          }
        }
      } else {
        // Camada 3: Fallback WMI
        const instalou = await instalarSSHRemoto(servidor, logMsg);
        if (instalou) {
          logMsg('Tentando conectar via SSH novamente...', 'progresso');
          ssh = await conectarSSH(servidor);
          firewallAberta = true;
        } else {
          throw sshErr;
        }
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
    // Evitar mensagem duplicada para erros de conexao ja detalhados
    if (/authentication/i.test(err.message)) {
      logMsg('--- DIAGNOSTICO ---', 'erro');
      logMsg('Credenciais SSH rejeitadas pelo servidor.', 'erro');
      logMsg('', 'erro');
      logMsg('SOLUCAO:', 'erro');
      logMsg('  1. Verifique o login e senha nas configuracoes do servidor no FDeploy', 'erro');
      logMsg('  2. Teste o acesso manualmente via TS/Radmin com as mesmas credenciais', 'erro');
      logMsg('  3. Se a senha foi alterada, atualize no cadastro do servidor', 'erro');
    } else if (!/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test(err.message)) {
      logMsg(`ERRO: ${err.message}`, 'erro');
    }
  } finally {
    if (firewallAberta && ssh) await removerFirewallSSH(ssh, logMsg);
    if (ssh) ssh.dispose();
    // Reverter preparacao temporaria do Agent (UAC, firewall 22, sshd)
    if (agentMudancas) await reverterDeployViaAgent(servidor, agentMudancas, logMsg);
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
    agentToken: undefined,
    temSenha: !!s.senha,
    temPgSenha: !!s.pgSenha,
    temAgentToken: !!s.agentToken,
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
    agentPort: s.agentPort || AGENT_DEFAULT_PORT,
    agentVersao: s.agentVersao || null,
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

  const { nome, ip, porta, usuario, senha, descricao, temPostgreSQL, pgBanco, pgPorta, pgUsuario, pgSenha, pgHost, agentPort } = req.body;
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
  if (agentPort !== undefined) servidores[idx].agentPort = agentPort;

  salvarServidores(servidores);
  res.json({ ok: true });
});

// ── Setup Wizard: instalar agent + diagnosticar ao criar servidor (SSE) ──
app.get('/api/servidores/:id/setup/stream', (req, res) => {
  req.setTimeout(5 * 60 * 1000);
  res.setTimeout(5 * 60 * 1000);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === req.params.id);
  if (idx === -1) {
    res.write(`data: ${JSON.stringify({ evento: 'erro', msg: 'Servidor nao encontrado' })}\n\n`);
    res.end();
    return;
  }
  const servidor = servidores[idx];

  function emit(data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  function logEtapa(msg, tipo) {
    const ts = new Date().toLocaleTimeString('pt-BR');
    emit({ evento: 'log', ts, msg, tipo: tipo || 'progresso' });
    console.log(`[Setup ${servidor.nome}] ${msg}`);
  }

  (async () => {
    // 1. Verificar agent.exe local
    logEtapa('Verificando fdeploy-agent.exe local...', 'progresso');
    if (!fs.existsSync(AGENT_EXE_PATH)) {
      logEtapa('fdeploy-agent.exe nao encontrado em dist/. Execute o build primeiro.', 'erro');
      emit({ evento: 'resultado', ok: false, fase: 'agent-exe', pendencias: ['agent'] });
      servidores[idx].pendencias = ['agent'];
      salvarServidores(servidores);
      res.end();
      return;
    }
    logEtapa('fdeploy-agent.exe encontrado', 'sucesso');

    // 2. Conectar SSH (com fallback Agent prepare → WMI)
    let ssh;
    let firewallAberta = false;
    let agentMudancas = null;
    logEtapa(`Conectando via SSH em ${servidor.ip}:${servidor.porta || 22}...`, 'progresso');
    try {
      ssh = await conectarSSH(servidor);
      logEtapa('Conexao SSH estabelecida', 'sucesso');
    } catch (sshErr) {
      logEtapa(`Falha na conexao SSH: ${sshErr.message}`, 'erro');

      // Camada 2: Preparar via Agent (se ja existir de antes — temporario)
      const resultado = await prepararDeployViaAgent(servidor, logEtapa);
      agentMudancas = resultado.mudancas;
      if (resultado.ok) {
        try {
          logEtapa('Tentando reconectar via SSH apos preparacao do Agent...', 'progresso');
          ssh = await conectarSSH(servidor);
          logEtapa('Conexao SSH estabelecida apos preparacao', 'sucesso');
        } catch (_) {
          logEtapa('SSH ainda falha apos Agent — tentando WMI/DCOM...', 'progresso');
          const instalou = await instalarSSHRemoto(servidor, logEtapa);
          if (instalou) {
            logEtapa('Tentando conectar via SSH novamente...', 'progresso');
            try {
              ssh = await conectarSSH(servidor);
              firewallAberta = true;
              logEtapa('Conexao SSH estabelecida via WMI', 'sucesso');
            } catch (e) {
              logEtapa(`SSH falhou mesmo apos WMI: ${e.message}`, 'erro');
              emit({ evento: 'resultado', ok: false, fase: 'ssh', pendencias: ['ssh'] });
              servidores[idx].pendencias = ['ssh'];
              salvarServidores(servidores);
              if (agentMudancas) await reverterDeployViaAgent(servidor, agentMudancas, logEtapa);
              res.end();
              return;
            }
          } else {
            logEtapa('WMI tambem falhou — servidor inacessivel', 'erro');
            emit({ evento: 'resultado', ok: false, fase: 'ssh', pendencias: ['ssh'] });
            servidores[idx].pendencias = ['ssh'];
            salvarServidores(servidores);
            if (agentMudancas) await reverterDeployViaAgent(servidor, agentMudancas, logEtapa);
            res.end();
            return;
          }
        }
      } else {
        // Camada 3: Fallback WMI direto
        logEtapa('Tentando instalar OpenSSH via WMI/DCOM...', 'progresso');
        const instalou = await instalarSSHRemoto(servidor, logEtapa);
        if (instalou) {
          logEtapa('Tentando conectar via SSH novamente...', 'progresso');
          try {
            ssh = await conectarSSH(servidor);
            firewallAberta = true;
            logEtapa('Conexao SSH estabelecida via WMI', 'sucesso');
          } catch (e) {
            logEtapa(`SSH falhou mesmo apos WMI: ${e.message}`, 'erro');
            emit({ evento: 'resultado', ok: false, fase: 'ssh', pendencias: ['ssh'] });
            servidores[idx].pendencias = ['ssh'];
            salvarServidores(servidores);
            res.end();
            return;
          }
        } else {
          logEtapa('WMI falhou — servidor inacessivel', 'erro');
          emit({ evento: 'resultado', ok: false, fase: 'ssh', pendencias: ['ssh'] });
          servidores[idx].pendencias = ['ssh'];
          salvarServidores(servidores);
          res.end();
          return;
        }
      }
    }

    // 3. Instalar Agent (helper emite logs via callback)
    emit({ evento: 'fase', fase: 'agent', descricao: 'Instalando Agent' });
    try {
      await instalarAgentNoServidor(ssh, servidor, servidores, idx, logEtapa);
    } catch (err) {
      logEtapa(`Falha ao instalar Agent: ${err.message}`, 'erro');
      emit({ evento: 'resultado', ok: false, fase: 'agent', pendencias: ['agent'] });
      servidores[idx].pendencias = ['agent'];
      salvarServidores(servidores);
      if (firewallAberta && ssh) await removerFirewallSSH(ssh, logEtapa);
      if (ssh) ssh.dispose();
      if (agentMudancas) await reverterDeployViaAgent(servidor, agentMudancas, logEtapa);
      res.end();
      return;
    }
    if (firewallAberta) await removerFirewallSSH(ssh, logEtapa);
    ssh.dispose();
    // Reverter preparacao temporaria do Agent (se houve)
    if (agentMudancas) await reverterDeployViaAgent(servidor, agentMudancas, logEtapa);

    // 4. Aguardar Agent ficar online
    emit({ evento: 'fase', fase: 'verificacao', descricao: 'Verificando Agent' });
    logEtapa('Aguardando Agent iniciar (3s)...', 'progresso');
    await new Promise(r => setTimeout(r, 3000));

    const servidoresAtual = lerServidores();
    const servidorAtual = servidoresAtual[idx];

    logEtapa('Verificando se Agent esta online...', 'progresso');
    const status = await verificarAgent(servidorAtual);

    if (!status.online) {
      logEtapa('Agent instalado mas nao respondeu ao ping', 'erro');
      emit({ evento: 'resultado', ok: false, fase: 'agent-offline', pendencias: ['agent-offline'] });
      servidoresAtual[idx].pendencias = ['agent-offline'];
      salvarServidores(servidoresAtual);
      res.end();
      return;
    }
    logEtapa(`Agent online (v${status.version || '?'})`, 'sucesso');

    // 5. Diagnostico via Agent
    emit({ evento: 'fase', fase: 'diagnostico', descricao: 'Executando diagnostico' });
    logEtapa('Executando diagnostico completo via Agent...', 'progresso');
    try {
      const diag = await chamarAgent(servidorAtual, 'GET', '/diagnostico');

      // Extrair pendencias (UAC e Firewall sao gerenciados temporariamente pelo Agent — nao sao pendencias)
      const pendencias = [];
      if (diag.uac) {
        logEtapa(diag.uac.status === 'ok' ? 'UAC: liberado' : 'UAC: restrito (liberado temporariamente no deploy)', diag.uac.status === 'ok' ? 'sucesso' : 'info');
      }
      if (diag.openssh && diag.openssh.status !== 'ok') {
        pendencias.push('openssh');
        logEtapa(`OpenSSH: ${diag.openssh.instalado ? 'instalado mas servico ' + diag.openssh.servico : 'nao instalado'}`, 'erro');
      } else if (diag.openssh) {
        logEtapa('OpenSSH: OK', 'sucesso');
      }
      if (diag.firewall && diag.firewall.portas) {
        const p22 = diag.firewall.portas[22] || diag.firewall.portas['22'];
        logEtapa(p22 && p22.status !== 'ok' ? 'Firewall porta 22: fechada (aberta temporariamente no deploy)' : 'Firewall porta 22: aberta', p22 && p22.status !== 'ok' ? 'info' : 'sucesso');
      }

      // Salvar pendencias
      servidoresAtual[idx].pendencias = pendencias;
      salvarServidores(servidoresAtual);

      if (pendencias.length === 0) {
        logEtapa('Diagnostico concluido — nenhuma pendencia encontrada', 'sucesso');
      } else {
        logEtapa(`Diagnostico concluido — ${pendencias.length} pendencia(s): ${pendencias.join(', ')}`, 'info');
      }

      emit({ evento: 'resultado', ok: true, fase: 'concluido', diagnostico: diag, pendencias });
    } catch (err) {
      logEtapa(`Diagnostico falhou: ${err.message}`, 'erro');
      emit({ evento: 'resultado', ok: false, fase: 'diagnostico', pendencias: ['diagnostico'] });
      servidoresAtual[idx].pendencias = ['diagnostico'];
      salvarServidores(servidoresAtual);
    }
    res.end();
  })();
});

// ── Atualizar pendencias de um servidor ──
app.put('/api/servidores/:id/pendencias', (req, res) => {
  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  servidores[idx].pendencias = req.body.pendencias || [];
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
  let agentMudancas = null; // rastreia o que o Agent preparou temporariamente

  function logMsg(msg, tipo = 'info') {
    const ts = new Date().toLocaleTimeString('pt-BR');
    const entry = { ts, msg, tipo };
    log.push(entry);
    console.log(`[${servidor.nome}] [${tipo}] ${msg}`);
    if (emit) emit({ evento: 'log', ...entry });
  }

  // Validar Agent antes do deploy
  const validacao = await validarAgentParaDeploy(servidor);
  if (!validacao.ok) {
    logMsg(`Deploy bloqueado: ${validacao.motivo}`, 'erro');
    const entry = { servidor: servidor.nome, ip: servidor.ip, sucesso: false, duracao: '0s', data: new Date().toISOString(), log, bloqueadoPorAgent: true };
    salvarDeployLog(entry);
    return entry;
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

    // 2. Conectar (com fallback Agent prepare → WMI)
    logMsg('Conectando via SSH...', 'progresso');
    try {
      ssh = await conectarSSH(servidor);
    } catch (sshErr) {
      logMsg(`Falha na conexao SSH: ${sshErr.message}`, 'erro');

      // Camada 2: Preparar via Agent (temporario — sera revertido no finally)
      const resultado = await prepararDeployViaAgent(servidor, logMsg);
      agentMudancas = resultado.mudancas;
      if (resultado.ok) {
        try {
          logMsg('Tentando conectar via SSH apos preparacao do Agent...', 'progresso');
          ssh = await conectarSSH(servidor);
        } catch (_) {
          logMsg('SSH ainda falha apos Agent — tentando WMI...', 'progresso');
          const instalou = await instalarSSHRemoto(servidor, logMsg);
          if (instalou) {
            logMsg('Tentando conectar via SSH novamente...', 'progresso');
            ssh = await conectarSSH(servidor);
            firewallAberta = true;
          } else {
            throw sshErr;
          }
        }
      } else {
        // Camada 3: Fallback WMI
        const instalou = await instalarSSHRemoto(servidor, logMsg);
        if (instalou) {
          logMsg('Tentando conectar via SSH novamente...', 'progresso');
          ssh = await conectarSSH(servidor);
          firewallAberta = true;
        } else {
          throw sshErr;
        }
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

    // 11. Monitorar log.txt para verificar inicializacao
    //     O Fvendas gera log.txt durante o boot — marcadores:
    //     - "servidor online" + "banco conectado" = sucesso
    //     - Servico parado (sc query STOPPED) = crash, rollback
    //     - Timeout 2 min sem marcadores = considerar sucesso parcial (servico pode estar lento)
    logMsg('Monitorando inicializacao do servico...', 'progresso');
    let linhasVistas = 0;
    let bootOk = false;
    let servicoCaiu = false;
    let crashLoop = false;
    const MAX_TENTATIVAS = 40; // 40 x 3s = 2 minutos

    for (let i = 0; i < MAX_TENTATIVAS; i++) {
      await new Promise(r => setTimeout(r, 3000));

      // Ler log.txt
      const logResult = await ssh.execCommand(`type "${REMOTE_DIR}\\log.txt" 2>nul`);
      const logTexto = (logResult.stdout || '').trim();
      if (logTexto) {
        const linhas = logTexto.split('\n');
        // Exibir apenas linhas novas
        for (let j = linhasVistas; j < linhas.length; j++) {
          const linha = linhas[j].trim();
          if (!linha) continue;
          const lower = linha.toLowerCase();
          const tipo = (lower.includes('erro') || lower.includes('error') || lower.includes('falha'))
            ? 'erro'
            : (lower.includes('online') || lower.includes('conectado') || lower.includes('connected') || lower.includes('sucesso') || lower.includes('pronto'))
              ? 'sucesso'
              : 'info';
          logMsg(linha, tipo);
        }
        linhasVistas = linhas.length;

        const logLower = logTexto.toLowerCase();

        // Detectar crash loop: "servidor iniciando" aparece mais de 1 vez = reiniciando repetidamente
        // Detectar crash loop: "servidor online" aparece mais de 5 vezes = reiniciando repetidamente
        const onlineCount = (logLower.match(/servidor online/g) || []).length;
        if (onlineCount > 5) {
          crashLoop = true;
          logMsg(`Crash loop detectado — servico reiniciou ${onlineCount} vezes`, 'erro');
          break;
        }

        // Verificar marcador de sucesso (primeira ocorrencia)
        if (logLower.includes('servidor online') || logLower.includes('banco conectado')) {
          bootOk = true;
          break;
        }
      }

      // Verificar se servico caiu (STOPPED = crash)
      const scStatus = await obterStatusServico(ssh);
      if (scStatus === 'parado') {
        servicoCaiu = true;
        break;
      }

      // Log de progresso a cada 15s
      if (i > 0 && i % 5 === 0) {
        logMsg(`Aguardando boot do Fvendas... (${i * 3}s)`, 'progresso');
      }
    }

    if (crashLoop || servicoCaiu) {
      // Servico em crash loop ou parou — rollback
      if (!crashLoop) logMsg('Servico parou apos iniciar. Executando rollback...', 'erro');
      logMsg('Executando rollback...', 'erro');
      await ssh.execCommand(`net stop ${SERVICE_NAME} 2>nul`);
      await ssh.execCommand(`taskkill /f /im Fvendas2.0.exe 2>nul`);
      await new Promise(r => setTimeout(r, 2000));
      await ssh.execCommand(`del "${REMOTE_EXE}" 2>nul`);
      await ssh.execCommand(`rename "${REMOTE_BAK}" "Fvendas2.0.exe"`);
      await ssh.execCommand(`net start ${SERVICE_NAME}`);
      logMsg('ROLLBACK executado — versao anterior restaurada', 'erro');
    } else if (bootOk) {
      const versao = await obterVersaoRemota(ssh);
      logMsg(`Servico iniciado com sucesso! Versao: ${versao || '?'}`, 'sucesso');
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
    } else {
      // Timeout — servico ainda em START_PENDING ou rodando sem log completo
      // Verificar sc query como fallback
      const scFinal = await obterStatusServico(ssh);
      if (scFinal === 'rodando' || scFinal === 'iniciando') {
        const versao = await obterVersaoRemota(ssh);
        logMsg(`Servico ativo (boot demorado). Versao: ${versao || '?'}`, 'sucesso');
        sucesso = true;

        if (versaoAtual) {
          const servidores = lerServidores();
          const idx = servidores.findIndex(s => s.id === servidor.id);
          if (idx !== -1) {
            servidores[idx].versaoDeployada = versaoAtual;
            salvarServidores(servidores);
          }
        }
      } else {
        logMsg(`Timeout — servico nao confirmou inicializacao (status: ${scFinal}). Executando rollback...`, 'erro');
        await ssh.execCommand(`net stop ${SERVICE_NAME} 2>nul`);
        await ssh.execCommand(`del "${REMOTE_EXE}" 2>nul`);
        await ssh.execCommand(`rename "${REMOTE_BAK}" "Fvendas2.0.exe"`);
        await ssh.execCommand(`net start ${SERVICE_NAME}`);
        logMsg('ROLLBACK executado — versao anterior restaurada', 'erro');
      }
    }
  } catch (err) {
    // Evitar mensagem duplicada para erros de conexao ja detalhados
    if (/authentication/i.test(err.message)) {
      logMsg('--- DIAGNOSTICO ---', 'erro');
      logMsg('Credenciais SSH rejeitadas pelo servidor.', 'erro');
      logMsg('', 'erro');
      logMsg('SOLUCAO:', 'erro');
      logMsg('  1. Verifique o login e senha nas configuracoes do servidor no FDeploy', 'erro');
      logMsg('  2. Teste o acesso manualmente via TS/Radmin com as mesmas credenciais', 'erro');
      logMsg('  3. Se a senha foi alterada, atualize no cadastro do servidor', 'erro');
    } else if (!/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test(err.message)) {
      logMsg(`ERRO: ${err.message}`, 'erro');
    }
  } finally {
    if (firewallAberta && ssh) await removerFirewallSSH(ssh, logMsg);
    if (ssh) ssh.dispose();
    // Reverter preparacao temporaria do Agent (UAC, firewall 22, sshd)
    if (agentMudancas) await reverterDeployViaAgent(servidor, agentMudancas, logMsg);
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

  const versaoAtiva = lerVersao();
  if (!versaoAtiva) {
    res.write(`data: ${JSON.stringify({ evento: 'erro', msg: 'Nenhuma versao selecionada. Crie ou selecione uma versao antes de atualizar.' })}\n\n`);
    res.end();
    return;
  }

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

      // Validar Agent antes do deploy
      const validacao = await validarAgentParaDeploy(s);
      if (!validacao.ok) {
        emit(s.id, { evento: 'deploy_bloqueado_agent', motivo: validacao.motivo, codigo: validacao.codigo });
        resultados.push({ servidorId: s.id, sucesso: false, bloqueadoPorAgent: true, motivo: validacao.motivo });
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

  const versaoAtiva = lerVersao();
  if (!versaoAtiva) {
    res.write(`data: ${JSON.stringify({ evento: 'erro', msg: 'Nenhuma versao selecionada. Crie ou selecione uma versao antes de atualizar.' })}\n\n`);
    res.end();
    return;
  }

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
// ROTAS — AGENT
// ══════════════════════════════════════════

// ── Status de todos os agents (deve vir ANTES de :id) ──
app.get('/api/agent/status/todos', async (req, res) => {
  const servidores = lerServidores();
  const resultados = {};
  const promises = servidores.map(async (s) => {
    const temAgent = !!s.agentToken;
    if (temAgent) {
      const status = await verificarAgent(s);
      const versaoRemota = status.version || s.agentVersao || '0.0.0';
      resultados[s.id] = { ...status, temAgent: true, versaoAgent: s.agentVersao || null, versaoEsperada: AGENT_EXPECTED_VERSION, desatualizado: status.online && versaoRemota !== AGENT_EXPECTED_VERSION };
    } else {
      resultados[s.id] = { online: false, temAgent: false, versaoEsperada: AGENT_EXPECTED_VERSION, desatualizado: false };
    }
  });
  await Promise.all(promises);
  res.json(resultados);
});

// ── Status do agent em um servidor ──
app.get('/api/agent/:id/status', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });
  const status = await verificarAgent(servidor);
  const versaoRemota = status.version || servidor.agentVersao || '0.0.0';
  res.json({ ...status, temAgent: !!servidor.agentToken, versaoAgent: servidor.agentVersao || null, versaoEsperada: AGENT_EXPECTED_VERSION, desatualizado: status.online && versaoRemota !== AGENT_EXPECTED_VERSION });
});

// ── Diagnostico completo via agent ──
app.get('/api/agent/:id/diagnostico', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  try {
    const diag = await chamarAgent(servidor, 'GET', '/diagnostico');
    res.json(diag);
  } catch (err) {
    res.json({ status: 'offline', erro: err.message });
  }
});

// ── Instalar/corrigir psql com log em tempo real (SSE) ──
app.get('/api/agent/:id/fix/psql/stream', (req, res) => {
  req.setTimeout(3 * 60 * 1000);
  res.setTimeout(3 * 60 * 1000);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  function emit(msg, tipo) {
    try { res.write(`data: ${JSON.stringify({ evento: 'log', msg, tipo: tipo || 'info' })}\n\n`); } catch (_) {}
  }
  function emitFim(ok, descricao) {
    try { res.write(`data: ${JSON.stringify({ evento: 'concluido', ok, descricao })}\n\n`); } catch (_) {}
    res.end();
  }

  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) { emitFim(false, 'Servidor nao encontrado'); return; }

  (async () => {
    try {
      const result = await instalarPsqlRemoto(servidor, emit);
      if (result.ok) {
        emitFim(true, result.descricao || 'psql instalado');
      } else {
        emitFim(false, result.erro || 'Falha na instalacao');
      }
    } catch (err) {
      emit(`Erro: ${err.message}`, 'erro');
      emitFim(false, err.message);
    }
  })();

  req.on('close', () => {});
});

// ── Instalar OpenSSH com log em tempo real (SSE) ──
app.get('/api/agent/:id/fix/openssh/stream', (req, res) => {
  req.setTimeout(3 * 60 * 1000);
  res.setTimeout(3 * 60 * 1000);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  function emit(msg, tipo) {
    try { res.write(`data: ${JSON.stringify({ evento: 'log', msg, tipo: tipo || 'info' })}\n\n`); } catch (_) {}
  }
  function emitFim(ok, descricao) {
    try { res.write(`data: ${JSON.stringify({ evento: 'concluido', ok, descricao })}\n\n`); } catch (_) {}
    res.end();
  }

  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) { emitFim(false, 'Servidor nao encontrado'); return; }

  (async () => {
    try {
      emit('Verificando Agent...', 'progresso');
      const agentSt = await verificarAgent(servidor);
      if (!agentSt.online) {
        emitFim(false, 'Agent offline — nao e possivel instalar OpenSSH');
        return;
      }
      emit(`Agent online (v${agentSt.version})`, 'sucesso');

      // Diagnosticar estado atual
      emit('Diagnosticando OpenSSH...', 'progresso');
      const diag = await chamarAgent(servidor, 'GET', '/diagnostico/openssh');
      if (diag.status === 'ok') {
        emit(`OpenSSH ja instalado e rodando`, 'sucesso');
        emitFim(true, 'OpenSSH ja esta configurado');
        return;
      }
      emit(`Status: ${diag.instalado ? 'instalado mas ' + (diag.servico || 'parado') : 'nao instalado'}`, 'info');

      // Instalar/corrigir
      emit('Instalando OpenSSH via Agent (DISM) — pode levar ate 2 minutos...', 'progresso');
      const result = await chamarAgent(servidor, 'POST', '/fix/openssh/instalar');

      if (result.ok) {
        emit(result.descricao || 'OpenSSH instalado', 'sucesso');

        // Verificar resultado
        emit('Verificando instalacao...', 'progresso');
        const diagFinal = await chamarAgent(servidor, 'GET', '/diagnostico/openssh');
        if (diagFinal.status === 'ok') {
          emit(`OpenSSH rodando — servico: ${diagFinal.servico || 'running'}`, 'sucesso');
        } else {
          emit(`OpenSSH instalado mas status: ${diagFinal.servico || 'desconhecido'}`, 'erro');
        }
        emitFim(true, result.descricao || 'OpenSSH instalado');
      } else {
        emit(`Falha: ${result.erro || 'erro desconhecido'}`, 'erro');

        // Tentar pegar log do agent para mais detalhes
        try {
          const agentLog = await chamarAgent(servidor, 'GET', '/log?lines=20');
          if (agentLog.linhas && agentLog.linhas.length) {
            emit('--- Log do Agent ---', 'info');
            agentLog.linhas.forEach(l => emit(l, 'info'));
          }
        } catch (_) {}

        emitFim(false, result.erro || 'Falha ao instalar OpenSSH');
      }
    } catch (err) {
      emit(`Erro: ${err.message}`, 'erro');
      emitFim(false, err.message);
    }
  })();

  req.on('close', () => {});
});

// ── Executar correcao via agent ──
app.post('/api/agent/:id/fix/:tipo', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  const tipo = req.params.tipo;
  const body = req.body || {};

  try {
    let result;
    switch (tipo) {
      case 'uac':
        result = await chamarAgent(servidor, 'POST', '/fix/uac');
        break;
      case 'firewall':
        result = await chamarAgent(servidor, 'POST', '/fix/firewall', { porta: body.porta || 22, nome: body.nome || 'OpenSSH Server (sshd)' });
        break;
      case 'firewall-remover':
        result = await chamarAgent(servidor, 'POST', '/fix/firewall/remover', { nome: body.nome });
        break;
      case 'openssh':
        result = await chamarAgent(servidor, 'POST', '/fix/openssh/instalar');
        break;
      case 'servico-iniciar':
        result = await chamarAgent(servidor, 'POST', '/fix/servico/iniciar', { nome: body.nome });
        break;
      case 'servico-parar':
        result = await chamarAgent(servidor, 'POST', '/fix/servico/parar', { nome: body.nome });
        break;
      case 'servico-auto':
        result = await chamarAgent(servidor, 'POST', '/fix/servico/auto', { nome: body.nome });
        break;
      case 'psql':
        result = await instalarPsqlRemoto(servidor);
        break;
      case 'tudo':
        result = await tentarCorrigirTudoViaAgent(servidor);
        break;
      default:
        return res.status(400).json({ erro: `Tipo de correcao desconhecido: ${tipo}` });
    }
    res.json(result);
  } catch (err) {
    res.json({ ok: false, erro: err.message });
  }
});

async function instalarPsqlRemoto(servidor, emit) {
  const log = emit || (() => {});
  let ssh;
  try {
    // 1. Criar ZIP se cache nao existe
    log('Preparando pacote psql...', 'progresso');
    const zipPath = await criarZipPsql();
    const zipSize = fs.statSync(zipPath).size;
    log(`Pacote pronto (${(zipSize / 1024 / 1024).toFixed(1)} MB)`, 'sucesso');

    // 2. Conectar SSH
    log(`Conectando via SSH em ${servidor.ip}...`, 'progresso');
    ssh = await conectarSSH(servidor);
    log('Conectado', 'sucesso');

    // 3. Criar diretorio remoto
    await ssh.execCommand(`mkdir "${PSQL_REMOTE_DIR}" 2>nul`);

    // 4. Upload ZIP via SFTP
    const remoteZip = `${PSQL_REMOTE_DIR}\\psql_client.zip`;
    log(`Enviando psql_client.zip via SFTP...`, 'progresso');
    await ssh.putFile(zipPath, remoteZip);
    log('ZIP enviado', 'sucesso');

    // 5. Extrair via PowerShell (com overwrite)
    log('Extraindo no servidor...', 'progresso');
    const extractCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${remoteZip}', '${PSQL_REMOTE_DIR}', $true)"`;
    // $true para overwrite requer .NET 4.7.2+ — usar fallback se falhar
    let extractResult = await ssh.execCommand(extractCmd);
    if (extractResult.code !== 0) {
      // Fallback: remover arquivos antigos e extrair sem overwrite
      log('Tentando extracao alternativa...', 'progresso');
      const fallbackCmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('${remoteZip}'); foreach ($e in $zip.Entries) { $dest = Join-Path '${PSQL_REMOTE_DIR}' $e.Name; if ($e.Name) { [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true) } }; $zip.Dispose()"`;
      extractResult = await ssh.execCommand(fallbackCmd);
      if (extractResult.code !== 0) {
        throw new Error('Falha ao extrair ZIP: ' + (extractResult.stderr || extractResult.stdout));
      }
    }
    log('Arquivos extraidos', 'sucesso');

    // 6. Limpar ZIP remoto
    await ssh.execCommand(`del "${remoteZip}" 2>nul`);

    // 7. Adicionar ao PATH do sistema
    // Primeiro verificar se ja esta no PATH
    log('Verificando PATH do sistema...', 'progresso');
    const pathCheck = await ssh.execCommand(`reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path`);
    const currentPath = (pathCheck.stdout || '').replace(/\r/g, '');
    const pathNorm = PSQL_REMOTE_DIR.toLowerCase();

    if (!currentPath.toLowerCase().includes(pathNorm)) {
      log(`Adicionando ${PSQL_REMOTE_DIR} ao PATH...`, 'progresso');
      // Tentar via agent se disponivel (roda como SYSTEM, mais confiavel)
      let pathAdded = false;
      try {
        const agentStatus = await verificarAgent(servidor);
        if (agentStatus.online) {
          const agentResult = await chamarAgent(servidor, 'POST', '/fix/psql/path', { caminho: PSQL_REMOTE_DIR });
          pathAdded = agentResult.ok;
          if (pathAdded) log('PATH atualizado via Agent', 'sucesso');
        }
      } catch (_) {}

      if (!pathAdded) {
        // Fallback: adicionar via reg add pelo SSH
        // Extrair valor atual do PATH
        const pathMatch = currentPath.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
        if (pathMatch) {
          let pathValue = pathMatch[1].trim();
          if (!pathValue.endsWith(';')) pathValue += ';';
          pathValue += PSQL_REMOTE_DIR;
          const regCmd = `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path /t REG_EXPAND_SZ /d "${pathValue}" /f`;
          const regResult = await ssh.execCommand(regCmd);
          if (regResult.code !== 0) {
            log(`Aviso: nao foi possivel adicionar ao PATH: ${regResult.stderr}`, 'erro');
            // Nao e erro fatal — psql pode ser usado com caminho completo
          } else {
            log('PATH atualizado via registro', 'sucesso');
          }
        }
      }

      // Broadcast WM_SETTINGCHANGE para processos pegarem o novo PATH
      await ssh.execCommand(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'Machine'), 'Machine')"`);
    } else {
      log('PATH ja contem psql', 'sucesso');
    }

    // 8. Validar instalacao (usar caminho completo pois PATH pode nao ter propagado)
    log('Validando instalacao...', 'progresso');
    const validateResult = await ssh.execCommand(`"${PSQL_REMOTE_DIR}\\psql.exe" --version 2>&1`);
    const versao = (validateResult.stdout || '').trim();

    // 9. Reiniciar Agent via NSSM para que pegue o novo PATH
    log('Reiniciando Agent para aplicar novo PATH...', 'progresso');
    await ssh.execCommand(`"${AGENT_REMOTE_DIR}\\nssm.exe" restart ${AGENT_SERVICE_NAME}`);
    await new Promise(r => setTimeout(r, 3000));
    try {
      const agentSt = await verificarAgent(servidor);
      if (agentSt.online) log('Agent reiniciado', 'sucesso');
      else log('Agent nao respondeu apos reinicio', 'erro');
    } catch (_) {
      log('Nao foi possivel verificar Agent apos reinicio', 'erro');
    }

    ssh.dispose();

    if (versao && versao.includes('psql')) {
      log(`psql instalado: ${versao}`, 'sucesso');
      return { ok: true, versao, descricao: `psql instalado em ${PSQL_REMOTE_DIR}: ${versao}` };
    }

    log(`Arquivos copiados para ${PSQL_REMOTE_DIR} (validacao pendente)`, 'sucesso');
    return { ok: true, descricao: `Arquivos copiados para ${PSQL_REMOTE_DIR} (validacao pendente)` };
  } catch (err) {
    if (ssh) ssh.dispose();
    log(`Erro: ${err.message}`, 'erro');
    return { ok: false, erro: err.message };
  }
}

async function tentarCorrigirTudoViaAgent(servidor) {
  const resultados = [];
  try {
    const diag = await chamarAgent(servidor, 'GET', '/diagnostico');
    if (diag.status === 'ok') return { ok: true, descricao: 'Nenhum problema encontrado', resultados: [] };

    if (diag.uac && diag.uac.status !== 'ok') {
      const r = await chamarAgent(servidor, 'POST', '/fix/uac');
      resultados.push({ tipo: 'UAC', ...r });
    }
    if (diag.openssh && !diag.openssh.instalado) {
      const r = await chamarAgent(servidor, 'POST', '/fix/openssh/instalar');
      resultados.push({ tipo: 'OpenSSH Instalar', ...r });
    } else if (diag.openssh && diag.openssh.servico !== 'running') {
      const r = await chamarAgent(servidor, 'POST', '/fix/servico/iniciar', { nome: 'sshd' });
      resultados.push({ tipo: 'OpenSSH Iniciar', ...r });
    }
    if (diag.firewall && diag.firewall.portas && diag.firewall.portas[22] && diag.firewall.portas[22].status !== 'ok') {
      const r = await chamarAgent(servidor, 'POST', '/fix/firewall', { porta: 22, nome: 'OpenSSH Server (sshd)' });
      resultados.push({ tipo: 'Firewall SSH', ...r });
    }

    return { ok: true, descricao: `${resultados.length} correcoes aplicadas`, resultados };
  } catch (err) {
    return { ok: false, erro: err.message, resultados };
  }
}

// ── Helper: instalar agent em servidor via SSH ──
async function instalarAgentNoServidor(ssh, servidor, servidores, idx, log) {
  const l = log || (() => {});
  const nssm = `"${AGENT_REMOTE_DIR}\\nssm.exe"`;

  // 1. Criar diretorio
  l('Criando diretorio remoto...', 'progresso');
  await ssh.execCommand(`mkdir "${AGENT_REMOTE_DIR}" 2>nul`);

  // 2. Parar e remover servico antigo (se existir)
  l('Removendo servico antigo (se existir)...', 'progresso');
  await ssh.execCommand(`${nssm} stop ${AGENT_SERVICE_NAME} 2>nul`);
  await ssh.execCommand(`${nssm} remove ${AGENT_SERVICE_NAME} confirm 2>nul`);
  await ssh.execCommand(`schtasks /delete /tn "FDeploy Agent" /f 2>nul`);
  await ssh.execCommand(`taskkill /f /im fdeploy-agent.exe 2>nul`);

  // 3. Gerar token
  const token = crypto.randomBytes(32).toString('hex');

  // 4. Upload config.json
  l('Enviando config.json...', 'progresso');
  const configJson = JSON.stringify({ port: servidor.agentPort || AGENT_DEFAULT_PORT, token }, null, 2);
  const configTmp = path.join(UPLOADS_DIR, `_agent_config_${Date.now()}.json`);
  fs.writeFileSync(configTmp, configJson, 'utf8');
  await ssh.putFile(configTmp, `${AGENT_REMOTE_DIR}\\config.json`);
  try { fs.unlinkSync(configTmp); } catch (_) {}

  // 5. Upload agent.exe (compactado) + nssm.exe
  l('Compactando fdeploy-agent.exe...', 'progresso');
  const agentGzLocal = path.join(UPLOADS_DIR, '_agent_install.gz');
  const agentGzRemote = `${AGENT_REMOTE_DIR}\\fdeploy-agent.exe.gz`;
  const agentExeRemote = `${AGENT_REMOTE_DIR}\\fdeploy-agent.exe`;
  const { compSize: agentCompSize } = await compactarArquivo(AGENT_EXE_PATH, agentGzLocal);
  l(`Enviando fdeploy-agent.exe.gz (${(agentCompSize / 1024 / 1024).toFixed(1)} MB) via SFTP...`, 'progresso');
  await ssh.putFile(agentGzLocal, agentGzRemote);
  try { fs.unlinkSync(agentGzLocal); } catch (_) {}
  l('Descompactando no servidor...', 'progresso');
  const decRes = await ssh.execCommand(PS_DECOMPRESS(agentGzRemote, agentExeRemote));
  if (decRes.stderr && !decRes.stdout.includes('OK')) {
    throw new Error(`Falha ao descompactar agent: ${decRes.stderr}`);
  }
  await ssh.execCommand(`del "${agentGzRemote}" 2>nul`);
  l('Enviando nssm.exe...', 'progresso');
  await ssh.putFile(AGENT_NSSM_PATH, `${AGENT_REMOTE_DIR}\\nssm.exe`);

  // 6. Instalar servico via NSSM
  l('Instalando servico via NSSM...', 'progresso');
  await ssh.execCommand(`${nssm} install ${AGENT_SERVICE_NAME} "${AGENT_REMOTE_DIR}\\fdeploy-agent.exe"`);
  await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} DisplayName "FDeploy Agent"`);
  await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} Description "FDeploy Agent - API de diagnostico e correcao remota"`);
  await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} AppDirectory "${AGENT_REMOTE_DIR}"`);
  await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} Start SERVICE_AUTO_START`);
  await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} AppExit Default Restart`);
  await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} AppRestartDelay 5000`);

  // 7. Abrir firewall
  const porta = servidor.agentPort || AGENT_DEFAULT_PORT;
  l(`Abrindo firewall porta ${porta}...`, 'progresso');
  await ssh.execCommand(`netsh advfirewall firewall delete rule name="FDeploy Agent" 2>nul`);
  await ssh.execCommand(`netsh advfirewall firewall add rule name="FDeploy Agent" dir=in action=allow protocol=TCP localport=${porta}`);

  // 8. Iniciar servico
  l('Iniciando servico FDeployAgent...', 'progresso');
  await ssh.execCommand(`${nssm} start ${AGENT_SERVICE_NAME}`);

  // 9. Salvar token encriptado
  servidores[idx].agentToken = encrypt(token);
  servidores[idx].agentPort = porta;
  servidores[idx].agentVersao = AGENT_EXPECTED_VERSION;
  salvarServidores(servidores);

  l('Agent instalado com sucesso', 'sucesso');
  return { token, porta };
}

// ── Instalar agent via SSH ──
app.post('/api/agent/:id/instalar', async (req, res) => {
  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Servidor nao encontrado' });
  const servidor = servidores[idx];

  if (!fs.existsSync(AGENT_EXE_PATH)) {
    return res.status(400).json({ erro: 'fdeploy-agent.exe nao encontrado em dist/. Execute o build primeiro.' });
  }

  let ssh;
  let firewallAberta = false;
  try {
    try {
      ssh = await conectarSSH(servidor);
    } catch (sshErr) {
      const instalou = await instalarSSHRemoto(servidor, () => {});
      if (instalou) {
        ssh = await conectarSSH(servidor);
        firewallAberta = true;
      } else {
        throw sshErr;
      }
    }
    await instalarAgentNoServidor(ssh, servidor, servidores, idx);
    if (firewallAberta) await removerFirewallSSH(ssh, () => {});
    ssh.dispose();

    // Aguardar agent iniciar e verificar
    await new Promise(r => setTimeout(r, 3000));
    const status = await verificarAgent(servidores[idx]);

    res.json({ ok: true, online: status.online, descricao: 'Agent instalado como servico' });
  } catch (err) {
    if (firewallAberta && ssh) {
      try { await removerFirewallSSH(ssh, () => {}); } catch (_) {}
    }
    if (ssh) ssh.dispose();
    res.json({ ok: false, erro: err.message });
  }
});

// ── Atualizar agent (funcao reutilizavel) ──
async function atualizarAgentInterno(servidor, servidores, idx, emit) {
  let ssh;
  let firewallAberta = false;
  try {
    const nssm = `"${AGENT_REMOTE_DIR}\\nssm.exe"`;
    let usouAgentHTTP = false;

    // Tentar SSH
    emit(`Conectando via SSH em ${servidor.ip}...`, 'progresso');
    try {
      ssh = await conectarSSH(servidor);
    } catch (sshErr) {
      emit(`Falha na conexao SSH: ${sshErr.message}`, 'erro');

      // Verificar Agent e versao do Windows para decidir caminho
      let windowsAntigo = false;
      const agentSt = await verificarAgent(servidor);
      if (agentSt.online) {
        try {
          const sysInfo = await chamarAgent(servidor, 'GET', '/diagnostico/sistema');
          const plat = sysInfo.plataforma || '';
          const verMatch = plat.match(/(\d+)\.\d+/);
          if (verMatch && parseInt(verMatch[1]) < 10) {
            windowsAntigo = true;
            emit(`Windows antigo detectado (${plat}) — DISM nao suportado`, 'info');
          }
        } catch (_) {}
      }

      if (windowsAntigo && agentSt.online) {
        emit(`Agent online (v${agentSt.version}) — atualizando via HTTP direto...`, 'sucesso');
        usouAgentHTTP = true;
      } else {
        emit('Tentando instalar OpenSSH via WMI/DCOM...', 'progresso');
        const instalou = await instalarSSHRemoto(servidor, emit);
        if (instalou) {
          emit('Tentando conectar via SSH novamente...', 'progresso');
          try {
            ssh = await conectarSSH(servidor);
            firewallAberta = true;
          } catch (sshErr2) {
            emit(`SSH falhou apos WMI: ${sshErr2.message}`, 'erro');
          }
        }

        if (!ssh) {
          if (agentSt.online) {
            emit(`Usando Agent HTTP como fallback (v${agentSt.version})...`, 'progresso');
            usouAgentHTTP = true;
          } else {
            throw new Error('SSH, WMI e Agent offline — impossivel atualizar');
          }
        }
      }
    }

    if (usouAgentHTTP) {
      const agentBin = fs.readFileSync(AGENT_EXE_PATH);
      const sizeMB = (agentBin.length / 1024 / 1024).toFixed(1);
      emit(`Enviando binario (${sizeMB} MB) via HTTP para Agent...`, 'progresso');
      const upResult = await chamarAgent(servidor, 'POST', '/update?autoRestart=1', agentBin, 5 * 60 * 1000);
      if (!upResult.ok) {
        throw new Error(`Agent rejeitou update: ${upResult.erro || 'erro desconhecido'}`);
      }
      emit('Binario salvo no servidor', 'sucesso');

      emit('Aguardando Agent reiniciar...', 'progresso');
      await new Promise(r => setTimeout(r, 10000));

      let atualizado = false;
      for (let i = 0; i < 4; i++) {
        try {
          const st = await verificarAgent(servidor);
          if (st.online && st.version === AGENT_EXPECTED_VERSION) {
            atualizado = true;
            break;
          }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 3000));
      }

      if (!atualizado) {
        emit('Agent nao reiniciou sozinho — trocando binario via WMI...', 'progresso');

        const ip = servidor.ip;
        const usuario = servidor.usuario;
        const senhaRaw = decrypt(servidor.senha);
        const senhaEscaped = senhaRaw.replace(/'/g, "''");

        const swapCmdLine = 'cmd.exe /c nssm.exe stop FDeployAgent & timeout /t 5 /nobreak >nul & taskkill /f /im fdeploy-agent.exe 2>nul & timeout /t 2 /nobreak >nul & del fdeploy-agent_old.exe 2>nul & ren fdeploy-agent.exe fdeploy-agent_old.exe & ren agent_new.exe fdeploy-agent.exe & nssm.exe start FDeployAgent';

        const wmiScript = `
try {
  $ErrorActionPreference = 'Stop'
  $secPass = ConvertTo-SecureString '${senhaEscaped}' -AsPlainText -Force
  $cred = New-Object System.Management.Automation.PSCredential('${usuario}', $secPass)
  $so = New-CimSessionOption -Protocol Dcom
  $session = New-CimSession -ComputerName '${ip}' -Credential $cred -SessionOption $so -OperationTimeoutSec 30
  $r = Invoke-CimMethod -CimSession $session -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${swapCmdLine}'; CurrentDirectory='${AGENT_REMOTE_DIR}'}
  if ($r.ReturnValue -eq 0) { Write-Host "SWAP_OK:PID=$($r.ProcessId)" } else { Write-Host "SWAP_ERRO:$($r.ReturnValue)" }
  Remove-CimSession $session
} catch {
  Write-Host "ERRO:$($_.Exception.Message)"
}`;
        const wmiResult = await executarPowerShell(wmiScript, 60000);
        const wmiOut = (wmiResult.stdout || '').trim();
        if (wmiOut.includes('SWAP_OK')) {
          emit('Troca de binario iniciada via WMI — aguardando reinicio...', 'sucesso');
        } else {
          emit(`WMI swap: ${wmiOut || wmiResult.stderr || 'falha'}`, 'erro');
        }
        await new Promise(r => setTimeout(r, 20000));
      }

      // Verificar versao final
      for (let i = 0; i < 6; i++) {
        try {
          const st = await verificarAgent(servidor);
          if (st.online && st.version === AGENT_EXPECTED_VERSION) {
            servidores[idx].agentVersao = st.version;
            salvarServidores(servidores);
            emit(`Agent online — v${st.version}`, 'sucesso');
            return { ok: true, descricao: 'Agent atualizado via HTTP e online' };
          }
          if (st.online) {
            emit(`Agent v${st.version} (esperada ${AGENT_EXPECTED_VERSION}) — aguardando...`, 'progresso');
          } else {
            emit('Agent reiniciando...', 'progresso');
          }
        } catch (_) {
          emit('Agent reiniciando...', 'progresso');
        }
        await new Promise(r => setTimeout(r, 5000));
      }
      emit('Agent nao confirmou a nova versao', 'erro');
      return { ok: false, descricao: 'Agent atualizado mas nao confirmou a nova versao — tente novamente' };
    }

    // Caminho 1/2: via SSH (direto ou apos WMI)
    emit('Conectado via SSH', 'sucesso');

    // 1. Parar servico
    emit('Parando servico FDeployAgent...', 'progresso');
    await ssh.execCommand(`${nssm} stop ${AGENT_SERVICE_NAME}`);
    await ssh.execCommand(`taskkill /f /im fdeploy-agent.exe 2>nul`);
    await new Promise(r => setTimeout(r, 2000));
    emit('Servico parado', 'sucesso');

    // 2. Compactar e enviar novo binario via SFTP
    emit('Compactando binario...', 'progresso');
    const tempGz = path.join(UPLOADS_DIR, '_agent_update.gz');
    const remoteGz = `${AGENT_REMOTE_DIR}\\fdeploy-agent.exe.gz`;
    const remoteExe = `${AGENT_REMOTE_DIR}\\fdeploy-agent.exe`;
    const { compSize } = await compactarArquivo(AGENT_EXE_PATH, tempGz);
    emit(`Enviando binario compactado (${(compSize / 1024 / 1024).toFixed(1)} MB)...`, 'progresso');
    await ssh.putFile(tempGz, remoteGz);
    try { fs.unlinkSync(tempGz); } catch (_) {}
    emit('Descompactando no servidor...', 'progresso');
    const decResult = await ssh.execCommand(PS_DECOMPRESS(remoteGz, remoteExe));
    if (decResult.stderr && !decResult.stdout.includes('OK')) {
      throw new Error(`Falha ao descompactar: ${decResult.stderr}`);
    }
    await ssh.execCommand(`del "${remoteGz}" 2>nul`);
    emit('Binario enviado e descompactado', 'sucesso');

    // 3. Iniciar servico
    emit('Iniciando servico FDeployAgent...', 'progresso');
    let startResult = await ssh.execCommand(`${nssm} start ${AGENT_SERVICE_NAME}`);
    if (startResult.stderr && startResult.stderr.includes('PAUSED')) {
      emit('Servico em PAUSED — reinstalando via NSSM...', 'progresso');
      await ssh.execCommand(`${nssm} remove ${AGENT_SERVICE_NAME} confirm`);
      await new Promise(r => setTimeout(r, 1000));
      await ssh.execCommand(`${nssm} install ${AGENT_SERVICE_NAME} "${AGENT_REMOTE_DIR}\\fdeploy-agent.exe"`);
      await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} DisplayName "FDeploy Agent"`);
      await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} AppDirectory "${AGENT_REMOTE_DIR}"`);
      await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} Start SERVICE_AUTO_START`);
      await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} AppExit Default Restart`);
      await ssh.execCommand(`${nssm} set ${AGENT_SERVICE_NAME} AppRestartDelay 5000`);
      await ssh.execCommand(`${nssm} start ${AGENT_SERVICE_NAME}`);
      emit('Servico reinstalado e iniciado', 'sucesso');
    } else {
      emit('Servico iniciado', 'sucesso');
    }
    if (firewallAberta) await removerFirewallSSH(ssh, emit);
    ssh.dispose();

    // 4. Verificar se voltou online
    emit('Aguardando Agent ficar online...', 'progresso');
    await new Promise(r => setTimeout(r, 3000));
    const status = await verificarAgent(servidor);

    if (status.online) {
      servidores[idx].agentVersao = status.version || AGENT_EXPECTED_VERSION;
      salvarServidores(servidores);
      emit(`Agent online — v${status.version || AGENT_EXPECTED_VERSION}`, 'sucesso');
      return { ok: true, descricao: 'Agent atualizado e online' };
    } else {
      emit('Agent nao respondeu ao ping', 'erro');
      return { ok: false, descricao: 'Agent atualizado mas offline — pode precisar reiniciar manualmente' };
    }
  } catch (err) {
    if (firewallAberta && ssh) {
      try { await removerFirewallSSH(ssh, emit); } catch (_) {}
    }
    if (ssh) ssh.dispose();
    emit(`Erro: ${err.message}`, 'erro');
    return { ok: false, descricao: err.message };
  }
}

app.get('/api/agent/:id/atualizar/stream', (req, res) => {
  req.setTimeout(5 * 60 * 1000);
  res.setTimeout(5 * 60 * 1000);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  function emit(msg, tipo) {
    try { res.write(`data: ${JSON.stringify({ evento: 'log', msg, tipo: tipo || 'info' })}\n\n`); } catch (_) {}
  }
  function emitFim(ok, descricao) {
    try { res.write(`data: ${JSON.stringify({ evento: 'concluido', ok, descricao })}\n\n`); } catch (_) {}
    res.end();
  }

  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === req.params.id);
  if (idx === -1) { emitFim(false, 'Servidor nao encontrado'); return; }
  const servidor = servidores[idx];

  if (!fs.existsSync(AGENT_EXE_PATH)) { emitFim(false, 'fdeploy-agent.exe nao encontrado em dist/'); return; }

  (async () => {
    const result = await atualizarAgentInterno(servidor, servidores, idx, emit);
    emitFim(result.ok, result.descricao);
  })();

  req.on('close', () => {});
});

// ── Atualizar todos os agents desatualizados ──
app.get('/api/agent/atualizar-todos/stream', (req, res) => {
  req.setTimeout(30 * 60 * 1000);
  res.setTimeout(30 * 60 * 1000);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

  function emit(msg, tipo) {
    try { res.write(`data: ${JSON.stringify({ evento: 'log', msg, tipo: tipo || 'info' })}\n\n`); } catch (_) {}
  }
  function emitEvento(evento, dados) {
    try { res.write(`data: ${JSON.stringify({ evento, ...dados })}\n\n`); } catch (_) {}
  }

  if (!fs.existsSync(AGENT_EXE_PATH)) {
    emitEvento('concluido', { ok: false, descricao: 'fdeploy-agent.exe nao encontrado em dist/' });
    res.end();
    return;
  }

  (async () => {
    try {
      const servidores = lerServidores();
      emit('Verificando status dos agents...', 'progresso');

      // Verificar todos em paralelo
      const statusList = await Promise.all(servidores.map(async (s) => {
        const st = await verificarAgent(s);
        return { servidor: s, status: st };
      }));

      // Filtrar: online + desatualizado
      const desatualizados = statusList.filter(({ status }) =>
        status.online && status.version && status.version !== AGENT_EXPECTED_VERSION
      );

      if (desatualizados.length === 0) {
        emit('Nenhum agent desatualizado encontrado', 'sucesso');
        emitEvento('concluido', { ok: true, descricao: 'Todos os agents ja estao atualizados', atualizados: 0, falhas: 0, total: 0 });
        res.end();
        return;
      }

      emit(`${desatualizados.length} agent(s) desatualizado(s) encontrado(s)`, 'info');
      let atualizados = 0;
      let falhas = 0;

      for (let i = 0; i < desatualizados.length; i++) {
        const { servidor } = desatualizados[i];
        const servidoresAtual = lerServidores();
        const idx = servidoresAtual.findIndex(s => s.id === servidor.id);
        if (idx === -1) continue;

        emitEvento('agent_iniciando', { id: servidor.id, nome: servidor.nome, indice: i + 1, total: desatualizados.length });
        emit(`\n━━━ [${i + 1}/${desatualizados.length}] ${servidor.nome} (${servidor.ip}) ━━━`, 'info');

        const prefixEmit = (msg, tipo) => emit(`[${servidor.nome}] ${msg}`, tipo);
        const result = await atualizarAgentInterno(servidoresAtual[idx], servidoresAtual, idx, prefixEmit);

        emitEvento('agent_concluido', { id: servidor.id, ok: result.ok, descricao: result.descricao });

        if (result.ok) {
          atualizados++;
          emit(`[${servidor.nome}] Concluido com sucesso`, 'sucesso');
        } else {
          falhas++;
          emit(`[${servidor.nome}] Falha: ${result.descricao}`, 'erro');
        }
      }

      emit(`\n━━━ Resultado: ${atualizados} atualizado(s), ${falhas} falha(s) ━━━`, atualizados > 0 ? 'sucesso' : 'info');
      emitEvento('concluido', { ok: falhas === 0, descricao: `${atualizados} atualizado(s), ${falhas} falha(s)`, atualizados, falhas, total: desatualizados.length });
      res.end();
    } catch (err) {
      emit(`Erro geral: ${err.message}`, 'erro');
      emitEvento('concluido', { ok: false, descricao: err.message });
      res.end();
    }
  })();

  req.on('close', () => {});
});

// ── Log do agent ──
app.get('/api/agent/:id/log', async (req, res) => {
  const servidores = lerServidores();
  const servidor = servidores.find(s => s.id === req.params.id);
  if (!servidor) return res.status(404).json({ erro: 'Servidor nao encontrado' });

  try {
    const lines = req.query.lines || 50;
    const result = await chamarAgent(servidor, 'GET', `/log?lines=${lines}`);
    res.json(result);
  } catch (err) {
    res.json({ erro: err.message });
  }
});

// ── Gerar script de instalacao manual ──
app.post('/api/agent/gerar-script/:id', (req, res) => {
  const servidores = lerServidores();
  const idx = servidores.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Servidor nao encontrado' });
  const servidor = servidores[idx];

  const token = crypto.randomBytes(32).toString('hex');
  const porta = servidor.agentPort || AGENT_DEFAULT_PORT;

  // Salvar token
  servidores[idx].agentToken = encrypt(token);
  servidores[idx].agentPort = porta;
  salvarServidores(servidores);

  const script = `@echo off
echo === FDeploy Agent - Instalacao Manual ===
echo.

set AGENT_DIR=${AGENT_REMOTE_DIR}
set AGENT_PORT=${porta}
set AGENT_TOKEN=${token}
set NSSM=%AGENT_DIR%\\nssm.exe
set SVC=${AGENT_SERVICE_NAME}

:: Criar diretorio
if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"

:: Copiar arquivos (devem estar na mesma pasta deste .bat)
copy /Y "%~dp0fdeploy-agent.exe" "%AGENT_DIR%\\fdeploy-agent.exe"
copy /Y "%~dp0nssm.exe" "%AGENT_DIR%\\nssm.exe"

:: Criar config.json
echo {"port":%AGENT_PORT%,"token":"%AGENT_TOKEN%"} > "%AGENT_DIR%\\config.json"

:: Remover servico/tarefa antiga
"%NSSM%" stop %SVC% 2>nul
"%NSSM%" remove %SVC% confirm 2>nul
schtasks /delete /tn "FDeploy Agent" /f 2>nul
taskkill /f /im fdeploy-agent.exe 2>nul

:: Instalar servico via NSSM
"%NSSM%" install %SVC% "%AGENT_DIR%\\fdeploy-agent.exe"
"%NSSM%" set %SVC% DisplayName "FDeploy Agent"
"%NSSM%" set %SVC% Description "FDeploy Agent - API de diagnostico e correcao remota"
"%NSSM%" set %SVC% AppDirectory "%AGENT_DIR%"
"%NSSM%" set %SVC% Start SERVICE_AUTO_START
"%NSSM%" set %SVC% AppExit Default Restart
"%NSSM%" set %SVC% AppRestartDelay 5000

:: Abrir firewall
netsh advfirewall firewall delete rule name="FDeploy Agent" 2>nul
netsh advfirewall firewall add rule name="FDeploy Agent" dir=in action=allow protocol=TCP localport=%AGENT_PORT%

:: Iniciar servico
"%NSSM%" start %SVC%

echo.
echo Agent instalado como servico na porta %AGENT_PORT%.
echo Token: %AGENT_TOKEN%
pause
`;

  res.json({ ok: true, script, token });
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

  const versaoAtiva = lerVersaoGeral();
  if (!versaoAtiva) {
    res.write(`data: ${JSON.stringify({ evento: 'erro', msg: 'Nenhuma versao selecionada. Crie ou selecione uma versao antes de atualizar.' })}\n\n`);
    res.end();
    return;
  }

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

      // Validar Agent de TODOS os membros antes de iniciar (replicacao requer todos)
      const validacoes = await Promise.all(membros.map(async s => ({ id: s.id, nome: s.nome, validacao: await validarAgentParaDeploy(s) })));
      const membroComProblema = validacoes.find(v => !v.validacao.ok);
      if (membroComProblema) {
        // Bloquear grupo inteiro se algum membro falhar
        for (const s of membros) {
          if (!deployedIds.has(s.id)) {
            deployedIds.add(s.id);
            emit(s.id, { evento: 'deploy_bloqueado_agent', motivo: `Grupo bloqueado: ${membroComProblema.nome} — ${membroComProblema.validacao.motivo}`, codigo: membroComProblema.validacao.codigo });
            resultados.push({ servidorId: s.id, sucesso: false, bloqueadoPorAgent: true, motivo: membroComProblema.validacao.motivo });
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

      // Validar Agent antes do deploy
      const validacao = await validarAgentParaDeploy(s);
      if (!validacao.ok) {
        emit(s.id, { evento: 'deploy_bloqueado_agent', motivo: validacao.motivo, codigo: validacao.codigo });
        resultados.push({ servidorId: s.id, sucesso: false, bloqueadoPorAgent: true, motivo: validacao.motivo });
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

  const versaoAtiva = lerVersaoGeral();
  if (!versaoAtiva) {
    res.write(`data: ${JSON.stringify({ evento: 'erro', msg: 'Nenhuma versao selecionada. Crie ou selecione uma versao antes de atualizar.' })}\n\n`);
    res.end();
    return;
  }

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
    const psqlBin = await resolverPsqlRemoto(ssh);
    if (!psqlBin) { ssh.dispose(); return res.json({ temReplicacao: false }); }

    const pgPass = decrypt(servidor.pgSenha);
    const pgUser = servidor.pgUsuario || 'frigo';
    const pgDb = servidor.pgBanco;
    const pgPort = servidor.pgPorta || 5432;
    const pgHost = servidor.pgHost || '127.0.0.1';

    const cmd = `set "PGPASSWORD=${pgPass}"&& ${psqlBin} -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} -t -A -c "SELECT replica FROM sl.licencas LIMIT 1" 2>&1`;
    const result = await ssh.execCommand(cmd);
    ssh.dispose();

    const output = (result.stdout || '').trim();
    // Detectar erro na consulta
    if (!output || output.includes('ERROR') || output.includes('does not exist') || output.includes('FATAL') || output.includes('connection refused')) {
      return res.json({ erro: `Falha ao consultar sl.licencas: ${output || 'sem resposta'}` });
    }
    // replica = 'S' tem replicacao, 'N' nao tem
    return res.json({ temReplicacao: output.toUpperCase() === 'S' });
  } catch (err) {
    if (ssh) ssh.dispose();
    return res.json({ erro: `Erro ao verificar replicacao: ${err.message}` });
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
    const psqlBin = await resolverPsqlRemoto(ssh);
    if (!psqlBin) { ssh.dispose(); return res.json({ versaoBD: null, erro: 'psql nao encontrado no servidor' }); }

    const pgPass = decrypt(servidor.pgSenha);
    const pgUser = servidor.pgUsuario || 'frigo';
    const pgDb = servidor.pgBanco;
    const pgPort = servidor.pgPorta || 5432;
    const pgHost = servidor.pgHost || '127.0.0.1';

    const cmd = `set "PGPASSWORD=${pgPass}"&& ${psqlBin} -U ${pgUser} -d ${pgDb} -p ${pgPort} -h ${pgHost} -t -A -c "SELECT versao_bd FROM re.servidor"`;
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
  if (process.pkg) {
    const url = `http://localhost:${PORT}`;
    const chromePaths = [
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const chrome = chromePaths.find(p => fs.existsSync(p));
    if (chrome) {
      exec(`"${chrome}" "${url}"`);
    } else {
      exec(`start ${url}`);
    }
  }
});
