# FDeploy

Gerenciador de deploys via SSH para servidores Windows.

## Stack
- **Backend**: Node.js + Express (porta 3500)
- **Frontend**: HTML/CSS/JS puro (SPA, sem frameworks)
- **SSH**: `node-ssh` (baseado em `ssh2`)
- **Compressao**: `zlib` nativo (gzip) + PowerShell `System.IO.Compression` (ZIP)

## Estrutura do Projeto

```
fdeploy/
├── server.js              # Backend completo (rotas, deploy, SSH, WMI, agent, scripts SQL)
├── package.json
├── build.js               # Script de build (fdeploy.exe + fdeploy-agent.exe)
├── CLAUDE.md              # Esta documentacao
├── agent/
│   ├── agent.js           # FDeploy Agent: HTTP server nativo (porta 3501)
│   ├── package.json       # Config pkg para gerar .exe
│   └── build-agent.js     # Script de build standalone do agent
├── public/
│   ├── index.html         # SPA com 3 telas: Home, Fvendas, Servidor Geral
│   ├── app.js             # Frontend: navegacao, estado, SSE, renderizacao
│   └── style.css          # Dark theme (GitHub-inspired)
├── data/
│   ├── servidores.json    # Lista de servidores (compartilhada entre modulos)
│   ├── versao.json        # Versao ativa do Fvendas { ativa, versoes[] }
│   ├── versao_geral.json  # Versao ativa do Servidor Geral { ativa, versoes[] }
│   ├── deploy_log.json    # Historico de deploys Fvendas (max 50)
│   ├── deploy_log_geral.json # Historico de deploys Servidor Geral (max 50)
│   ├── scripts_index.json # Indice incremental de scripts SQL
│   ├── versoes/           # Cache gzip do Fvendas: {versao}.gz
│   └── versoes_geral/     # Cache ZIP do Servidor Geral: {versao}_exes.zip, _dlls.zip, _reports.zip
├── uploads/               # .exe temporario do upload Fvendas
└── dist/
    ├── fdeploy.exe         # Build principal
    └── fdeploy-agent.exe   # Agent standalone (~35 MB)
```

## Modulos

### 1. Atualizacao Backend Fvendas

Deploy do `Fvendas2.0.exe` para servidores Windows.

**Fluxo:**
1. Upload do .exe → compacta em gzip → salva em cache `data/versoes/{versao}.gz`
2. Conecta SSH (com fallback WMI/DCOM para instalar OpenSSH)
3. Para servico `Fvendas2.0` → Backup → Upload SFTP do .gz → Descompacta via PowerShell
4. Grava `package.json` com versao → Inicia servico → Verifica status
5. Rollback automatico se servico nao iniciar

**Caminhos remotos:**
- EXE: `C:\f\Fvendas2.0\Fvendas2.0.exe`
- Backup: `C:\f\Fvendas2.0\Fvendas2.0Old.exe`
- Servico: `Fvendas2.0`

### 2. Atualizacao Servidor Geral

Deploy de EXEs, DLLs e Reports para servidores Windows.

**Caminhos de origem (local):**
- EXEs e DLLs: `C:\Net-Sql\Todos\DEBUG`
- Reports: `C:\Net-Sql\Todos\WebPrint\reports`

**Caminhos de destino (remoto):**
- EXEs e DLLs: `C:\f\Webfrigo`
- Reports: `C:\f\WebPrint\reports`

**Fluxo por servidor:**
1. Conectar via SSH
2. Detectar servico Apache (Apache2.4, Apache2.2, httpd, apache2, etc.)
3. Parar Apache (`net stop "NomeDoServico"`)
4. Enviar e descompactar `exes_update.zip` em `C:\f\Webfrigo`
5. Enviar e descompactar `dlls_update.zip` em `C:\f\Webfrigo`
6. Enviar e descompactar `reports_update.zip` em `C:\f\WebPrint\reports`
7. Executar scripts SQL pendentes (se PostgreSQL configurado) — ver secao abaixo
8. Iniciar Apache (`net start "NomeDoServico"`)
9. Registrar log

