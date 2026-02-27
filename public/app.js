// ── Operador ──
let nomeOperador = '';

// ── Estado local ──
const serverStatus = {}; // { id: { status, versao, log[], transferProgress } }
let arquivoPendente = null; // File selecionado aguardando confirmacao
let versaoAtiva = null; // Versao ativa atual (Fvendas)
let deployTodosEmAndamento = false; // Protecao contra duplo clique

// ── Estado Servidor Geral ──
const geralStatus = {}; // { id: { etapa, log[], transferProgress, deploying, aguardando, logCollapsed, deploySuccess } }
let versaoGeralAtiva = null;
let deployGeralTodosEmAndamento = false; // Protecao contra duplo clique
let todosServidoresGeral = [];

// ── Estado Scripts SQL ──
let scriptsIndexInfo = null;
let scriptsModalData = null; // { scripts: [], serverName: '', autoCloseTimer: null }

// ══════════════════════════════════════════
// NAVEGACAO
// ══════════════════════════════════════════
function navegarPara(tela) {
  var screens = ['operadorScreen', 'homeScreen', 'fvendasScreen', 'geralScreen'];
  for (var i = 0; i < screens.length; i++) {
    document.getElementById(screens[i]).style.display = 'none';
  }

  if (tela === 'home') {
    document.getElementById('homeScreen').style.display = 'block';
  } else if (tela === 'fvendas') {
    document.getElementById('fvendasScreen').style.display = 'block';
    verificarExe();
    carregarServidores();
    carregarHistorico();
    setupDropZone();
  } else if (tela === 'geral') {
    document.getElementById('geralScreen').style.display = 'block';
    verificarGeralStatus();
    verificarScriptsStatus();
    carregarServidoresGeral();
    carregarHistoricoGeral();
  }
}

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  const ultimo = localStorage.getItem('fdeploy_operador') || '';
  document.getElementById('inputOperador').value = ultimo;
  document.getElementById('inputOperador').focus();
});

function confirmarOperador() {
  const nome = document.getElementById('inputOperador').value.trim();
  if (!nome) {
    alert('Informe seu nome para continuar');
    return;
  }
  nomeOperador = nome;
  localStorage.setItem('fdeploy_operador', nome);
  navegarPara('home');
}

// ══════════════════════════════════════════
// UPLOAD (Fvendas)
// ══════════════════════════════════════════
let dropZoneSetup = false;
function setupDropZone() {
  if (dropZoneSetup) return;
  dropZoneSetup = true;

  const dz = document.getElementById('dropZone');
  const fi = document.getElementById('fileInput');

  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer.files.length) selecionarArquivo(e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', () => { if (fi.files.length) selecionarArquivo(fi.files[0]); });
}

function selecionarArquivo(file) {
  arquivoPendente = file;
  const confirm = document.getElementById('uploadConfirm');
  const fileName = document.getElementById('uploadFileName');
  const dropZone = document.getElementById('dropZone');
  fileName.textContent = file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' MB)';
  confirm.style.display = 'block';
  dropZone.style.display = 'none';
}

function cancelarUpload() {
  arquivoPendente = null;
  document.getElementById('uploadConfirm').style.display = 'none';
  document.getElementById('dropZone').style.display = '';
  document.getElementById('inputVersao').value = '';
  document.getElementById('inputDescricao').value = '';
  document.getElementById('fileInput').value = '';
}

function confirmarUpload() {
  const versao = document.getElementById('inputVersao').value.trim();
  if (!versao) {
    alert('Informe a versao antes de enviar');
    return;
  }
  if (!arquivoPendente) return;
  const descricao = document.getElementById('inputDescricao').value.trim();
  uploadFile(arquivoPendente, versao, descricao);
  document.getElementById('uploadConfirm').style.display = 'none';
  document.getElementById('dropZone').style.display = '';
  document.getElementById('inputVersao').value = '';
  document.getElementById('inputDescricao').value = '';
}

