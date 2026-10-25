// oc-inter-relay — Worker international, Optical Center
// Version 2026.10.25-1 (lot 0 : secrets Cloudflare, protection PEDLV/Kaizen, routes
// /notify /google-ratings /rh-effectif /analyze /com-hebdo ajoutées).
// V1 : couvre uniquement Bilan de Passage AR (relais SOAP Zimbra + persistance D1).
// Les autres apps (PEDLV, Kaizen, Évaluation Équipe, Observations Terrain, RH,
// Accompagnement Manager) seront ajoutées à ce même fichier au fur et à mesure,
// en reprenant le même pattern que le worker.js France.
//
// Différences volontaires par rapport à la version France :
// - Plus de secret statique (STORE_SECRET / NOTIFY_SECRET) transmis par le client.
//   Toutes les routes d'écriture exigent une session animateur valide (X-AR-Session),
//   obtenue via /ar-login après une vraie authentification Zimbra. C'est la correction
//   de la dette technique France actée dès le départ international.
// - magasins_inter.csv : séparateur point-virgule (vérifié sur le fichier réel —
//   contient des décimales à virgule française type "6,6"), nouvelles colonnes
//   (langue, region, directrice_inter, directeur_pays + sa langue, animateur + sa langue).

const ALLOWED_ORIGIN = 'https://oc-inter.github.io';
const ZIMBRA_SOAP_URL = 'https://zimbra.oc-pratique.com/service/soap';
const ZIMBRA_UPLOAD_URL = 'https://zimbra.oc-pratique.com/service/upload?fmt=raw';

// Clé de signature interne des sessions animateur (HMAC), jamais exposée côté client.
// Distincte de celle utilisée en France.
// 25/10 : la clé n'est plus écrite dans le code. Elle est lue au démarrage de
// chaque requête / cron dans le secret Cloudflare AR_SESSION_KEY.
let AR_SESSION_SECRET = '';
const AR_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, comme en France

const MAGASINS_CSV_URL = 'https://raw.githubusercontent.com/oc-inter/bilan-passage/main/magasins_inter.csv';
const KAIZEN_REFERENTIEL_URL = 'https://raw.githubusercontent.com/oc-inter/kaizen/main/kaizen-referentiel.csv';
const KAIZEN_POINTS_PAR_ITEM = 0.5;

// À confirmer : adresse de Cécilia (Directrice Inter) — mise en priorité sur les
// alertes admin, Olivier reste en copie. Corrige la valeur avant le premier déploiement.
const ADMIN_ALERT_EMAILS = ['cecilia.lecomte@optical-center.com', 'olivier.baroukh@optical-center.com'];

// Comptes ayant un accès complet ("ALL", tous magasins/pays) sur Bilan de Passage,
// indépendamment du référentiel magasins_inter.csv. Comparaison sur l'email Zimbra
// complet plutôt qu'un test de nom (moins fragile que la version France, qui ne
// testait qu'un fragment du nom "baroukh").
const ADMIN_FULL_ACCESS_EMAILS = ['cecilia.lecomte@optical-center.com', 'olivier.baroukh@optical-center.com'];

// ---------- Évaluation Équipe ----------
// Objectif unique pour tout le réseau (comme en France) — à revoir si Cécilia
// souhaite un objectif variable par pays/région, sur le modèle de renta_target.
const OBJECTIF_NIVEAU_EQUIPE = 8.0;

// Contrairement à la France (table D1 criteres_taches, active_depuis_annee pour
// gérer l'ouverture différée d'une tâche), les tâches et leurs 10 critères sont
// pilotés par ce fichier CSV, éditable par Olivier sans toucher au code. Les
// tâches ET les critères peuvent différer d'un pays à l'autre (colonne pays).
// Pas de notion d'"ouverture différée" côté international : toute ligne présente
// dans le fichier est active immédiatement.
const CRITERES_CSV_URL = 'https://raw.githubusercontent.com/oc-inter/eval-equipe/main/criteres_taches.csv';

let _criteresCache = null;
let _criteresCacheAt = 0;

// Séparateur point-virgule, comme magasins_inter.csv (vérifié sur le fichier
// réel — pas de virgule comme séparateur de colonnes dans aucun des deux) :
// les libellés de critères sont du texte libre contenant fréquemment des
// virgules. Langues de traduction disponibles pour les tâches/critères (HE
// laissé de côté pour l'instant, comme Bilan de Passage — repli FR si HE demandé).
const CRITERES_LANGUES = ['EN', 'ES', 'NL'];

async function getCriteresTachesServerSide() {
  const now = Date.now();
  if (_criteresCache && (now - _criteresCacheAt) < 10 * 60 * 1000) return _criteresCache;
  const resp = await fetch(CRITERES_CSV_URL + '?v=' + now);
  const text = await resp.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(';').map(h => h.trim());
  const iPays = header.indexOf('pays');
  const iTache = header.indexOf('tache');
  const iOrdre = header.indexOf('ordre');
  const iLibelle = header.indexOf('libelle');
  const iTacheLang = {};
  const iLibelleLang = {};
  for (const lang of CRITERES_LANGUES) {
    iTacheLang[lang] = header.indexOf('tache_' + lang);
    iLibelleLang[lang] = header.indexOf('libelle_' + lang);
  }

  const rows = lines.slice(1).map(line => {
    const cols = line.split(';');
    const row = {
      pays: (cols[iPays] || '').trim(),
      tache: (cols[iTache] || '').trim(),
      ordre: parseInt((cols[iOrdre] || '0').trim(), 10) || 0,
      libelle: iLibelle >= 0 ? (cols[iLibelle] || '').trim() : '',
    };
    for (const lang of CRITERES_LANGUES) {
      row['tache_' + lang] = iTacheLang[lang] >= 0 ? (cols[iTacheLang[lang]] || '').trim() : '';
      row['libelle_' + lang] = iLibelleLang[lang] >= 0 ? (cols[iLibelleLang[lang]] || '').trim() : '';
    }
    return row;
  }).filter(r => r.pays && r.tache);

  rows.sort((a, b) => a.tache === b.tache ? a.ordre - b.ordre : a.tache.localeCompare(b.tache));
  _criteresCache = rows;
  _criteresCacheAt = now;
  return rows;
}

// Résout un champ ('tache' ou 'libelle') pour une langue donnée : colonne
// <field>_<LANGUE> si elle existe et est renseignée, sinon repli sur le
// français. Ne traduit jamais l'identifiant réel stocké côté serveur (r.tache
// brut) — uniquement ce qui est renvoyé pour affichage.
function resolveCritereLabel(row, field, langue) {
  const code = (langue || '').toUpperCase();
  if (code && CRITERES_LANGUES.includes(code)) {
    const v = row[field + '_' + code];
    if (v) return v;
  }
  return row[field];
}

// Regroupe les lignes de critères par (pays, tâche) -> tableau de libellés ordonnés.
function groupCriteresByPaysTache(criteresRows) {
  const parPaysTache = {};
  for (const r of criteresRows) {
    const key = r.pays + '||' + r.tache;
    (parPaysTache[key] ??= []).push(r.libelle);
  }
  return parPaysTache;
}

function anneeCouranteEval() {
  return new Date().getUTCFullYear();
}

