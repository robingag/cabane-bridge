# cabane-bridge

Service Node.js tournant 24/7 qui fait le bridge MQTT pour la Cabane Marcoux.

## Ce que ça fait

- Écoute `cyd/+/dompeur` → chaque message = 1 cycle = 3 gallons
- Maintient un compteur de gallons par jour (reset à minuit America/Montreal)
- Publie le total du jour sur `cyd/<id>/settings/galToday` (retained)
- Archive l'historique 30 jours sur `cyd/<id>/settings/galHist` (retained)

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `MQTT_BROKER_URL` | `mqtt://broker.hivemq.com:1883` | URL du broker MQTT |
| `GALLONS_PER_CYCLE` | `3` | Gallons par cycle de dompeur |

## Déploiement sur Render (gratuit)

### Prérequis
- Compte sur [render.com](https://render.com)
- Ce repo poussé sur GitHub (ex: `Robin-Gagnon/cabane-bridge`)

### Étapes

1. **Nouveau service** → *New > Web Service*
2. **Connecter le repo** GitHub `cabane-bridge`
3. **Configuration** :
   - Environment : `Node`
   - Build Command : `npm install`
   - Start Command : `node index.js`
   - Plan : **Free**
4. **Variables d'environnement** (optionnel) :
   - `MQTT_BROKER_URL` si tu veux changer de broker
   - `GALLONS_PER_CYCLE` si différent de 3
5. **Deploy**

> **Note Render Free** : Le service s'endort après 15 min d'inactivité HTTP. Comme ce service n'expose pas de port HTTP, Render le considère comme un "Background Worker" — choisir ce type pour éviter le sleep.

### Déploiement comme Background Worker (recommandé)

1. **New > Background Worker** (pas Web Service)
2. Connecter le repo
3. Build : `npm install`, Start : `node index.js`
4. Plan : **Free** (500h/mois — suffisant pour 24/7)

---

## Déploiement sur Railway (alternative)

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Sélectionner le repo
3. Railway détecte automatiquement Node.js
4. Variables d'env si nécessaire
5. **Deploy**

Railway Free : 500h/mois de compute.

---

## Déploiement avec Docker (local ou VPS)

```bash
docker build -t cabane-bridge .
docker run -d --restart=always --name cabane-bridge cabane-bridge
```

Avec variable d'env custom :
```bash
docker run -d --restart=always \
  -e MQTT_BROKER_URL=mqtt://broker.hivemq.com:1883 \
  -e GALLONS_PER_CYCLE=3 \
  --name cabane-bridge \
  cabane-bridge
```

---

## Topics MQTT

| Topic | Direction | Description |
|---|---|---|
| `cyd/+/dompeur` | Subscribe | Nouveau cycle dompeur (non-retained) |
| `cyd/+/settings/hist` | Subscribe | Historique des 30 cycles (JSON array) |
| `cyd/+/dompeur/live` | Subscribe | Timer elapsed en secondes |
| `cyd/<id>/settings/galToday` | Publish (retained) | Total du jour `{date, gal, cycles}` |
| `cyd/<id>/settings/galHist` | Publish (retained) | Historique 30 jours `[{date, gal}, ...]` |

## Test local

```bash
npm install
node index.js
```
