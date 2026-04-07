'use strict';

const mqtt = require('mqtt');
const http = require('http');

// --- Configuration ---

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com:1883';
const GALLONS_PER_CYCLE = parseInt(process.env.GALLONS_PER_CYCLE || '3', 10);
const TIMEZONE = 'America/Montreal';
const HIST_DAYS = 30;
const DOMPEUR_HIST_MAX = 30;
const PORT = process.env.PORT || 3000;

// --- State ---

// Map<deviceId, { date: "YYYY-MM-DD", gal: number, cycles: number }>
const dailyTotals = new Map();

// Map<deviceId, Array<{ date: "YYYY-MM-DD", gal: number }>>
const galHistory = new Map();

// Map<deviceId, Array<number>> — durée en secondes des 30 derniers cycles dompeur
const dompeurHist = new Map();

// MQTT client exposed at module level for HTTP handlers
let mqttClient = null;

// --- Helpers ---

function nowMontreal() {
  return new Date(new Date().toLocaleString('en-CA', { timeZone: TIMEZONE }));
}

function todayStr() {
  const d = nowMontreal();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function log(msg, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, ...args);
}

function getOrInitDaily(deviceId) {
  const today = todayStr();
  let entry = dailyTotals.get(deviceId);
  if (!entry || entry.date !== today) {
    if (entry && entry.date !== today) {
      archiveDay(deviceId, entry);
    }
    entry = { date: today, gal: 0, cycles: 0 };
    dailyTotals.set(deviceId, entry);
    log(`[${deviceId}] Nouveau jour detecte: ${today} - compteur remis a zero`);
  }
  return entry;
}

function archiveDay(deviceId, dayEntry) {
  if (dayEntry.gal === 0) return;
  let hist = galHistory.get(deviceId) || [];
  hist = hist.filter(h => h.date !== dayEntry.date);
  hist.push({ date: dayEntry.date, gal: dayEntry.gal });
  hist.sort((a, b) => (a.date > b.date ? 1 : -1));
  if (hist.length > HIST_DAYS) hist = hist.slice(-HIST_DAYS);
  galHistory.set(deviceId, hist);
  log(`[${deviceId}] Journee archivee: ${dayEntry.date} = ${dayEntry.gal} gal (${dayEntry.gal / GALLONS_PER_CYCLE} cycles)`);
}

function publishDaily(client, deviceId) {
  const entry = dailyTotals.get(deviceId);
  if (!entry) return;
  const topic = `cyd/${deviceId}/settings/galToday`;
  const payload = JSON.stringify({ date: entry.date, gal: entry.gal, cycles: entry.cycles });
  client.publish(topic, payload, { retain: true, qos: 1 }, err => {
    if (err) log(`[${deviceId}] Erreur publish galToday:`, err.message);
    else log(`[${deviceId}] galToday publie: ${payload}`);
  });
}

function publishHistory(client, deviceId) {
  const hist = galHistory.get(deviceId);
  if (!hist || hist.length === 0) return;
  const topic = `cyd/${deviceId}/settings/galHist`;
  const payload = JSON.stringify(hist);
  client.publish(topic, payload, { retain: true, qos: 1 }, err => {
    if (err) log(`[${deviceId}] Erreur publish galHist:`, err.message);
    else log(`[${deviceId}] galHist publie (${hist.length} jours)`);
  });
}

function publishDompeurHist(client, deviceId) {
  const hist = dompeurHist.get(deviceId) || [];
  const topic = `cyd/${deviceId}/settings/hist`;
  const payload = JSON.stringify(hist);
  client.publish(topic, payload, { retain: true, qos: 1 }, err => {
    if (err) log(`[${deviceId}] Erreur publish dompeur hist:`, err.message);
    else log(`[${deviceId}] dompeur hist publie (${hist.length} entrees)`);
  });
}

