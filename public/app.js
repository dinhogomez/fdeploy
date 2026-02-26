// ── Estado local ──
const serverStatus = {}; // { id: { status, versao, log[], transferProgress } }

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  carregarServidores();
  verificarExe();
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
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', () => { if (fi.files.length) uploadFile(fi.files[0]); });
}

function uploadFile(file) {
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
      verificarExe();
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

  if (data.disponivel) {
    badge.className = 'badge badge-ok';
    badge.textContent = `${data.arquivo} (${data.tamanho_mb} MB)`;
    info.style.display = 'block';
    const dt = new Date(data.modificado_em).toLocaleString('pt-BR');
    info.innerHTML = `<strong>${data.arquivo}</strong> &mdash; ${data.tamanho_mb} MB &mdash; ${dt}`;
  } else {
    badge.className = 'badge badge-no';
    badge.textContent = 'Nenhum .exe';
    info.style.display = 'none';
  }
}

// ══════════════════════════════════════════
// SERVIDORES
// ══════════════════════════════════════════
async function carregarServidores() {
  const res = await fetch('/api/servidores');
  const servidores = await res.json();
  renderServidores(servidores);
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
    const versao = st.versao || '—';
    const deploying = st.deploying || false;

    // Log
    const logHtml = (st.log || []).map(l =>
      `<div class="log-${l.tipo}">[${l.ts}] ${l.msg}</div>`
    ).join('');
    const logVisible = st.log && st.log.length > 0 ? 'visible' : '';

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
        </div>
        <div class="server-actions">
          <button class="btn btn-ghost btn-sm" onclick="testarServidor('${s.id}')" ${deploying ? 'disabled' : ''}>Testar</button>
          ${st.status === 'parado'
            ? `<button class="btn btn-success btn-sm" onclick="iniciarServico('${s.id}')" ${deploying ? 'disabled' : ''}>Iniciar Servico</button>`
            : ''}
          ${st.status === 'rodando'
            ? `<button class="btn btn-danger btn-sm" onclick="pararServico('${s.id}')" ${deploying ? 'disabled' : ''}>Parar Servico</button>`
            : ''}
          <button class="btn btn-success btn-sm" onclick="deployServidor('${s.id}')" ${deploying ? 'disabled' : ''}>
            ${deploying ? '<span class="spinner"></span> Deploying...' : 'Deploy'}
          </button>
          <button class="btn btn-ghost btn-sm" onclick="editarServidor('${s.id}')" ${deploying ? 'disabled' : ''}>Editar</button>
          <button class="btn btn-danger btn-sm" onclick="removerServidor('${s.id}')" ${deploying ? 'disabled' : ''}>Remover</button>
        </div>
        ${progressHtml}
        <div class="deploy-log ${logVisible}" id="log-${s.id}">${logHtml}</div>
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

async function testarServidor(id) {
  serverStatus[id] = { ...serverStatus[id], status: 'verificando...' };
  carregarServidores();

  const res = await fetch(`/api/testar/${id}`, { method: 'POST' });
  const data = await res.json();

  if (data.conectou) {
    serverStatus[id] = { status: data.servico_status, versao: data.versao_atual };
  } else {
    serverStatus[id] = { status: 'erro: ' + (data.erro || '?'), versao: null };
  }
  carregarServidores();
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
    servidores.forEach(s => {
      serverStatus[s.id] = {
        ...serverStatus[s.id],
        deploying: true,
        log: [],
        transferProgress: null,
      };
    });
    carregarServidores();

    const evtSource = new EventSource('/api/deploy/todos/stream');

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        const sid = data.servidorId;

        if (data.evento === 'log' && sid) {
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
        if (serverStatus[s.id]?.deploying) {
          serverStatus[s.id].deploying = false;
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

// ── Utils ──
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function now() {
  return new Date().toLocaleTimeString('pt-BR');
}