function csvEscapeEval(v) {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function buildNiveauxEvalCsv(env) {
  const annee = anneeCouranteEval();
  const magasinsRef = await getMagasinsServerSide();

  const { results: notes } = await env.DB.prepare(
    `SELECT magasin_code, tache, note FROM notes_equipe WHERE annee = ?`
  ).bind(annee).all();

  const criteresRows = await getCriteresTachesServerSide();
  const nomsTaches = [...new Set(criteresRows.map(r => r.tache))].sort();

  const parMagasin = {};
  for (const n of notes) {
    const m = (parMagasin[n.magasin_code] ??= {});
    (m[n.tache] ??= []).push(n.note);
  }

  const header = ['Code magasin', 'Magasin', 'Pays', 'Animateur', ...nomsTaches, 'Niveau équipe', 'Objectif', 'Écart'];
  const lignes = [header];

  for (const mag of magasinsRef) {
    const parTache = parMagasin[mag.code] || {};
    const moyennesParTache = nomsTaches.map(t => {
      const notesArr = parTache[t];
      if (!notesArr || !notesArr.length) return '';
      const top3 = [...notesArr].sort((a, b) => b - a).slice(0, 3);
      return (top3.reduce((s, n) => s + n, 0) / top3.length).toFixed(1);
    });
    const valeurs = moyennesParTache.filter(v => v !== '').map(Number);
    const niveau = valeurs.length ? valeurs.reduce((s, v) => s + v, 0) / valeurs.length : null;
    const ecart = niveau != null ? (niveau - OBJECTIF_NIVEAU_EQUIPE).toFixed(1) : '';

    lignes.push([
      mag.code, mag.libelle, mag.pays || '', mag.animateur || '',
      ...moyennesParTache,
      niveau != null ? niveau.toFixed(1) : '',
      OBJECTIF_NIVEAU_EQUIPE.toFixed(1),
      ecart,
    ]);
  }

  return lignes.map(row => row.map(csvEscapeEval).join(';')).join('\r\n');
}

// ---------- Référentiel magasins ----------
let _magasinsCache = null;
let _magasinsCacheAt = 0;

async function getMagasinsServerSide() {
  const now = Date.now();
  if (_magasinsCache && (now - _magasinsCacheAt) < 10 * 60 * 1000) return _magasinsCache;
  const resp = await fetch(MAGASINS_CSV_URL + '?v=' + now);
  const text = await resp.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  // Séparateur point-virgule (vérifié sur le fichier réel) : magasins_inter.csv
  // contient des valeurs décimales à virgule française (ex. eff_theo "6,6"), pas
  // de virgule comme séparateur de colonnes — un split(',') viderait tous les
  // champs (idx('code') etc. renverrait -1 sur un header non éclaté).
  const header = lines[0].split(';').map(h => h.trim());

  const idx = (name) => header.indexOf(name);
  const iCode = idx('code');
  const iLibelle = idx('libelle');
  const iPays = idx('pays');
  const iRegion = idx('region');
  const iLangue = idx('langue');
  const iDevise = idx('devise');
  const iFuseau = idx('fuseau_horaire');
  const iDirecteurPays = idx('directeur_pays');
  const iDirectriceInter = idx('directrice_inter');
  const iLangueDirecteurPays = idx('langue_directeur_pays');
  const iDirecteurPaysEmail = idx('directeur_pays_email');
  const iAnimateur = idx('animateur');
  const iLangueAnimateur = idx('langue_animateur');
  const iAnimateurEmail = idx('animateur_email');
  const iEffOpt = idx('eff_opt');
  const iEffAudio = idx('eff_audio');
  const iEffTheo = idx('eff_theo');
  const iConcept = idx('concept');
  const iMeubleVitrine = idx('meuble_vitrine');
  const iPresentoirVerres = idx('presentoir_verres');
  const iPlaceId = idx('google_place_id');

  const num = (v) => {
    const s = (v || '').trim();
    if (!s) return null;
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const bool = (v) => /^(oui|1|true)$/i.test((v || '').trim());

  const rows = lines.slice(1).map(line => {
    const cols = line.split(';');
    return {
      code: (cols[iCode] || '').trim(),
      libelle: iLibelle >= 0 ? (cols[iLibelle] || '').trim() : '',
      pays: iPays >= 0 ? (cols[iPays] || '').trim() : '',
      region: iRegion >= 0 ? (cols[iRegion] || '').trim() : '',
      langue: iLangue >= 0 ? (cols[iLangue] || '').trim() : '',
      devise: iDevise >= 0 ? (cols[iDevise] || '').trim() : '',
      fuseauHoraire: iFuseau >= 0 ? (cols[iFuseau] || '').trim() : '',
      directeurPays: iDirecteurPays >= 0 ? (cols[iDirecteurPays] || '').trim() : '',
      directriceInter: iDirectriceInter >= 0 ? (cols[iDirectriceInter] || '').trim() : '',
      langueDirecteurPays: iLangueDirecteurPays >= 0 ? (cols[iLangueDirecteurPays] || '').trim() : '',
      directeurPaysEmail: iDirecteurPaysEmail >= 0 ? (cols[iDirecteurPaysEmail] || '').trim() : '',
      animateur: iAnimateur >= 0 ? (cols[iAnimateur] || '').trim() : '',
      langueAnimateur: iLangueAnimateur >= 0 ? (cols[iLangueAnimateur] || '').trim() : '',
      animateurEmail: iAnimateurEmail >= 0 ? (cols[iAnimateurEmail] || '').trim() : '',
      effOpt: num(iEffOpt >= 0 ? cols[iEffOpt] : null),
      effAudio: num(iEffAudio >= 0 ? cols[iEffAudio] : null),
      effTheo: num(iEffTheo >= 0 ? cols[iEffTheo] : null),
      concept: iConcept >= 0 ? (cols[iConcept] || '').trim() : '',
      meubleVitrine: iMeubleVitrine >= 0 ? bool(cols[iMeubleVitrine]) : false,
      presentoirVerres: iPresentoirVerres >= 0 ? bool(cols[iPresentoirVerres]) : false,
      googlePlaceId: iPlaceId >= 0 ? (cols[iPlaceId] || '').trim() : '',
    };
  }).filter(r => r.code);

  _magasinsCache = rows;
  _magasinsCacheAt = now;
  return rows;
}

// ---------- Kaizen : référentiel de zones/items (statique, hébergé sur GitHub) ----------
let _kaizenRefCache = null;
let _kaizenRefCacheAt = 0;

// Référentiel Kaizen lu directement depuis un CSV plat (une ligne par item),
// exactement comme magasins_inter.csv ou criteres_taches.csv — Olivier modifie
// son fichier Excel, l'exporte en CSV (point-virgule), le pousse sur GitHub,
// c'est pris en compte au prochain appel (cache 10 min) sans repasser par du
// code. Colonnes attendues : numero;nom;nom_EN;nom_ES;secteur;secteur_EN;
// secteur_ES;libelle;libelle_EN;libelle_ES;concept;pays;hors_notation
// (17/09, remplace l'ancien format JSON généré à la main).
async function getKaizenReferentiel() {
  const now = Date.now();
  if (_kaizenRefCache && (now - _kaizenRefCacheAt) < 10 * 60 * 1000) return _kaizenRefCache;
  const resp = await fetch(KAIZEN_REFERENTIEL_URL + '?v=' + now);
  const text = await resp.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(';').map(h => h.trim());
  const idx = name => header.indexOf(name);
  const iNumero = idx('numero'), iNom = idx('nom'), iNomEn = idx('nom_EN'), iNomEs = idx('nom_ES'),
        iSecteur = idx('secteur'), iSecteurEn = idx('secteur_EN'), iSecteurEs = idx('secteur_ES'),
        iLibelle = idx('libelle'), iLibelleEn = idx('libelle_EN'), iLibelleEs = idx('libelle_ES'),
        iConcept = idx('concept'), iPays = idx('pays'), iHorsNotation = idx('hors_notation');

  const zonesMap = new Map();
  const zonesOrder = [];
  for (const line of lines.slice(1)) {
    const c = line.split(';');
    const numero = (c[iNumero] || '').trim();
    const libelle = (c[iLibelle] || '').trim();
    if (!numero || !libelle) continue;

    if (!zonesMap.has(numero)) {
      zonesMap.set(numero, {
        numero: /^\d+$/.test(numero) ? parseInt(numero, 10) : numero,
        nom: (c[iNom] || '').trim(),
        nom_EN: iNomEn >= 0 ? (c[iNomEn] || '').trim() : '',
        nom_ES: iNomEs >= 0 ? (c[iNomEs] || '').trim() : '',
        secteursOrder: [], secteursMap: new Map(),
      });
      zonesOrder.push(numero);
    }
    const zone = zonesMap.get(numero);
    const secteurNom = (c[iSecteur] || '').trim() || null;
    const skey = secteurNom || '__default__';
    if (!zone.secteursMap.has(skey)) {
      zone.secteursMap.set(skey, {
        nom: secteurNom,
        nom_EN: iSecteurEn >= 0 ? (c[iSecteurEn] || '').trim() : '',
        nom_ES: iSecteurEs >= 0 ? (c[iSecteurEs] || '').trim() : '',
        items: [],
      });
      zone.secteursOrder.push(skey);
    }
    const secteur = zone.secteursMap.get(skey);
    const item = {
      id: `z${numero}-${secteur.items.length + 1}${secteurNom ? '-' + secteurNom.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-') : ''}`,
      label: libelle,
      label_EN: iLibelleEn >= 0 ? (c[iLibelleEn] || '').trim() : '',
      label_ES: iLibelleEs >= 0 ? (c[iLibelleEs] || '').trim() : '',
      concept: iConcept >= 0 ? ((c[iConcept] || '').trim() || 'Tous') : 'Tous',
      pays: iPays >= 0 ? (c[iPays] || '').trim() : '',
    };
    if (iHorsNotation >= 0 && /^oui$/i.test((c[iHorsNotation] || '').trim())) item.optional = true;
    secteur.items.push(item);
  }

  const zones = zonesOrder.map(numero => {
    const z = zonesMap.get(numero);
    const secteurs = z.secteursOrder.map(skey => z.secteursMap.get(skey));
    const zoneObj = { numero: z.numero, nom: z.nom, nom_EN: z.nom_EN, nom_ES: z.nom_ES, secteurs };
    const allItems = secteurs.flatMap(s => s.items);
    if (allItems.length && allItems.every(i => i.optional)) zoneObj.optional = true;
    return zoneObj;
  });

  _kaizenRefCache = zones;
  _kaizenRefCacheAt = now;
  return zones;
}

// Aplatit le référentiel en une liste d'items filtrée selon le concept ET le
// pays du magasin (16/09, décision Olivier : les variantes internationales
// n'existent pas encore, mais le champ pays est prêt pour quand elles
// apparaîtront — un item avec pays vide s'applique à tous les pays).
// Les 17 magasins internationaux sans concept renseigné dans magasins_inter.csv
// (Belgique/Luxembourg/Suisse à ce jour) sont traités comme "UDM" par défaut
// plutôt que de leur couper des zones entières (Facing Montures notamment) —
// à corriger dans le référentiel magasins quand Olivier aura les vraies valeurs.
function kaizenItemsApplicables(zones, concept, pays) {
  const conceptNorm = (concept || 'UDM').trim().toLowerCase() || 'udm';
  const paysNorm = (pays || '').trim().toLowerCase();
  const out = [];
  for (const zone of zones) {
    for (const secteur of zone.secteurs) {
      for (const item of secteur.items) {
        const itemConceptNorm = (item.concept || 'Tous').trim().toLowerCase();
        const concernePasConcept = itemConceptNorm === 'tous' || itemConceptNorm === conceptNorm;
        if (!concernePasConcept) continue;
        const itemPaysNorm = (item.pays || '').trim().toLowerCase();
        const concernePasPays = !itemPaysNorm || itemPaysNorm === paysNorm;
        if (!concernePasPays) continue;
        out.push({ ...item, zoneNumero: zone.numero, zoneNom: zone.nom, secteurNom: secteur.nom || null });
      }
    }
  }
  return out;
}

function kaizenComputeScore(itemsState, itemsApplicables) {
  const notes = itemsApplicables.filter(i => !i.optional);
  const scoreMax = notes.length * KAIZEN_POINTS_PAR_ITEM;
  let score = 0;
  for (const item of notes) {
    if (itemsState?.[item.id]?.checked) score += KAIZEN_POINTS_PAR_ITEM;
  }
  return { score: Math.round(score * 10) / 10, scoreMax: Math.round(scoreMax * 10) / 10 };
}

// ---------- Normalisation de noms (pour la résolution animateur au login) ----------
function normalizeName(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

// ---------- Sessions animateur (HMAC signé, 12h) ----------
async function hmacSign(payloadStr) {
  if (!AR_SESSION_SECRET) throw new Error('Secret AR_SESSION_KEY non configuré sur le Worker');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(AR_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadStr));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createArSession(ar) {
  const payload = JSON.stringify({ ar, exp: Date.now() + AR_SESSION_TTL_MS });
  const b64 = btoa(unescape(encodeURIComponent(payload)));
  const sig = await hmacSign(b64);
  return b64 + '.' + sig;
}

async function verifyArSession(token) {
  if (!AR_SESSION_SECRET) return null;
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expectedSig = await hmacSign(b64);
  if (sig !== expectedSig) return null;
  let payload;
  try { payload = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch (e) { return null; }
  if (!payload || !payload.ar || !payload.exp || payload.exp < Date.now()) return null;
  return payload.ar;
}

// Résout la liste des codes magasins auxquels une session donne accès.
// null = accès à tous les magasins (session 'ALL').
// sessionAr peut être : 'ALL', 'PAYS:<pays>' (directeur pays), ou un nom d'animateur.
async function getAllowedCodes(sessionAr, stores) {
  if (sessionAr === 'ALL') return null;
  if (sessionAr.startsWith('PAYS:')) {
    const paysListe = sessionAr.slice('PAYS:'.length).split('|');
    return stores.filter(s => paysListe.includes(s.pays)).map(s => s.code);
  }
  return stores.filter(s => s.animateur === sessionAr).map(s => s.code);
}

// ---------- Emails (alertes admin) ----------
function jsonError(msg, status, corsHeaders) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

// ---------- Checklist de passage (reprise France 24/09, ajout Inter 29/09) ----------
// Table ar_checklist (ar TEXT PRIMARY KEY, items_json TEXT, updated_at TEXT), créée
// automatiquement au premier appel. Une ligne par session (nom d'animateur,
// 'PAYS:...' pour un directeur pays, 'ALL' pour l'accès complet) + une ligne
// spéciale CHECKLIST_RESEAU_KEY pour les points réseau communs.
const CHECKLIST_RESEAU_KEY = '__reseau__';
let checklistTableOk = false;

async function ensureChecklistTable(env) {
  if (checklistTableOk) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS ar_checklist (ar TEXT PRIMARY KEY, items_json TEXT, updated_at TEXT)').run();
  checklistTableOk = true;
}

function sanitizeChecklistItems(list) {
  const items = [];
  const vus = new Set();
  for (const it of (list || [])) {
    const texte = String((it && it.texte) || '').trim().slice(0, 300);
    const id = String((it && it.id) || '').trim().slice(0, 40);
    if (!texte || !id || vus.has(id)) continue;
    vus.add(id);
    items.push({ id, texte });
  }
  return items;
}

async function readChecklistItems(env, cle) {
  const row = await env.DB.prepare('SELECT items_json FROM ar_checklist WHERE ar = ?').bind(cle).first();
  try { return sanitizeChecklistItems(JSON.parse((row && row.items_json) || '[]')); } catch (e) { return []; }
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function encodeAstralAsHtmlEntities(s) {
  return (s || '').replace(/[\u{10000}-\u{10FFFF}]/gu, ch => `&#${ch.codePointAt(0)};`);
}

function textToHtmlEmail(bodyText) {
  const lines = (bodyText || '').split('\n');
  let html = '';
  let inParagraph = false;
  const closeP = () => { if (inParagraph) { html += '</p>'; inParagraph = false; } };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') { closeP(); continue; }
    if (!inParagraph) { html += '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#2C2C2A;margin:0 0 10px">'; inParagraph = true; }
    else html += '<br>';
    html += encodeAstralAsHtmlEntities(escapeHtml(line));
  }
  closeP();
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:8px">${html}</div>`;
}

// Compte technique pour les emails envoyés par le Worker lui-même (alertes admin) —
// utilise les secrets Cloudflare ZIMBRA_USER / ZIMBRA_PASSWORD déjà configurés.
async function zimbraSendMail(env, { to, subject, bodyText, bodyHtml }) {
  const authResp = await fetch(ZIMBRA_SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
      Body: {
        AuthRequest: {
          _jsns: 'urn:zimbraAccount',
          account: { by: 'name', _content: env.ZIMBRA_USER },
          password: { _content: env.ZIMBRA_PASSWORD }
        }
      }
    })
  });
  const authData = await authResp.json();
  const token = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
  if (!token) throw new Error('Authentification Zimbra (compte technique) échouée');

  const sendResp = await fetch(ZIMBRA_SOAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': `ZM_AUTH_TOKEN=${token}` },
    body: JSON.stringify({
      Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' }, authToken: [{ _content: token }] } },
      Body: {
        SendMsgRequest: {
          _jsns: 'urn:zimbraMail',
          m: { su: { _content: subject }, e: to.map(addr => ({ t: 't', a: addr })), mp: { ct: 'text/html', content: { _content: bodyHtml || textToHtmlEmail(bodyText) } } }
        }
      }
    })
  });
  if (!sendResp.ok) throw new Error('Envoi email échoué (' + sendResp.status + ')');
}

// ---------- Score de santé magasin (17/09) ----------
// Porté depuis le worker France (buildStoreHealthResults), avec 3
// simplifications assumées pour la V1 internationale :
// - pas d'alias de noms de magasins (résolution France historique, inutile
//   ici : le rollout international est neuf, code_magasin toujours fiable) ;
// - pas de sous-score absentéisme (droit du travail différent par pays —
//   voir rh_effectif_simple ci-dessous, juste effectif réel vs théorique
//   pour l'instant, le vrai module RH légal par pays viendra ensuite) ;
// - pas de tendance PEDLV semaine sur semaine (dépend d'un historique
//   hebdomadaire, store_stats_history, qui n'existe pas côté international) ;
//   pedlvTrend reste toujours null, sans impact sur le score lui-même.
// Le calcul du score (poids, formule) est identique à la France.