// --- HTTP server ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (req.method === 'POST' && req.url === '/api/seed') {
    let data;
    try {
      data = await parseBody(req);
    } catch (e) {
      log('seed parse error:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }

    const deviceId = data.deviceId || '5ea48c';

    if (data.galToday && typeof data.galToday === 'object') {
      const { date, gal, cycles } = data.galToday;
      dailyTotals.set(deviceId, { date, gal: Number(gal), cycles: Number(cycles) });
      log(`[${deviceId}] seed galToday: ${date} = ${gal} gal, ${cycles} cycles`);
      if (mqttClient && mqttClient.connected) {
        publishDaily(mqttClient, deviceId);
      }
    }

    if (data.galHist && Array.isArray(data.galHist)) {
      let hist = data.galHist.map(h => ({ date: h.date, gal: Number(h.gal) }));
      hist.sort((a, b) => (a.date > b.date ? 1 : -1));
      if (hist.length > HIST_DAYS) hist = hist.slice(-HIST_DAYS);
      galHistory.set(deviceId, hist);
      log(`[${deviceId}] seed galHist: ${hist.length} entrees`);
      if (mqttClient && mqttClient.connected) {
        publishHistory(mqttClient, deviceId);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deviceId }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  log(`Health-check HTTP server listening on port ${PORT}`);
});

// --- Midnight reset scheduler ---

function scheduleMidnightReset(client) {
  const now = nowMontreal();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 5, 0);
  const msUntilMidnight = nextMidnight - now;

  log(`Prochain reset minuit dans ${Math.round(msUntilMidnight / 60000)} minutes`);

  setTimeout(() => {
    log('=== RESET MINUIT (America/Montreal) ===');
    for (const [deviceId, entry] of dailyTotals.entries()) {
      archiveDay(deviceId, entry);
      publishHistory(client, deviceId);
      const today = todayStr();
      dailyTotals.set(deviceId, { date: today, gal: 0, cycles: 0 });
      publishDaily(client, deviceId);
    }
    scheduleMidnightReset(client);
  }, msUntilMidnight);
}

// --- MQTT ---

function connect() {
  log(`Connexion au broker: ${BROKER_URL}`);

  mqttClient = mqtt.connect(BROKER_URL, {
    clientId: `cabane-bridge-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 5000,
    connectTimeout: 30 * 1000,
    keepalive: 60,
  });

  mqttClient.on('connect', () => {
    log('Connecte au broker MQTT');

    const topics = {
      'cyd/+/dompeur':         { qos: 1 },
      'cyd/+/settings/hist':   { qos: 1 },
      'cyd/+/dompeur/live':    { qos: 0 },
    };

    mqttClient.subscribe(topics, (err, granted) => {
      if (err) {
        log('Erreur subscribe:', err.message);
      } else {
        granted.forEach(g => log(`Abonne: ${g.topic} (qos ${g.qos})`));
      }
    });

    scheduleMidnightReset(mqttClient);
  });

  mqttClient.on('reconnect', () => {
    log('Tentative de reconnexion...');
  });

  mqttClient.on('offline', () => {
    log('Client hors-ligne');
  });

  mqttClient.on('error', err => {
    log('Erreur MQTT:', err.message);
  });

  mqttClient.on('message', (topic, payload, packet) => {
    const isRetained = packet.retain;

    const parts = topic.split('/');
    if (parts.length < 2) return;
    const deviceId = parts[1];

    if (topic === `cyd/${deviceId}/dompeur`) {
      if (isRetained) {
        log(`[${deviceId}] dompeur retained ignore`);
        return;
      }
      const entry = getOrInitDaily(deviceId);
      entry.cycles += 1;
      entry.gal += GALLONS_PER_CYCLE;
      log(`[${deviceId}] CYCLE DOMPEUR #${entry.cycles} -> ${entry.gal} gal aujourd'hui (${entry.date})`);
      publishDaily(mqttClient, deviceId);

      // Historique durées dompeur (format "MM:SS" → secondes)
      const raw = payload.toString().trim();
      const timeParts = raw.split(':');
      if (timeParts.length === 2) {
        const minutes = parseInt(timeParts[0], 10);
        const seconds = parseInt(timeParts[1], 10);
        if (!isNaN(minutes) && !isNaN(seconds)) {
          const totalSec = minutes * 60 + seconds;
          let hist = dompeurHist.get(deviceId) || [];
          if (hist.length >= DOMPEUR_HIST_MAX) hist.shift();
          hist.push(totalSec);
          dompeurHist.set(deviceId, hist);
          publishDompeurHist(mqttClient, deviceId);
        }
      }
      return;
    }

    if (topic === `cyd/${deviceId}/settings/hist`) {
      // Restaure l'état depuis MQTT au démarrage (retained), ignore si déjà en mémoire
      if (isRetained && !dompeurHist.has(deviceId)) {
        try {
          const arr = JSON.parse(payload.toString());
          if (Array.isArray(arr)) {
            dompeurHist.set(deviceId, arr.slice(-DOMPEUR_HIST_MAX));
            log(`[${deviceId}] dompeur hist restaure depuis MQTT: ${arr.length} entrees`);
          }
        } catch (e) {
          log(`[${deviceId}] settings/hist parse error:`, e.message);
        }
      }
      return;
    }

    if (topic === `cyd/${deviceId}/dompeur/live`) {
      return;
    }
  });

  return mqttClient;
}

// --- Entry point ---

log('=== cabane-bridge demarrage ===');
log(`Timezone: ${TIMEZONE}`);
log(`Gallons par cycle: ${GALLONS_PER_CYCLE}`);
connect();