**Controle de versao:**
- Ao criar uma versao, o sistema empacota os arquivos fonte em 3 ZIPs
- ZIPs ficam em cache em `data/versoes_geral/{versao}_exes.zip`, `_dlls.zip`, `_reports.zip`
- Cada servidor rastreia `versaoGeralDeployada` e `ultimaAtualizacaoGeral`
- "Atualizar Todos" pula servidores ja na versao ativa

### Deteccao do Apache

A funcao `detectarApache(ssh)` tenta identificar o servico Apache no servidor remoto:

1. Tenta nomes comuns via `sc query`: Apache2.4, Apache2.2, httpd, apache2, Apache
2. Se nenhum encontrado, usa PowerShell `Get-Service` com regex `apache|httpd`
3. Retorna o nome do servico encontrado ou `null` se nao encontrar

### 3. Scripts SQL (integrado no deploy Servidor Geral)

Execucao automatica de scripts SQL em bancos PostgreSQL remotos via SSH + psql.
Baseado no ExeScript (Delphi), mas usando psql remoto em vez de conexao direta.

**Pasta raiz dos scripts:** `C:\Net-Sql\Todos\Scripts\ExeScript\Script`
Subpastas filtradas por regex: `/^Scripts \d{4}$/i` (ex: Scripts 2025, Scripts 2026)
Pastas fora do padrao (scripts_nuvem, scripts_diversos) sao ignoradas.

**Indexacao incremental (`data/scripts_index.json`):**
- Primeira execucao: varre todas as subpastas validas, abre cada .txt, extrai versao
- Proximas execucoes: so le arquivos novos (nao indexados)
- Botao "Reindexar" forca varredura completa
- Estrutura: `{ pastaRaiz, ultimaVarredura, pastasDetectadas[], scripts[{versao, arquivo}] }`

**Controle de versao sequencial:**
- Cada script .txt contem `set versao_bd = N,` que indica sua versao
- O banco tem `re.servidor.versao_bd` com a versao atual
- Scripts executados em ordem estritamente sequencial (versaoBD + 1, nunca pula)
- Se um script falha: para imediatamente, nao executa os seguintes
- Erro em scripts NAO bloqueia o deploy — Apache e iniciado normalmente

**Execucao via SSH + psql:**
1. Verifica disponibilidade do psql no servidor (`where psql`, fallback `C:\f\pgsql\psql.exe`)
2. Consulta versao_bd via `psql -h {pgHost} -t -A -c "SELECT versao_bd FROM re.servidor"`
3. Filtra scripts pendentes do indice (versao > versaoBD)
4. Para cada script: upload SFTP → `psql -h {pgHost} --single-transaction -f` → verificar resultado
5. PGPASSWORD passado como variavel de ambiente (cmd `set "PGPASSWORD=xxx"&&`)
6. Arquivos temporarios limpos apos execucao (`C:\temp\fdeploy_script_v*.txt`)
7. O script e sempre copiado e executado via SSH no servidor Windows (IP das aplicacoes)
8. O `-h` no psql define onde o banco esta: local (127.0.0.1) ou remoto (pgHost)

**Campos PostgreSQL no servidor (servidores.json):**
- `temPostgreSQL`: boolean (toggle no modal)
- `pgHost`: IP do banco remoto (string, vazio = banco local 127.0.0.1)
- `pgBanco`: nome do banco
- `pgPorta`: porta (default 5432)
- `pgUsuario`: usuario (default "frigo")
- `pgSenha`: criptografada AES (mesmo padrao do projeto)
- `versaoScriptBD`: ultima versao conhecida do banco

**Modal de execucao de scripts:**
- Abre automaticamente quando scripts comecam a executar
- Lista todos os scripts pendentes com status em tempo real
- Status: aguardando, executando (com animacao), sucesso, erro
- Se erro: mostra log completo do psql, botao Fechar
- Se sucesso: auto-fecha apos 3 segundos

### Instalacao remota do psql client

Servidores com `temPostgreSQL: true` precisam do `psql` para executar scripts SQL. Se nao tiver psql, o FDeploy pode instalá-lo remotamente.

