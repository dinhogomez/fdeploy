// ── Estado local ──
const serverStatus = {}; // { id: { status, versao, log[], transferProgress } }
let arquivoPendente = null; // File selecionado aguardando confirmacao
let versaoAtiva = null; // Versao ativa atual

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  await verificarExe(); // Carregar versaoAtiva primeiro
  carregarServidores(); // Depois renderizar cards com badges
  carregarHistorico();
  setupDropZone();
});

// ══════════════════════════════════════════
// UPLOAD
// ══════════════════════════════════════════
function setupDropZone() {
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
  document.getElementById('fileInput').value = '';
}

function confirmarUpload() {
  const versao = document.getElementById('inputVersao').value.trim();
  if (!versao) {
    alert('Informe a versao antes de enviar');
    return;
  }
  if (!arquivoPendente) return;
  uploadFile(arquivoPendente, versao);
  document.getElementById('uploadConfirm').style.display = 'none';
  document.getElementById('dropZone').style.display = '';
  document.getElementById('inputVersao').value = '';
}

function uploadFile(file, versao) {
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
      // Salvar versao no backend
      if (versao) {
        fetch('/api/versao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ versao }),
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
  if (versoes.length > 0) {
    select.innerHTML = versoes.map(v =>
      `<option value="${v}" ${v === data.versao ? 'selected' : ''}>${v}${v === data.versao ? ' (ativa)' : ''}</option>`
    ).join('');
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
// SERVIDORES
// ══════════════════════════════════════════
let todosServidores = []; // Lista completa para filtro

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

  // Auto-scroll nos logs visíveis
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

  // Atualizar log
  const logEl = document.getElementById(`log-${id}`);
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

  // Atualizar progress de transferencia
  const tp = st.transferProgress;
  let tpEl = document.getElementById(`tp-${id}`);

  if (tp) {
    if (!tpEl) {
      // Criar elemento de progresso
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
  if (!confirm('Iniciar deploy neste servidor?')) return;

  // Inicializar estado
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
  if (!confirm('Iniciar deploy em TODOS os servidores?')) return;

  const fetchServidores = fetch('/api/servidores').then(r => r.json());
  fetchServidores.then(servidores => {
    // Marcar todos como pendentes (aguardando vez), exceto ja atualizados
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
            log: [{ ts: now(), msg: `Ja atualizado (v${data.versao})`, tipo: 'sucesso' }],
            logCollapsed: true,
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
          carregarServidores();
          carregarHistorico();
        }
      } catch (_) {}
    };

    evtSource.onerror = () => {
      evtSource.close();
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
  carregarServidores();
}

// ══════════════════════════════════════════
// MODAL
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
  document.getElementById('modalOverlay').classList.add('visible');
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
  };
  const senha = document.getElementById('fSenha').value;
  if (senha) body.senha = senha;

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
  carregarServidores();
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
// HISTORICO
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

// ── Utils ──
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function now() {
  return new Date().toLocaleTimeString('pt-BR');
}
