require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8090;
const COINS_API_URL = process.env.COINS_API_URL || 'http://127.0.0.1:5001';

const GIST_ID = '4cd4e8d26eb6efbc292ca41fdda70af8';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'ghp_YOUR_TOKEN_HERE';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch(e) { console.error('[-] Erro ao ler settings.json', e.message); }
  return { price: 25, targetCharacter: 'Nora Fylap' };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// Endpoint para puxar configurações (Público)
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

// Proxy para buscar dados do personagem no TibiaData
app.get('/api/character/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const url = `https://api.tibiadata.com/v4/character/${encodeURIComponent(name)}`;
    console.log(`[*] Buscando personagem '${name}' na API TibiaData...`);
    
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: 'Erro ao consultar a API TibiaData' });
    
    const data = await response.json();
    if (!data.character || !data.character.character || !data.character.character.name) {
      return res.status(404).json({ error: 'Personagem nao encontrado' });
    }
    
    const char = data.character.character;
    res.json({ name: char.name, world: char.world, level: char.level, vocation: char.vocation });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// Retorna YYYY-MM-DD para daqui a 30 dias
function getExpirationDate() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().split('T')[0];
}

// Atualiza o Gist
async function updateGist(uuid, character = 'Unknown') {
  const url = `https://api.github.com/gists/${GIST_ID}`;
  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Mauth-Sales-App'
  };

  const getRes = await fetch(url, { headers });
  if (!getRes.ok) throw new Error(`Falha ao ler Gist: ${getRes.status}`);
  
  const getJson = await getRes.json();
  const file = getJson.files['mauth.txt'];
  let contentText = file ? file.content : '';

  const cleanUuid = uuid.trim().toUpperCase();
  
  // Evita duplicatas se UUID já constar (só checa a string)
  if (contentText.includes(cleanUuid)) {
    console.log(`[*] UUID ${cleanUuid} ja consta no Gist.`);
    return true;
  }

  const expDate = getExpirationDate();
  const newEntry = `[EXP: ${expDate}] ${cleanUuid} # Boneco: ${character}`;
  
  let updatedText = contentText;
  if (!updatedText.endsWith('\n') && updatedText.length > 0) updatedText += '\n';
  updatedText += newEntry + '\n';

  const patchBody = { files: { 'mauth.txt': { content: updatedText } } };

  const patchRes = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(patchBody)
  });

  if (!patchRes.ok) throw new Error(`Erro ao gravar no Gist: ${patchRes.status}`);
  return true;
}

// Limpeza de licenças expiradas no Gist
async function cleanExpiredGistLicenses() {
  console.log(`[*] Verificando licenças expiradas no Gist...`);
  try {
    const url = `https://api.github.com/gists/${GIST_ID}`;
    const headers = {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Mauth-Sales-App'
    };

    const getRes = await fetch(url, { headers });
    if (!getRes.ok) return;
    
    const getJson = await getRes.json();
    const file = getJson.files['mauth.txt'];
    if (!file) return;

    const lines = file.content.split('\n');
    let hasChanges = false;
    const today = new Date().toISOString().split('T')[0];

    const newLines = lines.filter(line => {
      const match = line.match(/\[EXP: (\d{4}-\d{2}-\d{2})\]/);
      if (match) {
        if (match[1] < today) {
          console.log(`[*] Apagando licença expirada: ${line}`);
          hasChanges = true;
          return false; 
        }
      }
      return true;
    });

    if (hasChanges) {
      await fetch(url, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { 'mauth.txt': { content: newLines.join('\n') } } })
      });
      console.log(`[*] Limpeza do Gist finalizada!`);
    } else {
      console.log(`[*] Gist limpo. Nenhuma licença vencida.`);
    }
  } catch (err) {
    console.error(`[-] Erro no lixeiro do Gist:`, err.message);
  }
}

// Confirmação de Pagamento
app.post('/api/confirm-payment', async (req, res) => {
  const { character, uuid, product } = req.body;
  if (!character || !uuid) return res.status(400).json({ error: 'Dados incompletos.' });

  const cleanChar = character.trim();
  const cleanUuid = uuid.trim().toUpperCase();
  const cleanProduct = (product || 'mauth').trim().toLowerCase();

  if (cleanUuid.length < 10) return res.status(400).json({ error: 'UUID invalida.' });

  try {
    const settings = getSettings();
    const requiredAmount = cleanProduct.includes('bossbot') 
      ? parseInt(process.env.BOSSBOT_COINS_AMOUNT || '1000', 10)
      : parseInt(settings.price || '25', 10);

    const checkUrl = `${COINS_API_URL}/api/check-payment?character=${encodeURIComponent(cleanChar)}&amount=${requiredAmount}`;
    const checkRes = await fetch(checkUrl);
    if (!checkRes.ok) return res.status(checkRes.status).json({ error: 'Erro ao conectar com Coins API.' });
    
    const checkData = await checkRes.json();
    if (!checkData.found || !checkData.payment) {
      return res.status(404).json({ error: `Pagamento nao encontrado (Min: ${requiredAmount} TC).` });
    }
    
    const payment = checkData.payment;
    
    const useUrl = `${COINS_API_URL}/api/use-payment`;
    const useRes = await fetch(useUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: payment.id, metadata: { uuid: cleanUuid } })
    });
    
    if (!useRes.ok) return res.status(useRes.status).json({ error: 'Erro ao resgatar transacao.' });
    
    await updateGist(cleanUuid, payment.character);
    res.json({ status: 'success', message: 'Licenca de 30 dias ativada com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

// Geração Admin de Licenças (Bypass)
app.post('/api/admin/generate', async (req, res) => {
  const { username, password, character, uuid } = req.body;
  if (username !== 'genkidamma' || password !== 'C7kgxmwt!@#') {
    return res.status(401).json({ error: 'Acesso negado: Credenciais inválidas.' });
  }
  
  if (!character || !uuid) return res.status(400).json({ error: 'Faltam dados obrigatórios.' });

  try {
    await updateGist(uuid, character);
    res.json({ status: 'success', message: `Licença manual gerada para '${character}' (Validade 30 dias).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualização das Configurações Globais (Admin)
app.post('/api/admin/settings', (req, res) => {
  const { username, password, price, targetCharacter } = req.body;
  
  if (username !== 'genkidamma' || password !== 'C7kgxmwt!@#') {
    return res.status(401).json({ error: 'Acesso negado: Credenciais inválidas.' });
  }
  
  if (!price || !targetCharacter) {
    return res.status(400).json({ error: 'Faltam dados obrigatórios.' });
  }
  
  try {
    const settings = {
      price: parseInt(price, 10),
      targetCharacter: targetCharacter.trim()
    };
    saveSettings(settings);
    res.json({ status: 'success', message: 'Configurações atualizadas com sucesso!', settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

setInterval(cleanExpiredGistLicenses, 86400000);
setTimeout(cleanExpiredGistLicenses, 5000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(`🚀 M-Auth Sales Server rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://127.0.0.1:${PORT}`);
  console.log(`==================================================`);
});