**Fluxo (`POST /api/agent/:id/fix/psql`):**
1. Cria ZIP com binarios minimos do psql a partir do PostgreSQL local (`C:\Program Files\PostgreSQL\{18..12}\bin`)
2. Cache em `data/psql_client.zip` (~25-30 MB)
3. Upload via SFTP para `C:\f\pgsql\`
4. Extrai via PowerShell no servidor remoto
5. Adiciona `C:\f\pgsql` ao PATH do sistema (via agent ou `reg add`)
6. Valida: `psql.exe --version`

**Resolucao do psql (`resolverPsqlRemoto`):**
- Primeiro tenta `where psql` (PATH)
- Fallback: `C:\f\pgsql\psql.exe`
- Usado em: `executarScriptsSQL`, `verificar-replicacao`, `scripts/versao`

**Agent endpoint (`POST /fix/psql/path`):**
- Adiciona caminho ao PATH do sistema via `reg add`
- Verifica se psql.exe existe no caminho antes de modificar

## Lista de Servidores

A lista de servidores em `data/servidores.json` e **compartilhada** entre os dois modulos.
Cada servidor possui campos especificos de cada modulo:
- `versaoDeployada` — versao do Fvendas deployada
- `versaoGeralDeployada` — versao do Servidor Geral deployada
- `ultimaAtualizacaoGeral` — data/hora da ultima atualizacao geral
- `temPostgreSQL`, `pgBanco`, `pgPorta`, `pgUsuario`, `pgSenha` — dados PostgreSQL
- `versaoScriptBD` — ultima versao conhecida de scripts executados no banco

## API

### Rotas compartilhadas
- `GET/POST/PUT/DELETE /api/servidores` — CRUD de servidores
- `POST /api/servidores/:id/setup` — Setup Wizard (instalar agent + diagnosticar + extrair pendencias)
- `PUT /api/servidores/:id/pendencias` — Atualizar pendencias de um servidor
- `GET /api/testar/:id/stream` — Testar conexao SSH (SSE)
- `POST /api/servico/:id/iniciar|parar` — Controle do servico Fvendas

### Rotas Fvendas
- `POST /api/upload` — Upload do .exe
- `GET /api/upload/status` — Status do .exe e versoes
- `POST /api/versao` — Definir versao e compactar
- `GET /api/versoes` — Listar versoes em cache
- `POST /api/versao/selecionar` — Selecionar versao existente
- `GET /api/deploy/:id/stream` — Deploy individual (SSE)
- `GET /api/deploy/todos/stream` — Deploy em todos (SSE)
- `GET /api/historico` — Historico de deploys

### Rotas Servidor Geral
- `GET /api/geral/status` — Status dos arquivos fonte e versoes
- `POST /api/geral/versao` — Criar versao (empacotar ZIPs)
- `GET /api/geral/versoes` — Listar versoes em cache
- `POST /api/geral/versao/selecionar` — Selecionar versao existente
- `GET /api/geral/deploy/:id/stream` — Deploy individual (SSE)
- `GET /api/geral/deploy/todos/stream` — Deploy em todos (SSE)
- `GET /api/geral/historico` — Historico de deploys

### Rotas Scripts SQL
- `GET /api/geral/scripts/status` — Status do indice de scripts (pasta, total, versao)
- `POST /api/geral/scripts/config` — Configurar pasta raiz dos scripts
- `POST /api/geral/scripts/reindexar` — Forcar varredura completa do indice
- `GET /api/geral/scripts/versao/:id` — Verificar versao_bd de um servidor via SSH+psql

### Rotas Grupo de Replicacao
- `POST /api/servidores/grupo-replicacao` — Vincular dois servidores (body: `{ servidorIdA, servidorIdB }`)
- `POST /api/servidores/grupo-replicacao/remover` — Remover servidor do grupo (body: `{ servidorId }`)
- `GET /api/geral/verificar-replicacao/:id` — Verificar se servidor tem replicacao via psql

### 4. Servidores Irmaos (Replicacao)

Servidores que replicam dados entre si devem ser atualizados juntos, em sequencia.

**Campo `grupoReplicacao`** (string ID) em `servidores.json`:
- Relacao transitiva: se A e B sao irmaos e B e C sao irmaos, todos compartilham o mesmo grupo
- Ao vincular servidores com grupos diferentes, todos migram para o mesmo grupo
- Ao desvincular, se restar apenas 1 membro, o grupo e limpo automaticamente

**Deteccao de replicacao:**
- Via SSH + psql: `SELECT replica FROM replicacao.servidor`
- Se retorna valor (nao erro), servidor tem replicacao

**Fluxo de deploy com grupo:**
1. Deploy individual: se servidor tem replicacao e nao tem irmaos → bloqueio
2. Deploy individual: se servidor tem replicacao e tem irmaos → confirm com lista → deploy sequencial
3. "Atualizar Todos": grupos respeitados — se ALGUM membro precisa atualizar, deploy de TODOS; sem duplicatas

**Visual:**
- Servidores irmaos aparecem agrupados com borda azul na tela Servidor Geral
- Cards em grupo recebem badge "replica"
- Modal de edicao permite vincular/desvincular irmaos

### 5. Setup Wizard (ao criar servidor)

Ao criar um novo servidor, o sistema automaticamente instala o Agent, diagnostica pendencias e oferece correcoes.

**Fluxo:**
1. Usuario preenche modal → Salvar → `POST /api/servidores` (retorna `{ ok, id }`)
2. Modal fecha → diagModal abre como "Setup do Servidor"
3. `POST /api/servidores/:id/setup`:
   a. Conectar SSH → instalar Agent (NSSM + config + firewall)
   b. Aguardar Agent ficar online → `GET /diagnostico` via Agent
   c. Extrair pendencias → salvar em `servidores.json`
   d. Retornar `{ agentInstalado, agentOnline, diagnostico, pendencias, erro }`
4. Frontend renderiza resultado:
   - Tudo OK → "Servidor pronto!" + auto-fechar 3s
   - Com pendencias → grid diagnostico + botoes "Corrigir" + "Instalar Tudo" + "Pular"
5. Se pular → cards mostram badge de alerta com pendencias

**Campo `pendencias`** (string[]) em `servidores.json`:
- Valores possiveis: `ssh`, `agent`, `agent-offline`, `uac`, `openssh`, `firewall`, `diagnostico`
- Atualizado via `PUT /api/servidores/:id/pendencias`
- Limpo automaticamente quando `fixItem()` ou `corrigirTudo` resolve os problemas
- Badge nos cards: `⚠ N pendencia(s)` em vermelho

**Helper `instalarAgentNoServidor(ssh, servidor, servidores, idx)`:**
- Extraido da rota `POST /api/agent/:id/instalar` para reutilizacao
- Usado por: rota original de instalacao e rota `/setup`

### 6. FDeploy Agent

API auxiliar HTTP leve que roda nos servidores remotos para diagnostico e correcao automatica.

**Arquitetura:** Node.js HTTP server usando apenas modulos nativos. Porta 3501. Auth via Bearer token. Empacotado com pkg como .exe standalone.

**Diretorio no servidor remoto:** `C:\f\FDeploy Agent\` (fdeploy-agent.exe, config.json, agent.log)

**Execucao:** Tarefa agendada Windows (`schtasks /sc onstart /ru SYSTEM`)

**Endpoints do agent:**
- `GET /ping` (sem auth) — heartbeat
- `GET /diagnostico` — diagnostico completo (UAC, firewall, SSH, servicos, disco, memoria)
- `GET /diagnostico/{uac,firewall,openssh,servicos,sistema}` — diagnosticos individuais
- `POST /fix/uac` — liberar LocalAccountTokenFilterPolicy
- `POST /fix/firewall` — criar regra `{ porta, nome }`
- `POST /fix/firewall/remover` — remover regra `{ nome }`
- `POST /fix/openssh/instalar` — instalar OpenSSH via DISM
- `POST /fix/servico/{iniciar,parar,auto}` — controle de servico `{ nome }`
- `POST /fix/uac/revert` — reverter UAC (LocalAccountTokenFilterPolicy = 0)
- `POST /update` — self-update (recebe binario)
- `GET /config` — config e versao
- `GET /log?lines=50` — ultimas linhas do log

**Fluxo de deploy com agent — prepare/revert (3 camadas):**
1. Tentar SSH direto
2. Se falhar → `prepararDeployViaAgent()`: diagnosticar → habilitar UAC + abrir firewall 22 + iniciar sshd (temporario) → tentar SSH
3. Se tudo falhar → fallback WMI (comportamento original)
4. **Apos deploy (finally):** `reverterDeployViaAgent()` desfaz somente o que foi alterado:
   - Reverte UAC (LocalAccountTokenFilterPolicy = 0) via `POST /fix/uac/revert`
   - Fecha firewall porta 22 via `POST /fix/firewall/remover`
   - Para servico sshd via `POST /fix/servico/parar`
   - Tudo via Agent (porta 3501), independe do SSH

**Principio:** Agent e parceiro local do deploy — prepara o que o deploy precisa, executa, e reverte para manter seguranca original do servidor

**Instalacao:** Via SSH (automatica), via WMI (fallback), ou via script .bat manual

**Campos em servidores.json:** `agentPort`, `agentToken` (AES encrypted), `agentVersao`

### Rotas Agent (server.js)
- `GET /api/agent/status/todos` — Status de todos agents
- `GET /api/agent/:id/status` — Verificar agent
- `GET /api/agent/:id/diagnostico` — Diagnostico completo
- `POST /api/agent/:id/fix/:tipo` — Executar correcao (uac, firewall, openssh, tudo, etc.)
- `POST /api/agent/:id/instalar` — Instalar agent via SSH
- `POST /api/agent/:id/atualizar` — Atualizar agent
- `GET /api/agent/:id/log` — Log do agent
- `POST /api/agent/gerar-script/:id` — Gerar .bat de instalacao manual

## Validacao de Agent para Deploy

O Agent e **obrigatorio** para deploy. Antes de qualquer deploy (individual ou "Atualizar Todos"), o sistema valida:

1. **Agent instalado** — servidor tem `agentToken`
2. **Agent online** — responde ao `/ping`
3. **Agent na versao correta** — versao remota == `AGENT_EXPECTED_VERSION`

**Controle de versao do Agent:**
- `agent/package.json` → fonte unica da versao (usada por agent.js via `__dirname/package.json`)
- `build.js` → grava `data/agent-version.txt` para producao (pkg)
- `server.js` → `AGENT_EXPECTED_VERSION` le de `agent/package.json` (dev) ou `data/agent-version.txt` (prod)
- Agent: `VERSION` lê de `package.json` via `__dirname` (funciona em dev e pkg via `assets`)
- `pkg.assets` em `agent/package.json` garante que `package.json` e incluido no executavel

**Bloqueio no backend (`validarAgentParaDeploy`):**
- Deploy individual Fvendas/Geral: retorna entry com `bloqueadoPorAgent: true` sem conectar SSH
- "Atualizar Todos" Fvendas: pula servidor com evento SSE `deploy_bloqueado_agent`
- "Atualizar Todos" Geral — grupos: valida TODOS os membros; se algum falhar, bloqueia grupo inteiro
- "Atualizar Todos" Geral — standalone: pula servidor com evento SSE `deploy_bloqueado_agent`

**Bloqueio no frontend:**
- Botoes "Deploy"/"Atualizar" desabilitados com tooltip quando Agent nao esta pronto
- Safety check em `deployServidor()` e `deployServidorGeral()`: alert + return
- Painel do Agent mostra estado "Desatualizado" (amarelo) com botao "Atualizar"

**Fluxo para atualizar versao do Agent:**
1. Alterar versao em `agent/package.json`
2. Rebuild (`node build.js`)
3. No FDeploy, agents aparecem "Desatualizado"
4. Clicar "Atualizar" no card ou usar rota `POST /api/agent/:id/atualizar`

## UX — Feedback Visual Obrigatorio

**Regra geral:** toda rotina que leva tempo e executa multiplos processos (deploy, atualizacao de agent, instalacao, etc.) DEVE mostrar log em tempo real para o usuario via SSE (Server-Sent Events).

- Backend: usar SSE com eventos `log` (msg + tipo) e `concluido` (ok + descricao)
- Frontend: abrir modal ou painel com `deploy-log visible` e appendar cada mensagem
- Nunca fazer operacoes longas com `fetch` + `await` sem feedback visual
- Exemplos: deploy Fvendas (SSE), deploy Geral (SSE), atualizar Agent (SSE + diagModal), setup wizard

## Seguranca
- Senhas SSH criptografadas com AES-256-CBC
- XSS prevido com funcao `esc()` no frontend
- Erros nao tratados capturados globalmente para prevenir crash
- **Agent prepare/revert**: UAC, firewall porta 22 e sshd sao habilitados TEMPORARIAMENTE pelo Agent apenas durante o deploy, e revertidos automaticamente ao final (mesmo em caso de erro)
- Fallback WMI: porta 22 aberta temporariamente via WMI, regra removida via SSH ao final (`removerFirewallSSH`)
- UAC e firewall NAO tem botao "Corrigir" no frontend — sao gerenciados exclusivamente pelo Agent durante deploy
- Agent: Token SHA-256 unico por servidor, operacoes whitelist, validacao de nomes de servico

## Agent — Particularidades e Debug

### Logging
- Agent gera log detalhado em `agent.log` (rotativo, max 1MB)
- Niveis: DEBUG (cada comando executado + output), INFO (operacoes), WARN (problemas parciais), ERRO (falhas)
- Diagnostico completo logado com `=== DIAGNOSTICO COMPLETO ===` no inicio/fim com duracao

### Firewall — Ordem de verificacao
- `netsh advfirewall` e tentado PRIMEIRO (mais rapido, funciona sem elevacao)
- `Get-NetFirewallPortFilter` (PowerShell) so e usado como fallback
- **Razao**: `Get-NetFirewallPortFilter` exige elevacao e demora ~2s por porta quando falha
- Nos servidores (SYSTEM) ambos funcionam; no desktop/debug o PowerShell pode dar "Acesso negado"

### sc query — Respostas em portugues (PT-BR)
- Em servidores Windows PT-BR, o `sc query` retorna mensagens em portugues
- O agent usa `RUNNING`, `STOPPED` etc. que sao constantes do output independente do idioma
- O codigo de erro 1060 ("servico nao existe") aparece como numero, nao depende de idioma

### Deteccao de Apache
- Tenta em ordem: Apache2.4, Apache2.2, httpd, apache2, Apache (via `sc query`)
- Fallback: PowerShell `Get-Service` com regex `apache|httpd`
- O nome detectado e usado para parar/iniciar no deploy

### Agent como SYSTEM vs usuario
- No servidor real: roda como SYSTEM via tarefa agendada — tem acesso total
- Em debug local: roda como usuario — pode falhar em `Get-NetFirewallPortFilter`, `reg add` etc.
- O log sempre mostra o comando e o erro exato para debug

### Agent como servico Windows (NSSM)
- Agent e instalado como servico Windows usando NSSM (Non-Sucking Service Manager)
- Nome do servico: `FDeployAgent`, display: "FDeploy Agent"
- NSSM (nssm.exe ~331KB) e copiado junto com o agent para `C:\f\FDeploy Agent\`
- Configuracoes: `AUTO_START`, `AppExit=Restart`, `AppRestartDelay=5000`
- Vantagens sobre tarefa agendada: restart automatico em crash, `sc query`, visivel em services.msc
- Update: `nssm stop` → SFTP novo exe → `nssm start`
- Shutdown graceful via SIGINT (NSSM envia Ctrl+C)

### Por que NAO usar start/schtasks via SSH
- `start ""` via SSH **NAO persiste** o processo (morre quando sessao SSH fecha)
- `Start-Process -WindowStyle Hidden` via SSH tambem **NAO persiste**
- `schtasks /run` falha se o exe nao tem `process.stdin.resume()`
- NSSM resolve todos esses problemas nativamente

### Erros globais
- Agent tem `process.on('uncaughtException')` e `process.on('unhandledRejection')` para logar crashes
- `process.stdin.resume()` mantem o processo vivo (necessario para pkg executaveis)
- Shutdown graceful: `process.on('SIGINT/SIGTERM')` → `server.close()` → `process.exit(0)`