function daysBetween(isoFrom, isoTo) {
  const a = new Date(isoFrom + 'T00:00:00Z');
  const b = new Date(isoTo + 'T00:00:00Z');
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

const VISIT_REMINDER_THRESHOLD_DAYS = 28;

const POIDS_SANTE_SERVER = {
  actions: 7, effectif: 3, absenteisme: 4, positionnement: 5, pedlv: 8, avis: 4, equipe: 6, kaizen: 7,
};

function toNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function getLastBilanSnapshots(env) {
  if (!env.DB) return {};
  const { results } = await env.DB.prepare(`
    SELECT magasin_code, date, ca_annuel, data_json FROM (
      SELECT magasin_code, date, ca_annuel, data_json,
      ROW_NUMBER() OVER (PARTITION BY magasin_code ORDER BY date DESC, id DESC) as rn
      FROM bilans
    ) WHERE rn = 1
  `).all();
  const map = {};
  for (const row of results) {
    let data = {};
    try { data = JSON.parse(row.data_json); } catch(e) {}
    const mag = data.magasin || {};
    map[row.magasin_code] = {
      date: row.date,
      positionnementAnnuel: toNumOrNull(row.ca_annuel),
      effOpt: toNumOrNull(mag.eff_opt),
      effAudio: toNumOrNull(mag.eff_audio),
      actions: Array.isArray(data.actions) ? data.actions : [],
    };
  }
  return map;
}

async function getLastObservationMap(env) {
  if (!env.DB) return {};
  let results;
  try {
    ({ results } = await env.DB.prepare('SELECT magasin, last_date FROM observation_last_visit').all());
  } catch(e) { return {}; }
  const map = {};
  for (const row of results) map[normalizeName(row.magasin)] = row.last_date;
  return map;
}

async function getStoreStatsMap(env) {
  if (!env.DB) return {};
  let results;
  try {
    ({ results } = await env.DB.prepare('SELECT * FROM store_stats ORDER BY id DESC').all());
  } catch(e) { return {}; }
  const map = {};
  for (const r of results) {
    if (!r.code_magasin || map[r.code_magasin]) continue;
    let indicateurs = {};
    try { indicateurs = JSON.parse(r.indicateurs_json || '{}'); } catch(e) {}
    map[r.code_magasin] = { ...r, indicateurs };
  }
  return map;
}

function computePedlvSummary(row) {
  if (!row) return null;
  const entries = Object.entries(row.indicateurs || {}).filter(([, v]) => v && v.statut);
  if (!entries.length) return null;
  const rouge = entries.filter(([, v]) => v.statut === 'rouge').length;
  return { rouge, total: entries.length, periode: row.periode || null };
}

async function getNiveauxEquipeMap(env) {
  if (!env.DB) return {};
  try {
    const annee = anneeCouranteEval();
    const { results: notes } = await env.DB.prepare(
      `SELECT magasin_code, tache, note FROM notes_equipe WHERE annee = ?`
    ).bind(annee).all();
    const parMagasin = {};
    for (const n of notes) {
      const m = (parMagasin[n.magasin_code] ??= {});
      (m[n.tache] ??= []).push(n.note);
    }
    const niveaux = {};
    for (const [code, taches] of Object.entries(parMagasin)) {
      const moyennes = Object.values(taches).map(notesArr => {
        const top3 = [...notesArr].sort((a, b) => b - a).slice(0, 3);
        return top3.reduce((s, n) => s + n, 0) / top3.length;
      });
      niveaux[code] = moyennes.length
        ? Math.round((moyennes.reduce((s, m2) => s + m2, 0) / moyennes.length) * 10) / 10
        : null;
    }
    return niveaux;
  } catch (e) { console.error('Erreur calcul niveaux équipe (store-health):', e); return {}; }
}

async function getKaizenHealthMap(env) {
  if (!env.DB) return {};
  try {
    const moisCourant = new Date().toISOString().slice(0, 7);
    const anneeCourante = moisCourant.slice(0, 4);
    const { results } = await env.DB.prepare(
      `SELECT magasin_code, mois, score, closed FROM kaizen_audits WHERE mois LIKE ?`
    ).bind(anneeCourante + '-%').all();
    const map = {};
    for (const row of results) {
      const m = (map[row.magasin_code] ??= { scoreMois: null, closedMois: false, cumulAnnuel: 0, dernierScoreCloture: null, dernierScoreMax: null, dernierMoisCloture: null });
      m.cumulAnnuel += (row.score || 0);
      if (row.mois === moisCourant) { m.scoreMois = row.score; m.closedMois = !!row.closed; }
    }
    for (const m of Object.values(map)) m.cumulAnnuel = Math.round(m.cumulAnnuel * 10) / 10;

    const { results: closedRows } = await env.DB.prepare(
      `SELECT magasin_code, mois, score, score_max FROM kaizen_audits WHERE closed = 1 ORDER BY mois DESC`
    ).all();
    const seen = new Set();
    for (const row of closedRows) {
      if (seen.has(row.magasin_code)) continue;
      seen.add(row.magasin_code);
      const m = (map[row.magasin_code] ??= { scoreMois: null, closedMois: false, cumulAnnuel: null, dernierScoreCloture: null, dernierScoreMax: null, dernierMoisCloture: null });
      m.dernierScoreCloture = row.score;
      m.dernierScoreMax = row.score_max;
      m.dernierMoisCloture = row.mois;
    }
    return map;
  } catch (e) { console.error('Erreur calcul Kaizen (store-health):', e); return {}; }
}

// ---------- RH simplifié (17/09, provisoire) ----------
function rhMoisConsecutifs(moisArr) {
  for (let i = 1; i < moisArr.length; i++) {
    const [y1, m1] = moisArr[i - 1].split('-').map(Number);
    const [y2, m2] = moisArr[i].split('-').map(Number);
    const attendu = m1 === 12 ? [y1 + 1, 1] : [y1, m1 + 1];
    if (y2 !== attendu[0] || m2 !== attendu[1]) return false;
  }
  return true;
}

// ---------- Import RH (17/09, mis à jour) ----------
// Mêmes libellés de colonnes et mêmes règles de calcul que la France (décision
// Olivier) — à adapter plus tard si un pays a un droit du travail différent.
// Attention : certains libellés sont propres au droit du travail français
// (ex. régime particulier "Alsace-Moselle") — gardés tels quels pour l'instant,
// puisque c'est ce qui a été demandé, mais à revoir en priorité si un pays
// hors France utilise ce module.

const RH_POSTE_AUDIO = ['audioprothésiste', 'technicien audio'];
const RH_POSTE_OPTICIEN = ['manager', 'monteur', 'opticien/vendeur', 'optométriste/contactologue'];

function rhMapPosteCategorie(poste) {
  const p = (poste || '').trim().toLowerCase();
  if (RH_POSTE_AUDIO.includes(p)) return 'audio';
  if (RH_POSTE_OPTICIEN.includes(p)) return 'opticien';
  return null;
}

function rhMapCodeSiteVersMagasin(codeRh, magasinsCodesSet) {
  const n = parseInt(String(codeRh || '').trim(), 10);
  if (!Number.isFinite(n)) return { code: null, reconnu: false };
  const code = String(n);
  return { code, reconnu: magasinsCodesSet.has(code) };
}

function rhNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function rhJoursDansMois(mois) {
  const [y, m] = mois.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function rhMoisPrecedent(mois) {
  const [y, m] = mois.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

const RH_GROUPE_A_COLS = [
  'Absence maladie', 'Absence maladie (Alsace Moselle)',
  'Absence Accident Travail', 'Absence Accident Travail (Alsace Moselle)',
  'Absence non payée', 'Congés sans solde',
  'Congé maternité', 'Congé paternité', 'Congé Parental',
  'Naissance', 'Mariage/Pacs',
];

const RH_GROUPE_B_COLS = [
  'Congé Performance', 'Congés Ancienneté', 'Congé Supplémentaire Naissance',
  'Congés payes', 'Repos Anniversaire', 'Décès', 'Déduction Entrée', 'Déduction Sortie',
  'Evènement religieux', 'Férié', 'Garde Enfants', 'Jour de fermeture', 'Journée école',
  'Temps partiel Thérapeutique', 'Récupération', 'Repos hebdomadaire', 'Repos temps partiel',
];

const RH_MALADIE_AT_COLS = [
  'Absence maladie', 'Absence maladie (Alsace Moselle)',
  'Absence Accident Travail', 'Absence Accident Travail (Alsace Moselle)',
];

const RH_MATERNITE_PARENTAL_COLS = ['Congé maternité', 'Congé paternité', 'Congé Parental'];

function rhSommeColonnes(row, cols) {
  return cols.reduce((acc, c) => acc + rhNum(row[c]), 0);
}

async function getRhHealthSignalsMap(env) {
  if (!env.DB) return {};
  let results;
  try {
    ({ results } = await env.DB.prepare(`
      SELECT
        es.mois as mois,
        es.code_site as code_site,
        SUM(es.poids) as effectif_total,
        SUM(CASE WHEN a.longue_duree = 1 THEN es.poids ELSE 0 END) as effectif_longue_duree,
        SUM(a.jours_groupe_a * es.poids) as groupe_a_pondere,
        SUM(a.jours_ouvres_theoriques * es.poids) as theo_pondere
      FROM rh_effectif_site_mensuel es
      JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
      WHERE es.site_reconnu = 1
      GROUP BY es.mois, es.code_site
      ORDER BY es.mois ASC
    `).all());
  } catch (e) { console.error('Erreur lecture signaux RH (santé) :', e); return {}; }

  const parMagasin = {};
  for (const r of results) {
    (parMagasin[r.code_site] ??= []).push({
      mois: r.mois,
      effectifDispo: r.effectif_total - r.effectif_longue_duree,
      tauxAbsenteisme: r.theo_pondere > 0 ? (r.groupe_a_pondere / r.theo_pondere) : null,
    });
  }

  const map = {};
  for (const [code, moisArr] of Object.entries(parMagasin)) {
    const notes = moisArr.filter(m => m.tauxAbsenteisme !== null).map(m => Math.max(0, 100 - m.tauxAbsenteisme * 100));
    const absenteismeScore = notes.length ? Math.round((notes.reduce((a, b) => a + b, 0) / notes.length) * 10) / 10 : null;
    const derniers3 = moisArr.slice(-3);
    const consecutifs = derniers3.length === 3 && rhMoisConsecutifs(derniers3.map(m => m.mois));
    const dernierMois = moisArr.length ? moisArr[moisArr.length - 1] : null;
    map[code] = { derniers3, consecutifs, absenteismeScore, moisCount: notes.length, dernierMois };
  }
  return map;
}

function computeEffectifStatus(snapshot, effTheo, rhSignal) {
  if (effTheo === null || effTheo === undefined) return { label: 'pas de données', delta: null };
  if (snapshot && snapshot.effOpt !== null && snapshot.effAudio !== null) {
    const delta = Math.round((snapshot.effOpt + snapshot.effAudio - effTheo) * 10) / 10;
    return { label: delta === 0 ? 'OK' : (delta > 0 ? `+${delta}` : `${delta}`), delta };
  }
  if (rhSignal && rhSignal.dernierMois) {
    const delta = Math.round((rhSignal.dernierMois.effectifDispo - effTheo) * 10) / 10;
    return { label: delta === 0 ? 'OK' : (delta > 0 ? `+${delta}` : `${delta}`), delta };
  }
  return { label: 'pas de données', delta: null };
}

function computeEffectifRH(rhSignal, effTheo) {
  if (!rhSignal || !rhSignal.consecutifs || effTheo === null || effTheo === undefined) {
    return { soutenu: false, ecartMoyen: null };
  }
  const ecarts = rhSignal.derniers3.map(m => m.effectifDispo - effTheo);
  const soutenu = ecarts.every(e => e < 0);
  const ecartMoyen = soutenu ? Math.round((ecarts.reduce((a, b) => a + b, 0) / ecarts.length) * 10) / 10 : null;
  return { soutenu, ecartMoyen };
}

function healthSubScoresServer(s) {
  const scores = {};

  if (s.actionsNonSoldees && Array.isArray(s.actionsNonSoldees.items)) {
    const penalty = s.actionsNonSoldees.items
      .filter(a => a.fromPrevious)
      .reduce((acc, a) => acc + (a.status === 'todo' ? 25 : 15), 0);
    scores.actions = Math.max(0, 100 - penalty);
  } else {
    scores.actions = null;
  }

  if (s.effectif && s.effectif.delta !== null && s.effectif.delta !== undefined) {
    let score = s.effectif.delta <= 0 ? 100 : Math.max(0, 100 - s.effectif.delta * 25);
    if (s.effectifRH && s.effectifRH.soutenu && s.effectifRH.ecartMoyen !== null) {
      score = Math.min(score, Math.max(0, 100 + s.effectifRH.ecartMoyen * 25));
    }
    scores.effectif = score;
  } else if (s.effectifRH && s.effectifRH.soutenu && s.effectifRH.ecartMoyen !== null) {
    scores.effectif = Math.max(0, 100 + s.effectifRH.ecartMoyen * 25);
  } else {
    scores.effectif = null;
  }

  if (s.absenteisme && s.absenteisme.score !== null && s.absenteisme.score !== undefined) {
    scores.absenteisme = s.absenteisme.score;
  } else {
    scores.absenteisme = null;
  }

  if (s.positionnementAnnuel !== null && s.positionnementAnnuel !== undefined) {
    scores.positionnement = Math.max(0, Math.min(100, s.positionnementAnnuel));
  } else {
    scores.positionnement = null;
  }

  if (s.pedlv && s.pedlv.total) {
    scores.pedlv = Math.max(0, 100 - (s.pedlv.rouge / s.pedlv.total) * 100);
  } else {
    scores.pedlv = null;
  }

  if (s.googleRating && s.googleRating.rating) {
    scores.avis = Math.max(0, Math.min(100, (Number(s.googleRating.rating) / 5) * 100));
  } else {
    scores.avis = null;
  }

  if (s.niveauEquipe !== null && s.niveauEquipe !== undefined) {
    scores.equipe = Math.max(0, Math.min(100, (Number(s.niveauEquipe) / 10) * 100));
  } else {
    scores.equipe = null;
  }

  if (s.kaizenDernierScoreCloture !== null && s.kaizenDernierScoreCloture !== undefined && s.kaizenDernierScoreMax) {
    scores.kaizen = Math.max(0, Math.min(100, (s.kaizenDernierScoreCloture / s.kaizenDernierScoreMax) * 100));
  } else {
    scores.kaizen = null;
  }

  return scores;
}

function computeHealthScoreServer(s, precomputedSub) {
  const sub = precomputedSub || healthSubScoresServer(s);
  let total = 0, possible = 0, totalWeight = 0;
  Object.keys(POIDS_SANTE_SERVER).forEach(key => {
    totalWeight += POIDS_SANTE_SERVER[key];
    if (sub[key] === null) return;
    total += sub[key] * POIDS_SANTE_SERVER[key];
    possible += POIDS_SANTE_SERVER[key];
  });
  if (possible < totalWeight * 0.5) return null;
  return Math.round(total / possible);
}

async function buildStoreHealthResults(env, scope) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const snapshots = await getLastBilanSnapshots(env);
  const lastObservationMap = await getLastObservationMap(env);
  let ratingsMap = {};
  try {
    const { results: ratingRows } = await env.DB.prepare('SELECT magasin_code, rating, reviews_count FROM google_ratings').all();
    ratingRows.forEach(r => { ratingsMap[r.magasin_code] = { rating: r.rating, reviewsCount: r.reviews_count }; });
  } catch(e) {}

  const storeStatsMap = await getStoreStatsMap(env);
  const niveauxEquipeMap = await getNiveauxEquipeMap(env);
  const kaizenHealthMap = await getKaizenHealthMap(env);
  const rhMap = await getRhHealthSignalsMap(env);

  return scope.map(store => {
    const snap = snapshots[store.code] || null;
    const bilanDate = snap ? snap.date : null;
    const obsDate = lastObservationMap[normalizeName(store.libelle)] || null;
    const lastVisitDate = [bilanDate, obsDate].filter(Boolean).sort().slice(-1)[0] || null;
    const daysSinceVisit = lastVisitDate ? daysBetween(lastVisitDate, todayISO) : null;
    const kz = kaizenHealthMap[store.code] || null;
    const rhSignal = rhMap[store.code] || null;
    const result = {
      code: store.code,
      libelle: store.libelle,
      animateur: store.animateur,
      directeurPays: store.directeurPays,
      directriceInter: store.directriceInter,
      lastVisitDate,
      daysSinceVisit,
      lastBilanDate: bilanDate,
      lastObservationDate: obsDate,
      overdue: lastVisitDate === null || daysSinceVisit >= VISIT_REMINDER_THRESHOLD_DAYS,
      effectif: computeEffectifStatus(snap, store.effTheo, rhSignal),
      effectifRH: computeEffectifRH(rhSignal, store.effTheo),
      absenteisme: rhSignal ? { score: rhSignal.absenteismeScore, moisCount: rhSignal.moisCount } : { score: null, moisCount: 0 },
      positionnementAnnuel: snap ? snap.positionnementAnnuel : null,
      googleRating: ratingsMap[store.code] || null,
      actionsNonSoldees: snap ? {
        count: (snap.actions || []).length,
        items: (snap.actions || []).map(a => ({
          text: a.text, repriseCount: a._repriseCount || 0, fromPrevious: !!a._fromPrevious, status: a._status || null,
        })),
      } : null,
      pedlv: computePedlvSummary(storeStatsMap[store.code]),
      pedlvTrend: null, // pas d'historique hebdo PEDLV côté international pour l'instant
      niveauEquipe: niveauxEquipeMap[store.code] ?? null,
      objectifNiveauEquipe: OBJECTIF_NIVEAU_EQUIPE,
      kaizenScoreMois: kz ? kz.scoreMois : null,
      kaizenClosedMois: kz ? kz.closedMois : false,
      kaizenCumulAnnuel: kz ? kz.cumulAnnuel : null,
      kaizenDernierScoreCloture: kz ? kz.dernierScoreCloture : null,
      kaizenDernierScoreMax: kz ? kz.dernierScoreMax : null,
      kaizenDernierMoisCloture: kz ? kz.dernierMoisCloture : null,
    };
    result.subScores = healthSubScoresServer(result);
    result.score = computeHealthScoreServer(result, result.subScores);
    return result;
  }).sort((a, b) => (b.daysSinceVisit ?? 9999) - (a.daysSinceVisit ?? 9999));
}

// ---------- Crons (17/09) ----------
// Communications réseau automatiques (com hebdo, relance visite) volontairement
// laissées de côté pour l'instant (décision Olivier) — seuls les 3 jobs
// suivants sont actifs : clôture mensuelle Kaizen (sans email pour l'instant,
// juste la clôture D1 qui alimente le sous-score santé), rafraîchissement des
// avis Google, et le snapshot hebdomadaire du score de santé (alimente
// l'historique 26 semaines de /store-health-detail et /ar-dashboard).

const GOOGLE_RATINGS_BATCH_SIZE = 40;

function moisPrecedent(dateRef) {
  const d = dateRef ? new Date(dateRef) : new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

async function withCronAlert(env, jobName, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`Erreur ${jobName}:`, e);
    try {
      await zimbraSendMail(env, {
        to: ADMIN_ALERT_EMAILS,
        subject: `⚠️ Échec cron international — ${jobName}`,
        bodyText: `Le job planifié "${jobName}" a échoué le ${new Date().toISOString()}.\n\nErreur :\n${e && e.stack ? e.stack : String(e)}`,
      });
    } catch (mailErr) {
      console.error(`Échec de l'ENVOI de l'alerte cron pour ${jobName} :`, mailErr);
    }
  }
}

// Clôture simple : marque closed=1 sur les audits non clôturés du mois
// précédent. Le score/score_max sont déjà à jour (calculés à chaque toggle),
// rien à recalculer. Pas d'email de récap pour l'instant (à ajouter ensuite
// si besoin — laissé de côté avec les autres communications automatiques).
async function cloturerAuditsKaizen(env, moisOverride) {
  if (!env.DB) throw new Error('Base D1 non liée au Worker');
  const mois = moisOverride || moisPrecedent();
  await env.DB.prepare(
    `UPDATE kaizen_audits SET closed = 1, closed_at = datetime('now') WHERE mois = ? AND closed = 0`
  ).bind(mois).run();
}

async function getGoogleRatingsCursor(env) {
  const row = await env.DB.prepare('SELECT cursor_offset FROM google_ratings_state WHERE id = 1').first();
  return row ? row.cursor_offset : 0;
}

async function setGoogleRatingsCursor(env, offset) {
  await env.DB.prepare(
    `INSERT INTO google_ratings_state (id, cursor_offset) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET cursor_offset = excluded.cursor_offset`
  ).bind(offset).run();
}

async function refreshGoogleRatings(env) {
  if (!env.DB) { console.error('Refresh Google ratings : base D1 non liée au Worker'); return; }
  if (!env.GOOGLE_PLACES_API_KEY) { console.error('Refresh Google ratings : secret GOOGLE_PLACES_API_KEY manquant'); return; }

  const stores = await getMagasinsServerSide();
  const withPlaceId = stores.filter(s => s.googlePlaceId).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  if (withPlaceId.length === 0) { console.log('Refresh Google ratings : aucun magasin avec Place ID'); return; }

  const offset = await getGoogleRatingsCursor(env);
  const batch = [];
  for (let i = 0; i < GOOGLE_RATINGS_BATCH_SIZE && i < withPlaceId.length; i++) {
    batch.push(withPlaceId[(offset + i) % withPlaceId.length]);
  }

  let ok = 0, ko = 0;
  for (const s of batch) {
    try {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(s.googlePlaceId)}&fields=rating,user_ratings_total&key=${env.GOOGLE_PLACES_API_KEY}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.status === 'OK' && data.result) {
        await env.DB.prepare(
          `INSERT INTO google_ratings (magasin_code, rating, reviews_count, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(magasin_code) DO UPDATE SET rating = excluded.rating, reviews_count = excluded.reviews_count, updated_at = excluded.updated_at`
        ).bind(s.code, data.result.rating ?? null, data.result.user_ratings_total ?? null, new Date().toISOString()).run();
        ok++;
      } else {
        console.error('Google Place Details échoué pour', s.code, s.libelle, '-', data.status);
        ko++;
      }
    } catch (e) {
      console.error('Erreur refresh rating pour', s.code, s.libelle, e);
      ko++;
    }
  }

  const newOffset = (offset + batch.length) % withPlaceId.length;
  await setGoogleRatingsCursor(env, newOffset);
  console.log(`Refresh Google ratings terminé : ${ok} OK, ${ko} échec(s) sur ${batch.length} magasins`);
}

