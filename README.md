# FDeploy

Gerenciador de deploys do backend Fvendas em servidores Windows via SSH.
Roda localmente no Mac.

## Como iniciar

```bash
# Opção 1: duplo-clique no Finder
./iniciar.command

# Opção 2: terminal
npm install   # só na primeira vez
npm start
# Abrir http://localhost:3500
```

## Como usar

### Adicionar servidor
1. Clique em **+ Adicionar**
2. Preencha IP/DDNS, porta SSH, usuario e senha
3. Use **Testar conexao** para validar antes de salvar

### Fazer deploy individual
1. Faça upload do novo `Fvendas2.0.exe` na area de drag & drop
2. Clique em **Deploy** no card do servidor
3. Acompanhe o log em tempo real no card

### Deploy em massa
1. Faça upload do `.exe`
2. Clique em **Atualizar Todos**
3. Todos os servidores serao atualizados em paralelo

### Rollback automatico
Se o servico nao subir apos o deploy, o sistema automaticamente:
- Para o servico
- Restaura o backup (.exe.bak)
- Reinicia o servico
- Registra o erro no log

## Estrutura

```
fdeploy/
├── server.js           # Backend Express
├── package.json
├── iniciar.command      # Script de inicializacao Mac
├── data/
│   ├── servidores.json  # Servidores cadastrados (senhas AES)
│   └── deploy_log.json  # Historico de deploys
├── uploads/
│   └── Fvendas2.0.exe   # Exe para deploy
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## Caminhos remotos (Windows)

- **Exe:** `C:\f\Fvendas2.0\Fvendas2.0.exe`
- **Backup:** `C:\f\Fvendas2.0\Fvendas2.0.exe.bak`
- **Servico NSSM:** `Fvendas2.0`

## Porta

Roda em `localhost:3500`.
