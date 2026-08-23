# Discord 2.0 V6 — servidor online

Este diretório é a parte que precisa ficar online para PCs diferentes entrarem no mesmo servidor.

## Teste local
1. Instale Node.js 20+.
2. Abra o terminal nesta pasta.
3. Rode `npm install`.
4. Rode `npm start`.
5. Abra `http://localhost:3000`.

## Publicar
O projeto inclui `render.yaml`. Em um serviço Node compatível, use:
- Build: `npm install`
- Start: `npm start`
- Porta: a variável `PORT` é lida automaticamente.
- Para persistir `data.json`, configure `DATA_DIR` para uma pasta persistente.

Depois da publicação, copie a URL HTTPS do servidor. Ela será usada no aplicativo Desktop.
