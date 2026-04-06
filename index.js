'use strict';

const mqtt = require('mqtt');

// ─── Configuration ────────────────────────────────────────────────────────────

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com:1883';
const GALLONS_PER_CYCLE = parseInt(process.env.GALLONS_PER_CYCLE || '3', 10);
const TIMEZONE = 'America/Montreal';
const HIST_DAYS = 30;

// ─── State ────────────────────────────────────────────────────────────────────

// Map<deviceId, { date: "YYYY-MM-DD", gal: number, cycles: number }>
const dailyTotals = new Map();

// Map<deviceId, Array<{ date: "YYYY-MM-DD", gal: number }>>
const galHistory = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    // Day changed — archive previous day before resetting
    if (entry && entry.date !== today) {
      archiveDay(deviceId, entry);
    }
    entry = { date: today, gal: 0, cycles: 0 };
    dailyTotals.set(deviceId, entry);
    log(`[${deviceId}] Nouveau jour détecté: ${today} — compteur remis à zéro`);
  }
  return entry;
}

function archiveDay(deviceId, dayEntry) {
  if (dayEntry.gal === 0) return; // rien à archiver
  let hist = galHistory.get(deviceId) || [];
  // Éviter les doublons
  hist = hist.filter(h => h.date !== dayEntry.date);
  hist.push({ date: dayEntry.date, gal: dayEntry.gal });
  // Garder seulement les HIST_DAYS derniers jours
  hist.sort((a, b) => (a.date > b.date ? 1 : -1));
  if (hist.length > HIST_DAYS) hist = hist.slice(-HIST_DAYS);
  galHistory.set(deviceId, hist);
  log(`[${deviceId}] Journée archivée: ${dayEntry.date} = ${dayEntry.gal} gal (${dayEntry.gal / GALLONS_PER_CYCLE} cycles)`);
}

function publishDaily(client, deviceId) {
  const entry = dailyTotals.get(deviceId);
  if (!entry) return;
  const topic = `cyd/${deviceId}/settings/galToday`;
  const payload = JSON.stringify({ date: entry.date, gal: entry.gal, cycles: entry.cycles });
  client.publish(topic, payload, { retain: true, qos: 1 }, err => {
    if (err) log(`[${deviceId}] Erreur publish galToday:`, err.message);
    else log(`[${deviceId}] galToday publié: ${payload}`);
  });
}

function publishHistory(client, deviceId) {
  const hist = galHistory.get(deviceId);
  if (!hist || hist.length === 0) return;
  const topic = `cyd/${deviceId}/settings/galHist`;
  const payload = JSON.stringify(hist);
  client.publish(topic, payload, { retain: true, qos: 1 }, err => {
    if (err) log(`[${deviceId}] Erreur publish galHist:`, err.message);
    else log(`[${deviceId}] galHist publié (${hist.length} jours)`);
  });
}

// ─── Midnight reset scheduler ─────────────────────────────────────────────────

function scheduleMidnightReset(client) {
  const now = nowMontreal();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 5, 0); // 00:00:05 lendemain
  const msUntilMidnight = nextMidnight - now;

  log(`Prochain reset minuit dans ${Math.round(msUntilMidnight / 60000)} minutes`);

  setTimeout(() => {
    log('=== RESET MINUIT (America/Montreal) ===');
    for (const [deviceId, entry] of dailyTotals.entries()) {
      archiveDay(deviceId, entry);
      publishHistory(client, deviceId);
      // Reset le compteur du jour
      const today = todayStr();
      dailyTotals.set(deviceId, { date: today, gal: 0, cycles: 0 });
      publishDaily(client, deviceId);
    }
    // Replanifier pour le lendemain
    scheduleMidnightReset(client);
  }, msUntilMidnight);
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────

function connect() {
  log(`Connexion au broker: ${BROKER_URL}`);

  const client = mqtt.connect(BROKER_URL, {
    clientId: `cabane-bridge-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 5000,      // reconnexion toutes les 5s si déconnecté
    connectTimeout: 30 * 1000,
    keepalive: 60,
  });

  client.on('connect', () => {
    log('Connecté au broker MQTT');

    // S'abonner aux topics
    const topics = {
      'cyd/+/dompeur':         { qos: 1 },
      'cyd/+/settings/hist':   { qos: 1 },
      'cyd/+/dompeur/live':    { qos: 0 },
    };

    client.subscribe(topics, (err, granted) => {
      if (err) {
        log('Erreur subscribe:', err.message);
      } else {
        granted.forEach(g => log(`Abonné: ${g.topic} (qos ${g.qos})`));
      }
    });

    scheduleMidnightReset(client);
  });

  client.on('reconnect', () => {
    log('Tentative de reconnexion...');
  });

  client.on('offline', () => {
    log('Client hors-ligne');
  });

  client.on('error', err => {
    log('Erreur MQTT:', err.message);
  });

  client.on('message', (topic, payload, packet) => {
    // Ignorer les messages retained sauf settings/hist
    const isRetained = packet.retain;

    // Extraire le deviceId depuis le topic (cyd/<id>/...)
    const parts = topic.split('/');
    if (parts.length < 2) return;
    const deviceId = parts[1];

    // ── cyd/<id>/dompeur ────────────────────────────────────────────────────
    if (topic === `cyd/${deviceId}/dompeur`) {
      if (isRetained) {
        // Message retained résiduel — ignorer
        log(`[${deviceId}] dompeur retained ignoré`);
        return;
      }
      const entry = getOrInitDaily(deviceId);
      entry.cycles += 1;
      entry.gal += GALLONS_PER_CYCLE;
      log(`[${deviceId}] CYCLE DOMPEUR #${entry.cycles} → ${entry.gal} gal aujourd'hui (${entry.date})`);
      publishDaily(client, deviceId);
      return;
    }

    // ── cyd/<id>/settings/hist ──────────────────────────────────────────────
    if (topic === `cyd/${deviceId}/settings/hist`) {
      try {
        const arr = JSON.parse(payload.toString());
        if (Array.isArray(arr)) {
          // On reçoit l'historique du device (tableau de durées en secondes)
          // On le stocke juste pour référence — pas de traitement direct
          log(`[${deviceId}] settings/hist reçu: ${arr.length} entrées`);
        }
      } catch (e) {
        log(`[${deviceId}] settings/hist parse error:`, e.message);
      }
      return;
    }

    // ── cyd/<id>/dompeur/live ───────────────────────────────────────────────
    if (topic === `cyd/${deviceId}/dompeur/live`) {
      // Timer elapsed — on loggue seulement si besoin de debug
      // log(`[${deviceId}] live: ${payload.toString()}s`);
      return;
    }
  });

  return client;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

log('=== cabane-bridge démarrage ===');
log(`Timezone: ${TIMEZONE}`);
log(`Gallons par cycle: ${GALLONS_PER_CYCLE}`);
connect();