// Snapshot hebdomadaire (dimanche) du score de santé de tous les magasins —
// alimente store_health_score_history, utilisée par /store-health-detail et
// /ar-dashboard pour les courbes 26 semaines. Sans ce cron, l'historique reste
// vide indéfiniment (le score "live" fonctionne déjà sans lui).
async function snapshotHealthScoreHistory(env) {
  if (!env.DB) throw new Error('Base D1 non liée au Worker');
  const stores = await getMagasinsServerSide();
  if (!stores.length) return;
  const results = await buildStoreHealthResults(env, stores);
  const periodKey = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT INTO store_health_score_history
     (magasin_code, period_key, score, computed_at,
      score_actions, score_effectif, score_absenteisme, score_positionnement, score_pedlv, score_avis, score_equipe, score_kaizen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(magasin_code, period_key) DO UPDATE SET
     score = excluded.score, computed_at = excluded.computed_at,
     score_actions = excluded.score_actions, score_effectif = excluded.score_effectif,
     score_absenteisme = excluded.score_absenteisme, score_positionnement = excluded.score_positionnement,
     score_pedlv = excluded.score_pedlv, score_avis = excluded.score_avis,
     score_equipe = excluded.score_equipe, score_kaizen = excluded.score_kaizen`
  );
  await env.DB.batch(results.map(r => {
    const sub = r.subScores || {};
    return stmt.bind(
      r.code, periodKey, r.score, now,
      sub.actions ?? null, sub.effectif ?? null, sub.absenteisme ?? null, sub.positionnement ?? null,
      sub.pedlv ?? null, sub.avis ?? null, sub.equipe ?? null, sub.kaizen ?? null
    );
  }));
}


// ============================================================================
// Lot 0 (25/10/2026) — sécurité + routes manquantes
// ============================================================================

// ---------- Contrôle d'accès « outil posé en magasin » ou session animateur ----------
// PEDLV et Kaizen n'ont pas (encore) de connexion Zimbra : ils envoient un jeton
// d'outil dans X-Store-Token. Ce jeton n'est plus écrit dans le Worker : il est lu
// dans un secret Cloudflare (BILAN_STORE_TOKEN, PEDLV_STORE_TOKEN, KAIZEN_STORE_TOKEN).
// Une session animateur valide (X-AR-Session) est toujours acceptée à la place,
// pour que les applis puissent passer à la connexion Zimbra sans toucher au Worker.
async function accesOutilOuSession(request, env, nomsSecrets) {
  const jeton = request.headers.get('X-Store-Token') || '';
  if (jeton) {
    for (const nom of nomsSecrets) {
      const attendu = env[nom];
      if (attendu && jeton === attendu) return { ok: true, via: 'jeton', outil: nom };
    }
  }
  const ar = await verifyArSession(request.headers.get('X-AR-Session'));
  if (ar) return { ok: true, via: 'session', ar };
  return { ok: false };
}

// ---------- Analyse IA (/analyze) ----------
function resumeBilan(b, opts = {}) {
  const { includeHumeur = true } = opts;
  const actions = (b.actions || []).map(a => `- [${a.status || 'en cours'}] ${a.label || a.text || JSON.stringify(a)}`).join('\n') || 'Aucune action notée';
  return [
    `Date: ${b.date}${b.passage ? ' (passage n°' + b.passage + ')' : ''}`,
    `Magasin: ${b.magasin?.libelle || b.magasin_libelle || '?'} (${b.magasin?.code || b.magasin_code || '?'})`,
    `Animateur: ${b.ar || '?'}`,
    (includeHumeur && b.humeur !== undefined && b.humeur !== null) ? `Humeur/ambiance (échelle 0 à 4 : 0=Difficile, 1=Mitigé, 2=Correct, 3=Bien, 4=Top !): ${b.humeur}/4` : '',
    b.renta ? `Rentabilité salariale (ATTENTION : plus BAS = MEILLEUR, c'est un ratio coût salarial/CA, ne jamais présenter une valeur plus haute que l'objectif comme une réussite) : ${b.renta}%` : '',
    b.ca_mensuel ? `CA mensuel: ${b.ca_mensuel}` : '',
    b.forts ? `Points forts: ${b.forts}` : '',
    b.diff ? `Difficultés: ${b.diff}` : '',
    `Actions:\n${actions}`,
    b.manager_obs ? `Observations manager: ${b.manager_obs}` : '',
    b.remarque_libre ? `Remarque libre: ${b.remarque_libre}` : '',
  ].filter(Boolean).join('\n');
}

let _analyzeLogOk = false;
async function logAnalyzeCall(env, { ar, mode, nbMagasins, inputTokens, outputTokens }) {
  if (!env.DB) return;
  try {
    if (!_analyzeLogOk) {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analyze_calls_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ar TEXT, mode TEXT, nb_magasins INTEGER, input_tokens INTEGER, output_tokens INTEGER, called_at TEXT)`).run();
      _analyzeLogOk = true;
    }
    await env.DB.prepare(
      `INSERT INTO analyze_calls_log (ar, mode, nb_magasins, input_tokens, output_tokens, called_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(ar || null, mode || null, nbMagasins ?? null, inputTokens ?? null, outputTokens ?? null, new Date().toISOString()).run();
  } catch (e) { console.error('Erreur log analyze_calls_log:', e); }
}

async function appelClaude(env, { system, user, maxTokens }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: maxTokens || 1500, thinking: { type: 'disabled' }, system, messages: [{ role: 'user', content: user }] }),
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data, texte: (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') };
}

// ---------- Com hebdo (/com-hebdo, à la demande, profil ALL) ----------
// Pas d'envoi automatique à l'international (décision 25/10) : la com hebdo est
// seulement générée quand Cécilia ou Olivier cliquent sur le bouton de l'écran Analyse.
function repairEscapedUnicodeDeep(value) {
  if (typeof value === 'string') return value.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  if (Array.isArray(value)) return value.map(repairEscapedUnicodeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = repairEscapedUnicodeDeep(v);
    return out;
  }
  return value;
}

function extractJson(text) {
  const cleaned = (text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return repairEscapedUnicodeDeep(JSON.parse(cleaned)); } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return repairEscapedUnicodeDeep(JSON.parse(match[0]));
    throw e;
  }
}

// Semaine du lundi au samedi (même règle que la France depuis le 29/09).
function mostRecentWeekRange() {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToSaturday = ((day - 6) + 7) % 7 || 7;
  const saturday = new Date(now); saturday.setUTCDate(now.getUTCDate() - diffToSaturday);
  const monday = new Date(saturday); monday.setUTCDate(saturday.getUTCDate() - 5);
  const fmt = d => d.toISOString().slice(0, 10);
  return { from: fmt(monday), to: fmt(saturday) };
}

// Responsable de suivi d'un magasin : l'animateur s'il existe, sinon le directeur
// pays (les animateurs n'existent pas dans tous les pays à l'international).
function responsableMagasin(s) {
  return s.animateur || (s.directeurPays ? s.directeurPays + ' (' + (s.pays || '?') + ')' : '') || 'Non attribué';
}

// date_key des observations est au format non complété "2026-10-5" : on la relit
// en vraie date plutôt que de comparer des chaînes.
function dateKeyVersIso(dk) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dk || '');
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

async function generateComHebdo(env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Clé API Anthropic non configurée sur le Worker');
  const { from, to } = mostRecentWeekRange();
  const stores = await getMagasinsServerSide();
  const storeByCode = new Map(stores.map(s => [s.code, s]));
  const storeByName = new Map(stores.map(s => [normalizeName(s.libelle), s]));

  const { results: rowsBilans } = await env.DB.prepare('SELECT * FROM bilans WHERE date >= ? AND date <= ? ORDER BY ar, date').bind(from, to).all();
  const bilans = rowsBilans.map(r => { try { return JSON.parse(r.data_json); } catch (e) { return r; } });
  const byResp = {};
  for (const b of bilans) {
    const code = b.magasin?.code || b.magasin_code;
    const st = storeByCode.get(code);
    const resp = b.ar || (st ? responsableMagasin(st) : 'Non renseigné');
    (byResp[resp] ??= []).push(b);
  }
  const sections = Object.entries(byResp)
    .map(([r, list]) => `=== ${r} (${list.length} bilan(s)) ===\n` + list.map(b => resumeBilan(b, { includeHumeur: false })).join('\n\n---\n\n'))
    .join('\n\n\n');

  const statsMap = await getStoreStatsMap(env);
  const statsLines = Object.values(statsMap).map(s => {
    const st = storeByCode.get(s.code_magasin);
    const nom = st ? `${st.libelle} (${st.pays})` : (s.magasin || s.code_magasin);
    const dev = st && st.devise ? st.devise : '';
    const parts = [
      s.ca_total !== null && s.ca_total !== undefined ? `CA: ${Number(s.ca_total).toFixed(1)}k ${dev}` : '',
      s.objectif !== null && s.objectif !== undefined ? `objectif: ${Number(s.objectif).toFixed(1)}k ${dev}` : '',
      s.panier_moyen !== null && s.panier_moyen !== undefined ? `panier moyen: ${Number(s.panier_moyen).toFixed(0)} ${dev}` : '',
    ].filter(Boolean).join(', ');
    let prios = [];
    try { prios = JSON.parse(s.prios_json || '[]').slice(0, 2).map(p => p.titre).filter(Boolean); } catch (e) {}
    return `${nom} — période ${s.periode || '?'} — ${parts}` + (prios.length ? ` | Points de vigilance : ${prios.join(' ; ')}` : '');
  }).join('\n');

  let obsLines = '';
  try {
    const { results: obs } = await env.DB.prepare('SELECT magasin, theme, tone, texte, jour_label, date_key FROM observations ORDER BY id DESC LIMIT 1000').all();
    obsLines = obs.filter(o => { const d = dateKeyVersIso(o.date_key); return d && d >= from && d <= to; })
      .map(o => {
        const st = storeByName.get(normalizeName(o.magasin));
        return `[${o.jour_label || ''}][${o.magasin}${st ? ' / ' + st.pays : ''}][${o.theme}][${o.tone === 'p' ? '+' : '-'}] ${o.texte}`;
      }).join('\n');
  } catch (e) { console.error('Com hebdo : lecture observations', e); }

  const contentSource = [
    sections || '(Aucun bilan de passage enregistré cette semaine sur le réseau international.)',
    statsLines ? `\n\nDernières données «Analyse statistique» transmises par magasin :\n${statsLines}` : '\n\n(Aucune donnée «Analyse statistique» transmise.)',
    obsLines ? `\n\nObservations terrain de la semaine :\n${obsLines}` : '',
  ].join('');

  const system = `Tu aides à rédiger une communication hebdomadaire interne à partir des remontées terrain de la semaine (bilans de passage, indicateurs, observations), pour la direction du réseau international Optical Center (plusieurs pays, plusieurs devises : ne compare jamais des montants de devises différentes).

RÈGLES DE STYLE (à respecter strictement) :
- Ton motivant, jamais alarmiste.
- Ne JAMAIS pointer un magasin par son nom sur un point négatif — rester général ou parler de tendances.
- Cite les magasins par leur nom (jamais par un prénom de manager) quand tu les mentionnes positivement.
- Tu écris en français.
- ATTENTION sur la rentabilité salariale (renta) : plus BAS est MEILLEUR — ne jamais qualifier une valeur supérieure à l'objectif de positive.

Réponds uniquement en JSON valide, sans texte avant/après, sans balises markdown. N'utilise JAMAIS le guillemet droit (") à l'intérieur des valeurs de texte, utilise « ».
{
"slack1": {"titre": "emoji + titre court", "contenu": "1-2 phrases courtes", "conclusion": "1 phrase brève"},
"slack2": {"titre": "emoji + titre court (angle différent)", "contenu": "1-2 phrases courtes", "conclusion": "1 phrase brève"},
"slack3": {"titre": "emoji + titre court (angle différent)", "contenu": "1-2 phrases courtes", "conclusion": "1 phrase brève"},
"message_general": "message autonome avec emojis, 4-8 phrases, ton motivant",
"email_objet": "objet de l'email, sans emoji",
"email_corps": "email narratif (8-15 phrases), SANS AUCUN EMOJI, ton professionnel et motivant"
}`;
  const r = await appelClaude(env, { system, user: `Voici les remontées terrain de la semaine :\n\n${contentSource}`, maxTokens: 5000 });
  if (!r.ok) throw new Error('Erreur API Claude : ' + JSON.stringify(r.data).slice(0, 500));
  return { from, to, blocks: extractJson(r.texte) };
}

export default {
  async fetch(request, env) {
    AR_SESSION_SECRET = env.AR_SESSION_KEY || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Zimbra-Auth-Token, X-AR-Session, X-Store-Token, X-Notify-Token',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const GET_ALLOWED = ['/bilans', '/last-actions', '/evaluation/reseau', '/evaluation/magasin', '/evaluation/export-reseau', '/kaizen-etat', '/kaizen-historique', '/kaizen-photo', '/store-health', '/store-health-detail', '/ar-dashboard', '/rh-import/etat', '/ar-checklist', '/google-ratings', '/rh-effectif', '/com-hebdo'];
    if (request.method !== 'POST' && !(request.method === 'GET' && GET_ALLOWED.includes(url.pathname))) {
      return new Response('Méthode non autorisée', { status: 405, headers: corsHeaders });
    }

    try {
      // ---------- Relais upload de pièce jointe Zimbra ----------
      if (url.pathname === '/upload') {
        const token = request.headers.get('X-Zimbra-Auth-Token');
        if (!token) return new Response('Jeton manquant', { status: 400, headers: corsHeaders });
        const contentType = request.headers.get('Content-Type') || '';
        const bodyBuffer = await request.arrayBuffer();
        const uploadRes = await fetch(ZIMBRA_UPLOAD_URL, {
          method: 'POST',
          headers: { 'Content-Type': contentType, 'Cookie': `ZM_AUTH_TOKEN=${token}` },
          body: bodyBuffer,
        });
        const text = await uploadRes.text();
        return new Response(text, { status: uploadRes.status, headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
      }

      // ---------- Relais SOAP générique (auth Zimbra directe, envoi de mail, etc.) ----------
      // Utilisé par le front (soapEnv()) pour les appels qui ne passent pas par /ar-login,
      // par exemple l'envoi du mail final (SendMsgRequest) avec le authToken Zimbra déjà
      // obtenu côté client. Simple passe-plat vers Zimbra, sans vérification de session ici :
      // la sécurité repose sur le authToken Zimbra lui-même, fourni par le client.
      if (url.pathname === '/soap') {
        const bodyText = await request.text();
        const soapResp = await fetch(ZIMBRA_SOAP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyText,
        });
        const text = await soapResp.text();
        return new Response(text, { status: soapResp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Checklist de passage ----------
      // Points réseau : lisibles par tous (même non connectés), modifiables uniquement
      // par une session 'ALL' (Cécilia, Olivier). Points perso : propres à chaque
      // session, jamais remontés ; l'état coché des points réseau part avec le bilan
      // (data_json.checklistReseau).
      if (url.pathname === '/ar-checklist' || url.pathname === '/ar-checklist-reseau') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        const jsonOk = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        try {
          await ensureChecklistTable(env);
          if (!sessionAr) {
            if (request.method === 'GET') {
              const reseau = await readChecklistItems(env, CHECKLIST_RESEAU_KEY);
              return jsonOk({ ok: true, ar: null, estOlivier: false, items: null, reseau, sessionRequise: true });
            }
            return jsonError('Session invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
          }
          if (request.method === 'GET') {
            const perso = await readChecklistItems(env, sessionAr);
            const reseau = await readChecklistItems(env, CHECKLIST_RESEAU_KEY);
            return jsonOk({ ok: true, ar: sessionAr, estOlivier: sessionAr === 'ALL', items: perso, reseau });
          }
          const body = await request.json().catch(() => null);
          if (!body || !Array.isArray(body.items)) return jsonError('items (tableau) requis', 400, corsHeaders);
          if (body.items.length > 100) return jsonError('100 points maximum', 400, corsHeaders);
          let cle = sessionAr;
          if (url.pathname === '/ar-checklist-reseau') {
            if (sessionAr !== 'ALL') return jsonError('Seule la Direction Inter peut modifier les points réseau', 403, corsHeaders);
            cle = CHECKLIST_RESEAU_KEY;
          }
          const items = sanitizeChecklistItems(body.items);
          await env.DB.prepare(
            `INSERT INTO ar_checklist (ar, items_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(ar) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`
          ).bind(cle, JSON.stringify(items), new Date().toISOString()).run();
          return jsonOk({ ok: true, items });
        } catch (e) {
          return jsonError('Erreur checklist : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Login animateur (vraie authentification Zimbra) ----------
      if (url.pathname === '/ar-login') {
        const { zimbraUser, zimbraPass } = await request.json();
        if (!zimbraUser || !zimbraPass) return jsonError('Identifiant et mot de passe requis', 400, corsHeaders);

        const authResp = await fetch(ZIMBRA_SOAP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
            Body: { AuthRequest: { _jsns: 'urn:zimbraAccount', account: { by: 'name', _content: zimbraUser }, password: { _content: zimbraPass } } }
          })
        });
        const authData = await authResp.json();
        const zimbraToken = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
        if (!zimbraToken) return jsonError('Identifiants Zimbra invalides', 401, corsHeaders);

        const localPart = zimbraUser.split('@')[0];
        const normalizedLogin = normalizeName(localPart);
        const emailLogin = (zimbraUser || '').trim().toLowerCase();
        let ar = null;
        // Langue de l'interface pour la session (distincte de la langue des
        // magasins, utilisée par Évaluation Équipe pour la chrome UI puisqu'un
        // animateur/directeur peut naviguer entre magasins de langues
        // différentes dans une même session). Repli FR si non résolue.
        let langueUI = 'FR';
        if (ADMIN_FULL_ACCESS_EMAILS.includes(emailLogin)) {
          // Accès complet ("ALL", tous magasins/pays) : Cécilia (Directrice Inter) et Olivier.
          ar = 'ALL';
          langueUI = 'FR';
        } else {
          const stores = await getMagasinsServerSide();
          // Directeur pays : accès à tous les magasins des pays qu'il couvre (résolu via
          // directeur_pays_email dans magasins_inter.csv). Un directeur peut couvrir
          // plusieurs pays (ex. Angleterre + Irlande) — on prend l'union de tous les
          // pays trouvés sur les lignes où son email apparaît, pas juste la première.
          const lignesDirecteur = stores.filter(s => s.directeurPaysEmail && s.directeurPaysEmail.trim().toLowerCase() === emailLogin);
          const paysDirigés = [...new Set(lignesDirecteur.map(s => s.pays).filter(Boolean))];
          if (paysDirigés.length) {
            ar = 'PAYS:' + paysDirigés.join('|');
            langueUI = lignesDirecteur[0]?.langueDirecteurPays || 'FR';
          } else {
          const emailMatch = stores.find(s => s.animateurEmail && s.animateurEmail.trim().toLowerCase() === emailLogin);
          if (emailMatch) {
            ar = emailMatch.animateur;
            langueUI = emailMatch.langueAnimateur || 'FR';
          } else {
            const uniqueARs = [...new Set(stores.map(s => s.animateur).filter(Boolean))];
            ar = uniqueARs.find(a => normalizeName(a) === normalizedLogin) || null;
            if (ar) {
              const nameMatch = stores.find(s => s.animateur === ar);
              langueUI = nameMatch?.langueAnimateur || 'FR';
            }
          }
          }
        }
        if (!ar) {
          try {
            await zimbraSendMail(env, {
              to: ADMIN_ALERT_EMAILS,
              subject: `⚠️ Connexion Bilan de Passage échouée — aucun animateur ne correspond`,
              bodyText: `Identifiants Zimbra valides pour "${zimbraUser}", mais aucun animateur ne correspond dans magasins_inter.csv (ni par email, ni par nom).\n\nÀ corriger dans magasins_inter.csv : vérifier que la colonne "animateur_email" contient bien "${zimbraUser}" pour cette personne, ou à défaut que la colonne "animateur" suit le motif prenom.nom attendu (login testé : "${normalizedLogin}").`,
            });
          } catch (e) { console.error('Échec envoi alerte ar-login:', e); }
          return jsonError("Identifiants valides mais aucun animateur ne correspond à '" + zimbraUser + "' dans le référentiel magasins. Vérifie la colonne animateur_email (ou à défaut animateur) dans magasins_inter.csv.", 403, corsHeaders);
        }

        const sessionToken = await createArSession(ar);
        return new Response(JSON.stringify({ ok: true, sessionToken, ar, langueUI, expiresInMs: AR_SESSION_TTL_MS, zimbraToken }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ---------- Enregistrement d'un bilan (écriture — session animateur requise) ----------
      if (url.pathname === '/store-bilan') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        const data = await request.json();
        const magasinCode = data?.magasin?.code || null;
        const magasinLibelle = data?.magasin?.libelle || null;
        if (!magasinCode || !data?.date) return jsonError('Champs requis manquants (magasin.code, date)', 400, corsHeaders);

        if (sessionAr !== 'ALL') {
          const stores = await getMagasinsServerSide();
          const allowedCodes = await getAllowedCodes(sessionAr, stores);
          if (!allowedCodes.includes(magasinCode)) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
        }

        await env.DB.prepare(
          `INSERT INTO bilans (magasin_code, magasin_libelle, ar, date, passage, humeur, ca_mensuel, ca_annuel, renta, data_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          magasinCode, magasinLibelle, data.ar || null, data.date, data.passage || null,
          data.humeur !== undefined && data.humeur !== '' ? parseInt(data.humeur) : null,
          data.ca_mensuel || null, data.ca_annuel || null, data.renta || null, JSON.stringify(data)
        ).run();

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Dernières actions saisies pour un magasin ----------
      if (url.pathname === '/last-actions') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const magasinCode = url.searchParams.get('magasin_code');
        if (!magasinCode) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);
        try {
          const row = await env.DB.prepare(
            'SELECT date, data_json FROM bilans WHERE magasin_code = ? ORDER BY date DESC, id DESC LIMIT 1'
          ).bind(magasinCode).first();
          if (!row) return new Response(JSON.stringify({ ok: true, date: null, actions: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
          let data = {};
          try { data = JSON.parse(row.data_json); } catch (e) {}
          return new Response(JSON.stringify({ ok: true, date: row.date, actions: data.actions || [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture dernier bilan : ' + String(e), 500, corsHeaders);
        }
      }

      // ============================================================
      // Évaluation Équipe — routes
      // Toutes exigent une session animateur (X-AR-Session) ; pas de STORE_SECRET
      // ici, cohérent avec le reste de l'infra internationale.
      // ============================================================

      if (url.pathname === '/evaluation/controle') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        const { magasin_code, magasin_libelle, tache, criteres } = await request.json();
        if (!magasin_code || !tache || !Array.isArray(criteres)) {
          return jsonError('Payload invalide : magasin_code, tache et critères requis', 400, corsHeaders);
        }

        const stores = await getMagasinsServerSide();
        if (sessionAr !== 'ALL') {
          const allowedCodes = await getAllowedCodes(sessionAr, stores);
          if (!allowedCodes.includes(magasin_code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
        }

        // Le nombre de critères attendu dépend du pays du magasin (fichier
        // criteres_taches.csv) plutôt que d'un 10 codé en dur : les tâches et
        // leurs critères peuvent différer d'un pays à l'autre.
        const store = stores.find(s => s.code === magasin_code);
        const criteresRows = groupCriteresByPaysTache(await getCriteresTachesServerSide());
        const criteresAttendus = criteresRows[(store?.pays || '') + '||' + tache] || [];
        if (!criteresAttendus.length || criteres.length !== criteresAttendus.length) {
          return jsonError(`Payload invalide : ${criteresAttendus.length || '?'} critère(s) attendu(s) pour cette tâche/pays, ${criteres.length} reçu(s)`, 400, corsHeaders);
        }

        const note = criteres.filter(Boolean).length;
        const annee = anneeCouranteEval();
        const date_controle = new Date().toISOString().slice(0, 10);

        try {
          await env.DB.prepare(
            `INSERT INTO notes_equipe
             (magasin_code, magasin_libelle, tache, annee, note, criteres_json, date_controle, source, ar_login, ar_nom)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'saisie', ?, ?)`
          ).bind(magasin_code, magasin_libelle || magasin_code, tache, annee, note, JSON.stringify(criteres), date_controle, sessionAr, sessionAr).run();
        } catch (e) {
          return jsonError('Erreur enregistrement contrôle : ' + String(e), 500, corsHeaders);
        }

        return new Response(JSON.stringify({ ok: true, note, date_controle }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      if (url.pathname === '/evaluation/magasin') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        const code = url.searchParams.get('code');
        if (!code) return jsonError('Paramètre code requis', 400, corsHeaders);

        const stores = await getMagasinsServerSide();
        if (sessionAr !== 'ALL') {
          const allowedCodes = await getAllowedCodes(sessionAr, stores);
          if (!allowedCodes.includes(code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
        }
        const store = stores.find(s => s.code === code);

        try {
          const annee = anneeCouranteEval();

          const { results: notes } = await env.DB.prepare(
            `SELECT id, tache, note, date_controle, ar_nom, source, criteres_json
             FROM notes_equipe WHERE magasin_code = ? AND annee = ?
             ORDER BY tache, created_at DESC`
          ).bind(code, annee).all();

          const { results: fiches } = await env.DB.prepare(
            `SELECT tache, responsable, responsable_depuis, second, second_depuis
             FROM responsables_taches WHERE magasin_code = ?`
          ).bind(code).all();

          // Critères pilotés par criteres_taches.csv, filtrés sur le pays du
          // magasin (pas de notion d'active_depuis_annee côté international :
          // toute ligne présente dans le fichier est active immédiatement).
          const criteresRows = (await getCriteresTachesServerSide())
            .filter(r => r.pays === (store?.pays || ''));

          const parTache = {};
          for (const c of criteresRows) {
            const entry = (parTache[c.tache] ??= { criteres: [], notes: [] });
            entry.criteres.push(resolveCritereLabel(c, 'libelle', store?.langue));
            entry.tacheLabel = resolveCritereLabel(c, 'tache', store?.langue);
          }
          for (const n of notes) {
            (parTache[n.tache] ??= { criteres: [], notes: [] }).notes.push(n);
          }
          for (const f of fiches) {
            parTache[f.tache] ??= { criteres: [], notes: [] };
            parTache[f.tache].fiche = f;
          }

          const taches = Object.entries(parTache).map(([tache, data]) => {
            const meilleures = [...data.notes].sort((a, b) => b.note - a.note).slice(0, 3);
            const moyenne = meilleures.length
              ? Math.round((meilleures.reduce((s, n) => s + n.note, 0) / meilleures.length) * 10) / 10
              : null;
            return {
              tache,
              // Nom affichable, traduit selon la langue du magasin ; `tache`
              // ci-dessus reste l'identifiant brut FR (payload /evaluation/controle,
              // /evaluation/fiche, groupement D1) — ne jamais l'y substituer.
              tache_label: data.tacheLabel || tache,
              nb_criteres: data.criteres.length,
              criteres: data.criteres,
              fiche: data.fiche || null,
              nb_controles: data.notes.length,
              moyenne_3_meilleures: moyenne,
              dernier_controle: data.notes[0] || null,
              historique: data.notes,
            };
          });

          const moyennesValides = taches.filter(t => t.moyenne_3_meilleures !== null);
          const niveauEquipe = moyennesValides.length
            ? Math.round((moyennesValides.reduce((s, t) => s + t.moyenne_3_meilleures, 0) / moyennesValides.length) * 10) / 10
            : null;

          return new Response(JSON.stringify({
            ok: true, magasin_code: code, annee, langue: store?.langue || '',
            niveau_equipe: niveauEquipe, objectif: OBJECTIF_NIVEAU_EQUIPE, taches,
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture magasin : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/evaluation/fiche') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        const { magasin_code, tache, responsable, responsable_depuis, second, second_depuis } = await request.json();
        if (!magasin_code || !tache) return jsonError('magasin_code et tache requis', 400, corsHeaders);

        if (sessionAr !== 'ALL') {
          const stores = await getMagasinsServerSide();
          const allowedCodes = await getAllowedCodes(sessionAr, stores);
          if (!allowedCodes.includes(magasin_code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
        }

        try {
          await env.DB.prepare(
            `INSERT INTO responsables_taches (magasin_code, tache, responsable, responsable_depuis, second, second_depuis)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (magasin_code, tache) DO UPDATE SET
               responsable = excluded.responsable, responsable_depuis = excluded.responsable_depuis,
               second = excluded.second, second_depuis = excluded.second_depuis, updated_at = datetime('now')`
          ).bind(magasin_code, tache, responsable || null, responsable_depuis || null, second || null, second_depuis || null).run();
        } catch (e) {
          return jsonError('Erreur enregistrement fiche : ' + String(e), 500, corsHeaders);
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      if (url.pathname === '/evaluation/correction') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        if (sessionAr !== 'ALL') return jsonError('Réservé aux comptes à accès complet', 403, corsHeaders);

        const { id, criteres } = await request.json();
        if (!id || !Array.isArray(criteres) || criteres.length !== 10) {
          return jsonError('id et 10 critères requis', 400, corsHeaders);
        }
        const note = criteres.filter(Boolean).length;

        try {
          await env.DB.prepare(
            `UPDATE notes_equipe SET note = ?, criteres_json = ?, modifie_par = ?, modifie_le = datetime('now')
             WHERE id = ?`
          ).bind(note, JSON.stringify(criteres), sessionAr, id).run();
        } catch (e) {
          return jsonError('Erreur correction : ' + String(e), 500, corsHeaders);
        }

        return new Response(JSON.stringify({ ok: true, note }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      if (url.pathname === '/evaluation/supprimer-controle') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        if (sessionAr !== 'ALL') return jsonError('Réservé aux comptes à accès complet', 403, corsHeaders);

        const { id } = await request.json();
        if (!id) return jsonError('id requis', 400, corsHeaders);

        try {
          await env.DB.prepare('DELETE FROM notes_equipe WHERE id = ?').bind(id).run();
        } catch (e) {
          return jsonError('Erreur suppression : ' + String(e), 500, corsHeaders);
        }

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      if (url.pathname === '/evaluation/reseau') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        try {
          const annee = anneeCouranteEval();
          const stores = await getMagasinsServerSide();
          const allowedCodes = sessionAr === 'ALL' ? null : new Set(await getAllowedCodes(sessionAr, stores));
          const storesByCode = Object.fromEntries(stores.map(s => [s.code, s]));

          // Tâches actives regroupées par pays (fichier criteres_taches.csv) :
          // chaque magasin est comparé au nombre de tâches définies pour SON pays,
          // pas à une liste unique valable pour tout le réseau.
          const criteresRows = await getCriteresTachesServerSide();
          const activeTachesParPays = {};
          for (const r of criteresRows) {
            (activeTachesParPays[r.pays] ??= new Set()).add(r.tache);
          }

          const { results: notes } = await env.DB.prepare(
            `SELECT magasin_code, magasin_libelle, tache, note FROM notes_equipe WHERE annee = ?`
          ).bind(annee).all();

          const parMagasin = {};
          for (const n of notes) {
            if (allowedCodes && !allowedCodes.has(n.magasin_code)) continue;
            const m = (parMagasin[n.magasin_code] ??= { taches: {} });
            (m.taches[n.tache] ??= []).push(n.note);
          }

          const niveaux = {};
          const controles = {};
          for (const [code, data] of Object.entries(parMagasin)) {
            const moyennes = Object.values(data.taches).map(notesArr => {
              const top3 = [...notesArr].sort((a, b) => b - a).slice(0, 3);
              return top3.reduce((s, n) => s + n, 0) / top3.length;
            });
            niveaux[code] = moyennes.length
              ? Math.round((moyennes.reduce((s, m2) => s + m2, 0) / moyennes.length) * 10) / 10
              : null;

            const pays = storesByCode[code]?.pays || '';
            const activeTaches = [...(activeTachesParPays[pays] || [])];
            const minControles = activeTaches.length
              ? Math.min(...activeTaches.map(t => (data.taches[t] || []).length))
              : 0;
            controles[code] = Math.min(minControles, 3);
          }

          return new Response(JSON.stringify({ ok: true, annee, niveaux, controles }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur calcul niveaux réseau : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/evaluation/export-reseau') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        if (sessionAr !== 'ALL') return jsonError('Réservé aux comptes à accès complet', 403, corsHeaders);

        try {
          const csv = await buildNiveauxEvalCsv(env);
          return new Response('\ufeff' + csv, {
            status: 200,
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': `attachment; filename="evaluation-equipe-${anneeCouranteEval()}.csv"`,
              ...corsHeaders,
            },
          });
        } catch (e) {
          return jsonError('Erreur génération export : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- PEDLV (Analyse statistique / "Générateur de synthèse") ----------
      // Écriture simple, volontairement sans authentification (décision Olivier :
      // outil posé en magasin, utilisé sur place, pas un animateur itinérant —
      // pas de session à vérifier ni de token à protéger, contrairement aux
      // autres apps). Pas de cross-app store_stats_history / santé magasin pour
      // l'instant (fonctionnalité France non encore portée côté Bilan de Passage
      // international) : ce sera un lot séparé si besoin plus tard.
      if (url.pathname === '/store-stats') {
        { const acces = await accesOutilOuSession(request, env, ['PEDLV_STORE_TOKEN']); if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        try {
          const s = await request.json();
          if (!s.magasin) return jsonError('Champ magasin requis', 400, corsHeaders);
          await env.DB.prepare(
            `INSERT INTO store_stats (magasin, code_magasin, periode, date_extraction, ca_total, ca_opt, ca_audio, panier_moyen, taux_tc, taux_sop, taux_mdc, protheses_vendues, taux_essai, objectif, raf, prios_json, taux_test_auditif, taux_vente_add_audio, taux_pack_confort, pm_pack_confort, indicateurs_json, nb_vente_opt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            s.magasin, s.codeMagasin || null, s.periode || null, s.dateExtraction || null,
            s.caTotal ?? null, s.caOpt ?? null, s.caAudio ?? null, s.panierMoyen ?? null,
            s.tauxTc ?? null, s.tauxSop ?? null, s.tauxMdc ?? null,
            s.prothesesVendues ?? null, s.tauxEssai ?? null, s.objectif ?? null, s.raf ?? null,
            JSON.stringify(s.prios || []),
            s.tauxTestAuditif ?? null, s.tauxVenteAddAudio ?? null,
            s.tauxPackConfort ?? null, s.pmPackConfort ?? null,
            JSON.stringify(s.indicateurs || {}), s.nbVenteOpt ?? null
          ).run();
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur enregistrement : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Kaizen (grille d'audit 5S mensuelle) ----------
      // Même politique que PEDLV : pas de session ni de token à vérifier (le
      // magasin s'auto-sélectionne dans une liste, ce n'est pas un animateur
      // itinérant qui se connecte). Logique portée à l'identique du worker
      // France (getKaizenReferentiel / kaizenItemsApplicables /
      // kaizenComputeScore), avec le filtre pays en plus (cf. commentaire sur
      // kaizenItemsApplicables).
      if (url.pathname === '/kaizen-etat') {
        { const acces = await accesOutilOuSession(request, env, ['KAIZEN_STORE_TOKEN']); if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

        const code = url.searchParams.get('code');
        const mois = url.searchParams.get('mois');
        if (!code || !mois) return jsonError('Paramètres code et mois requis', 400, corsHeaders);

        try {
          const stores = await getMagasinsServerSide();
          const store = stores.find(s => s.code === code);
          if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);

          const zones = await getKaizenReferentiel();
          const itemsApplicables = kaizenItemsApplicables(zones, store.concept, store.pays);

          const row = await env.DB.prepare(
            `SELECT * FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`
          ).bind(code, mois).first();

          const itemsState = row ? JSON.parse(row.items_json) : {};
          const { score, scoreMax } = kaizenComputeScore(itemsState, itemsApplicables);

          return new Response(JSON.stringify({
            ok: true,
            magasin_code: code,
            magasin_libelle: store.libelle,
            concept: store.concept,
            meuble_vitrine: store.meubleVitrine,
            presentoir_verres: store.presentoirVerres,
            mois,
            zones,
            items_state: itemsState,
            score, score_max: scoreMax,
            closed: row ? !!row.closed : false,
            imported: row ? !!row.imported : false,
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture audit Kaizen : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/kaizen-toggle') {
        { const acces = await accesOutilOuSession(request, env, ['KAIZEN_STORE_TOKEN']); if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

        const { magasin_code, mois, item_id, checked, controleur } = await request.json();
        if (!magasin_code || !mois || !item_id || !controleur) {
          return jsonError('Payload invalide : magasin_code, mois, item_id et controleur requis', 400, corsHeaders);
        }

        try {
          const stores = await getMagasinsServerSide();
          const store = stores.find(s => s.code === magasin_code);
          if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);

          const existing = await env.DB.prepare(
            `SELECT * FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`
          ).bind(magasin_code, mois).first();

          if (existing && existing.closed) {
            return jsonError('Cet audit est clôturé, il ne peut plus être modifié', 409, corsHeaders);
          }

          const itemsState = existing ? JSON.parse(existing.items_json) : {};
          itemsState[item_id] = { checked: !!checked, controleur, checked_at: new Date().toISOString() };

          const zones = await getKaizenReferentiel();
          const itemsApplicables = kaizenItemsApplicables(zones, store.concept, store.pays);
          const { score, scoreMax } = kaizenComputeScore(itemsState, itemsApplicables);

          if (existing) {
            await env.DB.prepare(
              `UPDATE kaizen_audits SET items_json = ?, score = ?, score_max = ?, updated_at = datetime('now') WHERE id = ?`
            ).bind(JSON.stringify(itemsState), score, scoreMax, existing.id).run();
          } else {
            await env.DB.prepare(
              `INSERT INTO kaizen_audits (magasin_code, mois, items_json, score, score_max) VALUES (?, ?, ?, ?, ?)`
            ).bind(magasin_code, mois, JSON.stringify(itemsState), score, scoreMax).run();
          }

          return new Response(JSON.stringify({ ok: true, score, score_max: scoreMax }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (e) {
          return jsonError('Erreur sauvegarde audit Kaizen : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/kaizen-photo' && request.method === 'POST') {
        { const acces = await accesOutilOuSession(request, env, ['KAIZEN_STORE_TOKEN']); if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
        if (!env.PHOTOS) return jsonError('Bucket R2 non lié au Worker (binding PHOTOS manquant)', 500, corsHeaders);

        const key = url.searchParams.get('key');
        const code = url.searchParams.get('code');
        if (!key || !code) return jsonError('Paramètres key et code requis', 400, corsHeaders);
        if (!key.startsWith(code + '/')) return jsonError('Clé photo invalide pour ce magasin', 400, corsHeaders);

        try {
          const contentType = request.headers.get('Content-Type') || 'image/jpeg';
          const bytes = await request.arrayBuffer();
          // Préfixe kaizen/ : le bucket R2 (oc-inter-photos) est partagé entre
          // plusieurs apps, ce préfixe évite toute collision de clé avec une
          // autre app qui écrirait aussi sous {code}/... (16/09).
          await env.PHOTOS.put('kaizen/' + key, bytes, { httpMetadata: { contentType } });
          return new Response(JSON.stringify({ ok: true, key }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (e) {
          return jsonError('Erreur upload photo Kaizen : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/kaizen-photo' && request.method === 'GET') {
        if (!env.PHOTOS) return jsonError('Bucket R2 non lié au Worker (binding PHOTOS manquant)', 500, corsHeaders);

        const key = url.searchParams.get('key');
        if (!key) return jsonError('Paramètre key requis', 400, corsHeaders);

        try {
          const object = await env.PHOTOS.get('kaizen/' + key);
          if (!object) return jsonError('Photo introuvable', 404, corsHeaders);
          return new Response(object.body, {
            status: 200,
            headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg', ...corsHeaders },
          });
        } catch (e) {
          return jsonError('Erreur lecture photo Kaizen : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/kaizen-historique') {
        { const acces = await accesOutilOuSession(request, env, ['KAIZEN_STORE_TOKEN']); if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

        const code = url.searchParams.get('code');
        if (!code) return jsonError('Paramètre code requis', 400, corsHeaders);

        try {
          const { results } = await env.DB.prepare(
            `SELECT mois, score, score_max, closed, imported FROM kaizen_audits WHERE magasin_code = ? ORDER BY mois DESC LIMIT 12`
          ).bind(code).all();

          const anneeCourante = new Date().getFullYear().toString();
          const cumulAnnuel = Math.round(
            results.filter(r => r.mois.startsWith(anneeCourante)).reduce((s, r) => s + (r.score || 0), 0) * 10
          ) / 10;

          return new Response(JSON.stringify({ ok: true, historique: results, cumul_annuel: cumulAnnuel }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (e) {
          return jsonError('Erreur historique Kaizen : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Observations Terrain (carnet de terrain animateur) ----------
      // Contrairement à PEDLV/Kaizen, cet outil est utilisé par un animateur en
      // tournée (pas posé en magasin) : session Zimbra requise, comme Bilan de
      // Passage et Évaluation Équipe (décision Olivier, 17/09).
      if (url.pathname === '/store-observation') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        try {
          const o = await request.json();
          if (!o.m || !o.th || !o.tx || !o.t || !o.d) return jsonError('Champs requis manquants', 400, corsHeaders);
          await env.DB.prepare(
            `INSERT INTO observations (obs_id, magasin, theme, tone, texte, jour_label, date_key, ar_login, ar_nom)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(o.id || null, o.m, o.th, o.t, o.tx, o.dl || null, o.d, sessionAr, sessionAr).run();

          if (o.m !== 'Info générale' && o.m !== 'Info generale') {
            try {
              await env.DB.prepare(
                `INSERT INTO observation_last_visit (magasin, last_date) VALUES (?, ?)
                 ON CONFLICT(magasin) DO UPDATE SET last_date = CASE WHEN excluded.last_date > last_date THEN excluded.last_date ELSE last_date END`
              ).bind(o.m, o.d).run();
            } catch (e) { console.error('Erreur maj observation_last_visit:', e); }
          }

          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur enregistrement : ' + String(e), 500, corsHeaders);
        }
      }

      // Un mail par clôture de journée, à Cécilia + Olivier (pendant la mise en
      // place) + directeur(s) pays des magasins visités ce jour-là (décision
      // Olivier, 17/09). Contenu envoyé tel quel par le client (pas reconstitué
      // depuis D1), comme en France.
      if (url.pathname === '/obs-day-close') {
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        try {
          const body = await request.json();
          if (!Array.isArray(body.items) || !body.items.length) return jsonError('Aucune observation à envoyer', 400, corsHeaders);

          const stores = await getMagasinsServerSide();
          const magasinsVisites = [...new Set(body.items.map(it => it.m))];
          const directeurEmails = new Set();
          magasinsVisites.forEach(nomMagasin => {
            const store = stores.find(s => s.libelle === nomMagasin || s.code === nomMagasin);
            if (store?.directeurPaysEmail) directeurEmails.add(store.directeurPaysEmail);
          });
          const destinataires = [...new Set([...ADMIN_ALERT_EMAILS, ...directeurEmails])];

          const dateFr = (body.dateLabel || body.date || '');
          const subject = `Observations terrain — ${body.ar || sessionAr} — ${dateFr}`;
          const bodyText = body.items.map(it =>
            `${it.m} — ${it.th} [${it.t === 'p' ? 'Positif' : 'À améliorer'}]\n${it.tx}\n`
          ).join('\n');

          await zimbraSendMail(env, { to: destinataires, subject, bodyText });

          return new Response(JSON.stringify({ ok: true, sentTo: destinataires }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur envoi clôture journée : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/rh-import/etat' && request.method === 'GET') {
        if (!(await verifyArSession(request.headers.get('X-AR-Session')))) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        try {
          const { results: effectifMois } = await env.DB.prepare(
            `SELECT mois, COUNT(DISTINCT matricule) as nb_salaries FROM rh_effectif_site_mensuel GROUP BY mois ORDER BY mois DESC LIMIT 12`
          ).all();
          const { results: agendaMois } = await env.DB.prepare(
            `SELECT mois, COUNT(*) as nb_salaries FROM rh_agenda_mensuel GROUP BY mois ORDER BY mois DESC LIMIT 12`
          ).all();
          return new Response(JSON.stringify({ ok: true, effectifMois, agendaMois }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture état RH : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Import RH (17/09, mis à jour) ----------
      // Mêmes libellés de colonnes et mêmes règles que la France (décision
      // Olivier) — réservé à ALL (Cécilia/Olivier), comme en France.
      if (url.pathname === '/rh-import/effectif') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (sessionAr !== 'ALL') return jsonError('Réservé aux comptes à accès complet', 403, corsHeaders);

        try {
          const body = await request.json();
          const mois = (body.mois || '').trim();
          const rows = Array.isArray(body.rows) ? body.rows : [];
          if (!/^\d{4}-\d{2}$/.test(mois)) return jsonError('Champ "mois" requis, format YYYY-MM', 400, corsHeaders);
          if (!rows.length) return jsonError('Aucune ligne à importer', 400, corsHeaders);

          const stores = await getMagasinsServerSide();
          const magasinsCodes = new Set(stores.map(s => s.code));

          const now = new Date().toISOString();
          const sitesNonReconnus = new Map();
          let nbSalaries = 0, nbSansSite = 0;
          const stmts = [];

          for (const row of rows) {
            const matricule = String(row['Matricule'] ?? '').trim();
            if (!matricule) continue;
            nbSalaries++;

            const poste = String(row['Poste'] ?? '').trim();
            const posteCategorie = rhMapPosteCategorie(poste);
            const codesSitesRaw = String(row['Codes sites'] ?? '').trim();
            const nomsSitesRaw = String(row['Noms sites'] ?? '').trim();
            const codesSites = codesSitesRaw ? codesSitesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            const nomsSites = nomsSitesRaw ? nomsSitesRaw.split(',').map(s => s.trim()) : [];
            const nbSites = codesSites.length;
            if (!nbSites) nbSansSite++;

            stmts.push(env.DB.prepare(
              `INSERT INTO rh_effectif_mensuel (mois, matricule, nom, prenom, genre, poste, poste_categorie, codes_sites, nb_sites, date_entree, date_depart, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(mois, matricule) DO UPDATE SET
                 nom=excluded.nom, prenom=excluded.prenom, genre=excluded.genre, poste=excluded.poste,
                 poste_categorie=excluded.poste_categorie, codes_sites=excluded.codes_sites, nb_sites=excluded.nb_sites,
                 date_entree=excluded.date_entree, date_depart=excluded.date_depart, created_at=excluded.created_at`
            ).bind(
              mois, matricule,
              String(row['Nom'] ?? '').trim() || null, String(row['Prénom'] ?? '').trim() || null,
              String(row['Genre'] ?? '').trim() || null, poste || null, posteCategorie,
              codesSitesRaw || null, nbSites,
              String(row["Date d'entrée"] ?? '').trim() || null, String(row['Date de départ'] ?? '').trim() || null,
              now
            ));

            stmts.push(env.DB.prepare(`DELETE FROM rh_effectif_site_mensuel WHERE mois = ? AND matricule = ?`).bind(mois, matricule));

            codesSites.forEach((codeRh, i) => {
              const { code, reconnu } = rhMapCodeSiteVersMagasin(codeRh, magasinsCodes);
              const codeFinal = code || codeRh;
              if (!reconnu) sitesNonReconnus.set(codeFinal, nomsSites[i] || '');
              stmts.push(env.DB.prepare(
                `INSERT INTO rh_effectif_site_mensuel (mois, matricule, code_site, site_reconnu, poste_categorie, poids)
                 VALUES (?, ?, ?, ?, ?, ?)`
              ).bind(mois, matricule, codeFinal, reconnu ? 1 : 0, posteCategorie, 1 / nbSites));
            });
          }

          for (let i = 0; i < stmts.length; i += 400) {
            await env.DB.batch(stmts.slice(i, i + 400));
          }

          return new Response(JSON.stringify({
            ok: true, mois, nbSalaries, nbSansSite,
            sitesNonReconnus: [...sitesNonReconnus.entries()].map(([code, nom]) => ({ code, nom })),
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur import effectif : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/rh-import/agenda') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (sessionAr !== 'ALL') return jsonError('Réservé aux comptes à accès complet', 403, corsHeaders);

        try {
          const body = await request.json();
          const mois = (body.mois || '').trim();
          const rows = Array.isArray(body.rows) ? body.rows : [];
          if (!/^\d{4}-\d{2}$/.test(mois)) return jsonError('Champ "mois" requis, format YYYY-MM', 400, corsHeaders);
          if (!rows.length) return jsonError('Aucune ligne à importer', 400, corsHeaders);

          const joursCalendaires = rhJoursDansMois(mois);
          const moisPrecedent = rhMoisPrecedent(mois);
          const { results: prevRows } = await env.DB.prepare(
            `SELECT matricule, maladie_at_jours FROM rh_agenda_mensuel WHERE mois = ?`
          ).bind(moisPrecedent).all();
          const maladieAtMoisPrecedent = new Map(prevRows.map(r => [r.matricule, r.maladie_at_jours || 0]));

          const now = new Date().toISOString();
          const stmts = [];
          let nbSalaries = 0, nbLongueDuree = 0;

          for (const row of rows) {
            const matricule = String(row['Matricule'] ?? '').trim();
            if (!matricule) continue;
            nbSalaries++;

            const joursGroupeA = rhSommeColonnes(row, RH_GROUPE_A_COLS);
            const joursGroupeB = rhSommeColonnes(row, RH_GROUPE_B_COLS);
            const maladieAtJours = rhSommeColonnes(row, RH_MALADIE_AT_COLS);
            const maternitéParentalJours = rhSommeColonnes(row, RH_MATERNITE_PARENTAL_COLS);
            const reposHebdo = rhNum(row['Repos hebdomadaire']);
            const feries = rhNum(row['Férié']);
            const fermeture = rhNum(row['Jour de fermeture']);
            const joursOuvresTheoriques = joursCalendaires - reposHebdo - feries - fermeture;

            let longueDuree = 0;
            if (maternitéParentalJours > 0) {
              longueDuree = 1;
            } else if (maladieAtJours > 0 && (maladieAtMoisPrecedent.get(matricule) || 0) > 0) {
              longueDuree = 1;
            }
            if (longueDuree) nbLongueDuree++;

            stmts.push(env.DB.prepare(
              `INSERT INTO rh_agenda_mensuel (mois, matricule, type_contrat, jours_groupe_a, jours_groupe_b, jours_calendaires, jours_repos_hebdo, jours_feries, jours_fermeture_magasin, jours_ouvres_theoriques, maladie_at_jours, longue_duree, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(mois, matricule) DO UPDATE SET
                 type_contrat=excluded.type_contrat, jours_groupe_a=excluded.jours_groupe_a, jours_groupe_b=excluded.jours_groupe_b,
                 jours_calendaires=excluded.jours_calendaires, jours_repos_hebdo=excluded.jours_repos_hebdo, jours_feries=excluded.jours_feries,
                 jours_fermeture_magasin=excluded.jours_fermeture_magasin, jours_ouvres_theoriques=excluded.jours_ouvres_theoriques,
                 maladie_at_jours=excluded.maladie_at_jours, longue_duree=excluded.longue_duree, created_at=excluded.created_at`
            ).bind(
              mois, matricule, String(row['Type contrat'] ?? '').trim() || null,
              joursGroupeA, joursGroupeB, joursCalendaires, reposHebdo, feries, fermeture, joursOuvresTheoriques,
              maladieAtJours, longueDuree, now
            ));
          }

          for (let i = 0; i < stmts.length; i += 400) {
            await env.DB.batch(stmts.slice(i, i + 400));
          }

          return new Response(JSON.stringify({ ok: true, mois, nbSalaries, nbLongueDuree }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (e) {
          return jsonError('Erreur import agenda : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Score de santé magasin (17/09) ----------
      if (url.pathname === '/store-health') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        const stores = await getMagasinsServerSide();
        let scope = stores;
        if (sessionAr !== 'ALL') {
          const allowedCodes = new Set(await getAllowedCodes(sessionAr, stores));
          scope = stores.filter(s => allowedCodes.has(s.code));
        }

        const magasinCode = url.searchParams.get('magasin_code');
        if (magasinCode) {
          scope = scope.filter(s => s.code === magasinCode);
          if (!scope.length) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
        }

        try {
          const results = await buildStoreHealthResults(env, scope);
          let networkTrend = [];
          if (!magasinCode && scope.length) {
            const codesScope = new Set(scope.map(s => s.code));
            const { results: allRows } = await env.DB.prepare(
              `SELECT magasin_code, period_key, score FROM store_health_score_history WHERE score IS NOT NULL ORDER BY period_key ASC`
            ).all();
            const parPeriode = {};
            for (const r of allRows) {
              if (!codesScope.has(r.magasin_code)) continue;
              (parPeriode[r.period_key] ??= []).push(r.score);
            }
            networkTrend = Object.entries(parPeriode)
              .map(([periode, scores]) => ({ periode, score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10, nbMagasins: scores.length }))
              .sort((a, b) => a.periode.localeCompare(b.periode))
              .slice(-26);
          }
          return new Response(JSON.stringify({ ok: true, results, networkTrend }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur calcul fiche santé magasins : ' + String(e), 500, corsHeaders);
        }
      }

      // Version V1 internationale, volontairement plus légère que la France :
      // pas de suivi "indicateurs PEDLV rouges qui traînent" ni "points Kaizen
      // non résolus depuis plusieurs mois" (dépendent d'historiques hebdo/mensuels
      // pas encore construits côté international) — score + sous-scores +
      // historique 26 semaines déjà fonctionnels, le reste pourra s'ajouter ensuite
      // sans changer la forme de la réponse (nouvelles clés uniquement).
      if (url.pathname === '/store-health-detail') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        const code = url.searchParams.get('magasin_code');
        if (!code) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);

        const stores = await getMagasinsServerSide();
        const store = stores.find(s => s.code === code);
        if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
        if (sessionAr !== 'ALL') {
          const allowedCodes = new Set(await getAllowedCodes(sessionAr, stores));
          if (!allowedCodes.has(code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
        }

        try {
          const [base] = await buildStoreHealthResults(env, [store]);

          const { results: historyRows } = await env.DB.prepare(
            `SELECT period_key, score, score_actions, score_effectif, score_absenteisme, score_positionnement,
             score_pedlv, score_avis, score_equipe, score_kaizen
             FROM store_health_score_history WHERE magasin_code = ? ORDER BY period_key ASC LIMIT 26`
          ).bind(code).all();
          const history = historyRows.map(r => ({
            periode: r.period_key, score: r.score,
            sousScores: {
              actions: r.score_actions, effectif: r.score_effectif, absenteisme: r.score_absenteisme,
              positionnement: r.score_positionnement, pedlv: r.score_pedlv, avis: r.score_avis,
              equipe: r.score_equipe, kaizen: r.score_kaizen,
            },
          }));

          const storeStatsMap = await getStoreStatsMap(env);
          const statsRow = storeStatsMap[code] || null;
          let positionnementMensuel = null;
          if (statsRow && statsRow.objectif) {
            positionnementMensuel = Math.round(((statsRow.objectif - (statsRow.raf || 0)) / statsRow.objectif) * 1000) / 10;
          }
          const pedlvSummary = computePedlvSummary(statsRow);
          const pedlvIndicateurs = pedlvSummary && statsRow.indicateurs
            ? Object.entries(statsRow.indicateurs).map(([key, v]) => ({ cle: key, valeur: v.valeur, objectif: v.objectif, statut: v.statut, categorie: v.categorie }))
            : [];

          return new Response(JSON.stringify({
            ok: true, ...base, history, positionnementMensuel, pedlvIndicateurs,
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur détail santé magasin : ' + String(e), 500, corsHeaders);
        }
      }

      // "Mon dashboard" — équivalent fiche magasin, agrégé sur tout le périmètre
      // d'un animateur (ou d'un directeur pays / ALL). Réutilise buildStoreHealthResults.
      if (url.pathname === '/ar-dashboard') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        const arName = url.searchParams.get('ar') || sessionAr;
        if (sessionAr !== 'ALL' && sessionAr !== arName) return jsonError('Périmètre hors de votre accès', 403, corsHeaders);

        const allStores = await getMagasinsServerSide();
        let scope;
        if (arName === 'ALL') {
          scope = allStores;
        } else if (arName.startsWith('PAYS:')) {
          const paysListe = arName.slice('PAYS:'.length).split('|');
          scope = allStores.filter(s => paysListe.includes(s.pays));
        } else {
          scope = allStores.filter(s => s.animateur === arName);
        }
        if (!scope.length) return jsonError('Aucun magasin trouvé pour ce périmètre', 404, corsHeaders);

        try {
          const results = await buildStoreHealthResults(env, scope);
          const codesScope = new Set(scope.map(s => s.code));
          const { results: allRows } = await env.DB.prepare(
            `SELECT magasin_code, period_key, score, score_actions, score_effectif, score_absenteisme, score_positionnement,
             score_pedlv, score_avis, score_equipe, score_kaizen
             FROM store_health_score_history WHERE score IS NOT NULL ORDER BY period_key ASC`
          ).all();
          const parPeriode = {};
          for (const r of allRows) {
            if (!codesScope.has(r.magasin_code)) continue;
            (parPeriode[r.period_key] ??= []).push(r);
          }
          const avgOf = (rows, key) => {
            const vals = rows.map(r => r[key]).filter(v => v !== null && v !== undefined);
            return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
          };
          const history = Object.entries(parPeriode).map(([periode, rows]) => ({
            periode, score: avgOf(rows, 'score'),
            sousScores: {
              actions: avgOf(rows, 'score_actions'), effectif: avgOf(rows, 'score_effectif'), absenteisme: avgOf(rows, 'score_absenteisme'),
              positionnement: avgOf(rows, 'score_positionnement'), pedlv: avgOf(rows, 'score_pedlv'), avis: avgOf(rows, 'score_avis'),
              equipe: avgOf(rows, 'score_equipe'), kaizen: avgOf(rows, 'score_kaizen'),
            },
          })).sort((a, b) => a.periode.localeCompare(b.periode)).slice(-26);

          const moyenneListe = vals => { const v = vals.filter(x => x !== null && x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
          const scoreMoyen = moyenneListe(results.map(r => r.score));
          const magasinsEnRetard = results.filter(r => r.overdue).length;

          return new Response(JSON.stringify({
            ok: true, ar: arName, results, history, scoreMoyen, magasinsEnRetard, nbMagasins: scope.length,
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur dashboard animateur : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Liste des bilans (lecture — session animateur requise) ----------
      if (url.pathname === '/bilans') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

        let allowedCodes = null;
        if (sessionAr !== 'ALL') {
          const stores = await getMagasinsServerSide();
          allowedCodes = await getAllowedCodes(sessionAr, stores);
        }

        const magasinCode = url.searchParams.get('magasin_code');
        if (magasinCode && allowedCodes && !allowedCodes.includes(magasinCode)) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 1000);

        let query = 'SELECT id, magasin_code, magasin_libelle, ar, date, passage, humeur, ca_mensuel, ca_annuel, renta, data_json, created_at FROM bilans WHERE 1=1';
        const binds = [];
        if (magasinCode) { query += ' AND magasin_code = ?'; binds.push(magasinCode); }
        else if (allowedCodes) {
          if (!allowedCodes.length) return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
          query += ' AND magasin_code IN (' + allowedCodes.map(() => '?').join(',') + ')';
          binds.push(...allowedCodes);
        }
        if (from) { query += ' AND date >= ?'; binds.push(from); }
        if (to) { query += ' AND date <= ?'; binds.push(to); }
        query += ' ORDER BY date DESC LIMIT ?';
        binds.push(limit);

        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }


      // ======================================================================
      // Lot 0 (25/10/2026) — routes appelées par les applis mais absentes
      // jusqu'ici du Worker international (404 silencieux côté appli).
      // ======================================================================

      // ---------- Notification par mail (nouvel indicateur personnalisé) ----------
      // L'animateur s'authentifie avec ses propres identifiants Zimbra : c'est la
      // vraie protection. Destinataire limité aux adresses Optical Center.
      if (url.pathname === '/notify') {
        const { to, subject, body, zimbraUser, zimbraPass } = await request.json();
        if (!to || !subject || !body || !zimbraUser || !zimbraPass) return jsonError('Paramètres manquants', 400, corsHeaders);
        if (!/@optical-center\.com$/i.test(String(to).trim())) return jsonError('Destinataire non autorisé', 403, corsHeaders);
        const authResp = await fetch(ZIMBRA_SOAP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
            Body: { AuthRequest: { _jsns: 'urn:zimbraAccount', account: { by: 'name', _content: zimbraUser }, password: { _content: zimbraPass } } },
          }),
        });
        const authData = await authResp.json();
        const token = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
        if (!token) return jsonError('Auth Zimbra échouée', 401, corsHeaders);
        const sendResp = await fetch(ZIMBRA_SOAP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cookie': `ZM_AUTH_TOKEN=${token}` },
          body: JSON.stringify({
            Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' }, authToken: [{ _content: token }] } },
            Body: { SendMsgRequest: { _jsns: 'urn:zimbraMail', m: { su: { _content: subject }, e: [{ t: 't', a: String(to).trim() }], mp: { ct: 'text/plain', content: { _content: body } } } } },
          }),
        });
        const sendText = await sendResp.text();
        return new Response(sendText, { status: sendResp.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Notes Google (lecture du cache D1 alimenté par le cron) ----------
      if (url.pathname === '/google-ratings') {
        const acces = await accesOutilOuSession(request, env, ['BILAN_STORE_TOKEN']);
        if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders);
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        try {
          const { results } = await env.DB.prepare('SELECT magasin_code, rating, reviews_count, updated_at FROM google_ratings').all();
          const ratings = {};
          for (const r of results) ratings[r.magasin_code] = { rating: r.rating, reviewsCount: r.reviews_count, updatedAt: r.updated_at };
          return new Response(JSON.stringify({ ok: true, ratings }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture google_ratings : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Effectif RH (pré-remplissage Bilan de Passage et Analyse statistique) ----------
      // ?magasin_code=CODE (Bilan) : dernier mois importé POUR CE MAGASIN.
      // ?noms=A,B (Analyse statistique) : résolution par libellé magasins_inter.csv.
      if (url.pathname === '/rh-effectif') {
        const acces = await accesOutilOuSession(request, env, ['BILAN_STORE_TOKEN', 'PEDLV_STORE_TOKEN']);
        if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders);
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        try {
          const magasinCode = url.searchParams.get('magasin_code');
          const nomsRaw = url.searchParams.get('noms');
          const row = magasinCode
            ? await env.DB.prepare(`SELECT MAX(mois) as mois FROM rh_effectif_site_mensuel WHERE code_site = ? AND site_reconnu = 1`).bind(magasinCode).first()
            : await env.DB.prepare(`SELECT MAX(mois) as mois FROM rh_effectif_site_mensuel`).first();
          const dernierMois = row && row.mois;
          if (!dernierMois) return new Response(JSON.stringify({ ok: true, mois: null, magasins: {} }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

          let query = `SELECT code_site, poste_categorie, SUM(poids) as total FROM rh_effectif_site_mensuel
                       WHERE mois = ? AND site_reconnu = 1 AND poste_categorie IS NOT NULL`;
          const binds = [dernierMois];
          if (magasinCode) { query += ' AND code_site = ?'; binds.push(magasinCode); }
          query += ' GROUP BY code_site, poste_categorie';
          const { results } = await env.DB.prepare(query).bind(...binds).all();
          const magasins = {};
          for (const r of results) {
            if (!magasins[r.code_site]) magasins[r.code_site] = { eff_opt: 0, eff_audio: 0 };
            const val = Math.round(r.total * 10) / 10;
            if (r.poste_categorie === 'opticien') magasins[r.code_site].eff_opt = val;
            if (r.poste_categorie === 'audio') magasins[r.code_site].eff_audio = val;
          }

          if (nomsRaw) {
            const stores = await getMagasinsServerSide();
            const storeByName = new Map(stores.map(s => [normalizeName(s.libelle), s]));
            const parNom = {};
            for (const nom of nomsRaw.split(',').map(s => s.trim()).filter(Boolean)) {
              const store = storeByName.get(normalizeName(nom));
              if (store && magasins[store.code]) parNom[nom] = magasins[store.code];
            }
            return new Response(JSON.stringify({ ok: true, mois: dernierMois, magasins: parNom }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
          }
          return new Response(JSON.stringify({ ok: true, mois: dernierMois, magasins }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture effectif : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Analyse IA de l'historique (un magasin ou une tournée) ----------
      if (url.pathname === '/analyze') {
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        if (!env.ANTHROPIC_API_KEY) return jsonError('Clé API Anthropic non configurée sur le Worker (secret ANTHROPIC_API_KEY)', 500, corsHeaders);
        const { mode, bilans } = await request.json();
        if (!Array.isArray(bilans) || !bilans.length) return jsonError('Aucune donnée à analyser', 400, corsHeaders);

        // Un animateur ou un directeur pays n'analyse que ses propres magasins.
        if (sessionAr !== 'ALL') {
          const allowed = new Set(await getAllowedCodes(sessionAr, await getMagasinsServerSide()));
          const tous = mode === 'group' ? bilans.flat() : bilans;
          const horsPerimetre = tous.some(b => { const c = b?.magasin?.code || b?.magasin_code; return c && !allowed.has(c); });
          if (horsPerimetre) return jsonError('Accès non autorisé à un des magasins demandés', 403, corsHeaders);
        }

        let system, user;
        if (mode === 'group') {
          system = `Tu es un assistant qui aide un animateur réseau (AR) d'Optical Center à préparer sa tournée terrain. On te donne l'historique récent de plusieurs magasins. Pour chaque magasin, produis une synthèse courte et actionnable : tendance générale, actions non résolues qui traînent, et 1 à 2 points de vigilance prioritaires. Reste factuel, base-toi uniquement sur les données fournies, sois concis. Structure ta réponse par magasin avec un titre clair. Réponds en français.`;
          user = bilans.map((storeBilans, i) => `=== Magasin ${i + 1} ===\n` + storeBilans.map(b => resumeBilan(b)).join('\n\n---\n\n')).join('\n\n\n');
        } else {
          system = `Tu es un assistant qui aide un animateur réseau (AR) d'Optical Center à analyser l'historique d'un magasin. On te donne les bilans de passage successifs. Identifie les tendances (amélioration/dégradation), les actions récurrentes qui ne sont jamais résolues, et les points d'alerte. Reste factuel, base-toi uniquement sur les données fournies, sois concis et actionnable. Réponds en français.`;
          user = bilans.map(b => resumeBilan(b)).join('\n\n---\n\n');
        }
        const r = await appelClaude(env, { system, user, maxTokens: 1500 });
        if (!r.ok) return new Response(JSON.stringify({ error: r.data }), { status: r.status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        await logAnalyzeCall(env, {
          ar: sessionAr, mode: mode || 'single', nbMagasins: mode === 'group' ? bilans.length : 1,
          inputTokens: r.data.usage ? r.data.usage.input_tokens : null, outputTokens: r.data.usage ? r.data.usage.output_tokens : null,
        });
        return new Response(JSON.stringify({ ok: true, analysis: r.texte }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Com hebdo à la demande (profil réseau complet uniquement) ----------
      if (url.pathname === '/com-hebdo') {
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        if (sessionAr !== 'ALL') return jsonError('Fonctionnalité réservée au profil réseau complet', 403, corsHeaders);
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        try {
          const { from, to, blocks } = await generateComHebdo(env);
          return new Response(JSON.stringify({ ok: true, from, to, blocks }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur génération com hebdo : ' + String(e), 500, corsHeaders);
        }
      }

      return jsonError('Route inconnue : ' + url.pathname, 404, corsHeaders);
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
  },

  // 3 crons actifs pour l'instant (com hebdo / relance visite volontairement
  // laissés de côté, cf. commentaire plus haut). Motifs à créer dans Cloudflare
  // Dashboard → oc-inter-relay → Triggers :
  //   - Snapshot score de santé : 0 6 * * SUN
  //   - Clôture Kaizen : 0 8 1 * *
  //   - Refresh avis Google : 0 4 * * MON,WED,FRI
  async scheduled(event, env, ctx) {
    AR_SESSION_SECRET = env.AR_SESSION_KEY || '';
    const cron = event.cron;
    if (cron === '0 6 * * SUN') {
      ctx.waitUntil(withCronAlert(env, 'Snapshot score de santé', () => snapshotHealthScoreHistory(env)));
    } else if (cron === '0 8 1 * *') {
      ctx.waitUntil(withCronAlert(env, 'Clôture Kaizen', () => cloturerAuditsKaizen(env)));
    } else if (cron === '0 4 * * MON' || cron === '0 4 * * WED' || cron === '0 4 * * FRI' || cron === '0 4 * * MON,WED,FRI') {
      ctx.waitUntil(withCronAlert(env, 'Refresh Google ratings', () => refreshGoogleRatings(env)));
    } else {
      console.error('Cron non reconnu, aucune action déclenchée:', cron);
      ctx.waitUntil(zimbraSendMail(env, {
        to: ADMIN_ALERT_EMAILS,
        subject: `⚠️ Cron non reconnu sur oc-inter-relay`,
        bodyText: `Le trigger "${cron}" a déclenché scheduled() mais ne correspond à aucun job connu dans le code.`,
      }).catch(e => console.error('Échec envoi alerte cron non reconnu:', e)));
    }
  },
};
