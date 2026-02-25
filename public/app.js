// ── Estado local ──
const serverStatus = {}; // { id: { status, versao, log[] } }

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
  xhr.onload = () => {
    pf.style.width = '100%';
    setTimeout(() => { pb.style.display = 'none'; }, 1000);
    verificarExe();
  };
  xhr.onerror = () => { alert('Erro no upload'); pb.style.display = 'none'; };
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
    const logHtml = (st.log || []).map(l =>
      `<div class="log-${l.tipo}">[${l.ts}] ${l.msg}</div>`
    ).join('');
    const logVisible = st.log && st.log.length > 0 ? 'visible' : '';

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
          <button class="btn btn-ghost btn-sm" onclick="testarServidor('${s.id}')">Testar</button>
          <button class="btn btn-success btn-sm" onclick="deployServidor('${s.id}')">Deploy</button>
          <button class="btn btn-ghost btn-sm" onclick="editarServidor('${s.id}')">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="removerServidor('${s.id}')">Remover</button>
        </div>
        <div class="deploy-log ${logVisible}" id="log-${s.id}">${logHtml}</div>
      </div>
    `;
  }).join('');
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

async function deployServidor(id) {
  if (!confirm('Iniciar deploy neste servidor?')) return;

  serverStatus[id] = { ...serverStatus[id], log: [{ ts: now(), msg: 'Iniciando deploy...', tipo: 'progresso' }] };
  carregarServidores();

  const res = await fetch(`/api/deploy/${id}`, { method: 'POST' });
  const data = await res.json();

  serverStatus[id] = {
    status: data.sucesso ? 'rodando' : 'erro',
    versao: serverStatus[id]?.versao,
    log: data.log || [],
  };
  carregarServidores();
  carregarHistorico();
}

async function verificarTodos() {
  const res = await fetch('/api/servidores');
  const servidores = await res.json();
  await Promise.all(servidores.map(s => testarServidor(s.id)));
}

async function atualizarTodos() {
  if (!confirm('Iniciar deploy em TODOS os servidores?')) return;

  const res = await fetch('/api/deploy/todos', { method: 'POST' });
  const results = await res.json();

  // Recarregar para pegar logs
  const srvRes = await fetch('/api/servidores');
  const servidores = await srvRes.json();
  results.forEach((r, i) => {
    if (servidores[i]) {
      serverStatus[servidores[i].id] = {
        status: r.sucesso ? 'rodando' : 'erro',
        log: r.log || [],
      };
    }
  });
  carregarServidores();
  carregarHistorico();
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

  // Salvar temporariamente para testar
  const res = await fetch('/api/servidores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { id } = await res.json();

  const testRes = await fetch(`/api/testar/${id}`, { method: 'POST' });
  const data = await testRes.json();

  // Remover temporário
  await fetch(`/api/servidores/${id}`, { method: 'DELETE' });

  if (data.conectou) {
    alert(`Conexao OK!\nServico: ${data.servico_status}\nVersao: ${data.versao_atual || '?'}`);
  } else {
    alert(`Falha na conexao: ${data.erro}`);
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
