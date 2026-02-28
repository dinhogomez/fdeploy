/**
 * FDeploy Agent - API Auxiliar para servidores remotos
 * HTTP server leve usando apenas modulos nativos do Node.js
 * Porta padrao: 3501 | Auth: Bearer token | Zero dependencias externas
 */

const http = require('http');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ── Caminhos ──
const APP_ROOT = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(APP_ROOT, 'config.json');
const LOG_PATH = path.join(APP_ROOT, 'agent.log');
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0';
  } catch (_) { return '0.0.0'; }
})();
const DEFAULT_PORT = 3501;
const MAX_LOG_SIZE = 1 * 1024 * 1024; // 1MB

// ── Config ──
let config = { port: DEFAULT_PORT, token: '' };
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    log('ERRO', `Falha ao ler config.json: ${e.message}`);
  }
}

const PORT = config.port || DEFAULT_PORT;
const TOKEN = config.token || '';

// ── Logging rotativo ──
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    if (fs.existsSync(LOG_PATH)) {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size > MAX_LOG_SIZE) {
        // Manter ultima metade do log
        const content = fs.readFileSync(LOG_PATH, 'utf8');
        const lines = content.split('\n');
        fs.writeFileSync(LOG_PATH, lines.slice(Math.floor(lines.length / 2)).join('\n'), 'utf8');
      }
    }
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {}
  console.log(`[${level}] ${msg}`);
}

// ── Helpers ──
function execCmd(cmd, timeout = 30000) {
  log('DEBUG', `execCmd: ${cmd.substring(0, 200)}`);
  try {
    const result = execSync(cmd, { timeout, encoding: 'utf8', windowsHide: true });
    log('DEBUG', `execCmd OK: ${result.trim().substring(0, 300)}`);
    return { ok: true, output: result.trim() };
  } catch (e) {
    const out = (e.stdout || '').trim();
    const err = (e.stderr || e.message || '').trim();
    log('DEBUG', `execCmd FALHA: stdout=${out.substring(0, 200)} stderr=${err.substring(0, 200)}`);
    return { ok: false, output: out, error: err };
  }
}

function execPowerShell(script, timeout = 30000) {
  log('DEBUG', `execPowerShell: ${script.substring(0, 200)}`);
  const cmd = `powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`;
  return execCmd(cmd, timeout);
}

