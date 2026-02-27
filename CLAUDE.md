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
├── server.js              # Backend completo (rotas, deploy, SSH, WMI, scripts SQL)
├── package.json
├── CLAUDE.md              # Esta documentacao
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
└── uploads/               # .exe temporario do upload Fvendas
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
1. Verifica disponibilidade do psql no servidor (`where psql`)
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

## Seguranca
- Senhas SSH criptografadas com AES-256-CBC
- XSS prevido com funcao `esc()` no frontend
- Erros nao tratados capturados globalmente para prevenir crash
- Porta 22 aberta temporariamente via WMI apenas durante o deploy; regra de firewall removida via SSH ao final (`removerFirewallSSH`)
- Se SSH falha, fallback WMI cria regra de firewall, faz o deploy, e remove a regra ao concluir