function uploadFile(file, versao, descricao) {
  const form = new FormData();
  form.append('arquivo', file);

  const pb = document.getElementById('progressBar');
  const pf = document.getElementById('progressFill');
  pb.style.display = 'block';
  pf.style.width = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');

  xhr.upload.onprogress = e => {
    if (e.lengthComputable) pf.style.width = Math.round((e.loaded / e.total) * 100) + '%';
  };
  xhr.timeout = 10 * 60 * 1000;
  xhr.onload = () => {
    if (xhr.status === 200) {
      pf.style.width = '100%';
      setTimeout(() => { pb.style.display = 'none'; }, 1000);
      arquivoPendente = null;
      if (versao) {
        const body = { versao };
        if (descricao) body.descricao = descricao;
        fetch('/api/versao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(() => verificarExe());
      } else {
        verificarExe();
      }
    } else {
      pb.style.display = 'none';
      try {
        const data = JSON.parse(xhr.responseText);
        alert('Erro no upload: ' + (data.erro || xhr.statusText));
      } catch (_) {
        alert('Erro no upload: ' + xhr.statusText);
      }
    }
  };
  xhr.onerror = () => { alert('Erro de conexao no upload'); pb.style.display = 'none'; };
  xhr.ontimeout = () => { alert('Upload excedeu o tempo limite (10 min)'); pb.style.display = 'none'; };
  xhr.send(form);
}

async function verificarExe() {
  const res = await fetch('/api/upload/status');
  const data = await res.json();
  const badge = document.getElementById('exeBadge');
  const info = document.getElementById('uploadInfo');
  const selector = document.getElementById('versaoSelector');
  const select = document.getElementById('selectVersao');

  versaoAtiva = data.versao || null;

  if (data.disponivel) {
    const versaoLabel = data.versao ? ` v${data.versao}` : '';
    badge.className = 'badge badge-ok';
    if (data.arquivo) {
      badge.textContent = `${data.arquivo}${versaoLabel} (${data.tamanho_mb} MB)`;
      info.style.display = 'block';
      const dt = new Date(data.modificado_em).toLocaleString('pt-BR');
      info.innerHTML = `<strong>${data.arquivo}</strong>${versaoLabel} &mdash; ${data.tamanho_mb} MB &mdash; ${dt}`;
    } else {
      badge.textContent = `v${data.versao} (cache)`;
      info.style.display = 'none';
    }
  } else {
    badge.className = 'badge badge-no';
    badge.textContent = 'Nenhum .exe';
    info.style.display = 'none';
  }

  // Popular select de versoes
  const versoes = data.versoes || [];
  const descricoes = data.descricoes || {};
  if (versoes.length > 0) {
    select.innerHTML = versoes.map(v => {
      const desc = descricoes[v] ? ` - ${descricoes[v]}` : '';
      const ativa = v === data.versao ? ' (ativa)' : '';
      return `<option value="${v}" ${v === data.versao ? 'selected' : ''}>${v}${desc}${ativa}</option>`;
    }).join('');
    selector.style.display = 'flex';
  } else {
    selector.style.display = 'none';
  }
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

async function selecionarVersaoExistente() {
  const select = document.getElementById('selectVersao');
  const versao = select.value;
  if (!versao) return;

  try {
    const res = await fetch('/api/versao/selecionar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versao }),
    });
    const data = await res.json();
    if (data.ok) {
      verificarExe();
      carregarServidores();
    } else {
      alert('Erro ao selecionar versao: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    alert('Erro de conexao: ' + err.message);
  }
}

// ══════════════════════════════════════════
// SERVIDORES (Fvendas)
// ══════════════════════════════════════════
let todosServidores = [];

async function carregarServidores() {
  const res = await fetch('/api/servidores');
  todosServidores = await res.json();
  filtrarServidores();
}

function filtrarServidores() {
  const busca = (document.getElementById('buscarServidor')?.value || '').toLowerCase().trim();
  if (!busca) {
    renderServidores(todosServidores);
  } else {
    renderServidores(todosServidores.filter(s =>
      s.nome.toLowerCase().includes(busca) || s.ip.toLowerCase().includes(busca)
    ));
  }
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function renderServidores(lista) {
  const el = document.getElementById('serverList');
  if (lista.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:14px;">Nenhum servidor cadastrado.</p>';
    return;
  }
  el.innerHTML = lista.map(s => {
    const st = serverStatus[s.id] || {};
    const statusClass = st.status === 'rodando' ? 'status-running' : st.status === 'parado' ? 'status-stopped' : 'status-unknown';
    const statusText = st.status || 'Nao verificado';
    const versao = st.versao || s.versaoDeployada || '—';
    const deploying = st.deploying || false;
    const aguardando = st.aguardando || false;

    // Badge de atualizado/desatualizado
    const versaoServidor = st.versao || s.versaoDeployada;
    let versaoBadge = '';
    if (versaoAtiva && versaoServidor) {
      const cmp = compararVersoes(versaoServidor, versaoAtiva);
      if (cmp >= 0) {
        versaoBadge = '<span class="badge badge-atualizado">atualizado</span>';
      } else {
        versaoBadge = '<span class="badge badge-desatualizado">desatualizado</span>';
      }
    }

    // Log
    const logEntries = st.log || [];
    const logHtml = logEntries.map(l =>
      `<div class="log-${l.tipo}">[${l.ts}] ${l.msg}</div>`
    ).join('');
    const hasLog = logEntries.length > 0;
    const collapsed = st.logCollapsed === true;

    // Resumo colapsado
    let logSectionHtml = '';
    if (hasLog && collapsed) {
      const lastResult = st.deploySuccess !== undefined
        ? (st.deploySuccess ? 'Sucesso' : 'Erro')
        : 'Concluido';
      const resultClass = st.deploySuccess === true ? 'log-sucesso' : st.deploySuccess === false ? 'log-erro' : 'log-info';
      logSectionHtml = `
        <div class="log-summary">
          <span class="${resultClass}">Deploy concluido &mdash; ${lastResult}</span>
          <a class="log-toggle" onclick="toggleLog('${s.id}')">Ver log</a>
        </div>`;
    } else if (hasLog) {
      logSectionHtml = `
        ${!deploying ? `<div class="log-summary"><a class="log-toggle" onclick="toggleLog('${s.id}')">Ocultar log</a></div>` : ''}
        <div class="deploy-log visible" id="log-${s.id}">${logHtml}</div>`;
    }

    // Progress de transferencia
    const tp = st.transferProgress;
    let progressHtml = '';
    if (tp) {
      progressHtml = `
        <div class="transfer-progress" id="tp-${s.id}">
          <div class="transfer-info">
            <span>Enviando arquivo...</span>
            <span>${tp.percentual}% &mdash; ${formatMB(tp.transferido)} / ${formatMB(tp.total)} MB</span>
          </div>
          <div class="transfer-bar">
            <div class="transfer-fill" style="width:${tp.percentual}%"></div>
          </div>
        </div>`;
    }

    return `
      <div class="server-card" id="card-${s.id}">
        <div class="server-header">
          <div>
            <div class="server-name">${esc(s.nome)}</div>
            ${s.descricao ? `<div class="server-desc">${esc(s.descricao)}</div>` : ''}
          </div>
        </div>
        <div class="server-meta">
          <span>${esc(s.ip)}:${s.porta}</span>
          <span><span class="status-dot ${statusClass}"></span> ${statusText}</span>
          <span>v${versao}</span>
          ${versaoBadge}
        </div>
        <div class="server-actions">
          <button class="btn btn-ghost btn-sm" onclick="testarServidor('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Testar</button>
          ${st.status === 'parado'
            ? `<button class="btn btn-success btn-sm" onclick="iniciarServico('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Iniciar Servico</button>`
            : ''}
          ${st.status === 'rodando'
            ? `<button class="btn btn-danger btn-sm" onclick="pararServico('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Parar Servico</button>`
            : ''}
          <button class="btn btn-success btn-sm" onclick="deployServidor('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>
            ${deploying ? '<span class="spinner"></span> Deploying...' : aguardando ? 'Aguardando...' : 'Deploy'}
          </button>
          <button class="btn btn-ghost btn-sm" onclick="editarServidor('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Editar</button>
          <button class="btn btn-danger btn-sm" onclick="removerServidor('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Remover</button>
        </div>
        ${progressHtml}
        ${logSectionHtml}
      </div>
    `;
  }).join('');

  lista.forEach(s => {
    const logEl = document.getElementById(`log-${s.id}`);
    if (logEl && logEl.classList.contains('visible')) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  });
}

// ── Atualizar apenas o log e progress sem recriar tudo ──
function atualizarCardDeploy(id) {
  const st = serverStatus[id] || {};
  const cardEl = document.getElementById(`card-${id}`);

  let logEl = document.getElementById(`log-${id}`);
  if (!logEl && st.log && st.log.length > 0 && cardEl) {
    logEl = document.createElement('div');
    logEl.className = 'deploy-log visible';
    logEl.id = `log-${id}`;
    cardEl.appendChild(logEl);
  }
  if (logEl) {
    const logHtml = (st.log || []).map(l =>
      `<div class="log-${l.tipo}">[${l.ts}] ${l.msg}</div>`
    ).join('');
    logEl.innerHTML = logHtml;
    if (st.log && st.log.length > 0) {
      logEl.classList.add('visible');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  const tp = st.transferProgress;
  let tpEl = document.getElementById(`tp-${id}`);

  if (tp) {
    if (!tpEl) {
      tpEl = document.createElement('div');
      tpEl.className = 'transfer-progress';
      tpEl.id = `tp-${id}`;
      const logContainer = document.getElementById(`log-${id}`);
      if (logContainer) logContainer.parentNode.insertBefore(tpEl, logContainer);
    }
    tpEl.innerHTML = `
      <div class="transfer-info">
        <span>Enviando arquivo...</span>
        <span>${tp.percentual}% &mdash; ${formatMB(tp.transferido)} / ${formatMB(tp.total)} MB</span>
      </div>
      <div class="transfer-bar">
        <div class="transfer-fill" style="width:${tp.percentual}%"></div>
      </div>`;
  } else if (tpEl) {
    tpEl.remove();
  }
}

async function iniciarServico(id) {
  serverStatus[id] = { ...serverStatus[id], status: 'iniciando...' };
  carregarServidores();

  try {
    const res = await fetch(`/api/servico/${id}/iniciar`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      serverStatus[id] = { ...serverStatus[id], status: data.status };
    } else {
      serverStatus[id] = { ...serverStatus[id], status: 'parado' };
      alert('Falha ao iniciar servico:\n' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    serverStatus[id] = { ...serverStatus[id], status: 'erro' };
    alert('Erro de conexao: ' + err.message);
  }
  carregarServidores();
}

async function pararServico(id) {
  if (!confirm('Parar o servico neste servidor?')) return;

  serverStatus[id] = { ...serverStatus[id], status: 'parando...' };
  carregarServidores();

  try {
    const res = await fetch(`/api/servico/${id}/parar`, { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      serverStatus[id] = { ...serverStatus[id], status: data.status };
    } else {
      serverStatus[id] = { ...serverStatus[id], status: 'rodando' };
      alert('Falha ao parar servico:\n' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    serverStatus[id] = { ...serverStatus[id], status: 'erro' };
    alert('Erro de conexao: ' + err.message);
  }
  carregarServidores();
}

function testarServidor(id) {
  serverStatus[id] = { ...serverStatus[id], status: 'verificando...', deploying: true, log: [], logCollapsed: false };
  carregarServidores();

  const evtSource = new EventSource(`/api/testar/${id}/stream`);

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.evento === 'log') {
        if (!serverStatus[id].log) serverStatus[id].log = [];
        serverStatus[id].log.push({ ts: data.ts, msg: data.msg, tipo: data.tipo });
        atualizarCardDeploy(id);
      }

      else if (data.evento === 'resultado') {
        evtSource.close();
        if (data.conectou) {
          serverStatus[id] = {
            ...serverStatus[id],
            status: data.servico_status,
            versao: data.versao_atual,
            deploying: false,
            logCollapsed: true,
          };
        } else {
          serverStatus[id] = {
            ...serverStatus[id],
            status: 'erro',
            deploying: false,
            logCollapsed: false,
          };
        }
        carregarServidores();
      }
    } catch (_) {}
  };

  evtSource.onerror = () => {
    evtSource.close();
    serverStatus[id].deploying = false;
    if (!serverStatus[id].log) serverStatus[id].log = [];
    serverStatus[id].log.push({ ts: now(), msg: 'Conexao perdida', tipo: 'erro' });
    carregarServidores();
  };
}

function deployServidor(id) {
  if (!versaoAtiva) {
    alert('Nenhuma versao selecionada.\n\nCrie ou selecione uma versao antes de atualizar.');
    return;
  }
  // Proteger contra cliques multiplos
  if (serverStatus[id]?.deploying || serverStatus[id]?.aguardando) return;
  if (!confirm('Iniciar deploy neste servidor?')) return;

  serverStatus[id] = {
    ...serverStatus[id],
    deploying: true,
    log: [],
    transferProgress: null,
  };
  carregarServidores();

  const evtSource = new EventSource(`/api/deploy/${id}/stream`);

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.evento === 'log') {
        if (!serverStatus[id].log) serverStatus[id].log = [];
        serverStatus[id].log.push({ ts: data.ts, msg: data.msg, tipo: data.tipo });
        atualizarCardDeploy(id);
      }

      else if (data.evento === 'transferencia_inicio') {
        serverStatus[id].transferProgress = { transferido: 0, total: data.total, percentual: 0 };
        atualizarCardDeploy(id);
      }

      else if (data.evento === 'transferencia_progresso') {
        serverStatus[id].transferProgress = {
          transferido: data.transferido,
          total: data.total,
          percentual: data.percentual,
        };
        atualizarCardDeploy(id);
      }

      else if (data.evento === 'transferencia_fim') {
        serverStatus[id].transferProgress = null;
        atualizarCardDeploy(id);
      }

      else if (data.evento === 'concluido') {
        evtSource.close();
        serverStatus[id] = {
          status: data.sucesso ? 'rodando' : 'erro',
          versao: serverStatus[id]?.versao,
          log: data.log || serverStatus[id].log,
          transferProgress: null,
          deploying: false,
        };
        carregarServidores();
        carregarHistorico();
      }

      else if (data.evento === 'erro') {
        evtSource.close();
        if (!serverStatus[id].log) serverStatus[id].log = [];
        serverStatus[id].log.push({ ts: now(), msg: data.msg, tipo: 'erro' });
        serverStatus[id].deploying = false;
        serverStatus[id].transferProgress = null;
        carregarServidores();
      }
    } catch (_) {}
  };

  evtSource.onerror = () => {
    evtSource.close();
    if (serverStatus[id]?.deploying) {
      serverStatus[id].deploying = false;
      serverStatus[id].transferProgress = null;
      if (!serverStatus[id].log) serverStatus[id].log = [];
      serverStatus[id].log.push({ ts: now(), msg: 'Conexao com servidor perdida', tipo: 'erro' });
      carregarServidores();
    }
  };
}

async function verificarTodos() {
  const res = await fetch('/api/servidores');
  const servidores = await res.json();
  await Promise.all(servidores.map(s => testarServidor(s.id)));
}

function atualizarTodos() {
  if (!versaoAtiva) {
    alert('Nenhuma versao selecionada.\n\nCrie ou selecione uma versao antes de atualizar.');
    return;
  }
  if (deployTodosEmAndamento) return;
  if (!confirm('Iniciar deploy em TODOS os servidores?')) return;
  deployTodosEmAndamento = true;

  const fetchServidores = fetch('/api/servidores').then(r => r.json());
  fetchServidores.then(servidores => {
    servidores.forEach(s => {
      const versaoServidor = serverStatus[s.id]?.versao || s.versaoDeployada;
      const jaAtualizado = versaoAtiva && versaoServidor && versaoServidor === versaoAtiva;
      serverStatus[s.id] = {
        ...serverStatus[s.id],
        deploying: false,
        log: [],
        transferProgress: null,
        logCollapsed: false,
        deploySuccess: undefined,
        aguardando: !jaAtualizado,
      };
    });
    carregarServidores();

    const evtSource = new EventSource('/api/deploy/todos/stream');

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const sid = data.servidorId;

        if (data.evento === 'deploy_pulado' && sid) {
          serverStatus[sid] = {
            ...serverStatus[sid],
            deploying: false,
            aguardando: false,
            log: [{ ts: now(), msg: `Servidor ignorado por ja estar na versao do deploy (v${data.versao})`, tipo: 'info' }],
            logCollapsed: false,
            deploySuccess: true,
          };
          carregarServidores();
        }

        else if (data.evento === 'deploy_iniciando' && sid) {
          serverStatus[sid] = {
            ...serverStatus[sid],
            deploying: true,
            aguardando: false,
            log: [],
            transferProgress: null,
            logCollapsed: false,
            deploySuccess: undefined,
          };
          carregarServidores();
        }

        else if (data.evento === 'log' && sid) {
          if (!serverStatus[sid]) serverStatus[sid] = { deploying: true, log: [] };
          if (!serverStatus[sid].log) serverStatus[sid].log = [];
          serverStatus[sid].log.push({ ts: data.ts, msg: data.msg, tipo: data.tipo });
          atualizarCardDeploy(sid);
        }

        else if (data.evento === 'transferencia_inicio' && sid) {
          serverStatus[sid].transferProgress = { transferido: 0, total: data.total, percentual: 0 };
          atualizarCardDeploy(sid);
        }

        else if (data.evento === 'transferencia_progresso' && sid) {
          serverStatus[sid].transferProgress = {
            transferido: data.transferido,
            total: data.total,
            percentual: data.percentual,
          };
          atualizarCardDeploy(sid);
        }

        else if (data.evento === 'transferencia_fim' && sid) {
          serverStatus[sid].transferProgress = null;
          atualizarCardDeploy(sid);
        }

        else if (data.evento === 'concluido' && sid) {
          serverStatus[sid] = {
            status: data.sucesso ? 'rodando' : 'erro',
            log: data.log || serverStatus[sid]?.log,
            transferProgress: null,
            deploying: false,
            aguardando: false,
            logCollapsed: true,
            deploySuccess: data.sucesso,
          };
          carregarServidores();
        }

        else if (data.evento === 'concluido_todos') {
          evtSource.close();
          deployTodosEmAndamento = false;
          carregarServidores();
          carregarHistorico();
        }
      } catch (_) {}
    };

    evtSource.onerror = () => {
      evtSource.close();
      deployTodosEmAndamento = false;
      servidores.forEach(s => {
        if (serverStatus[s.id]?.deploying || serverStatus[s.id]?.aguardando) {
          serverStatus[s.id].deploying = false;
          serverStatus[s.id].aguardando = false;
          serverStatus[s.id].transferProgress = null;
        }
      });
      carregarServidores();
    };
  });
}

async function removerServidor(id) {
  if (!confirm('Remover este servidor?')) return;
  await fetch(`/api/servidores/${id}`, { method: 'DELETE' });
  delete serverStatus[id];
  delete geralStatus[id];
  carregarServidores();
  // Recarregar lista geral se estiver visivel
  if (document.getElementById('geralScreen').style.display !== 'none') {
    carregarServidoresGeral();
  }
}

// ══════════════════════════════════════════
// MODAL (compartilhado)
// ══════════════════════════════════════════
function abrirModal(dados) {
  document.getElementById('modalTitle').textContent = dados ? 'Editar Servidor' : 'Adicionar Servidor';
  document.getElementById('editId').value = dados?.id || '';
  document.getElementById('fNome').value = dados?.nome || '';
  document.getElementById('fIp').value = dados?.ip || '';
  document.getElementById('fPorta').value = dados?.porta || 22;
  document.getElementById('fUsuario').value = dados?.usuario || '';
  document.getElementById('fSenha').value = '';
  document.getElementById('fDescricao').value = dados?.descricao || '';
  // Campos PG
  document.getElementById('fTemPostgreSQL').checked = dados?.temPostgreSQL || false;
  document.getElementById('fPgHost').value = dados?.pgHost || '';
  document.getElementById('fPgBanco').value = dados?.pgBanco || '';
  document.getElementById('fPgPorta').value = dados?.pgPorta || 5432;
  document.getElementById('fPgUsuario').value = dados?.pgUsuario || 'frigo';
  document.getElementById('fPgSenha').value = '';
  togglePgFields();
  // Grupo de Replicacao — so exibir ao editar
  const modalEl = document.querySelector('.modal-servidor');
  if (dados && dados.id) {
    document.getElementById('grupoReplicacaoFields').style.display = 'block';
    if (modalEl) modalEl.classList.add('modal-two-cols');
    renderGrupoReplicacaoModal(dados);
  } else {
    document.getElementById('grupoReplicacaoFields').style.display = 'none';
    if (modalEl) modalEl.classList.remove('modal-two-cols');
  }
  document.getElementById('modalOverlay').classList.add('visible');
}

function togglePgFields() {
  const checked = document.getElementById('fTemPostgreSQL').checked;
  document.getElementById('pgFields').style.display = checked ? 'block' : 'none';
}

function fecharModal() {
  document.getElementById('modalOverlay').classList.remove('visible');
}

async function editarServidor(id) {
  const res = await fetch('/api/servidores');
  const lista = await res.json();
  const s = lista.find(x => x.id === id);
  if (s) abrirModal(s);
}

async function salvarServidor() {
  const id = document.getElementById('editId').value;
  const body = {
    nome: document.getElementById('fNome').value,
    ip: document.getElementById('fIp').value,
    porta: parseInt(document.getElementById('fPorta').value) || 22,
    usuario: document.getElementById('fUsuario').value,
    descricao: document.getElementById('fDescricao').value,
    temPostgreSQL: document.getElementById('fTemPostgreSQL').checked,
    pgHost: document.getElementById('fPgHost').value.trim(),
    pgBanco: document.getElementById('fPgBanco').value,
    pgPorta: parseInt(document.getElementById('fPgPorta').value) || 5432,
    pgUsuario: document.getElementById('fPgUsuario').value || 'frigo',
  };
  const senha = document.getElementById('fSenha').value;
  if (senha) body.senha = senha;
  const pgSenha = document.getElementById('fPgSenha').value;
  if (pgSenha) body.pgSenha = pgSenha;

  if (!body.nome || !body.ip || !body.usuario) {
    alert('Preencha os campos obrigatorios: nome, IP, usuario');
    return;
  }
  if (!id && !senha) {
    alert('Senha e obrigatoria para novos servidores');
    return;
  }

  if (id) {
    await fetch(`/api/servidores/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    await fetch('/api/servidores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  fecharModal();
  // Recarregar a lista correta dependendo da tela ativa
  if (document.getElementById('fvendasScreen').style.display !== 'none') {
    carregarServidores();
  }
  if (document.getElementById('geralScreen').style.display !== 'none') {
    carregarServidoresGeral();
  }
}

async function testarConexaoModal() {
  const body = {
    nome: document.getElementById('fNome').value || 'Teste',
    ip: document.getElementById('fIp').value,
    porta: parseInt(document.getElementById('fPorta').value) || 22,
    usuario: document.getElementById('fUsuario').value,
    senha: document.getElementById('fSenha').value,
  };

  if (!body.ip || !body.usuario || !body.senha) {
    alert('Preencha IP, usuario e senha para testar');
    return;
  }

  const btn = document.getElementById('btnTestarConexao');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Testando...';

  let id = null;
  try {
    const res = await fetch('/api/servidores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.erro || `Erro ao criar servidor temporario (HTTP ${res.status})`);
    }

    const resData = await res.json();
    id = resData.id;

    const testRes = await fetch(`/api/testar/${id}`, { method: 'POST' });
    if (!testRes.ok) {
      throw new Error(`Erro ao testar conexao (HTTP ${testRes.status})`);
    }

    const data = await testRes.json();

    if (data.conectou) {
      alert(`Conexao OK!\nServico: ${data.servico_status}\nVersao: ${data.versao_atual || '?'}`);
    } else {
      alert(`Falha na conexao: ${data.erro}`);
    }
  } catch (err) {
    alert(`Erro ao testar conexao: ${err.message}`);
  } finally {
    if (id) {
      try { await fetch(`/api/servidores/${id}`, { method: 'DELETE' }); } catch (_) {}
    }
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

// ══════════════════════════════════════════
// HISTORICO (Fvendas)
// ══════════════════════════════════════════
function toggleHistorico() {
  const el = document.getElementById('historicoContent');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function carregarHistorico() {
  const res = await fetch('/api/historico');
  const logs = await res.json();
  const tbody = document.getElementById('historicoBody');

  tbody.innerHTML = logs.map(l => {
    const dt = new Date(l.data).toLocaleString('pt-BR');
    const statusHtml = l.sucesso
      ? '<span style="color:var(--green)">Sucesso</span>'
      : '<span style="color:var(--red)">Erro</span>';
    return `<tr><td>${dt}</td><td>${esc(l.servidor)}</td><td>${statusHtml}</td><td>${l.duracao}</td></tr>`;
  }).join('');
}

// ── Toggle log colapsavel ──
function toggleLog(id) {
  if (!serverStatus[id]) return;
  serverStatus[id].logCollapsed = !serverStatus[id].logCollapsed;
  carregarServidores();
}

// ══════════════════════════════════════════
// SERVIDOR GERAL — VERSAO E STATUS
// ══════════════════════════════════════════
async function verificarGeralStatus() {
  const res = await fetch('/api/geral/status');
  const data = await res.json();
  const badge = document.getElementById('geralBadge');
  const statusEl = document.getElementById('geralSourceStatus');
  const selector = document.getElementById('geralVersaoSelector');
  const select = document.getElementById('geralSelectVersao');

  versaoGeralAtiva = data.versao || null;

  // Status dos arquivos fonte
  let html = '<div class="source-info">';
  html += `<div class="source-row">`;
  html += `<span class="source-label">EXEs:</span> `;
  html += data.debugExists
    ? `<span class="source-ok">${data.exeCount} arquivos em ${esc(data.debugDir)}</span>`
    : `<span class="source-err">Diretorio nao encontrado: ${esc(data.debugDir)}</span>`;
  html += `</div>`;
  html += `<div class="source-row">`;
  html += `<span class="source-label">DLLs:</span> `;
  html += data.debugExists
    ? `<span class="source-ok">${data.dllCount} arquivos em ${esc(data.debugDir)}</span>`
    : `<span class="source-err">Diretorio nao encontrado: ${esc(data.debugDir)}</span>`;
  html += `</div>`;
  html += `<div class="source-row">`;
  html += `<span class="source-label">Reports:</span> `;
  html += data.reportsExists
    ? `<span class="source-ok">${data.reportCount} arquivos em ${esc(data.reportsDir)}</span>`
    : `<span class="source-err">Diretorio nao encontrado: ${esc(data.reportsDir)}</span>`;
  html += `</div>`;
  html += '</div>';
  statusEl.innerHTML = html;

  // Badge
  if (data.versao) {
    badge.className = 'badge badge-ok';
    badge.textContent = `v${data.versao}`;
  } else {
    badge.className = 'badge badge-no';
    badge.textContent = 'Nenhuma versao';
  }

  // Popular select de versoes
  const versoes = data.versoes || [];
  const descricoes = data.descricoes || {};
  if (versoes.length > 0) {
    select.innerHTML = versoes.map(v => {
      const desc = descricoes[v] ? ` - ${descricoes[v]}` : '';
      const ativa = v === data.versao ? ' (ativa)' : '';
      return `<option value="${v}" ${v === data.versao ? 'selected' : ''}>${v}${desc}${ativa}</option>`;
    }).join('');
    selector.style.display = 'flex';
  } else {
    selector.style.display = 'none';
  }
}

async function criarVersaoGeral() {
  const versao = document.getElementById('geralInputVersao').value.trim();
  if (!versao) {
    alert('Informe a versao');
    return;
  }
  const descricao = document.getElementById('geralInputDescricao').value.trim();

  const btn = document.getElementById('btnCriarVersaoGeral');
  const pb = document.getElementById('geralProgressBar');
  const pf = document.getElementById('geralProgressFill');

  btn.disabled = true;
  btn.textContent = 'Empacotando...';
  pb.style.display = 'block';
  pf.style.width = '30%';

  try {
    const body = { versao };
    if (descricao) body.descricao = descricao;
    const res = await fetch('/api/geral/versao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    pf.style.width = '100%';

    if (data.ok) {
      setTimeout(() => { pb.style.display = 'none'; }, 1000);
      document.getElementById('geralInputVersao').value = '';
      document.getElementById('geralInputDescricao').value = '';
      verificarGeralStatus();
      carregarServidoresGeral();
    } else {
      pb.style.display = 'none';
      alert('Erro ao criar versao: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    pb.style.display = 'none';
    alert('Erro de conexao: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Criar Versao';
  }
}

async function selecionarVersaoGeral() {
  const select = document.getElementById('geralSelectVersao');
  const versao = select.value;
  if (!versao) return;

  try {
    const res = await fetch('/api/geral/versao/selecionar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versao }),
    });
    const data = await res.json();
    if (data.ok) {
      verificarGeralStatus();
      carregarServidoresGeral();
    } else {
      alert('Erro ao selecionar versao: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    alert('Erro de conexao: ' + err.message);
  }
}

// ══════════════════════════════════════════
// SERVIDOR GERAL — LISTA DE SERVIDORES
// ══════════════════════════════════════════
async function carregarServidoresGeral() {
  const res = await fetch('/api/servidores');
  todosServidoresGeral = await res.json();
  filtrarServidoresGeral();
}

function filtrarServidoresGeral() {
  const busca = (document.getElementById('buscarServidorGeral')?.value || '').toLowerCase().trim();
  if (!busca) {
    renderServidoresGeral(todosServidoresGeral);
  } else {
    renderServidoresGeral(todosServidoresGeral.filter(s =>
      s.nome.toLowerCase().includes(busca) || s.ip.toLowerCase().includes(busca)
    ));
  }
}

const ETAPAS_GERAL = [
  { id: 'parando_apache', label: 'Parando Apache' },
  { id: 'enviando_exes', label: 'EXEs' },
  { id: 'enviando_dlls', label: 'DLLs' },
  { id: 'enviando_reports', label: 'Reports' },
  { id: 'executando_scripts', label: 'Scripts SQL' },
  { id: 'iniciando_apache', label: 'Iniciando Apache' },
  { id: 'concluido', label: 'Concluido' },
];

function renderEtapasProgress(etapaAtual) {
  if (!etapaAtual) return '';
  const idx = ETAPAS_GERAL.findIndex(e => e.id === etapaAtual);
  return `<div class="etapas-progress">` +
    ETAPAS_GERAL.map((e, i) => {
      let cls = 'etapa-pending';
      let icon = '&#9675;'; // ○
      if (i < idx) { cls = 'etapa-done'; icon = '&#10003;'; } // ✓
      else if (i === idx) { cls = 'etapa-active'; icon = '&#9679;'; } // ●
      return `<div class="etapa-item ${cls}"><span class="etapa-icon">${icon}</span><span class="etapa-label">${e.label}</span></div>`;
    }).join('<span class="etapa-sep">&#8594;</span>') +
    `</div>`;
}

function renderCardServidorGeral(s, emGrupo) {
  const st = geralStatus[s.id] || {};
  const versao = s.versaoGeralDeployada || '—';
  const deploying = st.deploying || false;
  const aguardando = st.aguardando || false;

  // Badge atualizado/desatualizado
  const versaoServidor = s.versaoGeralDeployada;
  let versaoBadge = '';
  if (versaoGeralAtiva && versaoServidor) {
    const cmp = compararVersoes(versaoServidor, versaoGeralAtiva);
    if (cmp >= 0) {
      versaoBadge = '<span class="badge badge-atualizado">atualizado</span>';
    } else {
      versaoBadge = '<span class="badge badge-desatualizado">desatualizado</span>';
    }
  }

  // Ultima atualizacao
  const ultimaAtt = s.ultimaAtualizacaoGeral
    ? new Date(s.ultimaAtualizacaoGeral).toLocaleString('pt-BR')
    : '';

  // Etapas progress
  const etapasHtml = st.etapa ? renderEtapasProgress(st.etapa) : '';

  // Log
  const logEntries = st.log || [];
  const logHtml = logEntries.map(l =>
    `<div class="log-${l.tipo}">[${l.ts}] ${l.msg}</div>`
  ).join('');
  const hasLog = logEntries.length > 0;
  const collapsed = st.logCollapsed === true;

  let logSectionHtml = '';
  if (hasLog && collapsed) {
    const lastResult = st.deploySuccess !== undefined
      ? (st.deploySuccess ? 'Sucesso' : 'Erro')
      : 'Concluido';
    const resultClass = st.deploySuccess === true ? 'log-sucesso' : st.deploySuccess === false ? 'log-erro' : 'log-info';
    logSectionHtml = `
      <div class="log-summary">
        <span class="${resultClass}">Deploy concluido &mdash; ${lastResult}</span>
        <a class="log-toggle" onclick="toggleLogGeral('${s.id}')">Ver log</a>
      </div>`;
  } else if (hasLog) {
    logSectionHtml = `
      ${!deploying ? `<div class="log-summary"><a class="log-toggle" onclick="toggleLogGeral('${s.id}')">Ocultar log</a></div>` : ''}
      <div class="deploy-log visible" id="glog-${s.id}">${logHtml}</div>`;
  }

  // Progress de transferencia
  const tp = st.transferProgress;
  let progressHtml = '';
  if (tp) {
    progressHtml = `
      <div class="transfer-progress" id="gtp-${s.id}">
        <div class="transfer-info">
          <span>Enviando arquivo...</span>
          <span>${tp.percentual}% &mdash; ${formatMB(tp.transferido)} / ${formatMB(tp.total)} MB</span>
        </div>
        <div class="transfer-bar">
          <div class="transfer-fill" style="width:${tp.percentual}%"></div>
        </div>
      </div>`;
  }

  const cardClass = emGrupo ? 'server-card server-card-replicacao' : 'server-card';
  const replicaBadge = emGrupo ? ' <span class="badge-replicacao-sm">replica</span>' : '';

  return `
    <div class="${cardClass}" id="gcard-${s.id}">
      <div class="server-header">
        <div>
          <div class="server-name">${esc(s.nome)}${replicaBadge}</div>
          ${s.descricao ? `<div class="server-desc">${esc(s.descricao)}</div>` : ''}
        </div>
      </div>
      <div class="server-meta">
        <span>${esc(s.ip)}:${s.porta}</span>
        <span>v${versao}</span>
        ${versaoBadge}
        ${s.temPostgreSQL && s.pgHost ? '<span class="badge badge-pg-remote">BD Remoto</span>' : s.temPostgreSQL ? '<span class="badge badge-pg">PG</span>' : ''}
        ${s.temPostgreSQL && s.versaoScriptBD ? `<span class="text-muted">BD v${s.versaoScriptBD}${s.pgHost ? ' (' + esc(s.pgHost) + ')' : ''}</span>` : s.temPostgreSQL && s.pgHost ? `<span class="text-muted">${esc(s.pgBanco)} (${esc(s.pgHost)})</span>` : ''}
        ${ultimaAtt ? `<span class="text-muted">${ultimaAtt}</span>` : ''}
      </div>
      <div class="server-actions">
        <button class="btn btn-success btn-sm" onclick="deployServidorGeral('${s.id}')" ${deploying || aguardando || st.verificando ? 'disabled' : ''}>
          ${deploying ? '<span class="spinner"></span> Atualizando...' : st.verificando ? '<span class="spinner"></span> Verificando...' : aguardando ? 'Aguardando...' : 'Atualizar'}
        </button>
        ${s.temPostgreSQL ? `<button class="btn btn-ghost btn-sm" onclick="verificarVersaoBD('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Verificar BD</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="editarServidor('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Editar</button>
        <button class="btn btn-danger btn-sm" onclick="removerServidor('${s.id}')" ${deploying || aguardando ? 'disabled' : ''}>Remover</button>
      </div>
      ${etapasHtml}
      ${progressHtml}
      ${logSectionHtml}
    </div>
  `;
}

function renderServidoresGeral(lista) {
  const el = document.getElementById('geralServerList');
  if (lista.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:14px;">Nenhum servidor cadastrado.</p>';
    return;
  }

  // Separar em grupos e standalone
  const grupos = {};
  const standalone = [];
  lista.forEach(s => {
    if (s.grupoReplicacao) {
      if (!grupos[s.grupoReplicacao]) grupos[s.grupoReplicacao] = [];
      grupos[s.grupoReplicacao].push(s);
    } else {
      standalone.push(s);
    }
  });

  let html = '';

  // Renderizar grupos
  Object.keys(grupos).forEach(grupoId => {
    const membros = grupos[grupoId];
    const nomes = membros.map(s => esc(s.nome)).join(', ');
    html += `<div class="replicacao-group">
      <div class="replicacao-group-header">
        <span class="badge-replicacao">Grupo Replicacao</span>
        <span>${nomes}</span>
        <span class="text-muted">(${membros.length} servidores)</span>
      </div>`;
    membros.forEach(s => {
      html += renderCardServidorGeral(s, true);
    });
    html += '</div>';
  });

  // Renderizar standalone
  standalone.forEach(s => {
    html += renderCardServidorGeral(s, false);
  });

  el.innerHTML = html;

  lista.forEach(s => {
    const logEl = document.getElementById(`glog-${s.id}`);
    if (logEl && logEl.classList.contains('visible')) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  });
}

function atualizarCardGeralDeploy(id) {
  const st = geralStatus[id] || {};

  // Atualizar etapas
  const cardEl = document.getElementById(`gcard-${id}`);
  if (cardEl && st.etapa) {
    let etapasEl = cardEl.querySelector('.etapas-progress');
    const newHtml = renderEtapasProgress(st.etapa);
    if (etapasEl) {
      etapasEl.outerHTML = newHtml;
    } else {
      const actionsEl = cardEl.querySelector('.server-actions');
      if (actionsEl) actionsEl.insertAdjacentHTML('afterend', newHtml);
    }
  }

  // Atualizar log
  let logEl = document.getElementById(`glog-${id}`);
  if (!logEl && st.log && st.log.length > 0 && cardEl) {
    logEl = document.createElement('div');
    logEl.className = 'deploy-log visible';
    logEl.id = `glog-${id}`;
    cardEl.appendChild(logEl);
  }
  if (logEl) {
    const logHtml = (st.log || []).map(l =>
      `<div class="log-${l.tipo}">[${l.ts}] ${l.msg}</div>`
    ).join('');
    logEl.innerHTML = logHtml;
    if (st.log && st.log.length > 0) {
      logEl.classList.add('visible');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  // Atualizar progress
  const tp = st.transferProgress;
  let tpEl = document.getElementById(`gtp-${id}`);

  if (tp) {
    if (!tpEl) {
      tpEl = document.createElement('div');
      tpEl.className = 'transfer-progress';
      tpEl.id = `gtp-${id}`;
      const logContainer = document.getElementById(`glog-${id}`);
      if (logContainer) logContainer.parentNode.insertBefore(tpEl, logContainer);
    }
    tpEl.innerHTML = `
      <div class="transfer-info">
        <span>Enviando arquivo...</span>
        <span>${tp.percentual}% &mdash; ${formatMB(tp.transferido)} / ${formatMB(tp.total)} MB</span>
      </div>
      <div class="transfer-bar">
        <div class="transfer-fill" style="width:${tp.percentual}%"></div>
      </div>`;
  } else if (tpEl) {
    tpEl.remove();
  }
}

// ══════════════════════════════════════════
// SERVIDOR GERAL — DEPLOY
// ══════════════════════════════════════════
async function deployServidorGeral(id) {
  if (!versaoGeralAtiva) {
    alert('Nenhuma versao selecionada.\n\nCrie ou selecione uma versao antes de atualizar.');
    return;
  }

  const srv = todosServidoresGeral.find(s => s.id === id);
  if (!srv) return;

  // Proteger contra cliques multiplos
  if (geralStatus[id]?.verificando || geralStatus[id]?.deploying) return;

  // Verificar replicacao se tem PostgreSQL
  if (srv.temPostgreSQL) {
    try {
      // Feedback visual imediato — mostrar "Verificando..."
      geralStatus[id] = { ...geralStatus[id], verificando: true };
      renderServidoresGeral(todosServidoresGeral);

      const res = await fetch(`/api/geral/verificar-replicacao/${id}`);
      const data = await res.json();

      geralStatus[id].verificando = false;
      renderServidoresGeral(todosServidoresGeral);

      if (data.temReplicacao) {
        // Tem replicacao — verificar se tem irmaos cadastrados
        const irmaos = srv.grupoReplicacao
          ? todosServidoresGeral.filter(s => s.grupoReplicacao === srv.grupoReplicacao && s.id !== id)
          : [];

        if (irmaos.length === 0) {
          alert('Este servidor possui replicacao de dados, mas nao tem servidores irmaos cadastrados.\n\nCadastre os servidores irmaos no modal de edicao antes de atualizar, para evitar problemas de replicacao.');
          return;
        }

        // Tem irmaos — confirmar deploy do grupo
        const listaIrmaos = irmaos.map(i => `  - ${i.nome} (${i.ip})`).join('\n');
        const confirma = confirm(
          `Este servidor possui replicacao. Os seguintes servidores irmaos serao atualizados em sequencia:\n\n` +
          `  - ${srv.nome} (${srv.ip})\n${listaIrmaos}\n\n` +
          `Deseja continuar?`
        );
        if (!confirma) return;

        iniciarDeployGrupo(id, irmaos.map(i => i.id));
        return;
      }
    } catch (_) {
      // Erro na verificacao — prosseguir normalmente
      geralStatus[id] = { ...geralStatus[id], verificando: false };
      renderServidoresGeral(todosServidoresGeral);
    }
  }

  // Deploy individual normal
  if (!confirm('Iniciar atualizacao geral neste servidor?')) return;
  executarDeployGeralStream(id);
}

function executarDeployGeralStream(id) {
  const srv = todosServidoresGeral.find(s => s.id === id);
  geralStatus[id] = {
    deploying: true,
    log: [],
    transferProgress: null,
    etapa: null,
    logCollapsed: false,
    deploySuccess: undefined,
    _serverName: srv ? srv.nome : id,
  };
  renderServidoresGeral(todosServidoresGeral);

  const evtSource = new EventSource(`/api/geral/deploy/${id}/stream?operador=${encodeURIComponent(nomeOperador)}`);

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.evento === 'log') {
        if (!geralStatus[id].log) geralStatus[id].log = [];
        geralStatus[id].log.push({ ts: data.ts, msg: data.msg, tipo: data.tipo });
        atualizarCardGeralDeploy(id);
      }

      else if (data.evento === 'etapa') {
        geralStatus[id].etapa = data.etapa;
        atualizarCardGeralDeploy(id);
      }

      else if (data.evento === 'transferencia_inicio') {
        geralStatus[id].transferProgress = { transferido: 0, total: data.total, percentual: 0 };
        atualizarCardGeralDeploy(id);
      }

      else if (data.evento === 'transferencia_progresso') {
        geralStatus[id].transferProgress = {
          transferido: data.transferido,
          total: data.total,
          percentual: data.percentual,
        };
        atualizarCardGeralDeploy(id);
      }

      else if (data.evento === 'transferencia_fim') {
        geralStatus[id].transferProgress = null;
        atualizarCardGeralDeploy(id);
      }

      // ── Eventos de Scripts SQL ──
      else if (data.evento === 'scripts_inicio') {
        abrirScriptsModal(data.scripts, data.totalPendentes, data.versaoBD, geralStatus[id]._serverName || id);
      }

      else if (data.evento === 'script_executando') {
        atualizarScriptModal(data.indice, 'executando', data.versao, data.arquivo);
      }

      else if (data.evento === 'script_sucesso') {
        atualizarScriptModal(data.indice, 'sucesso');
      }

      else if (data.evento === 'script_erro') {
        atualizarScriptModal(data.indice, 'erro', data.versao, null, data.erro);
      }

      else if (data.evento === 'scripts_concluido') {
        finalizarScriptsModal(data.sucesso, data.executados, data.totalPendentes);
      }

      else if (data.evento === 'concluido') {
        evtSource.close();
        geralStatus[id] = {
          log: data.log || geralStatus[id].log,
          transferProgress: null,
          deploying: false,
          etapa: data.sucesso ? 'concluido' : null,
          logCollapsed: true,
          deploySuccess: data.sucesso,
        };
        carregarServidoresGeral();
        carregarHistoricoGeral();
      }

      else if (data.evento === 'erro') {
        evtSource.close();
        if (!geralStatus[id].log) geralStatus[id].log = [];
        geralStatus[id].log.push({ ts: now(), msg: data.msg, tipo: 'erro' });
        geralStatus[id].deploying = false;
        geralStatus[id].transferProgress = null;
        carregarServidoresGeral();
      }
    } catch (_) {}
  };

  evtSource.onerror = () => {
    evtSource.close();
    if (geralStatus[id]?.deploying) {
      geralStatus[id].deploying = false;
      geralStatus[id].transferProgress = null;
      if (!geralStatus[id].log) geralStatus[id].log = [];
      geralStatus[id].log.push({ ts: now(), msg: 'Conexao com servidor perdida', tipo: 'erro' });
      carregarServidoresGeral();
    }
  };
}

function deployGeralComPromise(id) {
  return new Promise((resolve) => {
    const srv = todosServidoresGeral.find(s => s.id === id);
    geralStatus[id] = {
      deploying: true,
      log: [],
      transferProgress: null,
      etapa: null,
      logCollapsed: false,
      deploySuccess: undefined,
      _serverName: srv ? srv.nome : id,
    };
    renderServidoresGeral(todosServidoresGeral);

    const evtSource = new EventSource(`/api/geral/deploy/${id}/stream?operador=${encodeURIComponent(nomeOperador)}`);

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);

        if (data.evento === 'log') {
          if (!geralStatus[id].log) geralStatus[id].log = [];
          geralStatus[id].log.push({ ts: data.ts, msg: data.msg, tipo: data.tipo });
          atualizarCardGeralDeploy(id);
        }

        else if (data.evento === 'etapa') {
          geralStatus[id].etapa = data.etapa;
          atualizarCardGeralDeploy(id);
        }

        else if (data.evento === 'transferencia_inicio') {
          geralStatus[id].transferProgress = { transferido: 0, total: data.total, percentual: 0 };
          atualizarCardGeralDeploy(id);
        }

        else if (data.evento === 'transferencia_progresso') {
          geralStatus[id].transferProgress = {
            transferido: data.transferido,
            total: data.total,
            percentual: data.percentual,
          };
          atualizarCardGeralDeploy(id);
        }

        else if (data.evento === 'transferencia_fim') {
          geralStatus[id].transferProgress = null;
          atualizarCardGeralDeploy(id);
        }

        else if (data.evento === 'scripts_inicio') {
          abrirScriptsModal(data.scripts, data.totalPendentes, data.versaoBD, geralStatus[id]._serverName || id);
        }
        else if (data.evento === 'script_executando') {
          atualizarScriptModal(data.indice, 'executando', data.versao, data.arquivo);
        }
        else if (data.evento === 'script_sucesso') {
          atualizarScriptModal(data.indice, 'sucesso');
        }
        else if (data.evento === 'script_erro') {
          atualizarScriptModal(data.indice, 'erro', data.versao, null, data.erro);
        }
        else if (data.evento === 'scripts_concluido') {
          finalizarScriptsModal(data.sucesso, data.executados, data.totalPendentes);
        }

        else if (data.evento === 'concluido') {
          evtSource.close();
          geralStatus[id] = {
            log: data.log || geralStatus[id].log,
            transferProgress: null,
            deploying: false,
            etapa: data.sucesso ? 'concluido' : null,
            logCollapsed: true,
            deploySuccess: data.sucesso,
          };
          carregarServidoresGeral();
          carregarHistoricoGeral();
          resolve({ sucesso: data.sucesso });
        }

        else if (data.evento === 'erro') {
          evtSource.close();
          if (!geralStatus[id].log) geralStatus[id].log = [];
          geralStatus[id].log.push({ ts: now(), msg: data.msg, tipo: 'erro' });
          geralStatus[id].deploying = false;
          geralStatus[id].transferProgress = null;
          carregarServidoresGeral();
          resolve({ sucesso: false });
        }
      } catch (_) {}
    };

    evtSource.onerror = () => {
      evtSource.close();
      if (geralStatus[id]?.deploying) {
        geralStatus[id].deploying = false;
        geralStatus[id].transferProgress = null;
        if (!geralStatus[id].log) geralStatus[id].log = [];
        geralStatus[id].log.push({ ts: now(), msg: 'Conexao com servidor perdida', tipo: 'erro' });
        carregarServidoresGeral();
      }
      resolve({ sucesso: false });
    };
  });
}

async function iniciarDeployGrupo(primarioId, irmaoIds) {
  const todosIds = [primarioId, ...irmaoIds];

  // Marcar todos como aguardando
  todosIds.forEach(id => {
    const srv = todosServidoresGeral.find(s => s.id === id);
    geralStatus[id] = {
      deploying: false,
      aguardando: true,
      log: [],
      transferProgress: null,
      etapa: null,
      logCollapsed: false,
      deploySuccess: undefined,
      _serverName: srv ? srv.nome : id,
    };
  });
  renderServidoresGeral(todosServidoresGeral);

  // Deploy sequencial
  for (const id of todosIds) {
    geralStatus[id].aguardando = false;
    await deployGeralComPromise(id);
  }
}

function atualizarTodosGeral() {
  if (!versaoGeralAtiva) {
    alert('Nenhuma versao selecionada.\n\nCrie ou selecione uma versao antes de atualizar.');
    return;
  }
  if (deployGeralTodosEmAndamento) return;
  if (!confirm('Iniciar atualizacao geral em TODOS os servidores?')) return;
  deployGeralTodosEmAndamento = true;

  fetch('/api/servidores').then(r => r.json()).then(servidores => {
    servidores.forEach(s => {
      const jaAtualizado = versaoGeralAtiva && s.versaoGeralDeployada && s.versaoGeralDeployada === versaoGeralAtiva;
      geralStatus[s.id] = {
        deploying: false,
        log: [],
        transferProgress: null,
        etapa: null,
        logCollapsed: false,
        deploySuccess: undefined,
        aguardando: !jaAtualizado,
      };
    });
    renderServidoresGeral(todosServidoresGeral);

    const evtSource = new EventSource(`/api/geral/deploy/todos/stream?operador=${encodeURIComponent(nomeOperador)}`);

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const sid = data.servidorId;

        if (data.evento === 'deploy_pulado' && sid) {
          geralStatus[sid] = {
            deploying: false,
            aguardando: false,
            log: [{ ts: now(), msg: `Servidor ignorado por ja estar na versao do deploy (v${data.versao})`, tipo: 'info' }],
            etapa: 'concluido',
            logCollapsed: false,
            deploySuccess: true,
          };
          renderServidoresGeral(todosServidoresGeral);
        }

        else if (data.evento === 'deploy_iniciando' && sid) {
          const srv = todosServidoresGeral.find(s => s.id === sid);
          geralStatus[sid] = {
            deploying: true,
            aguardando: false,
            log: [],
            transferProgress: null,
            etapa: null,
            logCollapsed: false,
            deploySuccess: undefined,
            _serverName: srv ? srv.nome : sid,
          };
          renderServidoresGeral(todosServidoresGeral);
        }

        else if (data.evento === 'log' && sid) {
          if (!geralStatus[sid]) geralStatus[sid] = { deploying: true, log: [] };
          if (!geralStatus[sid].log) geralStatus[sid].log = [];
          geralStatus[sid].log.push({ ts: data.ts, msg: data.msg, tipo: data.tipo });
          atualizarCardGeralDeploy(sid);
        }

        else if (data.evento === 'etapa' && sid) {
          if (!geralStatus[sid]) geralStatus[sid] = { deploying: true, log: [] };
          geralStatus[sid].etapa = data.etapa;
          atualizarCardGeralDeploy(sid);
        }

        // ── Eventos de Scripts SQL (todos) ──
        else if (data.evento === 'scripts_inicio' && sid) {
          abrirScriptsModal(data.scripts, data.totalPendentes, data.versaoBD, geralStatus[sid]?._serverName || sid);
        }

        else if (data.evento === 'script_executando' && sid) {
          atualizarScriptModal(data.indice, 'executando', data.versao, data.arquivo);
        }

        else if (data.evento === 'script_sucesso' && sid) {
          atualizarScriptModal(data.indice, 'sucesso');
        }

        else if (data.evento === 'script_erro' && sid) {
          atualizarScriptModal(data.indice, 'erro', data.versao, null, data.erro);
        }

        else if (data.evento === 'scripts_concluido' && sid) {
          finalizarScriptsModal(data.sucesso, data.executados, data.totalPendentes);
        }

        else if (data.evento === 'transferencia_inicio' && sid) {
          geralStatus[sid].transferProgress = { transferido: 0, total: data.total, percentual: 0 };
          atualizarCardGeralDeploy(sid);
        }

        else if (data.evento === 'transferencia_progresso' && sid) {
          geralStatus[sid].transferProgress = {
            transferido: data.transferido,
            total: data.total,
            percentual: data.percentual,
          };
          atualizarCardGeralDeploy(sid);
        }

        else if (data.evento === 'transferencia_fim' && sid) {
          geralStatus[sid].transferProgress = null;
          atualizarCardGeralDeploy(sid);
        }

        else if (data.evento === 'concluido' && sid) {
          geralStatus[sid] = {
            log: data.log || geralStatus[sid]?.log,
            transferProgress: null,
            deploying: false,
            aguardando: false,
            etapa: data.sucesso ? 'concluido' : null,
            logCollapsed: true,
            deploySuccess: data.sucesso,
          };
          renderServidoresGeral(todosServidoresGeral);
        }

        else if (data.evento === 'concluido_todos') {
          evtSource.close();
          deployGeralTodosEmAndamento = false;
          carregarServidoresGeral();
          carregarHistoricoGeral();
        }
      } catch (_) {}
    };

    evtSource.onerror = () => {
      evtSource.close();
      deployGeralTodosEmAndamento = false;
      servidores.forEach(s => {
        if (geralStatus[s.id]?.deploying || geralStatus[s.id]?.aguardando) {
          geralStatus[s.id].deploying = false;
          geralStatus[s.id].aguardando = false;
          geralStatus[s.id].transferProgress = null;
        }
      });
      renderServidoresGeral(todosServidoresGeral);
    };
  });
}

function toggleLogGeral(id) {
  if (!geralStatus[id]) return;
  geralStatus[id].logCollapsed = !geralStatus[id].logCollapsed;
  renderServidoresGeral(todosServidoresGeral);
}

// ══════════════════════════════════════════
// SERVIDOR GERAL — HISTORICO
// ══════════════════════════════════════════
function toggleHistoricoGeral() {
  const el = document.getElementById('geralHistoricoContent');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function carregarHistoricoGeral() {
  const res = await fetch('/api/geral/historico');
  const logs = await res.json();
  const tbody = document.getElementById('geralHistoricoBody');
  tbody.innerHTML = logs.map(renderHistoricoGeralRow).join('');
}

// ══════════════════════════════════════════
// SCRIPTS SQL — STATUS E INDEXACAO
// ══════════════════════════════════════════
async function verificarScriptsStatus() {
  const statusEl = document.getElementById('scriptsStatus');
  const toolbarEl = document.getElementById('scriptsToolbar');

  try {
    const res = await fetch('/api/geral/scripts/status');
    const data = await res.json();
    scriptsIndexInfo = data;

    if (data.erro) {
      statusEl.innerHTML = `<div class="scripts-info">
        <div class="scripts-info-row">
          <span class="source-err">${esc(data.erro)}</span>
        </div>
        <div class="scripts-info-row">
          <span class="scripts-info-label">Pasta raiz:</span>
          <span class="scripts-info-value">${esc(data.pastaRaiz)}</span>
        </div>
      </div>`;
      toolbarEl.style.display = 'flex';
      return;
    }

    let html = '<div class="scripts-info">';
    html += `<div class="scripts-info-row">
      <span class="scripts-info-label">Pasta raiz:</span>
      <span class="scripts-info-value">${esc(data.pastaRaiz)}</span>
    </div>`;
    html += `<div class="scripts-info-row">
      <span class="scripts-info-label">Scripts indexados:</span>
      <span class="source-ok">${data.totalScripts} scripts</span>
      ${data.versaoMaisRecente ? `<span class="text-muted">(versao mais recente: ${data.versaoMaisRecente})</span>` : ''}
    </div>`;

    if (data.pastasDetectadas && data.pastasDetectadas.length > 0) {
      html += `<div class="scripts-pastas">Pastas detectadas: ${data.pastasDetectadas.join(', ')} (${data.pastasDetectadas.length} pastas)</div>`;
    }

    if (data.ultimaVarredura) {
      const dt = new Date(data.ultimaVarredura).toLocaleString('pt-BR');
      html += `<div class="scripts-info-row">
        <span class="scripts-info-label">Ultima varredura:</span>
        <span class="text-muted">${dt}</span>
      </div>`;
    }

    html += '</div>';
    statusEl.innerHTML = html;
    toolbarEl.style.display = 'flex';
  } catch (err) {
    statusEl.innerHTML = `<span class="source-err">Erro ao verificar scripts: ${esc(err.message)}</span>`;
    toolbarEl.style.display = 'flex';
  }
}

async function reindexarScripts() {
  const statusEl = document.getElementById('scriptsStatus');
  statusEl.innerHTML = '<span class="text-muted"><span class="spinner"></span> Reindexando scripts...</span>';

  try {
    const res = await fetch('/api/geral/scripts/reindexar', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      verificarScriptsStatus();
    } else {
      statusEl.innerHTML = `<span class="source-err">Erro: ${esc(data.erro || 'Erro desconhecido')}</span>`;
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="source-err">Erro: ${esc(err.message)}</span>`;
  }
}

function alterarPastaScripts() {
  const novaPasta = prompt('Informe o caminho da pasta raiz dos scripts:', scriptsIndexInfo?.pastaRaiz || '');
  if (!novaPasta) return;

  fetch('/api/geral/scripts/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pastaRaiz: novaPasta }),
  }).then(r => r.json()).then(data => {
    if (data.ok || data.pastaRaiz) {
      verificarScriptsStatus();
    } else {
      alert('Erro: ' + (data.erro || 'Erro desconhecido'));
    }
  }).catch(err => alert('Erro: ' + err.message));
}

async function verificarVersaoBD(id) {
  const srv = todosServidoresGeral.find(s => s.id === id);
  if (!srv) return;

  // Feedback visual temporario
  const btn = event.target;
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Verificando...';

  try {
    const res = await fetch(`/api/geral/scripts/versao/${id}`);
    const data = await res.json();

    if (data.versaoBD !== null && data.versaoBD !== undefined) {
      let msg = `Versao BD: ${data.versaoBD}`;
      if (data.pendentes > 0) {
        msg += `\n${data.pendentes} script(s) pendente(s)`;
      } else {
        msg += '\nNenhum script pendente';
      }
      alert(msg);
      // Atualizar dados locais
      srv.versaoScriptBD = data.versaoBD;
      renderServidoresGeral(todosServidoresGeral);
    } else {
      alert('Erro ao verificar: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    alert('Erro: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

// ══════════════════════════════════════════
// SCRIPTS SQL — MODAL DE EXECUCAO
// ══════════════════════════════════════════
function abrirScriptsModal(scripts, totalPendentes, versaoBD, serverName) {
  scriptsModalData = {
    scripts: scripts.map(s => ({ ...s })),
    serverName,
    autoCloseTimer: null,
  };

  document.getElementById('scriptsModalTitle').textContent = 'Executando Scripts SQL — ' + serverName;
  document.getElementById('scriptsModalInfo').textContent = `Versao atual do banco: ${versaoBD} | ${totalPendentes} script(s) pendente(s)`;
  document.getElementById('scriptsErrorLog').style.display = 'none';
  document.getElementById('scriptsErrorLog').textContent = '';
  document.getElementById('scriptsModalFooter').style.display = 'none';

  renderScriptsModalList();
  document.getElementById('scriptsModalOverlay').classList.add('visible');
}

function renderScriptsModalList() {
  if (!scriptsModalData) return;
  const listEl = document.getElementById('scriptsModalList');

  listEl.innerHTML = scriptsModalData.scripts.map(s => {
    let icon = '&#9675;'; // ○
    let statusText = 'Aguardando';
    let cls = 'script-aguardando';

    if (s.status === 'executando') {
      icon = '&#9679;'; // ●
      statusText = 'Executando...';
      cls = 'script-executando';
    } else if (s.status === 'sucesso') {
      icon = '&#10003;'; // ✓
      statusText = 'Sucesso';
      cls = 'script-sucesso';
    } else if (s.status === 'erro') {
      icon = '&#10007;'; // ✗
      statusText = 'Erro';
      cls = 'script-erro';
    }

    return `<div class="script-item ${cls}">
      <span class="script-icon">${icon}</span>
      <span class="script-versao">v${s.versao}</span>
      <span class="script-arquivo" title="${esc(s.arquivo)}">${esc(s.arquivo)}</span>
      <span class="script-status-text">${statusText}</span>
    </div>`;
  }).join('');
}

function atualizarScriptModal(indice, status, versao, arquivo, erro) {
  if (!scriptsModalData || !scriptsModalData.scripts[indice]) return;

  scriptsModalData.scripts[indice].status = status;
  renderScriptsModalList();

  // Scroll para o item ativo
  const listEl = document.getElementById('scriptsModalList');
  const items = listEl.querySelectorAll('.script-item');
  if (items[indice]) {
    items[indice].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Mostrar erro se houver
  if (status === 'erro' && erro) {
    const errorEl = document.getElementById('scriptsErrorLog');
    errorEl.textContent = erro;
    errorEl.style.display = 'block';
  }
}

function finalizarScriptsModal(sucesso, executados, totalPendentes) {
  if (!scriptsModalData) return;

  const footerEl = document.getElementById('scriptsModalFooter');

  if (sucesso) {
    // Sucesso: mostrar mensagem e auto-fechar
    const infoEl = document.getElementById('scriptsModalInfo');
    infoEl.innerHTML = `<div class="scripts-success-msg">Todos os ${executados} script(s) executados com sucesso!</div>`;
    footerEl.style.display = 'flex';

    scriptsModalData.autoCloseTimer = setTimeout(() => {
      fecharScriptsModal();
    }, 3000);
  } else {
    // Erro: mostrar botao de fechar
    footerEl.style.display = 'flex';
    const infoEl = document.getElementById('scriptsModalInfo');
    infoEl.textContent = `${executados} de ${totalPendentes} script(s) executados — execucao interrompida por erro`;
  }
}

function fecharScriptsModal() {
  if (scriptsModalData && scriptsModalData.autoCloseTimer) {
    clearTimeout(scriptsModalData.autoCloseTimer);
  }
  scriptsModalData = null;
  document.getElementById('scriptsModalOverlay').classList.remove('visible');
}

// ══════════════════════════════════════════
// SERVIDOR GERAL — HISTORICO (atualizado com scripts)
// ══════════════════════════════════════════
function renderHistoricoGeralRow(l) {
  const dt = new Date(l.data).toLocaleString('pt-BR');
  let statusHtml = l.sucesso
    ? '<span style="color:var(--green)">Sucesso</span>'
    : '<span style="color:var(--red)">Erro</span>';

  // Adicionar info de scripts
  if (l.scripts) {
    if (l.scripts.executados > 0) {
      statusHtml += ` <span class="text-muted">(${l.scripts.executados} scripts)`;
      if (!l.scripts.sucesso) {
        statusHtml += ' <span style="color:var(--red)">script falhou</span>';
      }
      statusHtml += '</span>';
    }
  }

  return `<tr><td>${dt}</td><td>${esc(l.servidor)}</td><td>${statusHtml}</td><td>${l.duracao}</td></tr>`;
}

// ══════════════════════════════════════════
// GRUPO DE REPLICACAO (IRMAOS)
// ══════════════════════════════════════════
function renderGrupoReplicacaoModal(dados) {
  const container = document.getElementById('grupoReplicacaoFields');
  const section = container.querySelector('.grupo-replicacao-section');
  container.style.display = 'block';

  const grupo = dados.grupoReplicacao;
  // Buscar irmaos do mesmo grupo
  const irmaos = grupo
    ? todosServidoresGeral.filter(s => s.grupoReplicacao === grupo && s.id !== dados.id)
    : [];

  // Buscar servidores disponiveis para adicionar (que nao sao o proprio)
  const disponiveis = todosServidoresGeral.filter(s => s.id !== dados.id);

  let html = '<h4>Servidores Irmaos (Replicacao)</h4>';

  if (irmaos.length > 0) {
    html += '<div class="grupo-irmaos-list">';
    irmaos.forEach(irmao => {
      html += `<div class="grupo-irmao-item">
        <div class="grupo-irmao-info">
          <span class="grupo-irmao-nome">${esc(irmao.nome)}</span>
          <span class="grupo-irmao-ip">${esc(irmao.ip)}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="removerDoGrupo('${dados.id}', '${irmao.id}')">Desvincular</button>
      </div>`;
    });
    html += '</div>';
  } else {
    html += '<div class="grupo-sem-irmaos">Nenhum servidor irmao vinculado</div>';
  }

  // Select para adicionar novo irmao
  if (disponiveis.length > 0) {
    html += '<div class="grupo-adicionar">';
    html += '<select id="selectIrmao"><option value="">Selecionar servidor...</option>';
    disponiveis.forEach(s => {
      const jaIrmao = irmaos.some(i => i.id === s.id);
      if (!jaIrmao) {
        html += `<option value="${s.id}">${esc(s.nome)} (${esc(s.ip)})</option>`;
      }
    });
    html += '</select>';
    html += `<button class="btn btn-primary btn-sm" onclick="adicionarAoGrupo('${dados.id}')">Vincular</button>`;
    html += '</div>';
  }

  section.innerHTML = html;
}

async function adicionarAoGrupo(servidorIdA) {
  const select = document.getElementById('selectIrmao');
  const servidorIdB = select.value;
  if (!servidorIdB) { alert('Selecione um servidor para vincular'); return; }

  try {
    const res = await fetch('/api/servidores/grupo-replicacao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servidorIdA, servidorIdB }),
    });
    const data = await res.json();
    if (data.ok) {
      // Recarregar dados e re-renderizar modal
      const listRes = await fetch('/api/servidores');
      todosServidoresGeral = await listRes.json();
      if (document.getElementById('fvendasScreen').style.display !== 'none') {
        todosServidores = todosServidoresGeral;
      }
      const srv = todosServidoresGeral.find(s => s.id === servidorIdA);
      if (srv) renderGrupoReplicacaoModal(srv);
    } else {
      alert('Erro: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

async function removerDoGrupo(servidorIdAtual, servidorIdRemover) {
  if (!confirm('Desvincular este servidor do grupo de replicacao?')) return;

  try {
    const res = await fetch('/api/servidores/grupo-replicacao/remover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servidorId: servidorIdRemover }),
    });
    const data = await res.json();
    if (data.ok) {
      // Recarregar dados e re-renderizar modal
      const listRes = await fetch('/api/servidores');
      todosServidoresGeral = await listRes.json();
      if (document.getElementById('fvendasScreen').style.display !== 'none') {
        todosServidores = todosServidoresGeral;
      }
      const srv = todosServidoresGeral.find(s => s.id === servidorIdAtual);
      if (srv) renderGrupoReplicacaoModal(srv);
    } else {
      alert('Erro: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    alert('Erro: ' + err.message);
  }
}

// ══════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function now() {
  return new Date().toLocaleTimeString('pt-BR');
}