function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX_BODY = 50 * 1024 * 1024; // 50MB para self-update
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body excede limite'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      // Se Content-Type indica binario, retorna Buffer
      const ct = req.headers['content-type'] || '';
      if (ct.includes('octet-stream')) {
        resolve(raw);
        return;
      }
      try {
        resolve(JSON.parse(raw.toString('utf8')));
      } catch (_) {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

// Validacao de nome de servico (prevenir injecao de comando)
function validarNomeServico(nome) {
  if (!nome || typeof nome !== 'string') return false;
  return /^[\w.\-\s]{1,80}$/.test(nome);
}

// Validacao de porta
function validarPorta(porta) {
  const n = parseInt(porta, 10);
  return !isNaN(n) && n >= 1 && n <= 65535;
}

// Validacao de nome de regra firewall
function validarNomeRegra(nome) {
  if (!nome || typeof nome !== 'string') return false;
  return /^[\w.\-\s]{1,100}$/.test(nome);
}

// ══════════════════════════════════════════
// DIAGNOSTICOS
// ══════════════════════════════════════════

function diagnosticoUAC() {
  log('INFO', 'Diagnostico UAC iniciado');
  const result = execCmd('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v LocalAccountTokenFilterPolicy');
  if (result.ok && result.output.includes('0x1')) {
    log('INFO', 'Diagnostico UAC: OK (liberado)');
    return { status: 'ok', liberado: true, descricao: 'LocalAccountTokenFilterPolicy = 1 (liberado)' };
  }
  log('INFO', 'Diagnostico UAC: PROBLEMA (bloqueado ou nao definido)');
  return { status: 'problema', liberado: false, descricao: 'LocalAccountTokenFilterPolicy nao definido ou = 0 (bloqueado)' };
}

function diagnosticoFirewall() {
  log('INFO', 'Diagnostico Firewall iniciado');
  const portas = [22, 135, 3501];
  const resultados = {};
  for (const porta of portas) {
    // Tentar netsh primeiro (mais rapido e nao exige elevacao)
    const netsh = execCmd(`netsh advfirewall firewall show rule name=all dir=in | findstr /C:"LocalPort" | findstr /C:"${porta}"`);
    if (netsh.ok && netsh.output.includes(String(porta))) {
      resultados[porta] = { status: 'ok', regra: 'Encontrada via netsh' };
      log('INFO', `Firewall porta ${porta}: encontrada via netsh`);
    } else {
      // Fallback: PowerShell Get-NetFirewallPortFilter (precisa elevacao)
      const ps = `Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -eq ${porta} } | Get-NetFirewallRule | Select-Object -First 1 DisplayName, Enabled, Action | ConvertTo-Json`;
      const result = execPowerShell(ps, 15000);
      if (result.ok && result.output) {
        try {
          const info = JSON.parse(result.output);
          resultados[porta] = {
            regra: info.DisplayName || 'Encontrada',
            habilitada: info.Enabled === 1 || info.Enabled === true || info.Enabled === 'True',
            acao: info.Action === 2 || info.Action === 'Allow' ? 'Allow' : 'Block',
            status: (info.Enabled === 1 || info.Enabled === true || info.Enabled === 'True') &&
                    (info.Action === 2 || info.Action === 'Allow') ? 'ok' : 'problema'
          };
          log('INFO', `Firewall porta ${porta}: regra="${info.DisplayName}" enabled=${info.Enabled} action=${info.Action}`);
        } catch (parseErr) {
          resultados[porta] = { status: 'ok', regra: 'Encontrada (parse parcial)' };
          log('WARN', `Firewall porta ${porta}: parse parcial — ${result.output.substring(0, 100)}`);
        }
      } else {
        resultados[porta] = { status: 'ausente', regra: null };
        log('INFO', `Firewall porta ${porta}: AUSENTE`);
      }
    }
  }
  const todasOk = Object.values(resultados).every(r => r.status === 'ok');
  log('INFO', `Diagnostico Firewall concluido: ${todasOk ? 'OK' : 'PROBLEMA'}`);
  return { status: todasOk ? 'ok' : 'problema', portas: resultados };
}

function diagnosticoOpenSSH() {
  log('INFO', 'Diagnostico OpenSSH iniciado');
  // Verificar se sshd existe
  const scQuery = execCmd('sc query sshd');
  if (!scQuery.ok || scQuery.output.includes('1060')) {
    log('INFO', 'Diagnostico OpenSSH: AUSENTE (servico nao encontrado)');
    return { status: 'ausente', instalado: false, servico: null, startType: null };
  }
  // Servico existe — verificar estado
  const running = scQuery.output.includes('RUNNING');
  const stopped = scQuery.output.includes('STOPPED');

  // Verificar tipo de inicio
  const scQc = execCmd('sc qc sshd');
  let startType = 'desconhecido';
  if (scQc.ok) {
    if (scQc.output.includes('AUTO_START')) startType = 'automatico';
    else if (scQc.output.includes('DEMAND_START')) startType = 'manual';
    else if (scQc.output.includes('DISABLED')) startType = 'desabilitado';
  }

  let status = 'ok';
  if (!running) status = 'problema';
  if (startType === 'desabilitado') status = 'problema';

  const estado = running ? 'running' : (stopped ? 'stopped' : 'outro');
  log('INFO', `Diagnostico OpenSSH: instalado=true servico=${estado} startType=${startType} status=${status}`);

  return {
    status,
    instalado: true,
    servico: estado,
    startType,
  };
}

function diagnosticoServicos() {
  log('INFO', 'Diagnostico Servicos iniciado');
  const servicos = {};
  const nomes = ['Fvendas2.0', 'sshd'];

  // Adicionar Apache (detectar qual nome)
  const apacheNomes = ['Apache2.4', 'Apache2.2', 'httpd', 'apache2', 'Apache'];
  let apacheEncontrado = null;
  for (const nome of apacheNomes) {
    const result = execCmd(`sc query "${nome}"`);
    if (result.ok && !result.output.includes('1060')) {
      apacheEncontrado = nome;
      log('INFO', `Apache detectado: ${nome}`);
      break;
    }
  }
  if (!apacheEncontrado) {
    // Tentar PowerShell
    const ps = execPowerShell("Get-Service | Where-Object { $_.Name -match 'apache|httpd' } | Select-Object -First 1 Name | ForEach-Object { $_.Name }");
    if (ps.ok && ps.output) {
      apacheEncontrado = ps.output.trim();
      log('INFO', `Apache detectado via PowerShell: ${apacheEncontrado}`);
    } else {
      log('INFO', 'Apache nao detectado');
    }
  }
  if (apacheEncontrado) nomes.push(apacheEncontrado);

  for (const nome of nomes) {
    const result = execCmd(`sc query "${nome}"`);
    if (!result.ok || result.output.includes('1060')) {
      servicos[nome] = { status: 'ausente', estado: null };
      log('INFO', `Servico "${nome}": ausente`);
      continue;
    }
    const running = result.output.includes('RUNNING');
    const stopped = result.output.includes('STOPPED');
    const estado = running ? 'running' : (stopped ? 'stopped' : 'outro');
    servicos[nome] = {
      status: running ? 'ok' : 'problema',
      estado,
    };
    log('INFO', `Servico "${nome}": ${estado}`);
  }

  log('INFO', `Diagnostico Servicos concluido: ${Object.keys(servicos).length} verificados`);
  return { status: 'ok', servicos, apacheDetectado: apacheEncontrado };
}

function diagnosticoSistema() {
  log('INFO', 'Diagnostico Sistema iniciado');
  const info = {
    hostname: os.hostname(),
    plataforma: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptime: Math.floor(os.uptime()),
  };

  // Disco C:
  const diskResult = execPowerShell("Get-PSDrive C | Select-Object Used, Free | ConvertTo-Json");
  if (diskResult.ok && diskResult.output) {
    try {
      const disk = JSON.parse(diskResult.output);
      const usedGB = (disk.Used / 1073741824).toFixed(1);
      const freeGB = (disk.Free / 1073741824).toFixed(1);
      const totalGB = ((disk.Used + disk.Free) / 1073741824).toFixed(1);
      info.disco = { usadoGB: usedGB, livreGB: freeGB, totalGB, percentual: ((disk.Used / (disk.Used + disk.Free)) * 100).toFixed(0) };
      info.disco.status = parseFloat(freeGB) < 2 ? 'problema' : 'ok';
    } catch (_) {
      info.disco = { status: 'erro', descricao: 'Nao foi possivel obter info de disco' };
    }
  }

  // Memoria
  const memResult = execPowerShell("Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json");
  if (memResult.ok && memResult.output) {
    try {
      const mem = JSON.parse(memResult.output);
      const totalMB = (mem.TotalVisibleMemorySize / 1024).toFixed(0);
      const freeMB = (mem.FreePhysicalMemory / 1024).toFixed(0);
      const usedMB = totalMB - freeMB;
      info.memoria = { totalMB, livreMB: freeMB, usadoMB: usedMB, percentual: ((usedMB / totalMB) * 100).toFixed(0) };
      info.memoria.status = parseInt(freeMB) < 512 ? 'problema' : 'ok';
    } catch (_) {
      info.memoria = { status: 'erro', descricao: 'Nao foi possivel obter info de memoria' };
    }
  }

  return { status: 'ok', ...info };
}

function diagnosticoPsql() {
  log('INFO', 'Diagnostico psql iniciado');

  // 1. Verificar se psql esta no PATH
  const where = execCmd('where psql 2>nul');
  if (!where.ok || !where.output) {
    // 2. Tentar caminhos comuns do PostgreSQL
    const caminhos = [
      'C:\\f\\pgsql\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\14\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\13\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\12\\bin\\psql.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\17\\bin\\psql.exe',
      'C:\\Program Files (x86)\\PostgreSQL\\16\\bin\\psql.exe',
    ];
    let encontrado = null;
    for (const c of caminhos) {
      try {
        if (fs.existsSync(c)) { encontrado = c; break; }
      } catch (_) {}
    }
    if (encontrado) {
      log('INFO', `psql encontrado fora do PATH: ${encontrado}`);
      // Testar versao
      const ver = execCmd(`"${encontrado}" --version`);
      return {
        status: 'aviso',
        instalado: true,
        noPath: false,
        caminho: encontrado,
        versao: ver.ok ? ver.output.trim() : null,
        descricao: `psql encontrado em ${encontrado} mas NAO esta no PATH`
      };
    }
    log('INFO', 'psql NAO encontrado');
    return { status: 'problema', instalado: false, noPath: false, caminho: null, versao: null, descricao: 'psql nao encontrado no servidor' };
  }

  // psql esta no PATH
  const caminho = where.output.split('\n')[0].trim();
  const ver = execCmd('psql --version');
  log('INFO', `psql encontrado: ${caminho}`);
  return {
    status: 'ok',
    instalado: true,
    noPath: true,
    caminho,
    versao: ver.ok ? ver.output.trim() : null,
    descricao: `psql disponivel: ${ver.ok ? ver.output.trim() : caminho}`
  };
}

function diagnosticoCompleto() {
  log('INFO', '========== DIAGNOSTICO COMPLETO INICIADO ==========');
  const inicio = Date.now();
  const uac = diagnosticoUAC();
  const firewall = diagnosticoFirewall();
  const openssh = diagnosticoOpenSSH();
  const psql = diagnosticoPsql();
  const servicos = diagnosticoServicos();
  const sistema = diagnosticoSistema();

  const problemas = [];
  if (uac.status !== 'ok') problemas.push('UAC');
  if (firewall.status !== 'ok') problemas.push('Firewall');
  if (openssh.status !== 'ok') problemas.push('OpenSSH');
  if (psql.status === 'problema') problemas.push('psql');

  const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
  log('INFO', `========== DIAGNOSTICO COMPLETO CONCLUIDO em ${duracao}s — ${problemas.length === 0 ? 'TUDO OK' : 'PROBLEMAS: ' + problemas.join(', ')} ==========`);

  return {
    status: problemas.length === 0 ? 'ok' : 'problema',
    problemas,
    uac,
    firewall,
    openssh,
    psql,
    servicos,
    sistema,
    timestamp: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════
// CORRECOES (FIX)
// ══════════════════════════════════════════

function fixUAC() {
  log('INFO', '>>> FIX UAC: Definindo LocalAccountTokenFilterPolicy = 1');
  const result = execCmd('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f');
  if (result.ok) {
    log('INFO', 'UAC: LocalAccountTokenFilterPolicy definido para 1');
    return { ok: true, descricao: 'LocalAccountTokenFilterPolicy definido para 1' };
  }
  log('ERRO', `UAC fix falhou: ${result.error}`);
  return { ok: false, erro: result.error };
}

function fixUACRevert() {
  log('INFO', '>>> FIX UAC REVERT: Definindo LocalAccountTokenFilterPolicy = 0');
  const result = execCmd('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 0 /f');
  if (result.ok) {
    log('INFO', 'UAC: LocalAccountTokenFilterPolicy revertido para 0');
    return { ok: true, descricao: 'LocalAccountTokenFilterPolicy revertido para 0 (bloqueado)' };
  }
  log('ERRO', `UAC revert falhou: ${result.error}`);
  return { ok: false, erro: result.error };
}

function fixFirewall(porta, nome) {
  log('INFO', `>>> FIX FIREWALL: Criando regra "${nome}" porta ${porta}`);
  if (!validarPorta(porta)) { log('ERRO', `Porta invalida: ${porta}`); return { ok: false, erro: 'Porta invalida' }; }
  if (!validarNomeRegra(nome)) { log('ERRO', `Nome de regra invalido: ${nome}`); return { ok: false, erro: 'Nome de regra invalido' }; }

  const cmd = `netsh advfirewall firewall add rule name="${nome}" dir=in action=allow protocol=TCP localport=${porta}`;
  const result = execCmd(cmd);
  if (result.ok) {
    log('INFO', `Firewall: Regra "${nome}" criada para porta ${porta}`);
    return { ok: true, descricao: `Regra "${nome}" criada para porta ${porta}` };
  }
  log('ERRO', `Firewall fix falhou: ${result.error}`);
  return { ok: false, erro: result.error || result.output };
}

function fixFirewallRemover(nome) {
  log('INFO', `>>> FIX FIREWALL REMOVER: Removendo regra "${nome}"`);
  if (!validarNomeRegra(nome)) { log('ERRO', `Nome de regra invalido: ${nome}`); return { ok: false, erro: 'Nome de regra invalido' }; }

  const cmd = `netsh advfirewall firewall delete rule name="${nome}"`;
  const result = execCmd(cmd);
  if (result.ok) {
    log('INFO', `Firewall: Regra "${nome}" removida`);
    return { ok: true, descricao: `Regra "${nome}" removida` };
  }
  log('ERRO', `Firewall remover falhou: ${result.error}`);
  return { ok: false, erro: result.error || result.output };
}

function fixOpenSSHInstalar() {
  log('INFO', '>>> FIX OPENSSH: Iniciando instalacao do OpenSSH...');

  // Verificar se ja instalado
  const check = execCmd('sc query sshd');
  if (check.ok && !check.output.includes('1060')) {
    return { ok: true, descricao: 'OpenSSH ja esta instalado' };
  }

  // Metodo 1: DISM (Windows 10+ / Server 2016+)
  log('INFO', 'Tentando instalar via DISM...');
  const result = execCmd('dism /Online /Add-Capability /CapabilityName:OpenSSH.Server~~~~0.0.1.0', 120000);
  if (result.ok) {
    return finalizarOpenSSH();
  }
  log('INFO', `DISM nao disponivel: ${(result.error || '').substring(0, 100)}`);

  // Metodo 2: PowerShell Add-WindowsCapability (Windows 10+ / Server 2016+)
  log('INFO', 'Tentando via PowerShell Add-WindowsCapability...');
  const psResult = execPowerShell('Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0', 120000);
  if (psResult.ok) {
    return finalizarOpenSSH();
  }
  log('INFO', `Add-WindowsCapability nao disponivel: ${(psResult.error || '').substring(0, 100)}`);

  // Metodo 3: Download manual do Win32-OpenSSH (Windows antigo / Server 2012 R2)
  log('INFO', 'Tentando download manual do Win32-OpenSSH do GitHub...');
  return instalarOpenSSHManual();
}

function instalarOpenSSHManual() {
  const sshDir = 'C:\\Program Files\\OpenSSH-Win64';
  const zipPath = 'C:\\temp\\OpenSSH-Win64.zip';

  // Criar diretorio temp
  execCmd('mkdir C:\\temp 2>nul');

  // Download via PowerShell WebClient (funciona no PS 2.0+)
  log('INFO', 'Baixando OpenSSH-Win64.zip...');
  const dlScript = [
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    `(New-Object Net.WebClient).DownloadFile('https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip', '${zipPath}')`
  ].join('; ');

  const dl = execPowerShell(dlScript, 180000);
  if (!dl.ok) {
    log('ERRO', `Download OpenSSH falhou: ${dl.error}`);
    return { ok: false, erro: `Download do OpenSSH falhou (sem internet?): ${(dl.error || '').substring(0, 200)}` };
  }
  log('INFO', 'Download concluido');

  // Remover diretorio antigo se existir
  execPowerShell(`if (Test-Path '${sshDir}') { Remove-Item -Path '${sshDir}' -Recurse -Force }`);

  // Extrair ZIP (System.IO.Compression disponivel no .NET 4.5+ = Server 2012 R2)
  log('INFO', 'Extraindo ZIP...');
  const extractScript = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', 'C:\\Program Files')`
  ].join('; ');

  const ext = execPowerShell(extractScript, 60000);
  if (!ext.ok) {
    log('ERRO', `Extracao OpenSSH falhou: ${ext.error}`);
    return { ok: false, erro: `Extracao falhou: ${(ext.error || '').substring(0, 200)}` };
  }
  log('INFO', 'Extracao concluida');

  // Executar install-sshd.ps1
  log('INFO', 'Executando install-sshd.ps1...');
  const install = execPowerShell(`& '${sshDir}\\install-sshd.ps1'`, 60000);
  if (!install.ok) {
    log('ERRO', `install-sshd.ps1 falhou: ${install.error}`);
    return { ok: false, erro: `install-sshd.ps1 falhou: ${(install.error || '').substring(0, 200)}` };
  }
  log('INFO', `install-sshd.ps1: ${install.output || 'OK'}`);

  // Gerar chaves do host se nao existirem
  const keygen = path.join(sshDir, 'ssh-keygen.exe');
  const hostkeyDir = path.join(sshDir);
  if (!fs.existsSync(path.join(hostkeyDir, 'ssh_host_ed25519_key'))) {
    log('INFO', 'Gerando chaves do host...');
    execCmd(`"${keygen}" -A`, 30000);
  }

  // Ajustar permissoes das chaves (necessario no Win32-OpenSSH manual)
  log('INFO', 'Ajustando permissoes...');
  const fixPermsScript = `
    $sshDir = '${sshDir.replace(/\\/g, '\\\\')}';
    $acl = Get-Acl "$sshDir\\ssh_host_ed25519_key" -ErrorAction SilentlyContinue;
    if ($acl) {
      $acl.SetAccessRuleProtection($true, $false);
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','Allow');
      $acl.AddAccessRule($rule);
      $rule2 = New-Object System.Security.AccessControl.FileSystemAccessRule('Administrators','FullControl','Allow');
      $acl.AddAccessRule($rule2);
      Set-Acl "$sshDir\\ssh_host_ed25519_key" $acl -ErrorAction SilentlyContinue;
      Set-Acl "$sshDir\\ssh_host_rsa_key" $acl -ErrorAction SilentlyContinue
    }
  `.replace(/\n/g, ' ').trim();
  execPowerShell(fixPermsScript, 15000);

  // Adicionar ao PATH do sistema
  log('INFO', 'Adicionando ao PATH...');
  const pathScript = [
    `$p = [Environment]::GetEnvironmentVariable('Path','Machine')`,
    `if ($p -notlike '*${sshDir}*') { [Environment]::SetEnvironmentVariable('Path', $p + ';${sshDir}', 'Machine') }`
  ].join('; ');
  execPowerShell(pathScript, 15000);

  // Limpar ZIP
  execCmd(`del "${zipPath}" 2>nul`);

  return finalizarOpenSSH();
}

function finalizarOpenSSH() {
  // Iniciar e definir como automatico
  execCmd('sc config sshd start= auto');
  const startResult = execCmd('net start sshd');
  if (startResult.ok) {
    log('INFO', 'Servico sshd iniciado');
  } else {
    log('INFO', `net start sshd: ${startResult.error || startResult.output || 'sem output'}`);
  }

  // Abrir firewall
  fixFirewall(22, 'OpenSSH Server (sshd)');

  log('INFO', 'OpenSSH instalado e iniciado com sucesso');
  return { ok: true, descricao: 'OpenSSH instalado, iniciado e firewall configurado' };
}

function fixServicoIniciar(nome) {
  log('INFO', `>>> FIX SERVICO INICIAR: "${nome}"`);
  if (!validarNomeServico(nome)) { log('ERRO', `Nome de servico invalido: ${nome}`); return { ok: false, erro: 'Nome de servico invalido' }; }
  const result = execCmd(`net start "${nome}"`);
  if (result.ok || (result.output && result.output.includes('already been started'))) {
    log('INFO', `Servico "${nome}" iniciado`);
    return { ok: true, descricao: `Servico "${nome}" iniciado` };
  }
  log('ERRO', `Falha ao iniciar "${nome}": ${result.error || result.output}`);
  return { ok: false, erro: result.error || result.output };
}

function fixServicoParar(nome) {
  log('INFO', `>>> FIX SERVICO PARAR: "${nome}"`);
  if (!validarNomeServico(nome)) { log('ERRO', `Nome de servico invalido: ${nome}`); return { ok: false, erro: 'Nome de servico invalido' }; }
  const result = execCmd(`net stop "${nome}"`);
  if (result.ok || (result.output && (result.output.includes('not been started') || result.output.includes('is not started')))) {
    log('INFO', `Servico "${nome}" parado`);
    return { ok: true, descricao: `Servico "${nome}" parado` };
  }
  log('ERRO', `Falha ao parar "${nome}": ${result.error || result.output}`);
  return { ok: false, erro: result.error || result.output };
}

function fixServicoAuto(nome) {
  log('INFO', `>>> FIX SERVICO AUTO: "${nome}"`);
  if (!validarNomeServico(nome)) { log('ERRO', `Nome de servico invalido: ${nome}`); return { ok: false, erro: 'Nome de servico invalido' }; }
  const result = execCmd(`sc config "${nome}" start= auto`);
  if (result.ok) {
    log('INFO', `Servico "${nome}" configurado para inicio automatico`);
    return { ok: true, descricao: `Servico "${nome}" definido como automatico` };
  }
  log('ERRO', `Falha ao configurar "${nome}": ${result.error || result.output}`);
  return { ok: false, erro: result.error || result.output };
}

function fixPsqlPath(caminho) {
  const dir = caminho || 'C:\\f\\pgsql';
  log('INFO', `>>> FIX PSQL PATH: Adicionando "${dir}" ao PATH do sistema`);

  // Verificar se psql.exe existe no caminho
  const psqlExe = path.join(dir, 'psql.exe');
  try {
    if (!fs.existsSync(psqlExe)) {
      log('ERRO', `psql.exe nao encontrado em ${dir}`);
      return { ok: false, erro: `psql.exe nao encontrado em ${dir}` };
    }
  } catch (e) {
    log('ERRO', `Erro ao verificar ${psqlExe}: ${e.message}`);
    return { ok: false, erro: e.message };
  }

  // Ler PATH atual do registry
  const regResult = execCmd('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path');
  if (!regResult.ok) {
    log('ERRO', `Nao foi possivel ler PATH do registry: ${regResult.error}`);
    return { ok: false, erro: 'Nao foi possivel ler PATH do registry' };
  }

  const pathMatch = regResult.output.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
  if (!pathMatch) {
    log('ERRO', 'Nao foi possivel extrair valor do PATH');
    return { ok: false, erro: 'Nao foi possivel extrair valor do PATH' };
  }

  let currentPath = pathMatch[1].trim();
  const dirLower = dir.toLowerCase();

  // Verificar se ja esta no PATH
  const pathParts = currentPath.split(';').map(p => p.trim().toLowerCase());
  if (pathParts.includes(dirLower) || pathParts.includes(dirLower + '\\')) {
    log('INFO', `"${dir}" ja esta no PATH`);
    return { ok: true, descricao: `"${dir}" ja esta no PATH` };
  }

  // Adicionar ao PATH
  if (!currentPath.endsWith(';')) currentPath += ';';
  currentPath += dir;

  const addResult = execCmd(`reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path /t REG_EXPAND_SZ /d "${currentPath}" /f`);
  if (!addResult.ok) {
    log('ERRO', `Falha ao adicionar ao PATH: ${addResult.error}`);
    return { ok: false, erro: addResult.error };
  }

  log('INFO', `"${dir}" adicionado ao PATH do sistema`);
  return { ok: true, descricao: `"${dir}" adicionado ao PATH do sistema` };
}

// ══════════════════════════════════════════
// SELF-UPDATE
// ══════════════════════════════════════════

function selfUpdate(binaryBuffer, autoRestart) {
  log('INFO', `>>> SELF-UPDATE: Recebido binario de ${(binaryBuffer.length / 1024 / 1024).toFixed(1)} MB (autoRestart=${!!autoRestart})`);
  const currentExe = process.execPath;
  const newExe = path.join(APP_ROOT, 'agent_new.exe');
  const oldExe = path.join(APP_ROOT, 'agent_old.exe');

  try {
    fs.writeFileSync(newExe, binaryBuffer);
    log('INFO', 'Self-update: binario salvo como agent_new.exe');

    if (autoRestart) {
      // Trocar binarios e sair — NSSM reinicia automaticamente
      log('INFO', 'Self-update: trocando binarios e reiniciando via NSSM...');
      try { fs.unlinkSync(oldExe); } catch (_) {}
      try { fs.renameSync(currentExe, oldExe); } catch (_) {}
      fs.renameSync(newExe, currentExe);
      log('INFO', 'Self-update: binarios trocados, saindo para NSSM reiniciar...');
      setTimeout(() => process.exit(0), 500);
      return { ok: true, descricao: 'Binario trocado, reiniciando via NSSM...' };
    }

    return { ok: true, descricao: 'Binario salvo, aguardando restart externo' };
  } catch (e) {
    log('ERRO', `Self-update falhou: ${e.message}`);
    return { ok: false, erro: e.message };
  }
}

// ══════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════

function matchRoute(method, url) {
  const [pathname, search] = url.split('?');
  const params = new URLSearchParams(search || '');
  const p = pathname.replace(/\/+$/, '') || '/';

  const routes = [
    { method: 'GET',  path: '/ping',                handler: handlePing,              auth: false },
    { method: 'GET',  path: '/diagnostico',          handler: handleDiagnosticoCompleto, auth: true },
    { method: 'GET',  path: '/diagnostico/uac',      handler: handleDiagUAC,           auth: true },
    { method: 'GET',  path: '/diagnostico/firewall',  handler: handleDiagFirewall,      auth: true },
    { method: 'GET',  path: '/diagnostico/openssh',   handler: handleDiagOpenSSH,       auth: true },
    { method: 'GET',  path: '/diagnostico/psql',       handler: handleDiagPsql,          auth: true },
    { method: 'GET',  path: '/diagnostico/servicos',  handler: handleDiagServicos,      auth: true },
    { method: 'GET',  path: '/diagnostico/sistema',   handler: handleDiagSistema,       auth: true },
    { method: 'POST', path: '/fix/uac',              handler: handleFixUAC,            auth: true },
    { method: 'POST', path: '/fix/uac/revert',      handler: handleFixUACRevert,      auth: true },
    { method: 'POST', path: '/fix/firewall',          handler: handleFixFirewall,       auth: true },
    { method: 'POST', path: '/fix/firewall/remover',  handler: handleFixFirewallRemover, auth: true },
    { method: 'POST', path: '/fix/openssh/instalar',  handler: handleFixOpenSSH,        auth: true },
    { method: 'POST', path: '/fix/servico/iniciar',   handler: handleFixServicoIniciar, auth: true },
    { method: 'POST', path: '/fix/servico/parar',     handler: handleFixServicoParar,   auth: true },
    { method: 'POST', path: '/fix/servico/auto',      handler: handleFixServicoAuto,    auth: true },
    { method: 'POST', path: '/fix/psql/path',        handler: handleFixPsqlPath,       auth: true },
    { method: 'POST', path: '/update',               handler: handleUpdate,            auth: true },
    { method: 'GET',  path: '/config',               handler: handleConfig,            auth: true },
    { method: 'GET',  path: '/log',                  handler: handleLog,               auth: true },
  ];

  for (const route of routes) {
    if (route.method === method && route.path === p) {
      return { ...route, params };
    }
  }
  return null;
}

function checkAuth(req) {
  if (!TOKEN) return true; // Sem token configurado = sem auth
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match && match[1] === TOKEN;
}

// ── Handlers ──

function handlePing(req, res) {
  jsonResponse(res, 200, {
    ok: true,
    version: VERSION,
    hostname: os.hostname(),
    uptime: Math.floor(os.uptime()),
  });
}

async function handleDiagnosticoCompleto(req, res) {
  const result = diagnosticoCompleto();
  jsonResponse(res, 200, result);
}

function handleDiagUAC(req, res) { jsonResponse(res, 200, diagnosticoUAC()); }
function handleDiagFirewall(req, res) { jsonResponse(res, 200, diagnosticoFirewall()); }
function handleDiagOpenSSH(req, res) { jsonResponse(res, 200, diagnosticoOpenSSH()); }
function handleDiagPsql(req, res) { jsonResponse(res, 200, diagnosticoPsql()); }
function handleDiagServicos(req, res) { jsonResponse(res, 200, diagnosticoServicos()); }
function handleDiagSistema(req, res) { jsonResponse(res, 200, diagnosticoSistema()); }

async function handleFixUAC(req, res) { jsonResponse(res, 200, fixUAC()); }
async function handleFixUACRevert(req, res) { jsonResponse(res, 200, fixUACRevert()); }

async function handleFixFirewall(req, res, params, body) {
  if (!body || !body.porta || !body.nome) {
    return jsonResponse(res, 400, { ok: false, erro: 'Campos obrigatorios: porta, nome' });
  }
  jsonResponse(res, 200, fixFirewall(body.porta, body.nome));
}

async function handleFixFirewallRemover(req, res, params, body) {
  if (!body || !body.nome) {
    return jsonResponse(res, 400, { ok: false, erro: 'Campo obrigatorio: nome' });
  }
  jsonResponse(res, 200, fixFirewallRemover(body.nome));
}

async function handleFixOpenSSH(req, res) {
  jsonResponse(res, 200, fixOpenSSHInstalar());
}

async function handleFixServicoIniciar(req, res, params, body) {
  if (!body || !body.nome) {
    return jsonResponse(res, 400, { ok: false, erro: 'Campo obrigatorio: nome' });
  }
  jsonResponse(res, 200, fixServicoIniciar(body.nome));
}

async function handleFixServicoParar(req, res, params, body) {
  if (!body || !body.nome) {
    return jsonResponse(res, 400, { ok: false, erro: 'Campo obrigatorio: nome' });
  }
  jsonResponse(res, 200, fixServicoParar(body.nome));
}

async function handleFixServicoAuto(req, res, params, body) {
  if (!body || !body.nome) {
    return jsonResponse(res, 400, { ok: false, erro: 'Campo obrigatorio: nome' });
  }
  jsonResponse(res, 200, fixServicoAuto(body.nome));
}

async function handleFixPsqlPath(req, res, params, body) {
  jsonResponse(res, 200, fixPsqlPath(body && body.caminho));
}

async function handleUpdate(req, res, params, body) {
  if (!Buffer.isBuffer(body) || body.length < 1000) {
    return jsonResponse(res, 400, { ok: false, erro: 'Binario invalido ou muito pequeno' });
  }
  const autoRestart = params.get('autoRestart') === '1';
  jsonResponse(res, 200, selfUpdate(body, autoRestart));
}

function handleConfig(req, res) {
  jsonResponse(res, 200, {
    version: VERSION,
    port: PORT,
    hostname: os.hostname(),
    logPath: LOG_PATH,
    configPath: CONFIG_PATH,
    tokenConfigurado: !!TOKEN,
  });
}

function handleLog(req, res, params) {
  const lines = parseInt(params.get('lines')) || 50;
  try {
    if (!fs.existsSync(LOG_PATH)) {
      return jsonResponse(res, 200, { linhas: [] });
    }
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const allLines = content.split('\n').filter(l => l.trim());
    const lastLines = allLines.slice(-lines);
    jsonResponse(res, 200, { linhas: lastLines });
  } catch (e) {
    jsonResponse(res, 500, { erro: e.message });
  }
}

// ══════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  const route = matchRoute(req.method, req.url);
  if (!route) {
    return jsonResponse(res, 404, { erro: 'Rota nao encontrada' });
  }

  // Auth
  if (route.auth && !checkAuth(req)) {
    log('WARN', `Acesso negado: ${req.method} ${req.url} de ${req.socket.remoteAddress}`);
    return jsonResponse(res, 401, { erro: 'Token invalido ou ausente' });
  }

  try {
    let body = null;
    if (req.method === 'POST') {
      body = await parseBody(req);
    }
    log('INFO', `${req.method} ${req.url} de ${req.socket.remoteAddress}`);
    await route.handler(req, res, route.params, body);
  } catch (err) {
    log('ERRO', `Erro em ${req.method} ${req.url}: ${err.message}`);
    jsonResponse(res, 500, { erro: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('ERRO', `Porta ${PORT} ja em uso. Outra instancia do agent pode estar rodando.`);
    console.error(`ERRO: Porta ${PORT} ja esta em uso. Encerrando.`);
    process.exit(1);
  }
  log('ERRO', `Erro no servidor: ${err.message}`);
});

// ── Tratamento de erros globais ──
process.on('uncaughtException', (err) => {
  log('ERRO', `Excecao nao tratada: ${err.message}`);
  log('ERRO', `Stack: ${err.stack}`);
  console.error(`ERRO FATAL: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log('ERRO', `Promise rejeitada: ${reason}`);
});

// Shutdown graceful (NSSM envia SIGINT via Ctrl+C)
function shutdown() {
  log('INFO', 'Recebido sinal de shutdown, encerrando...');
  server.close(() => {
    log('INFO', 'Servidor encerrado');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Manter processo vivo
process.stdin.resume();

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', `FDeploy Agent v${VERSION} rodando na porta ${PORT}`);
  console.log(`FDeploy Agent v${VERSION} rodando em http://0.0.0.0:${PORT}`);
});
