// oc-inter-relay — Worker international, Optical Center
// Version 2026.10.25-5 (lot 5 : Suivi Managers — trames, lancements, réunion
// mensuelle, suivis datés, brouillons, historique, score magasin hebdo).
// Version 2026.10.25-4 (lot 4 : Analyse statistique — objectifs par pays/région,
// archives, jours ouvrés par pays, stats collaborateurs).
// Version 2026.10.25-3 (lot 3b : page d'accueil, fermetures réseau par pays).
// Version 2026.10.25-2 (lot 3 : historique central, récap magasin, poids du score,
// absences longue durée). Version 2026.10.25-1 (lot 0 : secrets Cloudflare, protection PEDLV/Kaizen, routes
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
  const iManager = idx('manager');
  const iEmail = idx('email');
  const iObjAnnuel = idx('objectif_annuel');

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
      manager: iManager >= 0 ? (cols[iManager] || '').trim() : '',
      email: iEmail >= 0 ? (cols[iEmail] || '').trim() : '',
      objectifAnnuel: num(iObjAnnuel >= 0 ? cols[iObjAnnuel] : null),
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
          m: { su: { _content: subject }, e: (Array.isArray(to) ? to : [to]).filter(Boolean).map(addr => ({ t: 't', a: addr })), mp: { ct: 'text/html', content: { _content: bodyHtml || textToHtmlEmail(bodyText) } } }
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

// Poids du score : table health_weights (getHealthWeights), repli POIDS_SANTE_DEFAULT.

function toNumOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function getLastBilanSnapshots(env) {
  if (!env.DB) return {};
  return memoD1('lastBilanSnapshots', MEMO_SANTE_MS, () => getLastBilanSnapshotsD1(env));
}
async function getLastBilanSnapshotsD1(env) {
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
  return { rouge, total: entries.length, indicateurs: row.indicateurs || {}, periode: row.periode || null };
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
      `SELECT magasin_code, mois, score, score_max, closed FROM kaizen_audits WHERE mois LIKE ?`
    ).bind(anneeCourante + '-%').all();
    const map = {};
    for (const row of results) {
      const m = (map[row.magasin_code] ??= { scoreMois: null, scoreMaxMois: null, closedMois: false, cumulAnnuel: 0, dernierScoreCloture: null, dernierScoreMax: null, dernierMoisCloture: null });
      m.cumulAnnuel += (row.score || 0);
      if (row.mois === moisCourant) { m.scoreMois = row.score; m.scoreMaxMois = row.score_max; m.closedMois = !!row.closed; }
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

// healthSubScoresServer, computeHealthScoreServer et buildStoreHealthResults :
// voir le module lot 6 (alignement France).

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
  await ensureHistoSanteColonnes(env);
  const results = await buildStoreHealthResultsD1(env, stores);
  const periodKey = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    `INSERT INTO store_health_score_history
     (magasin_code, period_key, score, computed_at,
      score_actions, score_effectif, score_absenteisme, score_positionnement, score_pedlv, score_avis, score_equipe, score_kaizen, score_entretiens, score_lancements)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(magasin_code, period_key) DO UPDATE SET
     score = excluded.score, computed_at = excluded.computed_at,
     score_actions = excluded.score_actions, score_effectif = excluded.score_effectif,
     score_absenteisme = excluded.score_absenteisme, score_positionnement = excluded.score_positionnement,
     score_pedlv = excluded.score_pedlv, score_avis = excluded.score_avis,
     score_equipe = excluded.score_equipe, score_kaizen = excluded.score_kaizen,
     score_entretiens = excluded.score_entretiens, score_lancements = excluded.score_lancements`
  );
  const lignes = results.map(r => {
    const sub = r.subScores || {};
    return stmt.bind(
      r.code, periodKey, r.score, now,
      sub.actions ?? null, sub.effectif ?? null, sub.absenteisme ?? null, sub.positionnement ?? null,
      sub.pedlv ?? null, sub.avis ?? null, sub.equipe ?? null, sub.kaizen ?? null, sub.entretiens ?? null, sub.lancements ?? null
    );
  });
  for (let i = 0; i < lignes.length; i += 50) await env.DB.batch(lignes.slice(i, i + 50));
}


// ============================================================================
// Lot 5 (25/10/2026) — Suivi Managers
// ============================================================================
// Trames d'entretien manager, lancements de journée, réunion mensuelle, suivis
// datés, brouillons serveur. Écriture protégée par le jeton de l'appli
// (secret SUIVI_STORE_TOKEN) ou une session animateur ; historique et sujets
// imposés réservés aux sessions (animateur, directeur pays, accès complet).
// Contenu des trames en français dans un premier temps (option A, 25/10) :
// seuls les libellés des mails envoyés au magasin suivent sa langue.

const BROUILLON_PURGE_JOURS = 30;
const TYPES_REUNION = { bilan_mois: 'Bilan du mois précédent', debrief: 'Débrief réunion groupe' };
const SOUS_TYPES_DEBRIEF = { managers: 'Réunion managers', produit: 'Réunion produit', annuelle: 'Réunion annuelle', autre: 'Autre' };
const LIBELLES_ENTRETIEN = {
  ecoute_fb: 'Écoute & Feedback de vente', pilotage_audio: 'Pilotage Audio', pilotage_optique: 'Pilotage Optique',
  recadrage: 'Entretien de recadrage', valorisation: 'Entretien de valorisation', remotivation: 'Entretien de remotivation',
};
const LIBELLES_MODELE_EFB = {
  taux_concretisation: 'Taux de concrétisation', decouverte_optique: 'Découverte client optique',
  decouverte_audio: 'Découverte client audio', vierge: 'Trame vierge',
};
const TYPES_ENTRETIEN_VALIDES = Object.keys(LIBELLES_ENTRETIEN);

let _reunionTablesOk = false;
async function ensureReunionTables(env) {
  if (_reunionTablesOk || !env.DB) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS entretiens_manager (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, magasin_code TEXT, magasin_libelle TEXT, animateur TEXT, collaborateur_matricule TEXT, collaborateur_nom TEXT, rempli_par TEXT, date TEXT NOT NULL, data_json TEXT, created_at TEXT DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_entretiens_code_date ON entretiens_manager(magasin_code, date)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_entretiens_date ON entretiens_manager(date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS lancements_journee (id INTEGER PRIMARY KEY AUTOINCREMENT, magasin_code TEXT, magasin_libelle TEXT, animateur TEXT, rempli_par TEXT, poste_rempli_par TEXT, date TEXT NOT NULL, presents_json TEXT, objectifs TEXT, note_libre TEXT, mensuel_json TEXT, reunion_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_lancements_code_date ON lancements_journee(magasin_code, date)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_lancements_date ON lancements_journee(date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS suivis_entretien (id INTEGER PRIMARY KEY AUTOINCREMENT, entretien_id INTEGER, magasin_code TEXT NOT NULL, magasin_libelle TEXT, animateur TEXT, collaborateur_matricule TEXT, collaborateur_nom TEXT, type_entretien TEXT, libelle TEXT NOT NULL, echeance TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'ouvert', cloture_par TEXT, cloture_le TEXT, cloture_via TEXT, cloture_entretien_id INTEGER, reunion_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_suivis_code_statut ON suivis_entretien(magasin_code, statut, echeance)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reunions_magasin (id INTEGER PRIMARY KEY AUTOINCREMENT, magasin_code TEXT NOT NULL, magasin_libelle TEXT, animateur TEXT, type_reunion TEXT NOT NULL, sous_type TEXT, intitule TEXT, rempli_par TEXT, poste_rempli_par TEXT, date TEXT NOT NULL, presents_json TEXT, absents_json TEXT, points_json TEXT, signatures_json TEXT, lancement_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_reunions_code_date ON reunions_magasin(magasin_code, date)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reunion_sujets (id INTEGER PRIMARY KEY AUTOINCREMENT, portee TEXT NOT NULL, ar TEXT, mois TEXT NOT NULL, titre TEXT NOT NULL, detail TEXT, cree_par TEXT, created_at TEXT DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_reunion_sujets_mois ON reunion_sujets(mois)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reunion_sujets_traites (sujet_id INTEGER NOT NULL, magasin_code TEXT NOT NULL, reunion_id INTEGER NOT NULL, PRIMARY KEY (sujet_id, magasin_code))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS brouillons_suivi (id INTEGER PRIMARY KEY AUTOINCREMENT, magasin_code TEXT NOT NULL, ecran TEXT NOT NULL, libelle TEXT, cree_par TEXT, json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_brouillons_code ON brouillons_suivi(magasin_code, updated_at)`),
  ]);
  if (env.ARCHIVES) {
    try { await env.ARCHIVES.prepare(`CREATE TABLE IF NOT EXISTS reunion_signatures (reunion_id INTEGER PRIMARY KEY, json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`).run(); } catch (e) { console.error('Table reunion_signatures (ARCHIVES) :', e); }
  }
  _reunionTablesOk = true;
}
function txt(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isoDateOk(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }
function parisTodayIso() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); }
function addDaysIso(iso, n) { return ajouterJoursIso(iso, n); }
function formatDateFr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}

// Sujets imposés à un magasin pour un mois : réseau + ceux de son animateur ou
// de son directeur pays (session 'PAYS:A|B'), moins ceux déjà traités.
async function sujetsImposesMagasin(env, magasin, mois) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.portee, s.ar, s.titre, s.detail FROM reunion_sujets s
     WHERE s.mois = ? AND (s.portee = 'reseau' OR (s.portee = 'ar' AND (s.ar = ? OR (s.ar LIKE 'PAYS:%' AND ('|' || substr(s.ar, 6) || '|') LIKE ?))))
     AND NOT EXISTS (SELECT 1 FROM reunion_sujets_traites t WHERE t.sujet_id = s.id AND t.magasin_code = ?)
     ORDER BY CASE s.portee WHEN 'reseau' THEN 0 ELSE 1 END, s.id`
  ).bind(mois, magasin.animateur || '\u0000', '%|' + (magasin.pays || '\u0000') + '|%', String(magasin.code)).all();
  return results || [];
}
function libelleReunion(r) {
  const base = TYPES_REUNION[r.type_reunion] || 'Réunion mensuelle';
  if (r.type_reunion !== 'debrief') return base;
  const st = r.sous_type === 'autre' ? (r.intitule || 'Autre') : (SOUS_TYPES_DEBRIEF[r.sous_type] || '');
  return st ? `${base} — ${st}` : base;
}
async function lireSignaturesReunion(env, reunion) {
  if (env.ARCHIVES) {
    try {
      const row = await env.ARCHIVES.prepare(`SELECT json FROM reunion_signatures WHERE reunion_id = ?`).bind(reunion.id).first();
      if (row) return JSON.parse(row.json || '{}');
    } catch (e) { console.error('Lecture signatures réunion :', e); }
  }
  try { return JSON.parse(reunion.signatures_json || '{}'); } catch (e) { return {}; }
}
function libelleEntretien(type, data) {
  const base = LIBELLES_ENTRETIEN[type] || 'Entretien manager';
  if (type === 'ecoute_fb') {
    const modele = (data && data.modele) || 'taux_concretisation';
    return `${base} — ${LIBELLES_MODELE_EFB[modele] || LIBELLES_MODELE_EFB.taux_concretisation}`;
  }
  return base;
}
function sanitizeSuivis(suivis) {
  if (!Array.isArray(suivis)) return [];
  return suivis
    .map(x => ({ libelle: String((x && x.libelle) || '').trim().slice(0, 300), echeance: String((x && x.echeance) || '').trim() }))
    .filter(x => x.libelle && /^\d{4}-\d{2}-\d{2}$/.test(x.echeance))
    .slice(0, 20);
}
// Clôture des suivis ouverts d'un magasin ; le magasin_code est exigé dans le
// WHERE : un id seul ne permet jamais de clôturer le suivi d'un autre magasin.
async function cloturerSuivis(env, magasinCode, reprises, par, via, entretienId) {
  const valides = (Array.isArray(reprises) ? reprises : [])
    .filter(r => r && Number.isInteger(Number(r.id)) && ['fait', 'pas_fait'].includes(r.statut)).slice(0, 50);
  if (!valides.length || !magasinCode) return 0;
  const stmt = env.DB.prepare(
    `UPDATE suivis_entretien SET statut = ?, cloture_par = ?, cloture_le = datetime('now'), cloture_via = ?, cloture_entretien_id = ?
     WHERE id = ? AND magasin_code = ? AND statut = 'ouvert'`
  );
  await env.DB.batch(valides.map(r => stmt.bind(r.statut, par || null, via, entretienId || null, Number(r.id), String(magasinCode))));
  return valides.length;
}

// Libellés des mails envoyés au magasin, dans la langue du magasin (repli FR).
const MAIL_SUIVI_I18N = {
  FR: { entretien: 'Entretien manager', lancement: 'Lancement de journée', reunion: 'Réunion mensuelle', magasin: 'Magasin :', collaborateur: 'Collaborateur :', realisePar: 'Réalisé par :', animeePar: 'Animée par :', date: 'Date :', type: 'Type :',
    pdfJoint: 'Le compte-rendu complet est joint à ce mail au format PDF.', pdfJointSigne: 'Le compte-rendu complet, signé par les présents, est joint au format PDF.', pdfAbsent: '(PDF non généré pour cet envoi — contenu brut ci-dessous)',
    donneesMois: 'Données du mois :', presents: 'Présents :', absents: 'Absents :', objectifsJour: 'Objectifs du jour :', noteLibre: 'Note libre :', pointsTraites: 'Points traités :', objectif: 'objectif :',
    sigManager: 'Signature du manager', sigCollab: 'Signature du collaborateur', nonSigne: 'non signé', ca: 'CA', positionnement: 'Positionnement mensuel', caAudio: 'CA audio', nbVenteOpt: 'Nb de ventes optique', nbProthese: 'Nb de prothèses' },
  EN: { entretien: 'Manager meeting', lancement: 'Day kick-off', reunion: 'Monthly meeting', magasin: 'Store:', collaborateur: 'Employee:', realisePar: 'Conducted by:', animeePar: 'Led by:', date: 'Date:', type: 'Type:',
    pdfJoint: 'The full report is attached to this email as a PDF.', pdfJointSigne: 'The full report, signed by the attendees, is attached as a PDF.', pdfAbsent: '(PDF not generated for this sending — raw content below)',
    donneesMois: 'Monthly figures:', presents: 'Attendees:', absents: 'Absent:', objectifsJour: 'Objectives of the day:', noteLibre: 'Free note:', pointsTraites: 'Topics covered:', objectif: 'objective:',
    sigManager: "Manager's signature", sigCollab: "Employee's signature", nonSigne: 'not signed', ca: 'Revenue', positionnement: 'Monthly achievement', caAudio: 'Audio revenue', nbVenteOpt: 'Optical sales', nbProthese: 'Hearing aids sold' },
  ES: { entretien: 'Entrevista de manager', lancement: 'Arranque del día', reunion: 'Reunión mensual', magasin: 'Tienda:', collaborateur: 'Colaborador:', realisePar: 'Realizado por:', animeePar: 'Dirigida por:', date: 'Fecha:', type: 'Tipo:',
    pdfJoint: 'El informe completo se adjunta a este correo en PDF.', pdfJointSigne: 'El informe completo, firmado por los asistentes, se adjunta en PDF.', pdfAbsent: '(PDF no generado para este envío — contenido en bruto a continuación)',
    donneesMois: 'Datos del mes:', presents: 'Presentes:', absents: 'Ausentes:', objectifsJour: 'Objetivos del día:', noteLibre: 'Nota libre:', pointsTraites: 'Puntos tratados:', objectif: 'objetivo:',
    sigManager: 'Firma del manager', sigCollab: 'Firma del colaborador', nonSigne: 'sin firmar', ca: 'Ventas', positionnement: 'Cumplimiento mensual', caAudio: 'Ventas audio', nbVenteOpt: 'Ventas ópticas', nbProthese: 'Audífonos vendidos' },
  NL: { entretien: 'Managementgesprek', lancement: 'Dagstart', reunion: 'Maandvergadering', magasin: 'Winkel:', collaborateur: 'Medewerker:', realisePar: 'Uitgevoerd door:', animeePar: 'Geleid door:', date: 'Datum:', type: 'Type:',
    pdfJoint: 'Het volledige verslag zit als PDF bij deze mail.', pdfJointSigne: 'Het volledige verslag, ondertekend door de aanwezigen, zit als PDF bijgevoegd.', pdfAbsent: '(Geen PDF gegenereerd voor deze verzending — ruwe inhoud hieronder)',
    donneesMois: 'Cijfers van de maand:', presents: 'Aanwezigen:', absents: 'Afwezigen:', objectifsJour: 'Doelen van de dag:', noteLibre: 'Vrije notitie:', pointsTraites: 'Besproken punten:', objectif: 'doel:',
    sigManager: 'Handtekening manager', sigCollab: 'Handtekening medewerker', nonSigne: 'niet ondertekend', ca: 'Omzet', positionnement: 'Maandrealisatie', caAudio: 'Omzet audio', nbVenteOpt: 'Optische verkopen', nbProthese: 'Verkochte hoortoestellen' },
};
function mailLibelles(langue) {
  const l = String(langue || 'FR').toUpperCase().split('-')[0];
  return { ...MAIL_SUIVI_I18N.FR, ...(MAIL_SUIVI_I18N[l] || {}) };
}

function buildEntretienManagerEmailHtml({ libelleType, magasin, remplipar, date, data, collaborateurNom, hasPdf, L }) {
  L = L || mailLibelles(magasin && magasin.langue);
  const collabLine = collaborateurNom ? `<p><b>${L.collaborateur}</b> ${escapeHtml(collaborateurNom)}</p>` : '';
  const entete = `<h2 style="color:#CC1719;">${escapeHtml(libelleType)}</h2>
<p><b>${L.magasin}</b> ${escapeHtml(magasin.libelle)}</p>
${collabLine}
<p><b>${L.realisePar}</b> ${escapeHtml(remplipar)} — <b>${L.date}</b> ${escapeHtml(formatDateFr(date))}</p>`;
  if (hasPdf) return `<div style="font-family:Arial,sans-serif;">${entete}<p>${L.pdfJoint}</p></div>`;
  const { signatureManager, signatureCollaborateur, ...dataSansSignatures } = data || {};
  const sigImg = (label, dataUrl) => dataUrl
    ? `<div style="margin-top:10px;"><b>${label} :</b><br><img src="${dataUrl}" style="max-width:220px;max-height:90px;border:1px solid #ddd;border-radius:4px;padding:4px;background:#fff;"></div>`
    : `<div style="margin-top:10px;color:#888;"><b>${label} :</b> ${L.nonSigne}</div>`;
  return `<div style="font-family:Arial,sans-serif;">${entete}
<p style="color:#888;font-size:12px;">${L.pdfAbsent}</p>
<pre style="background:#F0EDE6;padding:12px;white-space:pre-wrap;">${escapeHtml(JSON.stringify(dataSansSignatures, null, 2))}</pre>
${sigImg(L.sigManager, signatureManager)}
${sigImg(L.sigCollab, signatureCollaborateur)}
</div>`;
}

// Envoi avec PDF joint via le compte technique du Worker (ZIMBRA_USER /
// ZIMBRA_PASSWORD) : jamais de mot de passe demandé au manager qui remplit.
async function zimbraSendMailWithAttachment(env, { to, subject, bodyHtml, pdfBase64, filename }) {
  const authResp = await fetch(ZIMBRA_SOAP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
      Body: { AuthRequest: { _jsns: 'urn:zimbraAccount', account: { by: 'name', _content: env.ZIMBRA_USER }, password: { _content: env.ZIMBRA_PASSWORD } } } }),
  });
  const authData = await authResp.json();
  const token = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
  if (!token) throw new Error('Authentification Zimbra (compte technique) échouée');
  const bin = atob(pdfBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const formData = new FormData();
  formData.append('file', new Blob([bytes], { type: 'application/pdf' }), filename || 'document.pdf');
  const upResp = await fetch(ZIMBRA_UPLOAD_URL, { method: 'POST', headers: { 'Cookie': `ZM_AUTH_TOKEN=${token}` }, body: formData });
  const upText = await upResp.text();
  const upMatch = upText.match(/^\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'/);
  if (!upMatch || upMatch[1] !== '200') throw new Error('Échec upload pièce jointe : ' + upText.slice(0, 200));
  const dests = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const sendResp = await fetch(ZIMBRA_SOAP_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': `ZM_AUTH_TOKEN=${token}` },
    body: JSON.stringify({ Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' }, authToken: [{ _content: token }] } },
      Body: { SendMsgRequest: { _jsns: 'urn:zimbraMail', m: { su: { _content: subject }, e: dests.map(a => ({ t: 't', a })),
        mp: { ct: 'text/html', content: { _content: bodyHtml } }, attach: { aid: upMatch[3] } } } } }),
  });
  if (!sendResp.ok) throw new Error('Envoi email avec pièce jointe échoué (' + sendResp.status + ')');
}

// ============================================================================
// Lot 4 (25/10/2026) — Analyse statistique (PEDLV)
// ============================================================================

// Grille d'objectifs par pays / région : fichier objectifs_pedlv.csv du dépôt
// pedlv, modifiable directement sur GitHub (sans redéployer). Colonnes :
// cle;libelle;defaut;<PAYS ou région>… — case vide = valeur du niveau au-dessus.
// Priorité : région du magasin > pays > défaut. Relu toutes les 5 min au plus.
const OBJECTIFS_PEDLV_URL = 'https://raw.githubusercontent.com/oc-inter/pedlv/main/objectifs_pedlv.csv';
const OBJECTIFS_PEDLV_SECOURS = { obj_ca: 20, nb: 50, pm: 450, pm1: 120, sop: 40, tc: 95, pack: 50, mdc: 66, luk: 12, pmpc: 80, proth: 30, txc: 95, txe: 95, assur: 70, ta: 30, tva: 12, pm_aud: 2350, pm_app: 1250 };
// Clés recalculées côté serveur (statuts stockés, score santé) — mêmes que la France.
const CLES_STATUT_PEDLV = ['pm', 'tc', 'sop', 'mdc', 'pack', 'pmpc', 'ta', 'tva'];
let _objectifsPedlv = null, _objectifsPedlvAt = 0;

function lireCsvPointVirgule(texte) {
  const lignes = String(texte || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lignes.length) return { entetes: [], lignes: [] };
  const entetes = lignes[0].split(';').map(h => h.trim());
  return { entetes, lignes: lignes.slice(1).map(l => l.split(';').map(c => c.trim())) };
}
const nombreCsv = v => { const n = parseFloat(String(v || '').replace(',', '.').replace(/[%€\s]/g, '')); return isFinite(n) && n > 0 ? n : null; };

async function chargerObjectifsPedlv() {
  const now = Date.now();
  if (_objectifsPedlv && (now - _objectifsPedlvAt) < 5 * 60 * 1000) return _objectifsPedlv;
  _objectifsPedlvAt = now;
  const grilles = { defaut: { ...OBJECTIFS_PEDLV_SECOURS } };
  try {
    const resp = await fetch(OBJECTIFS_PEDLV_URL + '?v=' + now);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const { entetes, lignes } = lireCsvPointVirgule(await resp.text());
    const iCle = entetes.indexOf('cle'), iDef = entetes.indexOf('defaut');
    for (const cols of lignes) {
      const cle = cols[iCle];
      if (!cle) continue;
      entetes.forEach((h, i) => {
        if (i === iCle || h === 'libelle' || !h) return;
        const n = nombreCsv(cols[i]);
        if (n === null) return;
        const scope = i === iDef ? 'defaut' : normalizeName(h);
        (grilles[scope] ??= {})[cle] = n;
      });
    }
  } catch (e) { console.error('objectifs_pedlv.csv illisible, grille de secours :', e); }
  _objectifsPedlv = grilles;
  return grilles;
}

async function grilleObjectifsPour(store) {
  const g = await chargerObjectifsPedlv();
  return { ...g.defaut, ...(store && store.pays ? g[normalizeName(store.pays)] || {} : {}), ...(store && store.region ? g[normalizeName(store.region)] || {} : {}) };
}

function statutPedlvReseau(valeur, objectif) {
  if (!objectif || valeur === undefined || valeur === null || valeur === '') return null;
  const v = Number(valeur);
  if (isNaN(v)) return null;
  const ratio = v / objectif;
  return ratio >= 1 ? 'vert' : (ratio >= 0.7 ? 'orange' : 'rouge');
}
// Idempotent. L'objectif réglé dans le navigateur est conservé dans objectifMagasin.
function normaliserIndicateursPedlv(indicateurs, grille) {
  if (!indicateurs || typeof indicateurs !== 'object') return {};
  const out = {};
  for (const [key, v] of Object.entries(indicateurs)) {
    if (!v || typeof v !== 'object' || !CLES_STATUT_PEDLV.includes(key) || !grille || !grille[key]) { out[key] = v; continue; }
    out[key] = { ...v, objectifMagasin: v.objectifMagasin !== undefined ? v.objectifMagasin : (v.objectif ?? null), objectif: grille[key], statut: statutPedlvReseau(v.valeur, grille[key]) };
  }
  return out;
}

// Le code envoyé par l'Analyse statistique vient de la caisse : on le compare
// à magasins_inter.csv (avec ou sans zéros de tête), puis repli sur le nom.
async function resoudreMagasinPedlv(code, nom) {
  const stores = await getMagasinsServerSide();
  const c = String(code || '').trim();
  if (c) {
    const st = stores.find(x => x.code === c || x.code.replace(/^0+/, '') === c.replace(/^0+/, ''));
    if (st) return st;
  }
  const n = normalizeName(nom || '');
  if (n) return stores.find(x => normalizeName(x.libelle) === n) || null;
  return null;
}

let _storeStatsColsOk = false;
async function ensureStoreStatsColonnes(env) {
  if (_storeStatsColsOk) return;
  for (const [col, type] of [['jours_ouvres_mois', 'REAL'], ['positionnement', 'REAL'], ['pm_paire1', 'REAL'], ['taux_lukkas', 'REAL'], ['pm_prothese', 'REAL'], ['pm_vente_audio', 'REAL'], ['taux_assur_audio', 'REAL'], ['created_at', 'TEXT']]) {
    try { await env.DB.prepare(`ALTER TABLE store_stats ADD COLUMN ${col} ${type}`).run(); } catch (e) { /* déjà présente */ }
  }
  _storeStatsColsOk = true;
}

// Archives (base D1 séparée « ARCHIVES ») — même format que la France.
let _archivesTableOk = false;
async function ensureArchivesTable(env) {
  if (_archivesTableOk || !env.ARCHIVES) return;
  await env.ARCHIVES.prepare(`CREATE TABLE IF NOT EXISTS pedlv_rapports (id INTEGER PRIMARY KEY AUTOINCREMENT, magasin TEXT NOT NULL, magasin_key TEXT NOT NULL, code_magasin TEXT, periode TEXT, date_extraction TEXT, animateur TEXT, lang TEXT, encodage TEXT NOT NULL, taille_html INTEGER, contenu TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  await env.ARCHIVES.prepare('CREATE INDEX IF NOT EXISTS idx_pedlv_rapports_code ON pedlv_rapports(code_magasin)').run();
  await env.ARCHIVES.prepare('CREATE INDEX IF NOT EXISTS idx_pedlv_rapports_key ON pedlv_rapports(magasin_key, date_extraction)').run();
  _archivesTableOk = true;
}
async function decoderArchivePedlv(encodage, contenu) {
  if (encodage !== 'gzip-b64') return contenu;
  const bin = atob(contenu);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// Calendrier par pays : jours de repos hebdomadaire lus dans pays_inter.csv
// (dépôt bilan-passage, colonnes pays;jours_repos, jours en lettres séparés
// par des virgules : DIM, SAM…). Pays absent = dimanche. Les jours fériés où
// les magasins ferment se saisissent comme fermetures réseau du pays.
const PAYS_INTER_URL = 'https://raw.githubusercontent.com/oc-inter/bilan-passage/main/pays_inter.csv';
const JOURS_LETTRES = { DIM: 0, LUN: 1, MAR: 2, MER: 3, JEU: 4, VEN: 5, SAM: 6, SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
let _paysInter = null, _paysInterAt = 0;
async function joursReposPays(pays) {
  const now = Date.now();
  if (!_paysInter || (now - _paysInterAt) > 10 * 60 * 1000) {
    _paysInterAt = now;
    const map = {};
    try {
      const resp = await fetch(PAYS_INTER_URL + '?v=' + now);
      if (resp.ok) {
        const { entetes, lignes } = lireCsvPointVirgule(await resp.text());
        const iP = entetes.indexOf('pays'), iR = entetes.indexOf('jours_repos');
        for (const cols of lignes) {
          const jours = String(cols[iR] || '').toUpperCase().split(/[,\s|]+/).map(j => JOURS_LETTRES[j]).filter(j => j !== undefined);
          if (cols[iP]) map[normalizeName(cols[iP])] = jours;
        }
      }
    } catch (e) { console.error('pays_inter.csv illisible, dimanche par défaut :', e); }
    _paysInter = map;
  }
  const j = pays ? _paysInter[normalizeName(pays)] : null;
  return j && j.length ? j : [0];
}
function ajouterJoursIso(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fermeturesSetPourPays(fermetures, pays) {
  const set = new Set();
  const p = pays ? normalizeName(pays) : null;
  (fermetures || []).forEach(f => {
    if (f.pays && (!p || normalizeName(f.pays) !== p)) return; // fermeture d'un autre pays
    const n = Math.max(1, parseInt(f.nb_jours, 10) || 1);
    for (let i = 0; i < n; i++) set.add(ajouterJoursIso(f.date_debut, i));
  });
  return set;
}
function compterJoursOuvresInter(mois, joursRepos, fermSet, jusquAuIso) {
  const [y, m] = mois.split('-').map(Number);
  const nb = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= nb; d++) {
    const iso = `${mois}-${String(d).padStart(2, '0')}`;
    if (jusquAuIso && iso > jusquAuIso) break;
    if (joursRepos.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) continue;
    if (fermSet.has(iso)) continue;
    n++;
  }
  return n;
}

// ============================================================================
// Lot 3b (25/10/2026) — page d'accueil lanceur et fermetures réseau
// ============================================================================

// Sections internationales : pas de « Formation » (Accompagnement Manager hors
// périmètre). 'admin' = accès réseau complet (Cécilia, Olivier), jamais ouvrable
// nominativement. Les droits sont calculés ici, jamais par la page.
const ACCUEIL_SECTIONS = ['tous', 'animateurs', 'direction', 'admin'];
const ACCUEIL_SECTIONS_NOMINATIVES = ['animateurs', 'direction'];
const ACCUEIL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // la session ne donne accès qu'à la liste des liens
const ACCUEIL_ICONE_MAX = 400000;
const ACCUEIL_BASE = 'https://oc-inter.github.io';
let _accueilTablesOk = false;

const ACCUEIL_APPS_INITIALES = [
  { nom: 'Analyse statistique', url: ACCUEIL_BASE + '/pedlv/', section: 'tous', ordre: 1,
    description: "Synthèse de performance du magasin à partir des exports : indicateurs au vert ou au rouge, actions prioritaires, podium.",
    usage: "Charger les fichiers exportés, vérifier le nom du magasin, générer puis envoyer le rapport.", frequence: "Deux fois par semaine." },
  { nom: 'Kaizen', url: ACCUEIL_BASE + '/kaizen/', section: 'tous', ordre: 2,
    description: "Audit mensuel du magasin : points de contrôle répartis par zone, 50 points maximum, photos de preuve.",
    usage: "Chercher le magasin, ouvrir chaque zone et cocher les points conformes. L'audit peut se faire en plusieurs fois dans le mois.",
    frequence: "Une fois par mois. Clôture automatique le 1er du mois suivant." },
  { nom: 'Bilan de Passage', url: ACCUEIL_BASE + '/bilan-passage/', section: 'animateurs', ordre: 1,
    description: "Compte-rendu de visite magasin : humeur, chiffres, effectif, actions à suivre. Onglets Analyse et Tournée pour l'historique et le score de santé.",
    usage: "Sélectionner le magasin, remplir le bilan pendant la visite et l'envoyer (mail et PDF au magasin).", frequence: "À chaque visite, au moins toutes les 4 semaines par magasin." },
  { nom: 'Évaluation Équipe', url: ACCUEIL_BASE + '/eval-equipe/', section: 'animateurs', ordre: 2,
    description: "Évaluation des collaborateurs du magasin, tâche par tâche. Alimente la dimension Équipe du score de santé.",
    usage: "Choisir le magasin, évaluer chaque collaborateur et enregistrer.", frequence: "Lors des visites, dès que le niveau d'un collaborateur évolue." },
  { nom: 'Observations Terrain', url: ACCUEIL_BASE + '/observations-terrain/', section: 'animateurs', ordre: 3,
    description: "Notes prises au fil de l'eau sur les magasins (et infos générales).",
    usage: "Choisir le magasin, saisir ou dicter l'observation. « Terminer la journée » envoie un récapitulatif par magasin.", frequence: "Au fil de l'eau, clôture en fin de journée." },
  { nom: 'Dashboard', url: ACCUEIL_BASE + '/bilan-passage/dashboard.html', section: 'animateurs', ordre: 4,
    description: "Vue d'ensemble du périmètre : score de santé, alertes, fiche de chaque magasin.",
    usage: "Se connecter avec son identifiant Zimbra, repérer les magasins en alerte, ouvrir leur fiche.", frequence: "En début de semaine et avant chaque tournée." },
  { nom: 'Imports', url: ACCUEIL_BASE + '/bilan-passage/import.html', section: 'admin', ordre: 1,
    description: "Import mensuel RH (effectif et absences), fermetures réseau, gestion de la page d'accueil.",
    usage: "Déposer les deux fichiers RH du mois, saisir les fermetures réseau, ajouter ou modifier les applis de l'accueil.", frequence: "Chaque mois, après l'export RH." },
];

async function ensureAccueilTables(env) {
  if (_accueilTablesOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS accueil_apps (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, url TEXT NOT NULL, section TEXT NOT NULL, icone TEXT, description TEXT, usage TEXT, frequence TEXT, ordre INTEGER DEFAULT 0, actif INTEGER DEFAULT 1, updated_at TEXT)`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS accueil_acces (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, section TEXT NOT NULL, created_at TEXT, UNIQUE(email, section))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS accueil_meta (key TEXT PRIMARY KEY, value TEXT)`).run();
  const seeded = await env.DB.prepare(`SELECT value FROM accueil_meta WHERE key = 'seeded'`).first();
  if (!seeded) {
    const now = new Date().toISOString();
    const stmts = ACCUEIL_APPS_INITIALES.map(a => env.DB.prepare(
      `INSERT INTO accueil_apps (nom, url, section, icone, description, usage, frequence, ordre, actif, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1, ?)`
    ).bind(a.nom, a.url, a.section, a.description, a.usage, a.frequence, a.ordre, now));
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO accueil_meta (key, value) VALUES ('seeded', ?)`).bind(now));
    await env.DB.batch(stmts);
  }
  _accueilTablesOk = true;
}

// Même résolution d'identité que /ar-login (accès complet, directeur pays,
// animateur), sans l'alerte mail : un salarié non animateur peut légitimement
// se connecter à l'accueil.
async function resoudreIdentiteInter(email) {
  const emailLower = String(email || '').trim().toLowerCase();
  if (ADMIN_FULL_ACCESS_EMAILS.includes(emailLower)) return { ar: 'ALL', langueUI: 'FR' };
  const stores = await getMagasinsServerSide();
  const lignesDirecteur = stores.filter(x => x.directeurPaysEmail && x.directeurPaysEmail.trim().toLowerCase() === emailLower);
  const pays = [...new Set(lignesDirecteur.map(x => x.pays).filter(Boolean))];
  if (pays.length) return { ar: 'PAYS:' + pays.join('|'), langueUI: lignesDirecteur[0]?.langueDirecteurPays || 'FR' };
  const emailMatch = stores.find(x => x.animateurEmail && x.animateurEmail.trim().toLowerCase() === emailLower);
  if (emailMatch) return { ar: emailMatch.animateur, langueUI: emailMatch.langueAnimateur || 'FR' };
  const login = normalizeName(emailLower.split('@')[0]);
  const ar = [...new Set(stores.map(x => x.animateur).filter(Boolean))].find(a => normalizeName(a) === login) || null;
  const m = ar ? stores.find(x => x.animateur === ar) : null;
  return { ar, langueUI: (m && m.langueAnimateur) || null };
}

async function createAccueilSession(email, nom, sections) {
  const payload = JSON.stringify({ kind: 'accueil', email, nom, sections, exp: Date.now() + ACCUEIL_SESSION_TTL_MS });
  const b64 = btoa(unescape(encodeURIComponent(payload)));
  return b64 + '.' + await hmacSign(b64);
}
// Pas de champ `ar` : un jeton d'accueil n'est jamais accepté par verifyArSession.
async function verifyAccueilSession(token) {
  if (!AR_SESSION_SECRET || !token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  if (sig !== await hmacSign(b64)) return null;
  let payload;
  try { payload = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch (e) { return null; }
  if (!payload || payload.kind !== 'accueil' || !payload.exp || payload.exp < Date.now() || !Array.isArray(payload.sections)) return null;
  // L'accès complet voit toujours toutes les sections ; personne d'autre ne garde 'admin'.
  if (ADMIN_FULL_ACCESS_EMAILS.includes(String(payload.email || '').toLowerCase())) payload.sections = ACCUEIL_SECTIONS.slice();
  else payload.sections = payload.sections.filter(x => x !== 'admin' && ACCUEIL_SECTIONS.includes(x));
  return payload;
}
async function isAccueilAdmin(request) {
  const ar = await verifyArSession(request.headers.get('X-AR-Session'));
  if (ar === 'ALL') return true;
  const acc = await verifyAccueilSession(request.headers.get('X-Accueil-Session'));
  return !!(acc && acc.sections.includes('admin'));
}
function accueilAppRow(r) {
  return { id: r.id, nom: r.nom, url: r.url, section: r.section, icone: r.icone || '', description: r.description || '', usage: r.usage || '', frequence: r.frequence || '', ordre: r.ordre || 0, actif: r.actif ? 1 : 0 };
}

// Fermetures réseau : pays vide = tout le réseau international.
let _fermeturesTableOk = false;
async function ensureFermeturesTable(env) {
  if (_fermeturesTableOk) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS fermetures_reseau (id INTEGER PRIMARY KEY AUTOINCREMENT, intitule TEXT NOT NULL, date_debut TEXT NOT NULL, nb_jours INTEGER NOT NULL DEFAULT 1, pays TEXT, created_at TEXT)`).run();
  try { await env.DB.prepare(`ALTER TABLE fermetures_reseau ADD COLUMN pays TEXT`).run(); } catch (e) { /* déjà présente */ }
  _fermeturesTableOk = true;
}
async function getFermeturesReseau(env) {
  await ensureFermeturesTable(env);
  const { results } = await env.DB.prepare(`SELECT id, intitule, date_debut, nb_jours, pays FROM fermetures_reseau ORDER BY date_debut`).all();
  return results || [];
}

// ============================================================================
// Lot 3 (25/10/2026) — helpers Bilan de Passage
// ============================================================================

// Poids du score de santé, éditables via la modale ⚖️ de Bilan de Passage.
// Entretiens et lancements à 0 tant que Suivi Managers n'est pas déployé à
// l'international : sinon ces deux dimensions vaudraient 0 partout et feraient
// baisser tous les scores. À passer à 6 et 5 via ⚖️ quand l'appli sera en ligne.
const POIDS_SANTE_DEFAULT = {
  actions: 7, effectif: 3, absenteisme: 4, positionnement: 5, pedlv: 8, avis: 4, equipe: 6, kaizen: 7,
  entretiens: 0, lancements: 0,
};
let _healthWeightsTableOk = false;
async function ensureHealthWeightsTable(env) {
  if (_healthWeightsTableOk || !env.DB) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS health_weights (key TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at TEXT)').run();
  _healthWeightsTableOk = true;
}
async function getHealthWeights(env) {
  const weights = { ...POIDS_SANTE_DEFAULT };
  if (!env.DB) return weights;
  try {
    await ensureHealthWeightsTable(env);
    const { results } = await env.DB.prepare('SELECT key, value FROM health_weights').all();
    for (const r of results) if (r.key in weights) weights[r.key] = r.value;
  } catch (e) { console.error('Lecture health_weights, poids par défaut utilisés :', e); }
  return weights;
}

// Lecture tolérante : une table ou une colonne absente (applis pas encore
// déployées à l'international) ne doit jamais faire échouer le récap.
async function premiereLigneTolerante(env, sqls, binds) {
  for (const sql of sqls) {
    try { const r = await env.DB.prepare(sql).bind(...binds).first(); return r || null; } catch (e) { /* table/colonne absente : requête suivante */ }
  }
  return null;
}
function isoJour(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

async function buildBilanPrefill(env, store) {
  const code = store.code;
  const nb = v => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
  const r1 = v => v === null ? null : Math.round(v * 10) / 10;

  const [stats, bilan, kaizen, evalEq, obs, entretien, lancement] = await Promise.all([
    premiereLigneTolerante(env, ['SELECT * FROM store_stats WHERE code_magasin = ? ORDER BY id DESC LIMIT 1'], [code]),
    premiereLigneTolerante(env, ['SELECT date, ar, passage FROM bilans WHERE magasin_code = ? ORDER BY date DESC, id DESC LIMIT 1'], [code]),
    premiereLigneTolerante(env, [
      'SELECT mois, closed, COALESCE(updated_at, closed_at) AS maj FROM kaizen_audits WHERE magasin_code = ? ORDER BY mois DESC LIMIT 1',
      'SELECT mois, closed, closed_at AS maj FROM kaizen_audits WHERE magasin_code = ? ORDER BY mois DESC LIMIT 1',
      'SELECT mois, closed FROM kaizen_audits WHERE magasin_code = ? ORDER BY mois DESC LIMIT 1',
    ], [code]),
    premiereLigneTolerante(env, ['SELECT date_controle AS date, tache FROM notes_equipe WHERE magasin_code = ? ORDER BY date_controle DESC, rowid DESC LIMIT 1'], [code]),
    premiereLigneTolerante(env, ['SELECT date_key FROM observation_last_visit WHERE magasin = ? LIMIT 1', 'SELECT last_date AS date_key FROM observation_last_visit WHERE magasin = ? LIMIT 1'], [store.libelle]),
    premiereLigneTolerante(env, ['SELECT date, type, rempli_par FROM entretiens_manager WHERE magasin_code = ? ORDER BY date DESC, rowid DESC LIMIT 1'], [code]),
    premiereLigneTolerante(env, ['SELECT date, rempli_par FROM lancements_journee WHERE magasin_code = ? ORDER BY date DESC, rowid DESC LIMIT 1'], [code]),
  ]);

  let kaizenDate = kaizen ? isoJour(kaizen.maj) : null;
  if (kaizen && !kaizenDate && /^\d{4}-\d{2}$/.test(kaizen.mois || '')) kaizenDate = kaizen.mois + '-01';
  const statsDate = stats ? (isoJour(stats.created_at) || isoJour(stats.date_extraction)) : null;

  const derniereActivite = {
    bilan: bilan ? { date: isoJour(bilan.date), detail: [bilan.passage ? 'n°' + bilan.passage : '', bilan.ar || ''].filter(Boolean).join(' — ') || null } : null,
    pedlv: stats ? { date: statsDate, detail: stats.periode || null } : null,
    kaizen: kaizen ? { date: kaizenDate, detail: (kaizen.mois || '') + (kaizen.closed ? ' ✓' : '') } : null,
    evaluation: evalEq ? { date: isoJour(evalEq.date), detail: evalEq.tache || null } : null,
    observations: obs && obs.date_key ? { date: isoJour(obs.date_key), detail: null } : null,
    suiviManagers: entretien ? { date: isoJour(entretien.date), detail: [entretien.type, entretien.rempli_par].filter(Boolean).join(' — ') || null } : null,
    lancement: lancement ? { date: isoJour(lancement.date), detail: lancement.rempli_par || null } : null,
  };

  let kpis = null;
  if (stats) {
    const pcEur = nb(stats.pm_pack_confort), pcPct = nb(stats.taux_pack_confort);
    kpis = {
      sop: r1(nb(stats.taux_sop)), tc: r1(nb(stats.taux_tc)), pcPct: r1(pcPct),
      pcEur: pcEur !== null ? Math.round(pcEur) : null,
      panierMoyen: nb(stats.panier_moyen) !== null ? Math.round(nb(stats.panier_moyen)) : null,
      mdc: r1(nb(stats.taux_mdc)), audioDepistage: r1(nb(stats.taux_test_auditif)), venteAdd: r1(nb(stats.taux_vente_add_audio)),
      nbProtheses: nb(stats.protheses_vendues), ndv: nb(stats.nb_vente_opt),
      // Colonnes ajoutées par l'Analyse statistique au lot 4 : null tant qu'elles n'existent pas.
      pmPaire1: nb(stats.pm_paire1) !== null ? Math.round(nb(stats.pm_paire1)) : null,
      lukkas: r1(nb(stats.taux_lukkas)),
      pmProthese: nb(stats.pm_prothese) !== null ? Math.round(nb(stats.pm_prothese)) : null,
      pmVenteAudio: nb(stats.pm_vente_audio) !== null ? Math.round(nb(stats.pm_vente_audio)) : null,
      sap: r1(nb(stats.taux_assur_audio)),
      seuilPc: (pcEur !== null && pcPct !== null) ? Math.round(pcEur * pcPct) : null,
      seuilPerf: null, // calculé plus bas avec la grille du pays / de la région
      positionnement: r1(nb(stats.positionnement)),
    };
  }
  if (kpis) {
    // Seuil de performance : (PM × TC) / (objectif PM × objectif TC), en %, avec
    // la grille d'objectifs du pays / de la région du magasin.
    const g = await grilleObjectifsPour(store);
    const pm = nb(stats.panier_moyen), tc = nb(stats.taux_tc);
    if (pm !== null && tc !== null && g.pm && g.tc) kpis.seuilPerf = r1(pm * tc / (g.pm * g.tc) * 100);
  }
  return {
    magasin: { code: store.code, libelle: store.libelle },
    stats: stats ? { date: statsDate, periode: stats.periode || null, dateExtraction: stats.date_extraction || null } : null,
    kpis, derniereActivite,
  };
}

// Absences longue durée RH du magasin (hors manager), pour pré-remplir la case
// du bilan. Manager : poste RH « Manager », sinon nom de la colonne manager.
function rhEstPosteManager(poste) { return String(poste || '').trim().toLowerCase() === 'manager'; }
function rhCorrespondNomManager(store, prenom, nom) {
  const cible = normalizeName(store && store.manager);
  if (!cible) return false;
  return normalizeName(`${prenom || ''} ${nom || ''}`) === cible || normalizeName(`${nom || ''} ${prenom || ''}`) === cible;
}
function rhEligiblesParMagasin(rows, stores) {
  const storesByCode = new Map((stores || []).map(st => [st.code, st]));
  const parCode = {};
  (rows || []).forEach(r => { (parCode[r.code_site] ??= []).push(r); });
  const out = {};
  for (const [code, lignes] of Object.entries(parCode)) {
    const aUnPosteManager = lignes.some(r => rhEstPosteManager(r.poste));
    const store = storesByCode.get(code);
    const eligibles = new Set(); const ld = new Set();
    lignes.forEach(r => {
      if (rhEstPosteManager(r.poste)) return;
      if (!aUnPosteManager && rhCorrespondNomManager(store, r.prenom, r.nom)) return;
      eligibles.add(r.matricule);
      if (Number(r.longue_duree) === 1) ld.add(r.matricule);
    });
    out[code] = { eligibles, ldRh: ld.size };
  }
  return out;
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


// ============================================================================
// Lot 6 (25/10/2026) — score de santé aligné sur la France
// ============================================================================
// Reprise du calcul France (bascule du 19/09 : « pas de donnée » = 0 pour les
// dimensions qui dépendent de l'usage du magasin ; effectif, absentéisme et avis
// restent exclus sans donnée), dimensions entretiens et lancements (poids 0 par
// défaut à l'international tant que Suivi Managers n'est pas déployé), score
// mensuel « primes » (versions, neutralisations, validation), onglet
// « Aujourd'hui » du dashboard. Adaptations internationales :
// - calendrier : jours de repos du pays (pays_inter.csv) + fermetures réseau du
//   pays, à la place des fériés français et de l'Alsace-Moselle ;
// - « aujourd'hui » et l'heure butoir du lancement s'apprécient dans le fuseau
//   du magasin (colonne fuseau_horaire de magasins_inter.csv) ;
// - PEDLV lu dans store_stats (tous les envois sont conservés, clé code_magasin)
//   au lieu de store_stats_history ;
// - périmètres : animateur, directeur pays (PAYS:…) ou accès réseau complet ;
//   les actions réservées à Olivier en France le sont ici à l'accès complet.

// ---------- Cache mémoire par instance (reprise France 13/10) ----------
const _memoD1 = new Map();
function memoD1(cle, ttlMs, fn) {
  const now = Date.now();
  const hit = _memoD1.get(cle);
  if (hit && (now - hit.at) < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn);
  promise.catch(() => { if (_memoD1.get(cle) && _memoD1.get(cle).promise === promise) _memoD1.delete(cle); });
  _memoD1.set(cle, { at: now, promise });
  if (_memoD1.size > 100) {
    for (const [k, v] of _memoD1) if ((now - v.at) > 15 * 60 * 1000) _memoD1.delete(k);
  }
  return promise;
}
function viderMemoD1() { _memoD1.clear(); }
const MEMO_SANTE_MS = 5 * 60 * 1000;
const MEMO_ACTIVITE_MS = 60 * 1000;

// ---------- Cache persistant des calculs réseau (reprise France 14/10) ----------
const CACHE_CALC_MS = 15 * 60 * 1000;
const ROUTES_INVALIDANT_CALCULS = new Set(['/store-bilan', '/rh-import/effectif', '/rh-import/agenda', '/sante-mensuel', '/fermetures-reseau', '/health-weights']);
let _cacheCalculsOk = false;
async function ensureCacheCalculs(env) {
  if (_cacheCalculsOk || !env.DB) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cache_calculs (cle TEXT PRIMARY KEY, json TEXT NOT NULL, maj INTEGER NOT NULL)`).run();
  _cacheCalculsOk = true;
}
function calculMisEnCache(env, cle, ttlMs, fn) {
  return memoD1('calc:' + cle, 60 * 1000, async () => {
    try {
      await ensureCacheCalculs(env);
      const row = await env.DB.prepare('SELECT json, maj FROM cache_calculs WHERE cle = ?').bind(cle).first();
      if (row && (Date.now() - Number(row.maj)) < ttlMs) return JSON.parse(row.json);
    } catch (e) { console.error('cache_calculs lecture :', e); }
    const val = await fn();
    try {
      const json = JSON.stringify(val);
      if (json.length < 1800000) {
        await env.DB.prepare('INSERT INTO cache_calculs (cle, json, maj) VALUES (?, ?, ?) ON CONFLICT(cle) DO UPDATE SET json = excluded.json, maj = excluded.maj').bind(cle, json, Date.now()).run();
      } else console.error('cache_calculs : ' + cle + ' trop volumineux, non stocké');
    } catch (e) { console.error('cache_calculs écriture :', e); }
    return val;
  });
}
const CACHE_RH_MS = 24 * 60 * 60 * 1000;
function lectureRhEnCache(env, nom, sql, binds) {
  return calculMisEnCache(env, 'rh:' + nom + ':' + (binds || []).join('|'), CACHE_RH_MS, async () => {
    const st = env.DB.prepare(sql);
    const { results } = await (binds && binds.length ? st.bind(...binds) : st).all();
    return results || [];
  });
}
async function invaliderCalculs(env, inclureRh) {
  viderMemoD1();
  if (!env.DB) return;
  try {
    await ensureCacheCalculs(env);
    await env.DB.prepare(inclureRh ? 'DELETE FROM cache_calculs' : "DELETE FROM cache_calculs WHERE cle NOT LIKE 'rh:%'").run();
  } catch (e) { console.error('cache_calculs purge :', e); }
}

// ---------- Périmètre d'une session ----------
// Set des codes visibles (tous les magasins pour l'accès réseau complet).
async function codesDuPerimetre(sessionAr, stores) {
  if (sessionAr === 'ALL') return new Set(stores.map(s => s.code));
  return new Set(await getAllowedCodes(sessionAr, stores));
}
// Magasins d'un périmètre nommé (ALL, PAYS:A|B ou nom d'animateur).
function magasinsDuPerimetre(nom, stores) {
  if (nom === 'ALL') return stores.slice();
  if (String(nom).startsWith('PAYS:')) {
    const paysListe = nom.slice('PAYS:'.length).split('|');
    return stores.filter(s => paysListe.includes(s.pays));
  }
  return stores.filter(s => s.animateur === nom);
}

// ---------- Date et heure locales du magasin ----------
function fuseauValide(fz) {
  if (!fz) return 'Europe/Paris';
  try { new Date().toLocaleDateString('sv-SE', { timeZone: fz }); return fz; } catch (e) { return 'Europe/Paris'; }
}
function dateLocaleIso(d, fz) { return d.toLocaleDateString('sv-SE', { timeZone: fuseauValide(fz) }); }
function heureLocale(d, fz) { return d.toLocaleTimeString('fr-FR', { timeZone: fuseauValide(fz), hour: '2-digit', minute: '2-digit' }); }
function todayIsoMagasin(store) { return dateLocaleIso(new Date(), store && store.fuseauHoraire); }

// Calendrier d'un magasin : jours de repos du pays + fermetures du pays ou réseau.
async function calendrierMagasins(env, stores) {
  const fermetures = await getFermeturesReseau(env);
  const parPays = new Map();
  for (const s of stores) {
    const cle = normalizeName(s.pays || '');
    if (!parPays.has(cle)) parPays.set(cle, { repos: await joursReposPays(s.pays), fermSet: fermeturesSetPourPays(fermetures, s.pays) });
  }
  return code => {
    const s = stores.find(x => x.code === code);
    return parPays.get(normalizeName((s && s.pays) || '')) || { repos: [0], fermSet: new Set() };
  };
}

// Jours attendus pour le taux de lancement : mois en cours = jours ouvrés
// écoulés jusqu'à HIER (repli sur aujourd'hui le 1er), mois passé = mois complet.
function joursAttendusLancementInter(mois, repos, fermSet, todayLocal) {
  if (mois !== todayLocal.slice(0, 7)) return compterJoursOuvresInter(mois, repos, fermSet);
  const hier = compterJoursOuvresInter(mois, repos, fermSet, ajouterJoursIso(todayLocal, -1));
  return hier > 0 ? hier : compterJoursOuvresInter(mois, repos, fermSet, todayLocal);
}

// ---------- Entretiens et lancements (reprise France 18/09, 08/10) ----------
const TYPES_ENTRETIENS_COMPTES = ['pilotage_optique', 'pilotage_audio', 'recadrage', 'valorisation', 'remotivation'];

function santeMoisDecale(mois, n) {
  const [y, m] = mois.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function santeFinMois(mois) {
  const [y, m] = mois.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Absences longue durée saisies dans le bilan de passage (dernier bilan entre
// le 1er du mois précédent et la fin du mois).
async function getAbsencesLdBilans(env, mois) {
  const debut = santeMoisDecale(mois, -1) + '-01';
  const fin = santeFinMois(mois);
  let rows = [];
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT magasin_code, date, abs_ld FROM (
         SELECT magasin_code, date, json_extract(data_json, '$.magasin.abs_ld') AS abs_ld,
         ROW_NUMBER() OVER (PARTITION BY magasin_code ORDER BY date DESC, id DESC) AS rn
         FROM bilans WHERE date >= ? AND date <= ?
         AND json_extract(data_json, '$.magasin.abs_ld') IS NOT NULL AND json_extract(data_json, '$.magasin.abs_ld') != ''
       ) WHERE rn = 1`
    ).bind(debut, fin).all());
  } catch (e) { console.error('Lecture absences longue durée (bilans) :', e); }
  const out = {};
  (rows || []).forEach(r => {
    const n = parseInt(String(r.abs_ld).replace(',', '.'), 10);
    if (Number.isFinite(n) && n >= 0) out[r.magasin_code] = { n, date: r.date };
  });
  return out;
}
function entretiensAttendus(elig, absBilan) {
  const effectif = elig ? elig.eligibles.size : 0;
  const absLd = absBilan ? absBilan.n : (elig ? elig.ldRh : 0);
  const source = absBilan ? 'bilan' : 'rh';
  return { effectif, absLd, source, attendus: Math.max(0, effectif - absLd) };
}

async function getEntretiensLancementsMap(env, moisCible) {
  if (!env.DB) return {};
  const stores = (await getMagasinsServerSide()).filter(s => s.code);
  const moisActuel = moisCible || parisTodayIso().slice(0, 7);

  let eligibleRows = [];
  try {
    eligibleRows = await lectureRhEnCache(env, 'eligibles-dernier-mois',
      `SELECT es.code_site, es.matricule, em.poste, em.prenom, em.nom, a.longue_duree
       FROM rh_effectif_site_mensuel es
       JOIN rh_effectif_mensuel em ON em.mois = es.mois AND em.matricule = es.matricule
       LEFT JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
       INNER JOIN (
         SELECT code_site, MAX(mois) as maxmois FROM rh_effectif_site_mensuel WHERE site_reconnu = 1 GROUP BY code_site
       ) latest ON latest.code_site = es.code_site AND latest.maxmois = es.mois
       WHERE es.site_reconnu = 1`
    );
  } catch (e) {}
  const eligiblesParMagasin = rhEligiblesParMagasin(eligibleRows, stores);
  const absBilanParMagasin = await getAbsencesLdBilans(env, moisActuel);

  let entretienRows = [];
  try {
    ({ results: entretienRows } = await env.DB.prepare(
      `SELECT DISTINCT magasin_code, collaborateur_matricule FROM entretiens_manager
       WHERE date LIKE ? AND type IN (${TYPES_ENTRETIENS_COMPTES.map(() => '?').join(',')}) AND collaborateur_matricule IS NOT NULL`
    ).bind(moisActuel + '%', ...TYPES_ENTRETIENS_COMPTES).all());
  } catch (e) {}
  const vusParMagasin = {};
  entretienRows.forEach(r => { (vusParMagasin[r.magasin_code] ??= new Set()).add(r.collaborateur_matricule); });

  const cal = await calendrierMagasins(env, stores);
  const joursOuvertsParMagasin = {};
  stores.forEach(store => {
    const { repos, fermSet } = cal(store.code);
    joursOuvertsParMagasin[store.code] = joursAttendusLancementInter(moisActuel, repos, fermSet, todayIsoMagasin(store));
  });

  let lancementRows = [];
  try {
    ({ results: lancementRows } = await env.DB.prepare(
      `SELECT magasin_code, COUNT(DISTINCT date) as jours FROM lancements_journee WHERE date LIKE ? GROUP BY magasin_code`
    ).bind(moisActuel + '%').all());
  } catch (e) {}
  const lancementsParMagasin = {};
  lancementRows.forEach(r => { lancementsParMagasin[r.magasin_code] = r.jours; });

  let typeCountRows = [];
  try {
    ({ results: typeCountRows } = await env.DB.prepare(
      `SELECT magasin_code, type, COUNT(*) as n FROM entretiens_manager WHERE date LIKE ? GROUP BY magasin_code, type`
    ).bind(moisActuel + '%').all());
  } catch (e) {}
  const typeCountsParMagasin = {};
  typeCountRows.forEach(r => { (typeCountsParMagasin[r.magasin_code] ??= {})[r.type] = r.n; });

  const map = {};
  const allCodes = new Set([...Object.keys(eligiblesParMagasin), ...Object.keys(lancementsParMagasin), ...Object.keys(joursOuvertsParMagasin), ...Object.keys(typeCountsParMagasin)]);
  allCodes.forEach(code => {
    const elig = eligiblesParMagasin[code];
    const eligibles = elig ? elig.eligibles : new Set();
    const att = entretiensAttendus(elig, absBilanParMagasin[code]);
    const vus = vusParMagasin[code] || new Set();
    let nbVusBrut = 0;
    eligibles.forEach(m => { if (vus.has(m)) nbVusBrut++; });
    const nbVus = Math.min(nbVusBrut, att.attendus);
    const tauxEntretiens = att.attendus > 0 ? Math.round((nbVus / att.attendus) * 100) : (att.effectif > 0 ? 100 : 0);
    const joursOuverts = joursOuvertsParMagasin[code];
    const joursLances = lancementsParMagasin[code] || 0;
    const tauxLancements = joursOuverts ? Math.min(100, Math.round((joursLances / joursOuverts) * 100)) : 0;
    const tc = typeCountsParMagasin[code] || {};
    map[code] = {
      tauxEntretiens, nbEligibles: att.attendus, nbVus, nbEffectif: att.effectif, nbAbsencesLd: att.absLd, sourceAbsencesLd: att.source,
      tauxLancements, joursOuverts: joursOuverts || 0, joursLances,
      nbPilotage: (tc.pilotage_optique || 0) + (tc.pilotage_audio || 0) + (tc.recadrage || 0),
      nbEcouteFb: tc.ecoute_fb || 0, nbRecadrage: tc.recadrage || 0, nbValorisation: tc.valorisation || 0, nbRemotivation: tc.remotivation || 0,
      nbLancements: joursLances,
    };
  });
  return map;
}

// ---------- Historique PEDLV par semaine (à partir de store_stats) ----------
// Dernier envoi de chaque semaine (lundi UTC) par magasin, sur 8 semaines.
function lundiIso(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function getPedlvHistoSemaines(env) {
  return memoD1('pedlvHistoSemaines', MEMO_SANTE_MS, async () => {
    const lundiCourant = lundiIso(new Date().toISOString());
    const periodListe = [lundiCourant];
    for (let i = 1; i < 8; i++) periodListe.push(ajouterJoursIso(periodListe[i - 1], -7));
    const history = {};
    try {
      const { results } = await env.DB.prepare(
        `SELECT code_magasin, created_at, indicateurs_json FROM store_stats WHERE created_at >= ? ORDER BY id ASC`
      ).bind(periodListe[periodListe.length - 1]).all();
      for (const r of results || []) {
        if (!r.code_magasin || !r.created_at) continue;
        let ind = {}; try { ind = JSON.parse(r.indicateurs_json || '{}'); } catch (e) {}
        (history[r.code_magasin] ??= {})[lundiIso(r.created_at)] = ind; // ordre croissant : le dernier gagne
      }
    } catch (e) { console.error('Historique PEDLV (store_stats) :', e); }
    return { history, periodListe };
  });
}
function streakIndicateurPedlv(history, periodListe, code, cle) {
  let streak = 0;
  for (let i = 1; i < periodListe.length; i++) {
    const ind = history[code] && history[code][periodListe[i]];
    if (!ind || !(cle in ind)) break;
    if (!ind[cle] || ind[cle].statut !== 'rouge') break;
    streak++;
  }
  return streak;
}
async function getPreviousWeekPedlvMap(env) {
  const { history, periodListe } = await getPedlvHistoSemaines(env);
  const map = {};
  for (const [code, parSemaine] of Object.entries(history)) {
    const ind = parSemaine[periodListe[1]];
    if (!ind) continue;
    const entries = Object.values(ind).filter(v => v && v.statut);
    if (entries.length) map[code] = { rouge: entries.filter(v => v.statut === 'rouge').length, total: entries.length };
  }
  return map;
}

// ---------- Kaizen : points non conformes plusieurs mois de suite ----------
async function getKaizenItemsHistory(env, moisCourant, lookbackMonths = 6) {
  if (!env.DB) return { history: {}, moisListe: [moisCourant] };
  const moisListe = [moisCourant];
  for (let i = 1; i < lookbackMonths; i++) moisListe.push(santeMoisDecale(moisCourant, -i));
  const { results } = await env.DB.prepare(
    `SELECT magasin_code, mois, items_json FROM kaizen_audits WHERE mois IN (${moisListe.map(() => '?').join(',')})`
  ).bind(...moisListe).all();
  const history = {};
  (results || []).forEach(r => {
    let itemsState = {}; try { itemsState = JSON.parse(r.items_json || '{}'); } catch (e) {}
    (history[r.magasin_code] ??= {})[r.mois] = itemsState;
  });
  return { history, moisListe };
}
function computeItemStreak(history, moisListe, magasinCode, itemId) {
  let streak = 0;
  for (let i = 1; i < moisListe.length; i++) {
    const itemsState = history[magasinCode]?.[moisListe[i]];
    if (!itemsState || !(itemId in itemsState)) break;
    if (itemsState[itemId]?.checked) break;
    streak++;
  }
  return streak;
}
function computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, history, moisListe, magasinCode, threshold = 1) {
  const out = [];
  itemsApplicables.filter(i => !i.optional).forEach(item => {
    if (itemsStateThisMonth?.[item.id]?.checked) return;
    const streak = computeItemStreak(history, moisListe, magasinCode, item.id);
    if (streak >= threshold) out.push({ label: item.label, zoneNom: item.zoneNom, moisConsecutifs: streak + 1 });
  });
  return out;
}

// ---------- Score hebdo (reprise France 19/09) ----------
function healthSubScoresServer(s) {
  const scores = {};
  if (s.actionsNonSoldees && Array.isArray(s.actionsNonSoldees.items)) {
    const penalty = s.actionsNonSoldees.items.filter(a => a.fromPrevious).reduce((acc, a) => acc + (a.status === 'todo' ? 25 : 15), 0);
    scores.actions = Math.max(0, 100 - penalty);
  } else scores.actions = 0;

  // Effectif, absentéisme, avis : exclus (null) sans donnée — ils dépendent d'un
  // import ou d'un flux réseau, pas de l'usage du magasin.
  if (s.effectif && s.effectif.delta !== null && s.effectif.delta !== undefined) {
    let score = s.effectif.delta <= 0 ? 100 : Math.max(0, 100 - s.effectif.delta * 25);
    if (s.effectifRH && s.effectifRH.soutenu && s.effectifRH.ecartMoyen !== null) score = Math.min(score, Math.max(0, 100 + s.effectifRH.ecartMoyen * 25));
    scores.effectif = score;
  } else if (s.effectifRH && s.effectifRH.soutenu && s.effectifRH.ecartMoyen !== null) {
    scores.effectif = Math.max(0, 100 + s.effectifRH.ecartMoyen * 25);
  } else scores.effectif = null;

  scores.absenteisme = (s.absenteisme && s.absenteisme.score !== null && s.absenteisme.score !== undefined) ? s.absenteisme.score : null;
  scores.positionnement = (s.positionnementAnnuel !== null && s.positionnementAnnuel !== undefined) ? Math.max(0, Math.min(100, s.positionnementAnnuel)) : 0;
  scores.pedlv = (s.pedlv && s.pedlv.total) ? Math.max(0, 100 - (s.pedlv.rouge / s.pedlv.total) * 100) : 0;
  scores.avis = (s.googleRating && s.googleRating.rating) ? Math.max(0, Math.min(100, (Number(s.googleRating.rating) / 5) * 100)) : null;
  scores.equipe = (s.niveauEquipe !== null && s.niveauEquipe !== undefined) ? Math.max(0, Math.min(100, (Number(s.niveauEquipe) / 10) * 100)) : 0;
  scores.kaizen = (s.kaizenDernierScoreCloture !== null && s.kaizenDernierScoreCloture !== undefined && s.kaizenDernierScoreMax)
    ? Math.max(0, Math.min(100, (s.kaizenDernierScoreCloture / s.kaizenDernierScoreMax) * 100)) : 0;
  scores.entretiens = s.entretiensLancements ? s.entretiensLancements.tauxEntretiens : 0;
  scores.lancements = s.entretiensLancements ? s.entretiensLancements.tauxLancements : 0;
  return scores;
}

function computeHealthScoreServer(s, precomputedSub, weights) {
  const sub = precomputedSub || healthSubScoresServer(s);
  const poids = weights || POIDS_SANTE_DEFAULT;
  let total = 0, possible = 0, totalWeight = 0;
  Object.keys(poids).forEach(key => {
    totalWeight += poids[key];
    if (sub[key] === null || sub[key] === undefined) return;
    total += sub[key] * poids[key];
    possible += poids[key];
  });
  if (!possible || possible < totalWeight * 0.5) return null;
  return Math.round(total / possible);
}

function chargerDonneesSante(env) {
  return memoD1('donneesSante', MEMO_SANTE_MS, async () => {
    const healthWeights = await getHealthWeights(env);
    const snapshots = await getLastBilanSnapshots(env);
    const lastObservationMap = await getLastObservationMap(env);
    const ratingsMap = {};
    try {
      const { results: ratingRows } = await env.DB.prepare('SELECT magasin_code, rating, reviews_count FROM google_ratings').all();
      ratingRows.forEach(r => { ratingsMap[r.magasin_code] = { rating: r.rating, reviewsCount: r.reviews_count }; });
    } catch (e) {}
    const storeStatsMap = await getStoreStatsMap(env);
    const previousWeekPedlvMap = await getPreviousWeekPedlvMap(env);
    const niveauxEquipeMap = await getNiveauxEquipeMap(env);
    const kaizenHealthMap = await getKaizenHealthMap(env);
    const rhHealthMap = await getRhHealthSignalsMap(env);
    const entretiensLancementsMap = await getEntretiensLancementsMap(env);
    return { healthWeights, snapshots, lastObservationMap, ratingsMap, storeStatsMap, previousWeekPedlvMap, niveauxEquipeMap, kaizenHealthMap, rhHealthMap, entretiensLancementsMap };
  });
}

// Calculé pour tout le réseau et mis en cache, puis filtré sur le périmètre.
async function buildStoreHealthResults(env, scope) {
  let tous = null;
  try { tous = await getMagasinsServerSide(); } catch (e) {}
  if (tous && tous.length) {
    const all = await calculMisEnCache(env, 'sante-hebdo:' + new Date().toISOString().slice(0, 10), CACHE_CALC_MS, () => buildStoreHealthResultsD1(env, tous));
    const codes = new Set(scope.map(st => st.code));
    const connus = new Set(all.map(r => r.code));
    if ([...codes].every(c => connus.has(c))) return all.filter(r => codes.has(r.code));
  }
  return buildStoreHealthResultsD1(env, scope);
}
async function buildStoreHealthResultsD1(env, scope) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const { healthWeights, snapshots, lastObservationMap, ratingsMap, storeStatsMap, previousWeekPedlvMap, niveauxEquipeMap, kaizenHealthMap, rhHealthMap, entretiensLancementsMap } = await chargerDonneesSante(env);
  return scope.map(store => {
    const snap = snapshots[store.code] || null;
    const bilanDate = snap ? snap.date : null;
    const obsDate = lastObservationMap[normalizeName(store.libelle)] || null;
    const lastVisitDate = [bilanDate, obsDate].filter(Boolean).sort().slice(-1)[0] || null;
    const daysSinceVisit = lastVisitDate ? daysBetween(lastVisitDate, todayISO) : null;
    const kz = kaizenHealthMap[store.code] || null;
    const rhSignal = rhHealthMap[store.code] || null;
    const result = {
      code: store.code, libelle: store.libelle, animateur: store.animateur,
      pays: store.pays || null, directeurPays: store.directeurPays, directriceInter: store.directriceInter,
      lastVisitDate, daysSinceVisit, lastBilanDate: bilanDate, lastObservationDate: obsDate,
      overdue: lastVisitDate === null || daysSinceVisit >= VISIT_REMINDER_THRESHOLD_DAYS,
      effectif: computeEffectifStatus(snap, store.effTheo, rhSignal),
      effectifRH: computeEffectifRH(rhSignal, store.effTheo),
      absenteisme: { score: rhSignal ? rhSignal.absenteismeScore : null, moisCount: rhSignal ? rhSignal.moisCount : 0 },
      positionnementAnnuel: snap ? snap.positionnementAnnuel : null,
      googleRating: ratingsMap[store.code] || null,
      actionsNonSoldees: snap ? {
        count: (snap.actions || []).length,
        items: (snap.actions || []).map(a => ({
          text: a.text, repriseCount: a._repriseCount || 0, fromPrevious: !!a._fromPrevious, status: a._status || null,
          date: /^\d{4}-\d{2}-\d{2}/.test(a.date || '') ? String(a.date).slice(0, 10) : null, who: a.who || null,
        })),
      } : null,
      pedlv: computePedlvSummary(storeStatsMap[store.code]),
      pedlvTrend: previousWeekPedlvMap[store.code] || null,
      niveauEquipe: niveauxEquipeMap[store.code] ?? null,
      objectifNiveauEquipe: OBJECTIF_NIVEAU_EQUIPE,
      kaizenScoreMois: kz ? kz.scoreMois : null,
      kaizenScoreMaxMois: kz ? kz.scoreMaxMois : null,
      kaizenClosedMois: kz ? kz.closedMois : false,
      kaizenCumulAnnuel: kz ? kz.cumulAnnuel : null,
      kaizenDernierScoreCloture: kz ? kz.dernierScoreCloture : null,
      kaizenDernierScoreMax: kz ? kz.dernierScoreMax : null,
      kaizenDernierMoisCloture: kz ? kz.dernierMoisCloture : null,
      entretiensLancements: entretiensLancementsMap[store.code] || { tauxEntretiens: 0, tauxLancements: 0, nbEligibles: 0, nbVus: 0, joursOuverts: 0, joursLances: 0, nbPilotage: 0, nbEcouteFb: 0, nbRecadrage: 0, nbValorisation: 0, nbRemotivation: 0, nbLancements: 0 },
    };
    result.subScores = healthSubScoresServer(result);
    result.score = computeHealthScoreServer(result, result.subScores, healthWeights);
    return result;
  }).sort((a, b) => (b.daysSinceVisit ?? 9999) - (a.daysSinceVisit ?? 9999));
}

// Colonnes entretiens / lancements de l'historique hebdo (ajoutées au lot 6).
let _histoSanteColsOk = false;
async function ensureHistoSanteColonnes(env) {
  if (_histoSanteColsOk || !env.DB) return;
  for (const col of ['score_entretiens', 'score_lancements']) {
    try { await env.DB.prepare(`ALTER TABLE store_health_score_history ADD COLUMN ${col} REAL`).run(); } catch (e) { /* déjà présente */ }
  }
  _histoSanteColsOk = true;
}
const HISTO_SANTE_COLONNES = `period_key, score, score_actions, score_effectif, score_absenteisme, score_positionnement,
  score_pedlv, score_avis, score_equipe, score_kaizen, score_entretiens, score_lancements`;
function sousScoresHisto(r) {
  return {
    actions: r.score_actions, effectif: r.score_effectif, absenteisme: r.score_absenteisme, positionnement: r.score_positionnement,
    pedlv: r.score_pedlv, avis: r.score_avis, equipe: r.score_equipe, kaizen: r.score_kaizen,
    entretiens: r.score_entretiens ?? null, lancements: r.score_lancements ?? null,
  };
}

// ============================================================================
// Score de santé MENSUEL « primes » (reprise France 03/10)
// ============================================================================
// Calcul sur le mois civil, versions (rien n'est écrasé), neutralisations
// proposées automatiquement ou par un animateur / directeur pays, appliquées
// et validées uniquement par l'accès réseau complet. Poids, note Google et
// eff_theo figés au premier calcul du mois.
const SANTE_REGLES_VERSION = '2026-10-25-inter';
const SANTE_DIMS = ['actions', 'effectif', 'absenteisme', 'positionnement', 'pedlv', 'avis', 'equipe', 'kaizen', 'entretiens', 'lancements'];
const SANTE_DIMS_AR_ABSENT = ['actions', 'positionnement', 'equipe'];
const SANTE_SEUIL_COUVERTURE = 0.5;
const SANTE_AVIS_PERIME_JOURS = 35;
const SANTE_MOIS_NOMS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  januari: 1, februari: 2, maart: 3, mei: 5, juni: 6, juli: 7, augustus: 8, oktober: 10,
  'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'מרס': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12,
};
function santeDateLimite(mois) { return santeMoisDecale(mois, 2) + '-05'; }
// Période d'un envoi PEDLV (« octobre 2026 », « October 2026 », « אוקטובר 2026 »,
// « 2026-10 »…) → « 2026-10 ».
function santePeriodePedlvVersMois(periode) {
  if (!periode) return null;
  const s = String(periode).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const iso = s.match(/(20\d{2})-(0[1-9]|1[0-2])/);
  if (iso) return iso[1] + '-' + iso[2];
  const an = s.match(/(20\d{2})/);
  if (!an) return null;
  const mots = s.split(/[\s,./-]+/).map(m => m.replace(/^ב/, '')).filter(Boolean);
  for (const mot of mots) {
    const n = SANTE_MOIS_NOMS[mot] || SANTE_MOIS_NOMS[mot.replace(/^ב/, '')];
    if (n) return an[1] + '-' + String(n).padStart(2, '0');
  }
  return null;
}
const santeArrondi1 = x => Math.round(x * 10) / 10;

async function ensureSanteMensuelTables(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sante_mensuel_mois (mois TEXT PRIMARY KEY, statut TEXT NOT NULL, version INTEGER NOT NULL, poids_json TEXT, regles_version TEXT, calcule_le TEXT, calcule_par TEXT, valide_le TEXT, valide_par TEXT, revise_le TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sante_mensuel (mois TEXT NOT NULL, version INTEGER NOT NULL, magasin_code TEXT NOT NULL, magasin_libelle TEXT, animateur TEXT, score INTEGER, couverture REAL, sous_scores_json TEXT, exclusions_json TEXT, neutralisations_json TEXT, entrees_json TEXT, created_at TEXT, PRIMARY KEY (mois, version, magasin_code))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sante_mensuel_neutralisations (id INTEGER PRIMARY KEY AUTOINCREMENT, mois TEXT NOT NULL, magasin_code TEXT NOT NULL, dimension TEXT NOT NULL, motif TEXT, statut TEXT NOT NULL, origine TEXT, propose_par TEXT, propose_le TEXT, decide_par TEXT, decide_le TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sante_mensuel_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, mois TEXT NOT NULL, magasin_code TEXT, action TEXT NOT NULL, detail TEXT, motif TEXT, auteur TEXT, le TEXT)`),
  ]);
}

async function santeJournal(env, mois, action, { magasin = null, detail = null, motif = null, auteur = null } = {}) {
  await env.DB.prepare(`INSERT INTO sante_mensuel_journal (mois, magasin_code, action, detail, motif, auteur, le) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(mois, magasin, action, detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null, motif, auteur, new Date().toISOString()).run();
}

// Collecte des données du mois et calcul des 10 sous-scores bruts (avant
// neutralisation). Une requête groupée par source, jamais une par magasin.
async function collecterSanteMensuel(env, mois, stores, figes, opts = {}) {
  const debut = mois + '-01';
  const fin = santeFinMois(mois);
  const q = async (sql, ...b) => { const { results } = await env.DB.prepare(sql).bind(...b).all(); return results || []; };
  const qSur = async (sql, ...b) => { try { return await q(sql, ...b); } catch (e) { console.error('santé mensuelle, source indisponible :', e); return []; } };
  const qRh = (nom, sql, ...b) => lectureRhEnCache(env, nom, sql, b).catch(e => { console.error('santé mensuelle, RH :', e); return []; });

  const [bilans, notes, rhRows, rhElig, entretiens, lancements, kaizens, ratings, pedlvRows] = await Promise.all([
    qSur(`SELECT id, magasin_code, date, ca_annuel, data_json FROM (
            SELECT id, magasin_code, date, ca_annuel, data_json, ROW_NUMBER() OVER (PARTITION BY magasin_code ORDER BY date DESC, id DESC) AS rn
            FROM bilans WHERE date >= ? AND date <= ?) WHERE rn = 1`, debut, fin),
    qSur(`SELECT magasin_code, tache, note FROM notes_equipe WHERE annee = ? AND date_controle <= ?`, Number(mois.slice(0, 4)), fin),
    qRh('mensuel-absences', `SELECT es.mois AS mois, es.code_site AS code_site, SUM(es.poids) AS eff_total,
            SUM(CASE WHEN a.longue_duree = 1 THEN es.poids ELSE 0 END) AS eff_ld,
            SUM(a.jours_groupe_a * es.poids) AS ga, SUM(a.jours_ouvres_theoriques * es.poids) AS th
          FROM rh_effectif_site_mensuel es JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
          WHERE es.site_reconnu = 1 AND es.mois >= ? AND es.mois <= ? GROUP BY es.mois, es.code_site`, santeMoisDecale(mois, -6), mois),
    qRh('mensuel-eligibles', `SELECT es.mois AS mois, es.code_site AS code_site, es.matricule AS matricule, em.poste AS poste, em.prenom AS prenom, em.nom AS nom, a.longue_duree AS longue_duree
          FROM rh_effectif_site_mensuel es JOIN rh_effectif_mensuel em ON em.mois = es.mois AND em.matricule = es.matricule
          LEFT JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
          WHERE es.site_reconnu = 1
          AND es.mois = (SELECT MAX(mois) FROM rh_effectif_site_mensuel WHERE mois <= ?)`, mois),
    qSur(`SELECT DISTINCT magasin_code, collaborateur_matricule FROM entretiens_manager
          WHERE date >= ? AND date <= ? AND type IN (${TYPES_ENTRETIENS_COMPTES.map(() => '?').join(',')}) AND collaborateur_matricule IS NOT NULL`,
      debut, fin, ...TYPES_ENTRETIENS_COMPTES),
    qSur(`SELECT magasin_code, COUNT(DISTINCT date) AS jours FROM lancements_journee WHERE date >= ? AND date <= ? GROUP BY magasin_code`, debut, fin),
    qSur(`SELECT magasin_code, score, score_max, closed FROM kaizen_audits WHERE mois = ?`, mois),
    qSur(`SELECT magasin_code, rating, reviews_count, updated_at FROM google_ratings`),
    // PEDLV : tous les envois sont conservés dans store_stats ; dernier envoi dont la période = M.
    qSur(`SELECT id, magasin, code_magasin, periode, date_extraction, indicateurs_json, created_at FROM store_stats
          WHERE created_at IS NULL OR created_at >= ? ORDER BY id ASC`, santeMoisDecale(mois, -1) + '-01'),
  ]);
  const pedlvParCode = {};
  for (const r of pedlvRows) {
    if (!r.code_magasin || santePeriodePedlvVersMois(r.periode) !== mois) continue;
    pedlvParCode[r.code_magasin] = r; // ordre croissant : le dernier gagne
  }

  const bilanParCode = {}; bilans.forEach(r => { bilanParCode[r.magasin_code] = r; });
  const notesParCode = {};
  notes.forEach(n => { ((notesParCode[n.magasin_code] ??= {})[n.tache] ??= []).push(n.note); });
  const rh = {};
  rhRows.forEach(r => { (rh[r.code_site] ??= {})[r.mois] = { effectifDispo: (r.eff_total || 0) - (r.eff_ld || 0), effectifTotal: r.eff_total || 0, taux: r.th > 0 ? r.ga / r.th : null }; });
  const rhMoisEligibles = rhElig.length ? rhElig[0].mois : null;
  const rhImportPresent = rhRows.some(r => r.mois === mois);
  const motifRhAbsent = rhImportPresent ? 'Aucun salarié rattaché à ce magasin dans l\'import RH du mois' : 'Import RH du mois absent';
  const eligibles = rhEligiblesParMagasin(rhElig, stores);
  const absBilan = await getAbsencesLdBilans(env, mois);
  const vus = {}; entretiens.forEach(r => { (vus[r.magasin_code] ??= new Set()).add(r.collaborateur_matricule); });
  const lancParCode = {}; lancements.forEach(r => { lancParCode[r.magasin_code] = r.jours; });
  const kaizenParCode = {}; kaizens.forEach(r => { kaizenParCode[r.magasin_code] = r; });
  const ratingParCode = {}; ratings.forEach(r => { ratingParCode[r.magasin_code] = r; });
  const cal = await calendrierMagasins(env, stores);
  const finMs = Date.parse(fin + 'T23:59:59Z');

  return stores.map(store => {
    const code = store.code;
    const fige = (figes && figes[code]) || null;
    const sous = {}; const exclusions = {}; const entrees = {}; const propositions = [];

    const b = bilanParCode[code];
    if (b) {
      let data = {}; try { data = JSON.parse(b.data_json || '{}'); } catch (e) {}
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const reportees = actions.filter(a => a && a._fromPrevious);
      const penalite = reportees.reduce((acc, a) => acc + (a._status === 'todo' ? 25 : 15), 0);
      sous.actions = Math.max(0, 100 - penalite);
      const pos = toNumOrNull(b.ca_annuel);
      sous.positionnement = pos === null ? 0 : Math.max(0, Math.min(100, pos));
      entrees.bilan = { id: b.id, date: b.date, actionsReportees: reportees.length, actionsAFaire: reportees.filter(a => a._status === 'todo').length, positionnementAnnuel: pos };
    } else {
      sous.actions = 0; sous.positionnement = 0;
      entrees.bilan = null;
      propositions.push({ dimension: 'actions', motif: 'Aucun bilan de passage dans le mois' });
      propositions.push({ dimension: 'positionnement', motif: 'Aucun bilan de passage dans le mois' });
    }

    const taches = notesParCode[code];
    if (taches) {
      const moyennes = Object.values(taches).map(arr => { const t = [...arr].sort((x, y) => y - x).slice(0, 3); return t.reduce((s, n) => s + n, 0) / t.length; });
      const niveau = santeArrondi1(moyennes.reduce((s, m) => s + m, 0) / moyennes.length);
      sous.equipe = Math.max(0, Math.min(100, (niveau / 10) * 100));
      entrees.equipe = { niveau, nbTaches: moyennes.length };
    } else { sous.equipe = 0; entrees.equipe = null; }

    const effTheo = fige && fige.effTheo !== undefined ? fige.effTheo : store.effTheo;
    entrees.effTheo = effTheo;
    const rhM = rh[code] && rh[code][mois];
    let moisRhRef = rhM ? mois : null;
    if (!rhM && opts.apercu) {
      const moisRh = Object.keys(rh[code] || {}).filter(m => m <= mois).sort();
      moisRhRef = moisRh.length ? moisRh[moisRh.length - 1] : null;
    }
    const rRef = moisRhRef ? rh[code][moisRhRef] : null;
    const indicatif = !!(rRef && moisRhRef !== mois);
    entrees.rh = moisRhRef ? { mois: moisRhRef, indicatif } : null;

    if (rRef && rRef.taux !== null) {
      sous.absenteisme = santeArrondi1(Math.max(0, 100 - rRef.taux * 100));
      entrees.absenteisme = { tauxPct: santeArrondi1(rRef.taux * 100), rhMois: moisRhRef, indicatif };
    } else if (rRef) { sous.absenteisme = null; exclusions.absenteisme = 'Jours ouvrés théoriques nuls'; }
    else { sous.absenteisme = null; exclusions.absenteisme = opts.apercu ? 'Aucun import RH disponible' : motifRhAbsent; }

    let effBilan = null;
    if (b) { try { const mg = (JSON.parse(b.data_json || '{}').magasin) || {}; const o = toNumOrNull(mg.eff_opt), a = toNumOrNull(mg.eff_audio); if (o !== null && a !== null) effBilan = o + a; } catch (e) {} }
    if (effTheo === null || effTheo === undefined) { sous.effectif = null; exclusions.effectif = 'Effectif théorique non renseigné'; }
    else if (effBilan === null && !rRef) { sous.effectif = null; exclusions.effectif = opts.apercu ? 'Ni bilan du mois ni import RH disponible' : 'Ni effectif saisi dans un bilan du mois, ni ' + motifRhAbsent.charAt(0).toLowerCase() + motifRhAbsent.slice(1); }
    else {
      const base = effBilan !== null ? effBilan : rRef.effectifDispo;
      const delta = santeArrondi1(base - effTheo);
      let score = delta <= 0 ? 100 : Math.max(0, 100 - delta * 25);
      let soutenu = false, ecartMoyen = null;
      if (rRef) {
        const r1 = rh[code][santeMoisDecale(moisRhRef, -1)], r2 = rh[code][santeMoisDecale(moisRhRef, -2)];
        if (r1 && r2) {
          const ecarts = [r2, r1, rRef].map(x => x.effectifDispo - effTheo);
          if (ecarts.every(e => e < 0)) { soutenu = true; ecartMoyen = santeArrondi1(ecarts.reduce((s, e) => s + e, 0) / 3); score = Math.min(score, Math.max(0, 100 + ecartMoyen * 25)); }
        }
      }
      sous.effectif = score;
      entrees.effectif = { effectif: santeArrondi1(base), delta, sousEffectifSoutenu: soutenu, ecartMoyen3Mois: ecartMoyen,
        source: effBilan !== null ? 'bilan' : 'rh', bilanDate: effBilan !== null ? b.date : null, rhMois: effBilan !== null ? null : moisRhRef,
        indicatif: effBilan === null && indicatif };
    }

    const p = pedlvParCode[code];
    const resume = p ? computePedlvSummary({ ...p, indicateurs: (() => { try { return JSON.parse(p.indicateurs_json || '{}'); } catch (e) { return {}; } })() }) : null;
    if (resume && resume.total) {
      sous.pedlv = Math.max(0, 100 - (resume.rouge / resume.total) * 100);
      entrees.pedlv = { envoiId: p.id, envoyeLe: p.created_at, periode: p.periode, dateExtraction: p.date_extraction, rouges: resume.rouge, total: resume.total };
    } else { sous.pedlv = 0; entrees.pedlv = null; }

    const avis = fige && fige.avis !== undefined ? fige.avis : (ratingParCode[code] ? { rating: ratingParCode[code].rating, reviews: ratingParCode[code].reviews_count, majLe: ratingParCode[code].updated_at } : null);
    entrees.avis = avis;
    if (avis && avis.rating) {
      sous.avis = Math.max(0, Math.min(100, (Number(avis.rating) / 5) * 100));
      const maj = avis.majLe ? Date.parse(String(avis.majLe).includes('T') ? avis.majLe : String(avis.majLe).replace(' ', 'T') + 'Z') : NaN;
      if (!isNaN(maj) && (finMs - maj) / 86400000 > SANTE_AVIS_PERIME_JOURS) propositions.push({ dimension: 'avis', motif: 'Note Google non rafraîchie depuis plus de ' + SANTE_AVIS_PERIME_JOURS + ' jours' });
    } else { sous.avis = null; exclusions.avis = 'Pas de note Google disponible'; }

    const k = kaizenParCode[code];
    if (k && k.score_max) { sous.kaizen = Math.max(0, Math.min(100, (k.score / k.score_max) * 100)); entrees.kaizen = { score: k.score, scoreMax: k.score_max, cloture: !!k.closed }; }
    else { sous.kaizen = 0; entrees.kaizen = null; }
    if (!store.concept) propositions.push({ dimension: 'kaizen', motif: 'Magasin non éligible Kaizen (concept non renseigné)' });

    if (!rhMoisEligibles) { sous.entretiens = null; exclusions.entretiens = 'Aucun import RH disponible'; }
    else {
      const eg = eligibles[code];
      const elig = eg ? eg.eligibles : new Set();
      const att = entretiensAttendus(eg, absBilan[code]);
      if (!elig.size) { sous.entretiens = null; exclusions.entretiens = 'Aucun collaborateur éligible (RH ' + rhMoisEligibles + ')'; }
      else if (!att.attendus) { sous.entretiens = null; exclusions.entretiens = 'Tout l\'effectif est en absence longue durée (' + att.absLd + ')'; }
      else {
        const v = vus[code] || new Set(); let n = 0; elig.forEach(m => { if (v.has(m)) n++; });
        n = Math.min(n, att.attendus);
        sous.entretiens = Math.round((n / att.attendus) * 100);
        entrees.entretiens = { eligibles: att.attendus, effectifHorsManager: att.effectif, absencesLongueDuree: att.absLd, sourceAbsences: att.source, vus: n, rhMois: rhMoisEligibles };
      }
    }

    const { repos, fermSet } = cal(code);
    const joursOuverts = joursAttendusLancementInter(mois, repos, fermSet, todayIsoMagasin(store));
    const joursLances = lancParCode[code] || 0;
    sous.lancements = joursOuverts ? Math.min(100, Math.round((joursLances / joursOuverts) * 100)) : 0;
    entrees.lancements = { joursLances, joursOuverts };

    for (const d of SANTE_DIMS) if (typeof sous[d] === 'number') sous[d] = santeArrondi1(sous[d]);
    return { code, libelle: store.libelle, animateur: store.animateur || null, pays: store.pays || null, sous, exclusions, entrees, propositions, figes: { avis, effTheo } };
  });
}

function santeScoreFinal(sous, exclusions, neutralisees, poids) {
  if (neutralisees.has('*')) return { score: null, couverture: 0 };
  let total = 0, possible = 0, totalPoids = 0;
  for (const d of SANTE_DIMS) {
    const p = Number(poids[d]) || 0;
    totalPoids += p;
    if (neutralisees.has(d) || sous[d] === null || sous[d] === undefined || exclusions[d]) continue;
    total += sous[d] * p; possible += p;
  }
  const couverture = totalPoids ? possible / totalPoids : 0;
  if (!possible || couverture < SANTE_SEUIL_COUVERTURE) return { score: null, couverture: santeArrondi1(couverture * 100) };
  return { score: Math.round(total / possible), couverture: santeArrondi1(couverture * 100) };
}

async function santeNeutralisationsAppliquees(env, mois) {
  const { results } = await env.DB.prepare(`SELECT id, magasin_code, dimension, motif, origine, propose_par, decide_par, decide_le FROM sante_mensuel_neutralisations WHERE mois = ? AND statut = 'appliquee'`).bind(mois).all();
  const map = {};
  (results || []).forEach(r => { (map[r.magasin_code] ??= {})[r.dimension] = { id: r.id, motif: r.motif, origine: r.origine, proposePar: r.propose_par, par: r.decide_par, le: r.decide_le }; });
  return map;
}

async function santeEcrireVersion(env, mois, lignes, poids, auteur) {
  const etat = await env.DB.prepare(`SELECT * FROM sante_mensuel_mois WHERE mois = ?`).bind(mois).first();
  const version = etat ? etat.version + 1 : 1;
  const neutra = await santeNeutralisationsAppliquees(env, mois);
  const now = new Date().toISOString();
  const stmts = lignes.map(l => {
    const n = neutra[l.code] || {};
    const { score, couverture } = santeScoreFinal(l.sous, l.exclusions, new Set(Object.keys(n)), poids);
    return env.DB.prepare(`INSERT INTO sante_mensuel (mois, version, magasin_code, magasin_libelle, animateur, score, couverture, sous_scores_json, exclusions_json, neutralisations_json, entrees_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(mois, version, l.code, l.libelle, l.animateur, score, couverture, JSON.stringify(l.sous), JSON.stringify(l.exclusions || {}), JSON.stringify(n), JSON.stringify({ ...l.entrees, _figes: l.figes, _pays: l.pays || null }), now);
  });
  if (etat) {
    stmts.push(env.DB.prepare(`UPDATE sante_mensuel_mois SET version = ?, calcule_le = ?, calcule_par = ?, revise_le = CASE WHEN statut = 'valide' THEN ? ELSE revise_le END WHERE mois = ?`).bind(version, now, auteur, now, mois));
  } else {
    stmts.push(env.DB.prepare(`INSERT INTO sante_mensuel_mois (mois, statut, version, poids_json, regles_version, calcule_le, calcule_par) VALUES (?, 'provisoire', ?, ?, ?, ?, ?)`).bind(mois, version, JSON.stringify(poids), SANTE_REGLES_VERSION, now, auteur));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return version;
}

async function santeLignesVersion(env, mois, version) {
  const { results } = await env.DB.prepare(`SELECT * FROM sante_mensuel WHERE mois = ? AND version = ?`).bind(mois, version).all();
  return (results || []).map(r => {
    let entrees = {}; try { entrees = JSON.parse(r.entrees_json || '{}'); } catch (e) {}
    const figes = entrees._figes || null; const pays = entrees._pays || null;
    delete entrees._figes; delete entrees._pays;
    return {
      code: r.magasin_code, libelle: r.magasin_libelle, animateur: r.animateur, pays, score: r.score, couverture: r.couverture,
      sous: JSON.parse(r.sous_scores_json || '{}'), exclusions: JSON.parse(r.exclusions_json || '{}'),
      neutralisations: JSON.parse(r.neutralisations_json || '{}'), entrees, figes,
    };
  });
}

async function calculerSanteMensuel(env, mois, auteur, motif) {
  await ensureSanteMensuelTables(env);
  const etat = await env.DB.prepare(`SELECT * FROM sante_mensuel_mois WHERE mois = ?`).bind(mois).first();
  const stores = (await getMagasinsServerSide()).filter(s => s.code);
  let poids, figes = null;
  if (etat) {
    poids = JSON.parse(etat.poids_json || '{}');
    figes = {};
    (await santeLignesVersion(env, mois, etat.version)).forEach(l => { if (l.figes) figes[l.code] = l.figes; });
  } else {
    poids = await getHealthWeights(env);
  }
  const lignes = await collecterSanteMensuel(env, mois, stores, figes);
  const { results: existantes } = await env.DB.prepare(`SELECT magasin_code, dimension FROM sante_mensuel_neutralisations WHERE mois = ?`).bind(mois).all();
  const deja = new Set((existantes || []).map(r => r.magasin_code + '|' + r.dimension));
  const now = new Date().toISOString();
  const nouvelles = [];
  lignes.forEach(l => l.propositions.forEach(p => {
    if (deja.has(l.code + '|' + p.dimension)) return;
    deja.add(l.code + '|' + p.dimension);
    nouvelles.push(env.DB.prepare(`INSERT INTO sante_mensuel_neutralisations (mois, magasin_code, dimension, motif, statut, origine, propose_par, propose_le) VALUES (?, ?, ?, ?, 'proposee', 'auto', 'Système', ?)`).bind(mois, l.code, p.dimension, p.motif, now));
  }));
  for (let i = 0; i < nouvelles.length; i += 50) await env.DB.batch(nouvelles.slice(i, i + 50));
  const version = await santeEcrireVersion(env, mois, lignes, poids, auteur);
  await santeJournal(env, mois, etat ? (etat.statut === 'valide' ? 'revision_recalcul' : 'recalcul') : 'calcul', { detail: { version, magasins: lignes.length, propositionsAuto: nouvelles.length }, motif: motif || null, auteur });
  return version;
}

async function santeReappliquer(env, mois, auteur) {
  const etat = await env.DB.prepare(`SELECT * FROM sante_mensuel_mois WHERE mois = ?`).bind(mois).first();
  if (!etat) return null;
  const lignes = await santeLignesVersion(env, mois, etat.version);
  return santeEcrireVersion(env, mois, lignes, JSON.parse(etat.poids_json || '{}'), auteur);
}

// Calcul provisoire du mois écoulé, lancé par le cron du 1er (même trigger que
// la clôture Kaizen) uniquement s'il n'existe pas encore. Aucun envoi de mail.
async function calculerSanteMensuelProvisoireCron(env) {
  await ensureSanteMensuelTables(env);
  const mois = santeMoisDecale(parisTodayIso().slice(0, 7), -1);
  const etat = await env.DB.prepare(`SELECT mois FROM sante_mensuel_mois WHERE mois = ?`).bind(mois).first();
  if (etat) return;
  await calculerSanteMensuel(env, mois, 'Calcul automatique (1er du mois)');
}

async function apercuSanteMensuel(env, mois, stores) {
  let tous = null;
  try { tous = (await getMagasinsServerSide()).filter(s => s.code); } catch (e) {}
  if (tous && tous.length) {
    const all = await calculMisEnCache(env, 'sante-mensuel-apercu:' + mois, CACHE_CALC_MS, () => collecterSanteMensuel(env, mois, tous, null, { apercu: true }));
    const parCode = new Map(all.map(l => [l.code, l]));
    if (stores.every(st => parCode.has(st.code))) return stores.map(st => parCode.get(st.code));
  }
  return collecterSanteMensuel(env, mois, stores, null, { apercu: true });
}

async function handleSanteMensuel(request, env, url, corsHeaders) {
  if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
  const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
  if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
  const estAdmin = sessionAr === 'ALL';
  const auteur = estAdmin ? 'Accès réseau complet' : (sessionAr.startsWith('PAYS:') ? 'Direction ' + sessionAr.slice(5).split('|').join(', ') : sessionAr);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  await ensureSanteMensuelTables(env);
  const stores = (await getMagasinsServerSide()).filter(s => s.code);
  const codesScope = await codesDuPerimetre(sessionAr, stores);
  const moisCourant = parisTodayIso().slice(0, 7);
  const moisOk = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '') && m <= moisCourant;

  if (request.method === 'GET') {
    const mois = url.searchParams.get('mois') || santeMoisDecale(moisCourant, -1);
    if (!moisOk(mois)) return jsonError('Mois invalide', 400, corsHeaders);
    const { results: moisCalcules } = await env.DB.prepare(`SELECT mois, statut, version FROM sante_mensuel_mois ORDER BY mois DESC`).all();
    const etat = await env.DB.prepare(`SELECT * FROM sante_mensuel_mois WHERE mois = ?`).bind(mois).first();
    let lignes, apercu = false, poids;
    if (etat) { lignes = await santeLignesVersion(env, mois, etat.version); poids = JSON.parse(etat.poids_json || '{}'); }
    else {
      apercu = true; poids = await getHealthWeights(env);
      const neutra = await santeNeutralisationsAppliquees(env, mois);
      lignes = (await apercuSanteMensuel(env, mois, stores)).map(l => {
        const n = neutra[l.code] || {};
        return { ...l, neutralisations: n, ...santeScoreFinal(l.sous, l.exclusions, new Set(Object.keys(n)), poids) };
      });
    }
    const etatPrec = await env.DB.prepare(`SELECT * FROM sante_mensuel_mois WHERE mois = ?`).bind(santeMoisDecale(mois, -1)).first();
    const prec = {};
    if (etatPrec) (await santeLignesVersion(env, etatPrec.mois, etatPrec.version)).forEach(l => { prec[l.code] = l.score; });
    const { results: props } = await env.DB.prepare(`SELECT * FROM sante_mensuel_neutralisations WHERE mois = ? AND statut = 'proposee' ORDER BY id`).bind(mois).all();
    const parCode = new Map(stores.map(s => [s.code, s]));
    const out = {
      ok: true, mois, apercu, estOlivier: estAdmin, estAdmin, moisCourant,
      statut: etat ? etat.statut : null, version: etat ? etat.version : null,
      calculeLe: etat ? etat.calcule_le : null, calculePar: etat ? etat.calcule_par : null,
      valideLe: etat ? etat.valide_le : null, validePar: etat ? etat.valide_par : null, reviseLe: etat ? etat.revise_le : null,
      reglesVersion: etat ? etat.regles_version : SANTE_REGLES_VERSION, dateLimite: santeDateLimite(mois),
      poids, dims: SANTE_DIMS, dimsArAbsent: SANTE_DIMS_AR_ABSENT,
      moisCalcules: moisCalcules || [],
      magasins: lignes.filter(l => codesScope.has(l.code)).map(l => ({ ...l, pays: l.pays || (parCode.get(l.code) || {}).pays || null, devise: (parCode.get(l.code) || {}).devise || null, scorePrecedent: prec[l.code] ?? null, propositions: undefined, figes: undefined })),
      propositions: (props || []).filter(p => codesScope.has(p.magasin_code)).map(p => ({ ...p, libelle: (parCode.get(p.magasin_code) || {}).libelle || p.magasin_code, animateur: (parCode.get(p.magasin_code) || {}).animateur || null })),
    };
    if (estAdmin && url.searchParams.get('journal') === '1') {
      const { results: j } = await env.DB.prepare(`SELECT * FROM sante_mensuel_journal WHERE mois = ? ORDER BY id`).bind(mois).all();
      const { results: toutes } = await env.DB.prepare(`SELECT * FROM sante_mensuel_neutralisations WHERE mois = ? ORDER BY id`).bind(mois).all();
      out.journal = j || []; out.neutralisationsHistorique = toutes || [];
    }
    return json(out);
  }

  let body; try { body = await request.json(); } catch (e) { return jsonError('Requête invalide', 400, corsHeaders); }
  const { action, mois } = body || {};
  if (!moisOk(mois)) return jsonError('Mois invalide', 400, corsHeaders);
  const etat = await env.DB.prepare(`SELECT * FROM sante_mensuel_mois WHERE mois = ?`).bind(mois).first();
  const valide = etat && etat.statut === 'valide';
  const motifRevision = String(body.motifRevision || '').trim();
  const exigerAdmin = () => estAdmin ? null : jsonError('Action réservée à l\'accès réseau complet', 403, corsHeaders);
  const exigerRevision = () => (valide && !motifRevision) ? jsonError('Mois validé : un motif de révision est obligatoire pour toute modification.', 409, corsHeaders) : null;
  const now = new Date().toISOString();

  if (action === 'calculer') {
    const e = exigerAdmin() || exigerRevision(); if (e) return e;
    if (mois >= moisCourant) return jsonError('Le mois en cours ne peut pas être calculé : il n\'est pas terminé.', 400, corsHeaders);
    const version = await calculerSanteMensuel(env, mois, auteur, motifRevision || null);
    return json({ ok: true, version });
  }

  if (action === 'neutraliser') {
    const motif = String(body.motif || '').trim();
    if (!motif) return jsonError('Motif obligatoire', 400, corsHeaders);
    let codes = Array.isArray(body.magasins) ? body.magasins.map(String) : [];
    let dims = Array.isArray(body.dimensions) ? body.dimensions.filter(d => d === '*' || SANTE_DIMS.includes(d)) : [];
    if (body.arAbsent) {
      codes = stores.filter(s => s.animateur === body.arAbsent).map(s => s.code);
      dims = SANTE_DIMS_AR_ABSENT.slice();
    }
    codes = codes.filter(c => codesScope.has(c));
    if (!codes.length || !dims.length) return jsonError('Aucun magasin ou aucune dimension valide', 400, corsHeaders);
    if (estAdmin) { const e = exigerRevision(); if (e) return e; }
    const statut = estAdmin ? 'appliquee' : 'proposee';
    const stmts = [];
    for (const c of codes) for (const d of dims) {
      stmts.push(env.DB.prepare(`UPDATE sante_mensuel_neutralisations SET statut = 'remplacee', decide_par = ?, decide_le = ? WHERE mois = ? AND magasin_code = ? AND dimension = ? AND statut IN ('proposee', 'appliquee')`).bind(auteur, now, mois, c, d));
      stmts.push(env.DB.prepare(`INSERT INTO sante_mensuel_neutralisations (mois, magasin_code, dimension, motif, statut, origine, propose_par, propose_le, decide_par, decide_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(mois, c, d, motif, statut, estAdmin ? 'admin' : 'ar', auteur, now, estAdmin ? auteur : null, estAdmin ? now : null));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    await santeJournal(env, mois, estAdmin ? (valide ? 'revision_neutralisation' : 'neutralisation') : 'proposition_ar', { magasin: codes.length === 1 ? codes[0] : null, detail: { magasins: codes, dimensions: dims, arAbsent: body.arAbsent || null }, motif: motifRevision ? motif + ' — révision : ' + motifRevision : motif, auteur });
    const version = (estAdmin && etat) ? await santeReappliquer(env, mois, auteur) : null;
    return json({ ok: true, statut, version });
  }

  if (action === 'decider' || action === 'retirer') {
    const e = exigerAdmin() || exigerRevision(); if (e) return e;
    const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(Number).filter(Boolean);
    if (!ids.length) return jsonError('Aucune neutralisation indiquée', 400, corsHeaders);
    const nouveauStatut = action === 'retirer' ? 'retiree' : (body.accepter ? 'appliquee' : 'refusee');
    const statutAttendu = action === 'retirer' ? 'appliquee' : 'proposee';
    const stmts = ids.map(id => env.DB.prepare(`UPDATE sante_mensuel_neutralisations SET statut = ?, decide_par = ?, decide_le = ? WHERE id = ? AND mois = ? AND statut = ?`).bind(nouveauStatut, auteur, now, id, mois, statutAttendu));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    await santeJournal(env, mois, (valide ? 'revision_' : '') + (action === 'retirer' ? 'retrait_neutralisation' : (body.accepter ? 'proposition_acceptee' : 'proposition_refusee')), { detail: { ids }, motif: motifRevision || null, auteur });
    const version = (etat && nouveauStatut !== 'refusee') ? await santeReappliquer(env, mois, auteur) : null;
    return json({ ok: true, version });
  }

  if (action === 'supprimer') {
    const e = exigerAdmin(); if (e) return e;
    if (!etat) return jsonError('Ce mois n\'est pas calculé.', 400, corsHeaders);
    if (valide) return jsonError('Un mois validé ne peut pas être supprimé.', 409, corsHeaders);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sante_mensuel WHERE mois = ?`).bind(mois),
      env.DB.prepare(`DELETE FROM sante_mensuel_neutralisations WHERE mois = ?`).bind(mois),
      env.DB.prepare(`DELETE FROM sante_mensuel_mois WHERE mois = ?`).bind(mois),
    ]);
    await santeJournal(env, mois, 'suppression', { detail: { versionSupprimee: etat.version }, auteur });
    return json({ ok: true });
  }

  if (action === 'valider') {
    const e = exigerAdmin(); if (e) return e;
    if (!etat) return jsonError('Mois non calculé : lance d\'abord le calcul.', 400, corsHeaders);
    if (valide) return jsonError('Mois déjà validé.', 409, corsHeaders);
    const { results: enAttente } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sante_mensuel_neutralisations WHERE mois = ? AND statut = 'proposee'`).bind(mois).all();
    if (enAttente[0].n > 0) return jsonError(enAttente[0].n + ' proposition(s) de neutralisation en attente : accepte-les ou refuse-les avant de valider.', 409, corsHeaders);
    let nRh = 0;
    try { const { results: rhCount } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rh_agenda_mensuel WHERE mois = ?`).bind(mois).all(); nRh = rhCount[0].n; } catch (e2) {}
    const motifSansRh = String(body.motifSansRh || '').trim();
    if (!nRh && !motifSansRh) return jsonError('RH_ABSENT', 409, corsHeaders);
    await env.DB.prepare(`UPDATE sante_mensuel_mois SET statut = 'valide', valide_le = ?, valide_par = ? WHERE mois = ?`).bind(now, auteur, mois).run();
    await santeJournal(env, mois, 'validation', { detail: { version: etat.version }, motif: motifSansRh ? 'Validé sans import RH : ' + motifSansRh : null, auteur });
    return json({ ok: true });
  }

  return jsonError('Action inconnue', 400, corsHeaders);
}

// ============================================================================
// Onglet « Aujourd'hui » du dashboard (reprise France 03/10)
// ============================================================================
// Le jour consulté est un jour civil ; chaque horodatage est ramené au jour et à
// l'heure LOCAUX du magasin (fuseau_horaire). Lancement attendu chaque jour
// ouvré du pays (hors jours de repos et fermetures), « manquant » après l'heure
// butoir locale. PEDLV : dernier envoi connu (store_stats.created_at).
const LANCEMENT_HEURE_BUTOIR = '11:30';
function activiteParseTs(ts) {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}
function activiteDate(ts, fz) { const d = activiteParseTs(ts); return d ? dateLocaleIso(d, fz) : null; }
function activiteHeure(ts, fz) { const d = activiteParseTs(ts); return d ? heureLocale(d, fz) : null; }
async function activiteQuery(env, sqls, binds) {
  for (const sql of sqls) {
    try {
      const { results } = await env.DB.prepare(sql).bind(...binds).all();
      return results || [];
    } catch (e) { /* variante suivante */ }
  }
  console.error('activite-jour : source indisponible —', sqls[sqls.length - 1]);
  return [];
}
async function buildActiviteJour(env, scope, jour) {
  const today = parisTodayIso();
  const veille = ajouterJoursIso(jour, -1);
  const lendemain = ajouterJoursIso(jour, 1);
  const [y, m, d] = jour.split('-').map(Number);
  const jourNonPadde = y + '-' + m + '-' + d; // format date_key d'Observations Terrain
  const mois = jour.slice(0, 7);

  const byCode = new Map(scope.map(s => [s.code, s]));
  const byNom = new Map(scope.map(s => [normalizeName(s.libelle), s]));

  const [bilans, lancements, entretiens, notes, observations, kaizens, pedlvs, derniersBilans, dernieresEvals] = await memoD1('activite:' + jour, MEMO_ACTIVITE_MS, () => Promise.all([
    activiteQuery(env, ['SELECT magasin_code, magasin_libelle, ar, date, created_at FROM bilans WHERE date = ? OR created_at >= ?', 'SELECT magasin_code, ar, date FROM bilans WHERE date = ?'], [jour, veille]),
    activiteQuery(env, [
      'SELECT magasin_code, rempli_par, date, created_at, reunion_id FROM lancements_journee WHERE date = ?',
      'SELECT magasin_code, rempli_par, date, created_at FROM lancements_journee WHERE date = ?',
      'SELECT magasin_code, rempli_par, date FROM lancements_journee WHERE date = ?',
    ], [jour]),
    activiteQuery(env, [
      'SELECT type, magasin_code, collaborateur_nom, rempli_par, date, created_at FROM entretiens_manager WHERE date = ?',
      'SELECT type, magasin_code, collaborateur_nom, rempli_par, date FROM entretiens_manager WHERE date = ?',
    ], [jour]),
    activiteQuery(env, [
      'SELECT magasin_code, tache, ar_nom, date_controle, created_at FROM notes_equipe WHERE date_controle = ?',
      'SELECT magasin_code, tache, ar_nom, date_controle FROM notes_equipe WHERE date_controle = ?',
    ], [jour]),
    activiteQuery(env, [
      'SELECT magasin, theme, date_key, created_at FROM observations WHERE date_key IN (?, ?)',
      'SELECT magasin, theme, date_key FROM observations WHERE date_key IN (?, ?)',
    ], [jourNonPadde, jour]),
    activiteQuery(env, ['SELECT magasin_code, items_json, score, score_max FROM kaizen_audits WHERE mois = ?'], [mois]),
    activiteQuery(env, ['SELECT code_magasin, MAX(created_at) AS updated_at FROM store_stats WHERE created_at >= ? AND created_at < ? GROUP BY code_magasin'], [ajouterJoursIso(jour, -60), lendemain + ' 12:00:00']),
    activiteQuery(env, ['SELECT magasin_code, MAX(date) AS d FROM bilans WHERE date <= ? GROUP BY magasin_code'], [jour]),
    activiteQuery(env, ['SELECT magasin_code, MAX(date_controle) AS d FROM notes_equipe WHERE date_controle <= ? GROUP BY magasin_code'], [jour]),
  ]));

  const cal = await calendrierMagasins(env, scope);
  const jourSemaine = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const res = {};
  for (const s of scope) {
    const { repos, fermSet } = cal(s.code);
    const attendu = !repos.includes(jourSemaine) && !fermSet.has(jour);
    const todayLocal = todayIsoMagasin(s);
    const maintenantLocal = heureLocale(new Date(), s.fuseauHoraire);
    const butoirPasse = jour < todayLocal || (jour === todayLocal && maintenantLocal >= LANCEMENT_HEURE_BUTOIR);
    res[s.code] = {
      code: s.code, libelle: s.libelle, animateur: s.animateur || null, pays: s.pays || null, fuseau: fuseauValide(s.fuseauHoraire),
      lancement: { statut: attendu ? (butoirPasse ? 'manquant' : 'attendu') : 'non_attendu', heure: null, par: null },
      bilan: null, pedlv: null, kaizen: null, entretien: null, observation: null, equipe: null,
      bilanJours: null, equipeJours: null,
    };
  }
  const events = [];
  const pushEvent = (store, outil, detail, par, ts, heure) => {
    const dts = activiteParseTs(ts);
    events.push({ ts: dts ? dts.toISOString() : null, heure: heure || null, code: store.code, libelle: store.libelle, animateur: store.animateur || null, pays: store.pays || null, outil, detail: detail || '', par: par || null });
  };

  for (const r of lancements) {
    const s = byCode.get(r.magasin_code); if (!s) continue;
    const L = res[s.code].lancement;
    const heure = activiteHeure(r.created_at, s.fuseauHoraire);
    if (r.reunion_id) {
      L.statut = 'fait'; L.heure = null; L.par = L.par || r.rempli_par || null; L.reunion = true;
      pushEvent(s, 'lancement', 'reunion', r.rempli_par, r.created_at, heure);
      continue;
    }
    if (L.statut !== 'fait' || (heure && L.heure && heure < L.heure)) { if (!L.reunion) { L.statut = 'fait'; L.heure = heure; L.par = r.rempli_par || null; } }
    pushEvent(s, 'lancement', heure && heure > LANCEMENT_HEURE_BUTOIR ? 'en_retard' : '', r.rempli_par, r.created_at, heure);
  }
  for (const code of Object.keys(res)) {
    const L = res[code].lancement;
    L.enRetard = L.statut === 'fait' && !!L.heure && L.heure > LANCEMENT_HEURE_BUTOIR;
  }
  for (const r of bilans) {
    const s = byCode.get(r.magasin_code); if (!s) continue;
    const saisiLe = activiteDate(r.created_at, s.fuseauHoraire);
    if (r.date !== jour && saisiLe !== jour) continue;
    const heure = saisiLe === jour ? activiteHeure(r.created_at, s.fuseauHoraire) : null;
    const B = res[s.code].bilan || (res[s.code].bilan = { nb: 0, heure: null, par: null });
    B.nb++; if (heure && (!B.heure || heure > B.heure)) B.heure = heure; B.par = r.ar || B.par;
    pushEvent(s, 'bilan', r.date !== jour ? r.date : '', r.ar, saisiLe === jour ? r.created_at : null, heure);
  }
  for (const r of entretiens) {
    const s = byCode.get(r.magasin_code); if (!s) continue;
    const heure = activiteHeure(r.created_at, s.fuseauHoraire);
    const E = res[s.code].entretien || (res[s.code].entretien = { nb: 0, heure: null, par: null, types: [] });
    E.nb++; if (heure && (!E.heure || heure > E.heure)) E.heure = heure; E.par = r.rempli_par || E.par;
    if (r.type && !E.types.includes(r.type)) E.types.push(r.type);
    pushEvent(s, 'entretien', r.type, r.rempli_par, r.created_at, heure);
  }
  for (const r of notes) {
    const s = byCode.get(r.magasin_code); if (!s) continue;
    const heure = activiteHeure(r.created_at, s.fuseauHoraire);
    const Q = res[s.code].equipe || (res[s.code].equipe = { nb: 0, heure: null, par: null });
    Q.nb++; if (heure && (!Q.heure || heure > Q.heure)) Q.heure = heure; Q.par = r.ar_nom || Q.par;
    pushEvent(s, 'equipe', r.tache || '', r.ar_nom, r.created_at, heure);
  }
  for (const r of observations) {
    if (!r.magasin || r.magasin === 'Info générale') continue;
    const s = byNom.get(normalizeName(r.magasin)); if (!s) continue;
    const heure = activiteHeure(r.created_at, s.fuseauHoraire);
    const O = res[s.code].observation || (res[s.code].observation = { nb: 0, heure: null });
    O.nb++; if (heure && (!O.heure || heure > O.heure)) O.heure = heure;
    pushEvent(s, 'observation', r.theme || '', null, r.created_at, heure);
  }
  for (const r of kaizens) {
    const s = byCode.get(r.magasin_code); if (!s) continue;
    let items = {};
    try { items = JSON.parse(r.items_json || '{}'); } catch (e) {}
    let nb = 0, dernier = null, par = null;
    for (const it of Object.values(items)) {
      if (!it || !it.checked_at || activiteDate(it.checked_at, s.fuseauHoraire) !== jour) continue;
      nb++;
      if (!dernier || it.checked_at > dernier) { dernier = it.checked_at; par = it.controleur || par; }
    }
    res[s.code].kaizen = { fait: nb > 0, nbItems: nb, heure: activiteHeure(dernier, s.fuseauHoraire), par, score: r.score, scoreMax: r.score_max };
    if (nb > 0) pushEvent(s, 'kaizen', String(nb), par, dernier, activiteHeure(dernier, s.fuseauHoraire));
  }
  const joursEntre = (iso) => Math.round((Date.parse(jour + 'T00:00:00Z') - Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z')) / 86400000);
  for (const r of derniersBilans) { const s = byCode.get(r.magasin_code); if (s && r.d) res[s.code].bilanJours = joursEntre(r.d); }
  for (const r of dernieresEvals) { const s = byCode.get(r.magasin_code); if (s && r.d) res[s.code].equipeJours = joursEntre(r.d); }
  for (const r of pedlvs) {
    const s = byCode.get(r.code_magasin); if (!s || !r.updated_at) continue;
    const dj = activiteDate(r.updated_at, s.fuseauHoraire);
    if (!dj || dj > jour) continue;
    const joursDepuis = joursEntre(dj);
    res[s.code].pedlv = { fait: joursDepuis === 0, heure: joursDepuis === 0 ? activiteHeure(r.updated_at, s.fuseauHoraire) : null, joursDepuis };
    if (joursDepuis === 0) pushEvent(s, 'pedlv', '', null, r.updated_at, activiteHeure(r.updated_at, s.fuseauHoraire));
  }

  events.sort((a, b) => {
    if (a.ts && b.ts) return a.ts < b.ts ? 1 : (a.ts > b.ts ? -1 : 0);
    return a.ts ? -1 : (b.ts ? 1 : 0);
  });
  const maintenant = new Date().toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  return { jour, today, maintenant, butoir: LANCEMENT_HEURE_BUTOIR, magasins: Object.values(res), events: events.slice(0, 400) };
}

export default {
  async fetch(request, env) {
    AR_SESSION_SECRET = env.AR_SESSION_KEY || '';
    if (request.method === 'POST') viderMemoD1();
    const _cheminRequete = new URL(request.url).pathname;
    if (request.method === 'POST' && ROUTES_INVALIDANT_CALCULS.has(_cheminRequete)) await invaliderCalculs(env, _cheminRequete.startsWith('/rh-import'));
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Zimbra-Auth-Token, X-AR-Session, X-Store-Token, X-Notify-Token, X-Accueil-Session',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const GET_ALLOWED = ['/bilans', '/last-actions', '/evaluation/reseau', '/evaluation/magasin', '/evaluation/export-reseau', '/kaizen-etat', '/kaizen-historique', '/kaizen-photo', '/store-health', '/store-health-detail', '/ar-dashboard', '/rh-import/etat', '/ar-checklist', '/google-ratings', '/rh-effectif', '/com-hebdo', '/bilan-get', '/bilan-prefill', '/health-weights', '/accueil-apps', '/accueil-admin', '/fermetures-reseau', '/jours-ouvres', '/pedlv-archives', '/pedlv-archive-get', '/suivis-magasin', '/suivis-collaborateur', '/brouillons', '/brouillon-get', '/reunion-sujets', '/reunion-sujets-admin', '/reunion-get', '/historique-managers', '/collab-stats', '/store-monthly-stats', '/rh-collaborateurs', '/score-magasin', '/sante-mensuel', '/activite-jour'];
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

        // Lot 3 (25/10) : l'appli réessaie et renvoie les bilans en attente →
        // anti-doublon sur l'identifiant unique (uid) posé au premier envoi.
        if (data.uid) {
          const deja = await env.DB.prepare(`SELECT id FROM bilans WHERE magasin_code = ? AND date = ? AND json_extract(data_json, '$.uid') = ? LIMIT 1`).bind(String(magasinCode), data.date, String(data.uid)).first();
          if (deja) return new Response(JSON.stringify({ ok: true, id: deja.id, deja: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
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
          // Lot 4 : statuts vert/orange/rouge recalculés ici avec la grille du
          // pays / de la région du magasin (objectifs_pedlv.csv), pas avec les
          // objectifs réglés dans le navigateur qui a fait l'import.
          const store = await resoudreMagasinPedlv(s.codeMagasin, s.magasin);
          const grille = await grilleObjectifsPour(store);
          s.indicateurs = normaliserIndicateursPedlv(s.indicateurs || {}, grille);
          await ensureStoreStatsColonnes(env);
          const num = v => (v != null && v !== '' && isFinite(Number(v))) ? Number(v) : null;
          await env.DB.prepare(
            `INSERT INTO store_stats (magasin, code_magasin, periode, date_extraction, ca_total, ca_opt, ca_audio, panier_moyen, taux_tc, taux_sop, taux_mdc, protheses_vendues, taux_essai, objectif, raf, prios_json, taux_test_auditif, taux_vente_add_audio, taux_pack_confort, pm_pack_confort, indicateurs_json, nb_vente_opt,
               jours_ouvres_mois, positionnement, pm_paire1, taux_lukkas, pm_prothese, pm_vente_audio, taux_assur_audio, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
          ).bind(
            s.magasin, (store && store.code) || s.codeMagasin || null, s.periode || null, s.dateExtraction || null,
            s.caTotal ?? null, s.caOpt ?? null, s.caAudio ?? null, s.panierMoyen ?? null,
            s.tauxTc ?? null, s.tauxSop ?? null, s.tauxMdc ?? null,
            s.prothesesVendues ?? null, s.tauxEssai ?? null, s.objectif ?? null, s.raf ?? null,
            JSON.stringify(s.prios || []),
            s.tauxTestAuditif ?? null, s.tauxVenteAddAudio ?? null,
            s.tauxPackConfort ?? null, s.pmPackConfort ?? null,
            JSON.stringify(s.indicateurs || {}), s.nbVenteOpt ?? null,
            num(s.joursOuvresMois), num(s.positionnement), num(s.pmPaire1), num(s.tauxLukkas), num(s.pmProthese), num(s.pmVenteAudio), num(s.tauxAssurAudio)
          ).run();
          return new Response(JSON.stringify({ ok: true, code: store ? store.code : null }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
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
        // Lot 7 (reprise France 14/09) — mode « visite de contrôle » : un animateur,
        // un directeur pays ou l'accès complet authentifié (session /ar-login) qui
        // coche/décoche un item le verrouille ; le magasin ne peut plus le modifier
        // tant qu'il n'est pas déverrouillé (/kaizen-lock) ou que le mois change.
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        const nomAr = sessionAr === 'ALL' ? 'Accès réseau complet' : (sessionAr && sessionAr.startsWith('PAYS:') ? 'Direction ' + sessionAr.slice(5).split('|').join(', ') : sessionAr);

        try {
          const stores = await getMagasinsServerSide();
          const store = stores.find(s => s.code === magasin_code);
          if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
          if (sessionAr && !(await codesDuPerimetre(sessionAr, stores)).has(magasin_code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);

          const existing = await env.DB.prepare(
            `SELECT * FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`
          ).bind(magasin_code, mois).first();

          if (existing && existing.closed) {
            return jsonError('Cet audit est clôturé, il ne peut plus être modifié', 409, corsHeaders);
          }

          const itemsState = existing ? JSON.parse(existing.items_json) : {};
          const currentItem = itemsState[item_id];
          if (currentItem && currentItem.locked && !sessionAr) {
            const parDepuis = currentItem.locked_by ? `par ${currentItem.locked_by} ` : '';
            const depuisLe = currentItem.locked_at ? `le ${currentItem.locked_at.slice(0, 10)} ` : '';
            return jsonError(`Cet item a été verrouillé ${parDepuis}${depuisLe}lors d'une visite de contrôle — seul un animateur réseau authentifié peut le déverrouiller.`, 423, corsHeaders);
          }
          const now = new Date().toISOString();
          itemsState[item_id] = {
            checked: !!checked,
            controleur: nomAr || controleur,
            checked_at: now,
            locked: !!sessionAr,
            locked_by: nomAr || null,
            locked_at: sessionAr ? now : null,
          };

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

          return new Response(JSON.stringify({ ok: true, score, score_max: scoreMax, locked: !!sessionAr }), {
            status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        } catch (e) {
          return jsonError('Erreur sauvegarde audit Kaizen : ' + String(e), 500, corsHeaders);
        }
      }

      // Déverrouillage (ou verrouillage) d'un item sans toucher à son état —
      // réservé à une session authentifiée couvrant le magasin.
      if (url.pathname === '/kaizen-lock') {
        { const acces = await accesOutilOuSession(request, env, ['KAIZEN_STORE_TOKEN']); if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur réseau requise pour verrouiller/déverrouiller un item', 401, corsHeaders);
        const { magasin_code, mois, item_id, locked } = await request.json();
        if (!magasin_code || !mois || !item_id || typeof locked !== 'boolean') {
          return jsonError('Payload invalide : magasin_code, mois, item_id et locked (booléen) requis', 400, corsHeaders);
        }
        try {
          const stores = await getMagasinsServerSide();
          if (!(await codesDuPerimetre(sessionAr, stores)).has(magasin_code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
          const existing = await env.DB.prepare(`SELECT * FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`).bind(magasin_code, mois).first();
          if (!existing) return jsonError('Aucun audit trouvé pour ce magasin/mois', 404, corsHeaders);
          if (existing.closed) return jsonError('Cet audit est clôturé, il ne peut plus être modifié', 409, corsHeaders);
          const itemsState = JSON.parse(existing.items_json);
          if (!itemsState[item_id]) return jsonError('Aucun contrôle existant pour cet item', 404, corsHeaders);
          itemsState[item_id] = { ...itemsState[item_id], locked, locked_by: locked ? (sessionAr === 'ALL' ? 'Accès réseau complet' : (sessionAr.startsWith('PAYS:') ? 'Direction ' + sessionAr.slice(5).split('|').join(', ') : sessionAr)) : null, locked_at: locked ? new Date().toISOString() : null };
          await env.DB.prepare(`UPDATE kaizen_audits SET items_json = ?, updated_at = datetime('now') WHERE id = ?`).bind(JSON.stringify(itemsState), existing.id).run();
          return new Response(JSON.stringify({ ok: true, locked }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur verrouillage item Kaizen : ' + String(e), 500, corsHeaders);
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
      // ======================================================================
      // Lot 6 (25/10/2026) — score de santé et dashboard alignés sur la France
      // ======================================================================

      // ---------- Score de santé : liste des magasins du périmètre ----------
      if (url.pathname === '/store-health') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const stores = await getMagasinsServerSide();
        const codesOk = await codesDuPerimetre(sessionAr, stores);
        let scope = stores.filter(s => codesOk.has(s.code));
        const magasinCode = url.searchParams.get('magasin_code');
        if (magasinCode) {
          scope = scope.filter(s => s.code === magasinCode);
          if (!scope.length) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
        }
        try {
          await ensureHistoSanteColonnes(env);
          const results = await buildStoreHealthResults(env, scope);
          let networkTrend = [];
          if (!magasinCode && scope.length) {
            const codesScope = new Set(scope.map(s => s.code));
            const { results: allRows } = await memoD1('histoScores', MEMO_SANTE_MS, () => env.DB.prepare(
              `SELECT magasin_code, period_key, score FROM store_health_score_history WHERE score IS NOT NULL ORDER BY period_key ASC`
            ).all());
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
          const poids = await getHealthWeights(env);
          return new Response(JSON.stringify({ ok: true, results, networkTrend, poids }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur calcul fiche santé magasins : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Fiche détaillée d'un magasin (dashboard) ----------
      if (url.pathname === '/store-health-detail') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const code = url.searchParams.get('magasin_code');
        if (!code) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);
        const stores = await getMagasinsServerSide();
        const store = stores.find(s => s.code === code);
        if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
        if (!(await codesDuPerimetre(sessionAr, stores)).has(code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);

        try {
          await ensureHistoSanteColonnes(env);
          const [base] = await buildStoreHealthResults(env, [store]);

          const { results: historyRows } = await env.DB.prepare(
            `SELECT ${HISTO_SANTE_COLONNES} FROM store_health_score_history WHERE magasin_code = ? ORDER BY period_key DESC LIMIT 26`
          ).bind(code).all();
          const history = historyRows.reverse().map(r => ({ periode: r.period_key, score: r.score, sousScores: sousScoresHisto(r) }));

          // Positionnement mensuel : valeur envoyée par PEDLV (projection fin de mois).
          const storeStatsMap = await getStoreStatsMap(env);
          const statsRow = storeStatsMap[code] || null;
          const positionnementMensuel = (statsRow && statsRow.positionnement != null) ? Math.round(Number(statsRow.positionnement) * 10) / 10 : null;

          // PEDLV détaillé, avec le nombre de semaines consécutives en rouge.
          const pedlvSummary = computePedlvSummary(statsRow);
          let pedlvIndicateurs = [];
          if (pedlvSummary && pedlvSummary.indicateurs) {
            const { history: ph, periodListe } = await getPedlvHistoSemaines(env);
            pedlvIndicateurs = Object.entries(pedlvSummary.indicateurs).filter(([, v]) => v && v.statut).map(([key, v]) => ({
              cle: key, label: v.label || null, valeur: v.valeur, objectif: v.objectif, statut: v.statut, categorie: v.categorie,
              semainesRouge: v.statut === 'rouge' ? streakIndicateurPedlv(ph, periodListe, code, key) : 0,
            }));
          }

          // Kaizen : points non conformes depuis plusieurs mois.
          let kaizenPointsNonResolus = [];
          try {
            const moisCourant = new Date().toISOString().slice(0, 7);
            const zones = await getKaizenReferentiel();
            const itemsApplicables = kaizenItemsApplicables(zones, store.concept, store.pays);
            const auditRow = await env.DB.prepare(`SELECT items_json FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`).bind(code, moisCourant).first();
            const itemsStateThisMonth = auditRow ? JSON.parse(auditRow.items_json || '{}') : {};
            const { history: kzHistory, moisListe } = await getKaizenItemsHistory(env, moisCourant, 6);
            kaizenPointsNonResolus = computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, kzHistory, moisListe, code, 1);
          } catch (e) { console.error('Points Kaizen non résolus (détail magasin) :', e); }

          // Équipe : tâches, responsables et moyenne des 3 meilleures notes.
          let equipeTaches = [];
          try {
            const annee = anneeCouranteEval();
            const { results: notes } = await env.DB.prepare(`SELECT tache, note FROM notes_equipe WHERE magasin_code = ? AND annee = ?`).bind(code, annee).all();
            const { results: fiches } = await env.DB.prepare(`SELECT tache, responsable FROM responsables_taches WHERE magasin_code = ?`).bind(code).all();
            const notesByTache = {};
            notes.forEach(n => (notesByTache[n.tache] ??= []).push(n.note));
            const tachesSet = new Set([...fiches.map(f => f.tache), ...notes.map(n => n.tache)]);
            equipeTaches = [...tachesSet].map(tache => {
              const noteList = (notesByTache[tache] || []).sort((a, b) => b - a).slice(0, 3);
              const moyenne = noteList.length ? Math.round((noteList.reduce((s, n) => s + n, 0) / noteList.length) * 10) / 10 : null;
              const fiche = fiches.find(f => f.tache === tache);
              return { tache, responsable: fiche ? fiche.responsable : null, moyenne };
            });
          } catch (e) { console.error('Tâches équipe (détail magasin) :', e); }

          // Checklist réseau : points réseau sur les 6 derniers bilans qui la portent.
          let checklistReseauPassages = [];
          try {
            const { results: ckRows } = await env.DB.prepare('SELECT date, ar, passage, data_json FROM bilans WHERE magasin_code = ? ORDER BY date DESC, id DESC LIMIT 20').bind(code).all();
            for (const r of ckRows) {
              let dj = {}; try { dj = JSON.parse(r.data_json || '{}'); } catch (e) {}
              const liste = Array.isArray(dj.checklistReseau) ? dj.checklistReseau.filter(it => it && it.id) : [];
              if (!liste.length) continue;
              checklistReseauPassages.push({ date: r.date, ar: r.ar, passage: r.passage, total: liste.length, coches: liste.filter(it => it.coche).length, oublis: liste.filter(it => !it.coche).map(it => it.texte || it.id) });
              if (checklistReseauPassages.length >= 6) break;
            }
          } catch (e) { checklistReseauPassages = []; }

          const caPrevisionnelAnnuel = (store.objectifAnnuel !== null && store.objectifAnnuel !== undefined && base.positionnementAnnuel !== null && base.positionnementAnnuel !== undefined)
            ? Math.round(store.objectifAnnuel * base.positionnementAnnuel) / 100 : null;

          // Suivis posés en entretien (Suivi Managers) : ouverts + clôturés depuis 30 jours.
          let suivisManager = { today: todayIsoMagasin(store), ouverts: [], clotures: [] };
          try {
            await ensureReunionTables(env);
            const { results: svRows } = await env.DB.prepare(
              `SELECT s.id, s.collaborateur_nom, s.type_entretien, s.libelle, s.echeance, s.statut,
                      s.created_at, s.cloture_par, s.cloture_le, e.rempli_par, e.date AS entretien_date
               FROM suivis_entretien s LEFT JOIN entretiens_manager e ON e.id = s.entretien_id
               WHERE s.magasin_code = ? AND (s.statut = 'ouvert' OR s.cloture_le >= datetime('now', '-30 days'))
               ORDER BY s.echeance ASC, s.id ASC LIMIT 150`
            ).bind(code).all();
            svRows.forEach(r => {
              const item = { id: r.id, collaborateur: r.collaborateur_nom || null, type: r.type_entretien, libelle: r.libelle,
                echeance: r.echeance, posePar: r.rempli_par || null, poseLe: r.entretien_date || (r.created_at ? String(r.created_at).slice(0, 10) : null) };
              if (r.statut === 'ouvert') suivisManager.ouverts.push(item);
              else suivisManager.clotures.push({ ...item, statut: r.statut, cloturePar: r.cloture_par || null, clotureLe: r.cloture_le ? String(r.cloture_le).slice(0, 10) : null });
            });
            suivisManager.clotures.sort((a, b) => String(b.clotureLe || '').localeCompare(String(a.clotureLe || '')));
          } catch (e) { console.error('Suivis manager (détail magasin) :', e); }

          return new Response(JSON.stringify({
            ok: true,
            magasin: { code: store.code, libelle: store.libelle, animateur: store.animateur, concept: store.concept, pays: store.pays, devise: store.devise, langue: store.langue },
            ...base,
            positionnementMensuel, objectifAnnuel: store.objectifAnnuel ?? null, caPrevisionnelAnnuel,
            history, pedlvIndicateurs, kaizenPointsNonResolus, equipeTaches,
            manager: store.manager || null, checklistReseauPassages, suivisManager, accompagnement: null,
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur détail magasin : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- « Mon dashboard » : agrégat d'un périmètre ----------
      // ar = nom d'animateur, PAYS:A|B (direction pays) ou ALL (réseau complet).
      if (url.pathname === '/ar-dashboard') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const arName = url.searchParams.get('ar') || sessionAr;
        const allStores = await getMagasinsServerSide();
        const scope = magasinsDuPerimetre(arName, allStores);
        if (!scope.length) return jsonError('Aucun magasin trouvé pour ce périmètre', 404, corsHeaders);
        if (sessionAr !== 'ALL') {
          const ok = await codesDuPerimetre(sessionAr, allStores);
          if (!scope.every(s => ok.has(s.code))) return jsonError('Périmètre hors de votre accès', 403, corsHeaders);
        }

        try {
          await ensureHistoSanteColonnes(env);
          const results = await buildStoreHealthResults(env, scope);
          const scopeByCode = new Map(scope.map(s => [s.code, s]));
          const codesScope = new Set(scope.map(s => s.code));
          const { results: allRows } = await memoD1('histoScoresDetail', MEMO_SANTE_MS, () => env.DB.prepare(
            `SELECT magasin_code, ${HISTO_SANTE_COLONNES} FROM store_health_score_history WHERE score IS NOT NULL ORDER BY period_key ASC`
          ).all());
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
              entretiens: avgOf(rows, 'score_entretiens'), lancements: avgOf(rows, 'score_lancements'),
            },
          })).sort((a, b) => a.periode.localeCompare(b.periode)).slice(-26);

          const moyenneListe = vals => { const v = vals.filter(x => x !== null && x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
          const moyennePonderee = pairs => {
            const valides = pairs.filter(([v, p]) => v !== null && v !== undefined && p !== null && p !== undefined && p > 0);
            const totalPoids = valides.reduce((s, [, p]) => s + p, 0);
            if (!totalPoids) return null;
            return Math.round((valides.reduce((s, [v, p]) => s + v * p, 0) / totalPoids) * 10) / 10;
          };
          const scoreMoyen = moyenneListe(results.map(r => r.score));
          // Objectifs annuels en devise locale : pas de total ni de pondération
          // entre pays de devises différentes (moyenne simple dans ce cas).
          const devises = new Set(scope.map(s => s.devise || ''));
          const uneDevise = devises.size === 1;
          const positionnementAnnuelMoyen = uneDevise
            ? (moyennePonderee(results.map(r => [r.positionnementAnnuel, (scopeByCode.get(r.code) || {}).objectifAnnuel])) ?? moyenneListe(results.map(r => r.positionnementAnnuel)))
            : moyenneListe(results.map(r => r.positionnementAnnuel));
          const objectifAnnuelTotal = uneDevise ? scope.reduce((sum, s) => sum + (s.objectifAnnuel || 0), 0) : null;
          const caPrevisionnelTotal = uneDevise ? Math.round(results.reduce((sum, r) => {
            const st = scopeByCode.get(r.code);
            if (st && st.objectifAnnuel !== null && st.objectifAnnuel !== undefined && r.positionnementAnnuel !== null && r.positionnementAnnuel !== undefined) return sum + (st.objectifAnnuel * r.positionnementAnnuel) / 100;
            return sum;
          }, 0)) : null;
          const subKeys = ['actions', 'effectif', 'absenteisme', 'positionnement', 'pedlv', 'avis', 'equipe', 'kaizen', 'entretiens', 'lancements'];
          const subScoresMoyens = {};
          for (const k of subKeys) subScoresMoyens[k] = moyenneListe(results.map(r => r.subScores ? r.subScores[k] : null));

          const actionsAgregees = [];
          for (const r of results) {
            (r.actionsNonSoldees && r.actionsNonSoldees.items || []).filter(a => a.fromPrevious).forEach(a =>
              actionsAgregees.push({ magasin: r.libelle, code: r.code, text: a.text, repriseCount: a.repriseCount, status: a.status, date: a.date, who: a.who }));
          }

          const kaizenAgreges = [];
          try {
            const moisCourant = new Date().toISOString().slice(0, 7);
            const zones = await getKaizenReferentiel();
            const { history: kzHistory, moisListe } = await getKaizenItemsHistory(env, moisCourant, 6);
            for (const st of scope) {
              const itemsApplicables = kaizenItemsApplicables(zones, st.concept, st.pays);
              const itemsStateThisMonth = (kzHistory[st.code] && kzHistory[st.code][moisCourant]) || {};
              computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, kzHistory, moisListe, st.code, 1)
                .forEach(p => kaizenAgreges.push({ magasin: st.libelle, code: st.code, ...p }));
            }
          } catch (e) { console.error('Points Kaizen agrégés (dashboard) :', e); }

          // PEDLV agrégé : moyenne pondérée par le volume (ventes optique / prothèses audio).
          const storeStatsMap = await getStoreStatsMap(env);
          const pedlvAgregatData = {};
          for (const st of scope) {
            const statsRow = storeStatsMap[st.code] || null;
            const summary = computePedlvSummary(statsRow);
            if (!summary || !summary.indicateurs) continue;
            for (const [key, v] of Object.entries(summary.indicateurs)) {
              if (!v || !v.statut) continue;
              const acc = (pedlvAgregatData[key] ??= { valeursPonderees: [], objectifs: [], nbRouge: 0, nbTotal: 0, label: v.label || null, categorie: v.categorie || null });
              const poids = v.categorie === 'audio' ? (statsRow && statsRow.protheses_vendues) : (statsRow && statsRow.nb_vente_opt);
              if (v.valeur !== null && v.valeur !== undefined) acc.valeursPonderees.push([Number(v.valeur), poids ?? 1]);
              if (v.objectif !== null && v.objectif !== undefined) acc.objectifs.push(v.objectif);
              acc.nbTotal++;
              if (v.statut === 'rouge') acc.nbRouge++;
            }
          }
          const modeListe = vals => {
            const v = vals.filter(x => x !== null && x !== undefined);
            if (!v.length) return null;
            const compte = new Map();
            for (const x of v) compte.set(x, (compte.get(x) || 0) + 1);
            let meilleur = v[0], meilleurCompte = 0;
            for (const [val, c] of compte) if (c > meilleurCompte) { meilleur = val; meilleurCompte = c; }
            return meilleur;
          };
          const pedlvIndicateursAgreges = Object.entries(pedlvAgregatData).map(([cle, acc]) => ({
            cle, label: acc.label, categorie: acc.categorie, valeurMoyenne: moyennePonderee(acc.valeursPonderees), objectifMoyen: modeListe(acc.objectifs), nbRouge: acc.nbRouge, nbTotal: acc.nbTotal,
          }));

          const niveauEquipeMoyen = moyennePonderee(results.map(r => [
            r.niveauEquipe !== null && r.niveauEquipe !== undefined ? Number(r.niveauEquipe) : null, (scopeByCode.get(r.code) || {}).effTheo || 1,
          ]));
          let equipeTachesAgregees = [];
          try {
            const annee = anneeCouranteEval();
            const { results: notes } = await env.DB.prepare(`SELECT magasin_code, tache, note FROM notes_equipe WHERE annee = ?`).bind(annee).all();
            const { results: fiches } = await env.DB.prepare(`SELECT magasin_code, tache, responsable FROM responsables_taches`).all();
            const notesByTache = {};
            notes.filter(n => codesScope.has(n.magasin_code)).forEach(n => { ((notesByTache[n.tache] ??= {})[n.magasin_code] ??= []).push(n.note); });
            const fichesByTache = {};
            fiches.filter(f => codesScope.has(f.magasin_code)).forEach(f => { (fichesByTache[f.tache] ??= {})[f.magasin_code] = f.responsable; });
            const tachesSet = new Set([...Object.keys(notesByTache), ...Object.keys(fichesByTache)]);
            equipeTachesAgregees = [...tachesSet].map(tache => {
              const moyennesParMagasin = Object.values(notesByTache[tache] || {}).map(noteList => {
                const top3 = noteList.slice().sort((a, b) => b - a).slice(0, 3);
                return top3.reduce((a, b) => a + b, 0) / top3.length;
              });
              const respMap = fichesByTache[tache] || {};
              const magasinsVacants = scope.filter(s => !respMap[s.code]).map(s => s.libelle);
              return { tache, moyenne: moyenneListe(moyennesParMagasin), nbVacant: magasinsVacants.length, nbTotal: scope.length, magasinsVacants };
            });
          } catch (e) { console.error('Tâches équipe agrégées (dashboard) :', e); }

          const sousEffectifSoutenu = results.filter(r => r.effectifRH && r.effectifRH.soutenu).map(r => r.libelle);
          const sureffectif = results.filter(r => r.effectif && r.effectif.delta !== null && r.effectif.delta !== undefined && r.effectif.delta > 0).map(r => r.libelle);

          // Absentéisme du périmètre pondéré par les personnes (jours-personnes
          // additionnés par mois, puis taux mensuel), lecture RH non filtrée en SQL.
          let tauxAbsenteismeMoyen = null;
          try {
            const absRows = await lectureRhEnCache(env, 'absenteisme-par-site',
              `SELECT es.mois as mois, es.code_site as code_site, SUM(a.jours_groupe_a * es.poids) as ga, SUM(a.jours_ouvres_theoriques * es.poids) as th
               FROM rh_effectif_site_mensuel es JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
               WHERE es.site_reconnu = 1 GROUP BY es.mois, es.code_site`);
            const parMois = {};
            absRows.filter(r => codesScope.has(r.code_site)).forEach(r => { const m = (parMois[r.mois] ??= { ga: 0, th: 0 }); m.ga += r.ga || 0; m.th += r.th || 0; });
            const notesMensuelles = Object.values(parMois).filter(m => m.th > 0).map(m => Math.max(0, 100 - (m.ga / m.th) * 100));
            if (notesMensuelles.length) tauxAbsenteismeMoyen = Math.round((100 - notesMensuelles.reduce((a, b) => a + b, 0) / notesMensuelles.length) * 10) / 10;
          } catch (e) { console.error('Taux absentéisme pondéré (dashboard) :', e); }

          const magasinsEnRetard = results.filter(r => r.overdue).length;
          return new Response(JSON.stringify({
            ok: true, ar: arName, nbMagasins: scope.length, devise: uneDevise ? ([...devises][0] || null) : null,
            scoreMoyen, positionnementAnnuelMoyen, objectifAnnuelTotal, caPrevisionnelTotal, magasinsEnRetard,
            subScoresMoyens, history, results, actionsAgregees, kaizenAgreges,
            pedlvIndicateursAgreges, niveauEquipeMoyen, equipeTachesAgregees, sousEffectifSoutenu, sureffectif, tauxAbsenteismeMoyen,
          }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur dashboard : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Score de santé mensuel « primes » ----------
      if (url.pathname === '/sante-mensuel') {
        try { return await handleSanteMensuel(request, env, url, corsHeaders); }
        catch (e) { return jsonError('Erreur score mensuel : ' + String(e), 500, corsHeaders); }
      }

      // ---------- Onglet « Aujourd'hui » du dashboard ----------
      if (url.pathname === '/activite-jour') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const today = parisTodayIso();
        let jour = url.searchParams.get('jour') || today;
        // Lendemain toléré : il peut déjà être « aujourd'hui » dans un pays à l'est.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(jour) || jour > ajouterJoursIso(today, 1) || jour < ajouterJoursIso(today, -62)) jour = today;
        try {
          const stores = await getMagasinsServerSide();
          const codesOk = await codesDuPerimetre(sessionAr, stores);
          const scope = stores.filter(s => s.code && codesOk.has(s.code));
          const data = await buildActiviteJour(env, scope, jour);
          return new Response(JSON.stringify({ ok: true, ...data }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur activité du jour : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Score de santé du magasin (écran manager de Suivi Managers) ----------
      // Hebdo (même calcul que le dashboard) + mensuel (mois en cours en aperçu,
      // 6 derniers mois calculés tels qu'enregistrés).
      if (url.pathname === '/score-magasin') {
        { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const code = url.searchParams.get('magasin_code');
        if (!code) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);
        const stores = await getMagasinsServerSide();
        const store = stores.find(x => x.code === code);
        if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
        try {
          const poids = await getHealthWeights(env);
          let hebdo = null;
          try {
            await ensureHistoSanteColonnes(env);
            const [base] = await buildStoreHealthResults(env, [store]);
            const sous = healthSubScoresServer(base);
            const score = computeHealthScoreServer(base, sous, poids);
            const pedlvIndic = (base.pedlv && base.pedlv.indicateurs) ? Object.entries(base.pedlv.indicateurs)
              .filter(([, v]) => v && v.statut).map(([cle, v]) => ({ cle, label: v.label || null, valeur: v.valeur, objectif: v.objectif, statut: v.statut })) : [];
            const { results: hist } = await env.DB.prepare(
              `SELECT ${HISTO_SANTE_COLONNES} FROM store_health_score_history WHERE magasin_code = ? ORDER BY period_key DESC LIMIT 26`
            ).bind(code).all();
            hebdo = {
              score, sous,
              details: {
                actions: base.actionsNonSoldees ? {
                  reportees: base.actionsNonSoldees.items.filter(a => a.fromPrevious).length,
                  aFaire: base.actionsNonSoldees.items.filter(a => a.fromPrevious && a.status === 'todo').length,
                  items: base.actionsNonSoldees.items.filter(a => a.fromPrevious).slice(0, 10).map(a => ({ text: a.text, status: a.status, date: a.date, who: a.who })),
                } : null,
                dernierBilan: base.lastVisitDate || null,
                effectif: base.effectif || null, effectifRH: base.effectifRH || null,
                absenteisme: base.absenteisme || null,
                positionnementAnnuel: base.positionnementAnnuel ?? null,
                pedlv: base.pedlv ? { rouge: base.pedlv.rouge, total: base.pedlv.total, indicateurs: pedlvIndic } : null,
                avis: base.googleRating || null,
                equipe: { niveau: base.niveauEquipe ?? null, objectif: base.objectifNiveauEquipe || null },
                kaizen: { moisEnCours: base.kaizenScoreMois ?? null, dernierCloture: base.kaizenDernierMoisCloture || null,
                  dernierScore: base.kaizenDernierScoreCloture ?? null, dernierMax: base.kaizenDernierScoreMax ?? null },
                entretiensLancements: base.entretiensLancements || null,
              },
              historique: (hist || []).reverse().map(r => ({ periode: r.period_key, score: r.score, sous: sousScoresHisto(r) })),
            };
          } catch (e) { console.error('score-magasin (hebdo) :', e); }

          let mensuel = null;
          try {
            await ensureSanteMensuelTables(env);
            const moisCourant = parisTodayIso().slice(0, 7);
            let enCours = null;
            try {
              const neutra = await santeNeutralisationsAppliquees(env, moisCourant);
              const [l] = await apercuSanteMensuel(env, moisCourant, [store]);
              if (l) {
                const n = neutra[code] || {};
                enCours = { mois: moisCourant, poids, sous: l.sous, exclusions: l.exclusions, entrees: l.entrees, neutralisations: n,
                  ...santeScoreFinal(l.sous, l.exclusions, new Set(Object.keys(n)), poids) };
              }
            } catch (e) { console.error('score-magasin (mensuel en cours) :', e); }
            const { results: moisCalc } = await env.DB.prepare(`SELECT mois, statut, version, poids_json FROM sante_mensuel_mois WHERE mois < ? ORDER BY mois DESC LIMIT 6`).bind(moisCourant).all();
            const historique = [];
            for (const m of moisCalc || []) {
              const r = await env.DB.prepare(`SELECT score, couverture, sous_scores_json, exclusions_json, neutralisations_json, entrees_json FROM sante_mensuel WHERE mois = ? AND version = ? AND magasin_code = ?`).bind(m.mois, m.version, code).first();
              if (!r) continue;
              let entrees = {}; try { entrees = JSON.parse(r.entrees_json || '{}'); } catch (e) {}
              delete entrees._figes; delete entrees._pays;
              let poidsMois = {}; try { poidsMois = JSON.parse(m.poids_json || '{}'); } catch (e) {}
              historique.push({ mois: m.mois, statut: m.statut, score: r.score, couverture: r.couverture, poids: poidsMois,
                sous: JSON.parse(r.sous_scores_json || '{}'), exclusions: JSON.parse(r.exclusions_json || '{}'),
                neutralisations: JSON.parse(r.neutralisations_json || '{}'), entrees });
            }
            mensuel = { enCours, historique };
          } catch (e) { console.error('score-magasin (mensuel) :', e); }

          return new Response(JSON.stringify({ ok: true, magasin: { code: store.code, libelle: store.libelle, devise: store.devise || null }, poids, hebdo, mensuel }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur score magasin : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Conseils IA (fiche magasin et « Mon dashboard ») ----------
      // Données recalculées côté serveur, jamais reçues du client. Réponse dans
      // la langue de l'interface du dashboard (fr, en, es, nl).
      if ((url.pathname === '/store-advice' || url.pathname === '/ar-advice') && request.method === 'POST') {
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        if (!env.ANTHROPIC_API_KEY) return jsonError('Clé API Anthropic non configurée sur le Worker', 500, corsHeaders);
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const body = await request.json().catch(() => ({}));
        const LANGUES_IA = { fr: 'français', en: 'English', es: 'español', nl: 'Nederlands', he: 'עברית' };
        const consigneLangue = 'Réponds en ' + (LANGUES_IA[body.langue] || 'français') + '.';
        const allStores = await getMagasinsServerSide();
        const codesOk = await codesDuPerimetre(sessionAr, allStores);
        const moisCourant = new Date().toISOString().slice(0, 7);
        try {
          const zones = await getKaizenReferentiel();
          const { history: kzHistory, moisListe } = await getKaizenItemsHistory(env, moisCourant, 6);
          const stuck = st => computeStuckKaizenItems((kzHistory[st.code] && kzHistory[st.code][moisCourant]) || {}, kaizenItemsApplicables(zones, st.concept, st.pays), kzHistory, moisListe, st.code, 1);
          let system, lignes;
          if (url.pathname === '/store-advice') {
            const store = allStores.find(s => s.code === body.magasin_code);
            if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
            if (!codesOk.has(store.code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
            const [base] = await buildStoreHealthResults(env, [store]);
            const pedlvRouges = base.pedlv && base.pedlv.indicateurs
              ? Object.entries(base.pedlv.indicateurs).filter(([, v]) => v && v.statut === 'rouge').map(([k, v]) => `${v.label || k} (valeur ${v.valeur}, objectif ${v.objectif})`) : [];
            const kz = stuck(store);
            const actions = (base.actionsNonSoldees && base.actionsNonSoldees.items || []).filter(a => a.fromPrevious);
            lignes = [
              `Magasin : ${store.libelle} (${store.code}), pays ${store.pays || '—'}, devise ${store.devise || '—'}, animateur ${store.animateur || store.directeurPays || 'non renseigné'}.`,
              `Score de santé global : ${base.score !== null ? base.score + '/100' : 'pas assez de données'}.`,
              `Dernière visite : ${base.lastVisitDate ? base.lastVisitDate + ' (' + base.daysSinceVisit + ' jours)' : 'jamais'}.`,
              `Sous-scores : ${Object.entries(base.subScores || {}).map(([k, v]) => `${k}=${v !== null ? Math.round(v) : 'N/A'}`).join(', ')}.`,
              actions.length ? `Actions de bilan de passage non soldées depuis plusieurs visites : ${actions.map(a => a.text).join(' ; ')}.` : `Aucune action de bilan de passage en retard.`,
              kz.length ? `Points Kaizen non conformes depuis plusieurs mois : ${kz.map(k => k.label + (k.zoneNom ? ' (' + k.zoneNom + ')' : '')).join(' ; ')}.` : `Pas de point Kaizen non résolu.`,
              pedlvRouges.length ? `Indicateurs Pedlv dans le rouge : ${pedlvRouges.join(' ; ')}.` : `Aucun indicateur Pedlv dans le rouge.`,
              `Effectif vs théorique : ${base.effectif ? base.effectif.label : 'pas de donnée'}${base.effectifRH && base.effectifRH.soutenu ? ' (sous-effectif soutenu depuis 3 mois)' : ''}.`,
              base.niveauEquipe !== null && base.niveauEquipe !== undefined ? `Note équipe : ${base.niveauEquipe}/10.` : `Pas de donnée d'évaluation équipe.`,
            ];
            system = `Tu es un assistant qui aide un animateur réseau (AR) d'Optical Center à préparer sa prochaine visite dans un magasin précis. On te donne un état des lieux structuré du magasin. Produis une liste courte de 3 à 5 actions concrètes et priorisées à mener sur ce point de vente, en commençant par la plus urgente. Reste factuel, base-toi uniquement sur les données fournies (n'invente rien), sois direct et actionnable. Format : liste à puces, une action par ligne. ${consigneLangue}`;
          } else {
            const arName = body.ar || sessionAr;
            const scope = magasinsDuPerimetre(arName, allStores);
            if (!scope.length) return jsonError('Aucun magasin trouvé pour ce périmètre', 404, corsHeaders);
            if (!scope.every(s => codesOk.has(s.code))) return jsonError('Périmètre hors de votre accès', 403, corsHeaders);
            const results = await buildStoreHealthResults(env, scope);
            const kzAgreges = [];
            scope.forEach(st => stuck(st).forEach(p => kzAgreges.push(`${st.libelle} : ${p.label}${p.zoneNom ? ' (' + p.zoneNom + ')' : ''} — ${p.moisConsecutifs} mois`)));
            const actions = [];
            results.forEach(r => (r.actionsNonSoldees && r.actionsNonSoldees.items || []).filter(a => a.fromPrevious).forEach(a => actions.push(`${r.libelle} : ${a.text} (${a.repriseCount + 1} visites)`)));
            const enAlerte = results.filter(r => r.score !== null && r.score < 60).map(r => `${r.libelle} (score ${r.score})`);
            const nomPerimetre = arName === 'ALL' ? 'tout le réseau international' : (arName.startsWith('PAYS:') ? 'pays ' + arName.slice(5).split('|').join(', ') : 'animateur ' + arName);
            lignes = [
              `Périmètre (${nomPerimetre}) : ${scope.length} magasins.`,
              enAlerte.length ? `Magasins en alerte (score bas) : ${enAlerte.join(' ; ')}.` : `Aucun magasin en alerte sur le score global.`,
              actions.length ? `Actions de bilan de passage non soldées depuis plusieurs visites : ${actions.slice(0, 80).join(' ; ')}.` : `Aucune action de bilan de passage en retard sur le périmètre.`,
              kzAgreges.length ? `Points Kaizen non conformes depuis plusieurs mois : ${kzAgreges.slice(0, 80).join(' ; ')}.` : `Pas de point Kaizen non résolu sur le périmètre.`,
            ];
            system = `Tu es un assistant qui aide un responsable réseau d'Optical Center (animateur, directeur pays ou direction internationale) à prioriser sa semaine sur l'ensemble de son périmètre. On te donne un état des lieux structuré. Produis une liste courte de 3 à 5 priorités concrètes pour la semaine, en commençant par la plus urgente, en précisant le magasin concerné pour chaque priorité. Reste factuel, base-toi uniquement sur les données fournies (n'invente rien), sois direct et actionnable. ${consigneLangue}`;
          }
          const r = await appelClaude(env, { system, user: lignes.join('\n'), maxTokens: 900 });
          if (!r.ok) return jsonError('Erreur API Claude : ' + JSON.stringify(r.data), 500, corsHeaders);
          return new Response(JSON.stringify({ ok: true, conseils: r.texte.trim() }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur génération conseils : ' + String(e), 500, corsHeaders);
        }
      }


      // Version V1 internationale, volontairement plus légère que la France :
      // pas de suivi "indicateurs PEDLV rouges qui traînent" ni "points Kaizen
      // non résolus depuis plusieurs mois" (dépendent d'historiques hebdo/mensuels
      // pas encore construits côté international) — score + sous-scores +
      // historique 26 semaines déjà fonctionnels, le reste pourra s'ajouter ensuite
      // sans changer la forme de la réponse (nouvelles clés uniquement).

      // "Mon dashboard" — équivalent fiche magasin, agrégé sur tout le périmètre
      // d'un animateur (ou d'un directeur pays / ALL). Réutilise buildStoreHealthResults.

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

        // Lot 3 : light=1 → data_json sans les photos (liste d'historique) ;
        // magasin_codes=A,B → plusieurs magasins (intersectés avec le périmètre).
        const light = url.searchParams.get('light') === '1';
        const codesParam = (url.searchParams.get('magasin_codes') || '').split(',').map(x => x.trim()).filter(Boolean);
        const dataCol = light ? "CASE WHEN json_valid(data_json) THEN json_remove(data_json, '$.photos') ELSE data_json END AS data_json" : 'data_json';
        let query = 'SELECT id, magasin_code, magasin_libelle, ar, date, passage, humeur, ca_mensuel, ca_annuel, renta, ' + dataCol + ', created_at FROM bilans WHERE 1=1';
        const binds = [];
        if (magasinCode) { query += ' AND magasin_code = ?'; binds.push(magasinCode); }
        else if (codesParam.length) {
          const codes = allowedCodes ? codesParam.filter(c => allowedCodes.includes(c)) : codesParam;
          if (!codes.length) return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
          query += ' AND magasin_code IN (' + codes.map(() => '?').join(',') + ')';
          binds.push(...codes);
        }
        else if (allowedCodes) {
          if (!allowedCodes.length) return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
          query += ' AND magasin_code IN (' + allowedCodes.map(() => '?').join(',') + ')';
          binds.push(...allowedCodes);
        }
        if (from) { query += ' AND date >= ?'; binds.push(from); }
        if (to) { query += ' AND date <= ?'; binds.push(to); }
        query += ' ORDER BY date DESC, id DESC LIMIT ?';
        binds.push(limit);

        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }





      // ======================================================================
      // Lot 5 (25/10/2026) — Suivi Managers
      // ======================================================================
      // ---------- Suivi Managers (16/09) ----------
      // Trames d'entretien manager (Écoute&FB, Pilotage Audio, Pilotage Optique) +
      // lancements de journée. Même principe que store-observation : écriture
      // publique protégée par X-Store-Token, résolution animateur/magasin côté
      // serveur depuis magasins.csv (jamais fait confiance au client), mail au
      // magasin à l'envoi. Historique réservé aux AR + Olivier via /ar-login.
      if (url.pathname === '/entretien-manager') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      const body = await request.json();
      const { type, magasinCode, collaborateurMatricule, collaborateurNom, remplipar, date, data, pdfBase64, pdfFilename, suivis, reprises } = body;
      if (!TYPES_ENTRETIEN_VALIDES.includes(type)) return jsonError('Type invalide', 400, corsHeaders);
      if (!remplipar || !date) return jsonError('Champs manquants', 400, corsHeaders);

      const stores = await getMagasinsServerSide();
      const magasin = stores.find(s => String(s.code) === String(magasinCode)) || null;
      const animateur = magasin ? magasin.animateur : null;

      // 09/10 (anti-doublons) : même magasin + même date + même type + même
      // collaborateur déjà enregistré → on ne crée rien (ni ligne, ni suivis, ni
      // mail) et on renvoie l'existant. Même clé que le repérage « doublon
      // probable » de l'Historique. Sans collaborateur, pas de contrôle.
      const cleCollab = String(collaborateurMatricule || collaborateurNom || '').trim();
      if (cleCollab) {
      const existant = await env.DB.prepare(
      `SELECT id FROM entretiens_manager WHERE CAST(COALESCE(magasin_code, '') AS TEXT) = ? AND date = ? AND type = ?
      AND COALESCE(NULLIF(collaborateur_matricule, ''), collaborateur_nom, '') = ? LIMIT 1`
      ).bind(String(magasinCode || ''), date, type, cleCollab).first();
      if (existant) return new Response(JSON.stringify({ ok: true, id: existant.id, deja: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      const insert = await env.DB.prepare(
      `INSERT INTO entretiens_manager
      (type, magasin_code, magasin_libelle, animateur, collaborateur_matricule, collaborateur_nom, rempli_par, date, data_json)
      VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(
      type, magasinCode || null, magasin ? magasin.libelle : null, animateur,
      collaborateurMatricule || null, collaborateurNom || null, remplipar, date, JSON.stringify(data || {})
      ).run();
      const entretienId = insert && insert.meta ? insert.meta.last_row_id : null;

      // Suivis datés + reprise des suivis précédents (26/09). Jamais bloquant :
      // l'entretien est déjà enregistré, un souci ici (table suivis_entretien pas
      // encore créée…) ne doit pas faire échouer l'envoi du mail.
      try {
      const propres = sanitizeSuivis(suivis);
      if (propres.length && magasinCode) {
      const stmt = env.DB.prepare(
      `INSERT INTO suivis_entretien
      (entretien_id, magasin_code, magasin_libelle, animateur, collaborateur_matricule, collaborateur_nom, type_entretien, libelle, echeance)
      VALUES (?,?,?,?,?,?,?,?,?)`
      );
      await env.DB.batch(propres.map(x => stmt.bind(
      entretienId, String(magasinCode), magasin ? magasin.libelle : null, animateur,
      collaborateurMatricule || null, collaborateurNom || null, type, x.libelle, x.echeance
      )));
      }
      await cloturerSuivis(env, magasinCode, reprises, remplipar, 'entretien', entretienId);
      } catch (e) { console.error('Suivis entretien non enregistrés:', e); }

      if (magasin && magasin.email) {
      const libelleType = libelleEntretien(type, data);
      const L = mailLibelles(magasin.langue);
      const subject = `${L.entretien} — ${libelleType} — ${magasin.libelle} — ${formatDateFr(date)}`;
      const bodyHtml = buildEntretienManagerEmailHtml({ libelleType, magasin, remplipar, date, data, collaborateurNom, hasPdf: !!pdfBase64, L });
      try {
      if (pdfBase64) {
      await zimbraSendMailWithAttachment(env, { to: magasin.email, subject, bodyHtml, pdfBase64, filename: pdfFilename });
      } else {
      await zimbraSendMail(env, { to: magasin.email, subject, bodyHtml });
      }
      } catch (e) { console.error('Échec envoi mail entretien manager:', e); }
      }

      return new Response(JSON.stringify({ ok: true, id: entretienId }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur enregistrement entretien : ' + String(e), 500, corsHeaders);
      }
      }

      // Bandeau « À suivre » (26/09) — suivis ouverts d'un magasin : en retard ou
      // arrivant à échéance dans les 7 prochains jours.
      if (url.pathname === '/suivis-magasin') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      const magasinCode = url.searchParams.get('magasin_code');
      if (!magasinCode) return jsonError('magasin_code manquant', 400, corsHeaders);
      try {
      const today = parisTodayIso();
      const limite = addDaysIso(today, 7);
      const { results } = await env.DB.prepare(
      `SELECT id, collaborateur_matricule, collaborateur_nom, type_entretien, libelle, echeance
      FROM suivis_entretien WHERE magasin_code = ? AND statut = 'ouvert' AND echeance <= ?
      ORDER BY echeance ASC, id ASC LIMIT 100`
      ).bind(String(magasinCode), limite).all();
      return new Response(JSON.stringify({ ok: true, today, suivis: results }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      // Table pas encore créée : bandeau vide plutôt qu'une erreur à l'écran.
      return new Response(JSON.stringify({ ok: true, today: parisTodayIso(), suivis: [], warning: String(e) }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      }

      // Reprise au prochain entretien (26/09) — tous les suivis encore ouverts d'un
      // collaborateur pour un même type d'entretien (toutes échéances confondues).
      if (url.pathname === '/suivis-collaborateur') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      const magasinCode = url.searchParams.get('magasin_code');
      const matricule = url.searchParams.get('matricule');
      const type = url.searchParams.get('type');
      if (!magasinCode || !matricule || !type) return jsonError('Paramètres manquants', 400, corsHeaders);
      try {
      const { results } = await env.DB.prepare(
      `SELECT id, libelle, echeance, created_at FROM suivis_entretien
      WHERE magasin_code = ? AND collaborateur_matricule = ? AND type_entretien = ? AND statut = 'ouvert'
      ORDER BY echeance ASC, id ASC LIMIT 50`
      ).bind(String(magasinCode), String(matricule), String(type)).all();
      return new Response(JSON.stringify({ ok: true, suivis: results }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return new Response(JSON.stringify({ ok: true, suivis: [], warning: String(e) }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      }

      // Bouton « Fait » du bandeau (26/09) — horodaté et signé du prénom saisi.
      if (url.pathname === '/suivi-cloture') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      const { id, magasinCode, par } = await request.json();
      if (!id || !magasinCode || !par) return jsonError('Champs manquants', 400, corsHeaders);
      await cloturerSuivis(env, magasinCode, [{ id, statut: 'fait' }], String(par).slice(0, 80), 'bandeau', null);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur clôture suivi : ' + String(e), 500, corsHeaders);
      }
      }

      if (url.pathname === '/lancement-journee') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      const body = await request.json();
      const { magasinCode, remplipar, posteRemplipar, date, presents, objectifs, noteLibre, mensuel, pdfBase64, pdfFilename } = body;
      if (!remplipar || !posteRemplipar || !date) return jsonError('Champs manquants', 400, corsHeaders);

      const stores = await getMagasinsServerSide();
      const magasin = stores.find(s => String(s.code) === String(magasinCode)) || null;
      const animateur = magasin ? magasin.animateur : null;

      // 09/10 (anti-doublons) : un seul lancement par magasin et par jour.
      // 14/10 : un lancement créé par une réunion mensuelle ne bloque pas un vrai
      // lancement le même jour (le score compte les jours, pas les saisies).
      let existantL;
      try {
      existantL = await env.DB.prepare(
      `SELECT id FROM lancements_journee WHERE CAST(COALESCE(magasin_code, '') AS TEXT) = ? AND date = ? AND reunion_id IS NULL LIMIT 1`
      ).bind(String(magasinCode || ''), date).first();
      } catch (e) {
      existantL = await env.DB.prepare(
      `SELECT id FROM lancements_journee WHERE CAST(COALESCE(magasin_code, '') AS TEXT) = ? AND date = ? LIMIT 1`
      ).bind(String(magasinCode || ''), date).first();
      }
      if (existantL) return new Response(JSON.stringify({ ok: true, id: existantL.id, deja: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      await env.DB.prepare(
      `INSERT INTO lancements_journee
      (magasin_code, magasin_libelle, animateur, rempli_par, poste_rempli_par, date, presents_json, objectifs, note_libre, mensuel_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(
      magasinCode || null, magasin ? magasin.libelle : null, animateur,
      remplipar, posteRemplipar, date, JSON.stringify(presents || []), objectifs || '', noteLibre || '', JSON.stringify(mensuel || {})
      ).run();

      if (magasin && magasin.email) {
      const L = mailLibelles(magasin.langue);
      const subject = `${L.lancement} — ${magasin.libelle} — ${formatDateFr(date)}`;
      const mensuelLabels = { ca: L.ca, positionnement: L.positionnement, caAudio: L.caAudio, nbVenteOpt: L.nbVenteOpt, nbProthese: L.nbProthese };
      const mensuelLine = mensuel ? Object.entries(mensuelLabels).filter(([k]) => mensuel[k]).map(([k, label]) => `${label} : ${escapeHtml(String(mensuel[k]))}`).join(' — ') : '';
      const bodyHtml = pdfBase64
        ? `<div style="font-family:Arial,sans-serif;"><h2 style="color:#CC1719;">${L.lancement}</h2><p><b>${L.magasin}</b> ${escapeHtml(magasin.libelle)}</p><p><b>${L.realisePar}</b> ${escapeHtml(remplipar)} (${escapeHtml(posteRemplipar)}) — <b>${L.date}</b> ${escapeHtml(formatDateFr(date))}</p><p>${L.pdfJoint}</p></div>`
        : `<div style="font-family:Arial,sans-serif;"><h2 style="color:#CC1719;">${L.lancement}</h2><p><b>${L.magasin}</b> ${escapeHtml(magasin.libelle)}</p><p><b>${L.realisePar}</b> ${escapeHtml(remplipar)} (${escapeHtml(posteRemplipar)}) — <b>${L.date}</b> ${escapeHtml(formatDateFr(date))}</p>${mensuelLine ? `<p><b>${L.donneesMois}</b> ${mensuelLine}</p>` : ''}<p><b>${L.presents}</b> ${escapeHtml((presents || []).join(', '))}</p><p><b>${L.objectifsJour}</b><br>${escapeHtml(objectifs || '').replace(/\n/g, '<br>')}</p><p><b>${L.noteLibre}</b><br>${escapeHtml(noteLibre || '').replace(/\n/g, '<br>')}</p></div>`;
      try {
      if (pdfBase64) {
      await zimbraSendMailWithAttachment(env, { to: magasin.email, subject, bodyHtml, pdfBase64, filename: pdfFilename });
      } else {
      await zimbraSendMail(env, { to: magasin.email, subject, bodyHtml });
      }
      } catch (e) { console.error('Échec envoi mail lancement journée:', e); }
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur enregistrement lancement : ' + String(e), 500, corsHeaders);
      }
      }

      // ---------- Brouillons serveur Suivi Managers (14/10) ----------
      // Liste (en-têtes seulement, jamais le contenu), lecture, enregistrement
      // (création ou mise à jour), suppression. Toujours bornés au magasin.
      if (url.pathname === '/brouillons' || url.pathname === '/brouillon-get' || url.pathname === '/brouillon-save' || url.pathname === '/brouillon-supprimer') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      const jsonOk = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
      await ensureReunionTables(env);
      if (url.pathname === '/brouillons') {
      const code = url.searchParams.get('magasin_code');
      if (!code) return jsonError('magasin_code manquant', 400, corsHeaders);
      const { results } = await env.DB.prepare(
      `SELECT id, ecran, libelle, cree_par, updated_at FROM brouillons_suivi WHERE magasin_code = ? AND updated_at >= datetime('now', ?) ORDER BY updated_at DESC LIMIT 50`
      ).bind(String(code), `-${BROUILLON_PURGE_JOURS} days`).all();
      return jsonOk({ ok: true, brouillons: results || [] });
      }
      if (url.pathname === '/brouillon-get') {
      const id = Number(url.searchParams.get('id'));
      const code = url.searchParams.get('magasin_code');
      if (!Number.isInteger(id) || !code) return jsonError('Paramètres manquants', 400, corsHeaders);
      const row = await env.DB.prepare(`SELECT id, ecran, libelle, cree_par, json, updated_at FROM brouillons_suivi WHERE id = ? AND magasin_code = ?`).bind(id, String(code)).first();
      if (!row) return jsonError('Brouillon introuvable (déjà envoyé ou supprimé)', 404, corsHeaders);
      return jsonOk({ ok: true, brouillon: { id: row.id, ecran: row.ecran, libelle: row.libelle, creePar: row.cree_par, updatedAt: row.updated_at, data: JSON.parse(row.json || '{}') } });
      }
      const body = await request.json().catch(() => null);
      if (!body || !body.magasinCode) return jsonError('magasinCode manquant', 400, corsHeaders);
      const code = String(body.magasinCode);
      if (url.pathname === '/brouillon-supprimer') {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return jsonError('id manquant', 400, corsHeaders);
      await env.DB.prepare(`DELETE FROM brouillons_suivi WHERE id = ? AND magasin_code = ?`).bind(id, code).run();
      return jsonOk({ ok: true });
      }
      // /brouillon-save
      const ecran = txt(body.ecran, 40);
      if (!/^screen-[a-z-]+$/.test(ecran)) return jsonError('Écran invalide', 400, corsHeaders);
      const json = JSON.stringify(body.data || {});
      if (json.length > 300000) return jsonError('Brouillon trop volumineux', 413, corsHeaders);
      const libelle = txt(body.libelle, 200), creePar = txt(body.creePar, 80);
      const id = Number(body.id);
      if (Number.isInteger(id) && id > 0) {
      const r = await env.DB.prepare(`UPDATE brouillons_suivi SET ecran = ?, libelle = ?, cree_par = COALESCE(NULLIF(?, ''), cree_par), json = ?, updated_at = datetime('now') WHERE id = ? AND magasin_code = ?`)
      .bind(ecran, libelle, creePar, json, id, code).run();
      if (r && r.meta && r.meta.changes) return jsonOk({ ok: true, id });
      }
      const ins = await env.DB.prepare(`INSERT INTO brouillons_suivi (magasin_code, ecran, libelle, cree_par, json) VALUES (?, ?, ?, ?, ?)`).bind(code, ecran, libelle, creePar, json).run();
      return jsonOk({ ok: true, id: ins && ins.meta ? ins.meta.last_row_id : null });
      } catch (e) {
      return jsonError('Erreur brouillon : ' + String(e), 500, corsHeaders);
      }
      }

      // ---------- Sujets imposés pour la réunion mensuelle (14/10) ----------
      // Côté magasin (jeton magasin) : sujets du mois à traiter. Côté AR / Olivier
      // (session AR) : liste, création, suppression. Olivier crée des sujets réseau,
      // un AR des sujets pour ses magasins.
      if (url.pathname === '/reunion-sujets') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      await ensureReunionTables(env);
      const code = url.searchParams.get('magasin_code');
      const mois = url.searchParams.get('mois') || parisTodayIso().slice(0, 7);
      if (!code || !/^\d{4}-\d{2}$/.test(mois)) return jsonError('Paramètres invalides', 400, corsHeaders);
      const stores = await getMagasinsServerSide();
      const magasin = stores.find(s => String(s.code) === String(code));
      if (!magasin) return jsonError('Magasin inconnu', 404, corsHeaders);
      const sujets = await sujetsImposesMagasin(env, magasin, mois);
      return new Response(JSON.stringify({ ok: true, mois, sujets }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur sujets imposés : ' + String(e), 500, corsHeaders);
      }
      }

      if (url.pathname === '/reunion-sujets-admin' || url.pathname === '/reunion-sujet-save' || url.pathname === '/reunion-sujet-supprimer') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
      if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
      const jsonOk = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      try {
      await ensureReunionTables(env);
      if (url.pathname === '/reunion-sujets-admin') {
      const depuis = parisTodayIso().slice(0, 7);
      const sql = sessionAr === 'ALL'
      ? `SELECT s.*, (SELECT COUNT(*) FROM reunion_sujets_traites t WHERE t.sujet_id = s.id) AS nb_traites FROM reunion_sujets s WHERE s.mois >= ? ORDER BY s.mois, s.portee DESC, s.id`
      : `SELECT s.*, (SELECT COUNT(*) FROM reunion_sujets_traites t WHERE t.sujet_id = s.id) AS nb_traites FROM reunion_sujets s WHERE s.mois >= ? AND (s.portee = 'reseau' OR s.ar = ?) ORDER BY s.mois, s.portee DESC, s.id`;
      const stmt = env.DB.prepare(sql);
      const { results } = await (sessionAr === 'ALL' ? stmt.bind(depuis) : stmt.bind(depuis, sessionAr)).all();
      const stores = await getMagasinsServerSide();
      const nbMagasinsAr = {};
      for (const s of (results || [])) if (s.portee === 'ar' && s.ar && !(s.ar in nbMagasinsAr)) nbMagasinsAr[s.ar] = (await getAllowedCodes(s.ar, stores)).length;
      const sujets = (results || []).map(s => ({ ...s, nb_magasins: s.portee === 'reseau' ? stores.length : (nbMagasinsAr[s.ar] || 0), modifiable: sessionAr === 'ALL' || (s.portee === 'ar' && s.ar === sessionAr) }));
      return jsonOk({ ok: true, ar: sessionAr, estOlivier: sessionAr === 'ALL', sujets });
      }
      const body = await request.json().catch(() => null);
      if (!body) return jsonError('Corps invalide', 400, corsHeaders);
      if (url.pathname === '/reunion-sujet-supprimer') {
      const id = Number(body.id);
      if (!Number.isInteger(id)) return jsonError('id manquant', 400, corsHeaders);
      const s = await env.DB.prepare(`SELECT * FROM reunion_sujets WHERE id = ?`).bind(id).first();
      if (!s) return jsonError('Sujet introuvable', 404, corsHeaders);
      if (!(sessionAr === 'ALL' || (s.portee === 'ar' && s.ar === sessionAr))) return jsonError('Ce sujet ne t\'appartient pas', 403, corsHeaders);
      await env.DB.prepare(`DELETE FROM reunion_sujets WHERE id = ?`).bind(id).run();
      return jsonOk({ ok: true });
      }
      // /reunion-sujet-save
      const mois = txt(body.mois, 7), titre = txt(body.titre, 200), detail = txt(body.detail, 3000);
      if (!/^\d{4}-\d{2}$/.test(mois) || !titre) return jsonError('Mois et titre obligatoires', 400, corsHeaders);
      const portee = sessionAr === 'ALL' ? 'reseau' : 'ar';
      const id = Number(body.id);
      if (Number.isInteger(id) && id > 0) {
      const s = await env.DB.prepare(`SELECT * FROM reunion_sujets WHERE id = ?`).bind(id).first();
      if (!s) return jsonError('Sujet introuvable', 404, corsHeaders);
      if (!(sessionAr === 'ALL' || (s.portee === 'ar' && s.ar === sessionAr))) return jsonError('Ce sujet ne t\'appartient pas', 403, corsHeaders);
      await env.DB.prepare(`UPDATE reunion_sujets SET mois = ?, titre = ?, detail = ? WHERE id = ?`).bind(mois, titre, detail, id).run();
      return jsonOk({ ok: true, id });
      }
      const ins = await env.DB.prepare(`INSERT INTO reunion_sujets (portee, ar, mois, titre, detail, cree_par) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(portee, portee === 'ar' ? sessionAr : null, mois, titre, detail, sessionAr).run();
      return jsonOk({ ok: true, id: ins && ins.meta ? ins.meta.last_row_id : null });
      } catch (e) {
      return jsonError('Erreur sujets imposés : ' + String(e), 500, corsHeaders);
      }
      }

      // ---------- Validation d'une réunion mensuelle (14/10) ----------
      if (url.pathname === '/reunion-mensuelle') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      await ensureReunionTables(env);
      const b = await request.json();
      const stores = await getMagasinsServerSide();
      const magasin = stores.find(s => String(s.code) === String(b.magasinCode)) || null;
      if (!magasin) return jsonError('Magasin inconnu', 400, corsHeaders);
      const typeReunion = TYPES_REUNION[b.typeReunion] ? b.typeReunion : null;
      const remplipar = txt(b.remplipar, 80), poste = txt(b.poste, 80), date = txt(b.date, 10);
      if (!typeReunion || !remplipar || !isoDateOk(date)) return jsonError('Type, prénom et date obligatoires', 400, corsHeaders);
      const sousType = typeReunion === 'debrief' && SOUS_TYPES_DEBRIEF[b.sousType] ? b.sousType : null;
      const intitule = txt(b.intitule, 150);
      const presents = (Array.isArray(b.presents) ? b.presents : []).slice(0, 60).map(p => ({ nom: txt(p && p.nom, 100), fonction: txt(p && p.fonction, 80), signature: typeof (p && p.signature) === 'string' && p.signature.startsWith('data:image/') && p.signature.length < 60000 ? p.signature : null })).filter(p => p.nom);
      const absents = (Array.isArray(b.absents) ? b.absents : []).slice(0, 60).map(n => txt(n, 100)).filter(Boolean);
      if (!presents.length) return jsonError('Aucun présent', 400, corsHeaders);
      if (presents.some(p => !p.signature)) return jsonError('Chaque présent doit signer (ou être décoché)', 400, corsHeaders);
      const points = (Array.isArray(b.points) ? b.points : []).slice(0, 40).map(p => ({
      sujetId: Number.isInteger(Number(p && p.sujetId)) && Number(p.sujetId) > 0 ? Number(p.sujetId) : null,
      portee: ['reseau', 'ar'].includes(p && p.portee) ? p.portee : null,
      titre: txt(p && p.titre, 200), detail: txt(p && p.detail, 3000), miseEnPlace: txt(p && p.miseEnPlace, 3000),
      objectif: txt(p && p.objectif, 500), echeance: isoDateOk(p && p.echeance) ? p.echeance : '',
      })).filter(p => p.titre);
      // Sujets imposés du mois : tous présents et tous renseignés (mise en place).
      const imposes = await sujetsImposesMagasin(env, magasin, date.slice(0, 7));
      for (const s of imposes) {
      const p = points.find(x => x.sujetId === s.id);
      if (!p) return jsonError(`Sujet imposé manquant : « ${s.titre} »`, 400, corsHeaders);
      if (!p.miseEnPlace) return jsonError(`Mise en place à renseigner pour le sujet imposé « ${s.titre} »`, 400, corsHeaders);
      p.titre = s.titre; p.detail = s.detail || ''; p.portee = s.portee;
      }
      // Anti-doublon : même magasin, même date, même type de réunion (et même sous-type).
      const existant = await env.DB.prepare(`SELECT id FROM reunions_magasin WHERE magasin_code = ? AND date = ? AND type_reunion = ? AND COALESCE(sous_type, '') = ? LIMIT 1`)
      .bind(String(magasin.code), date, typeReunion, sousType || '').first();
      if (existant) return new Response(JSON.stringify({ ok: true, id: existant.id, deja: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      const signatures = {};
      presents.forEach((p, i) => { signatures[i] = p.signature; });
      const presentsSansSig = presents.map(p => ({ nom: p.nom, fonction: p.fonction }));
      const ins = await env.DB.prepare(
      `INSERT INTO reunions_magasin (magasin_code, magasin_libelle, animateur, type_reunion, sous_type, intitule, rempli_par, poste_rempli_par, date, presents_json, absents_json, points_json, signatures_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(String(magasin.code), magasin.libelle, magasin.animateur || null, typeReunion, sousType, intitule, remplipar, poste, date,
      JSON.stringify(presentsSansSig), JSON.stringify(absents), JSON.stringify(points), env.ARCHIVES ? null : JSON.stringify(signatures)).run();
      const reunionId = ins && ins.meta ? ins.meta.last_row_id : null;
      if (env.ARCHIVES && reunionId) {
      try { await env.ARCHIVES.prepare(`INSERT OR REPLACE INTO reunion_signatures (reunion_id, json) VALUES (?, ?)`).bind(reunionId, JSON.stringify(signatures)).run(); }
      catch (e) {
      console.error('Signatures réunion non archivées, repli base principale :', e);
      await env.DB.prepare(`UPDATE reunions_magasin SET signatures_json = ? WHERE id = ?`).bind(JSON.stringify(signatures), reunionId).run();
      }
      }
      const libelle = libelleReunion({ type_reunion: typeReunion, sous_type: sousType, intitule });
      // Compte comme lancement de journée (sauf si un lancement existe déjà ce jour-là).
      let lancementId = null;
      try {
      const dejaL = await env.DB.prepare(`SELECT id FROM lancements_journee WHERE CAST(COALESCE(magasin_code, '') AS TEXT) = ? AND date = ? LIMIT 1`).bind(String(magasin.code), date).first();
      if (!dejaL) {
      const insL = await env.DB.prepare(
      `INSERT INTO lancements_journee (magasin_code, magasin_libelle, animateur, rempli_par, poste_rempli_par, date, presents_json, objectifs, note_libre, mensuel_json, reunion_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(String(magasin.code), magasin.libelle, magasin.animateur || null, remplipar, poste || 'Réunion mensuelle', date,
      JSON.stringify(presents.map(p => p.nom)), 'Réunion mensuelle — ' + libelle, '', '{}', reunionId).run();
      lancementId = insL && insL.meta ? insL.meta.last_row_id : null;
      await env.DB.prepare(`UPDATE reunions_magasin SET lancement_id = ? WHERE id = ?`).bind(lancementId, reunionId).run();
      }
      } catch (e) { console.error('Lancement lié à la réunion non créé :', e); }
      // Sujets imposés traités + objectifs datés → suivis (bandeau « À suivre »).
      try {
      const stmts = [];
      for (const p of points) {
      if (p.sujetId && imposes.some(s => s.id === p.sujetId)) stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO reunion_sujets_traites (sujet_id, magasin_code, reunion_id) VALUES (?, ?, ?)`).bind(p.sujetId, String(magasin.code), reunionId));
      if (p.objectif && p.echeance) stmts.push(env.DB.prepare(
      `INSERT INTO suivis_entretien (entretien_id, magasin_code, magasin_libelle, animateur, collaborateur_matricule, collaborateur_nom, type_entretien, libelle, echeance, reunion_id)
      VALUES (NULL, ?, ?, ?, NULL, 'Équipe', 'reunion_mensuelle', ?, ?, ?)`
      ).bind(String(magasin.code), magasin.libelle, magasin.animateur || null, (p.titre + ' — ' + p.objectif).slice(0, 300), p.echeance, reunionId));
      }
      if (stmts.length) await env.DB.batch(stmts);
      } catch (e) { console.error('Suivis / sujets traités de la réunion non enregistrés :', e); }
      // Mails : magasin + AR.
      const L = mailLibelles(magasin.langue);
      const subject = `${L.reunion} — ${libelle} — ${magasin.libelle} — ${formatDateFr(date)}`;
      const bodyHtml = `<div style="font-family:Arial,sans-serif;"><h2 style="color:#E2231A;">${L.reunion}</h2><p><b>${L.magasin}</b> ${escapeHtml(magasin.libelle)}</p><p><b>${L.type}</b> ${escapeHtml(libelle)}</p><p><b>${L.animeePar}</b> ${escapeHtml(remplipar)}${poste ? ' (' + escapeHtml(poste) + ')' : ''} — <b>${L.date}</b> ${escapeHtml(formatDateFr(date))}</p><p><b>${L.presents.replace(/\s*:$/, '')} (${presents.length}) :</b> ${escapeHtml(presents.map(p => p.nom).join(', '))}</p>${absents.length ? `<p><b>${L.absents}</b> ${escapeHtml(absents.join(', '))}</p>` : ''}<p><b>${L.pointsTraites}</b></p><ul>${points.map(p => `<li>${escapeHtml(p.titre)}${p.objectif ? ' — ' + L.objectif + ' ' + escapeHtml(p.objectif) + (p.echeance ? ' (' + escapeHtml(formatDateFr(p.echeance)) + ')' : '') : ''}</li>`).join('')}</ul>${b.pdfBase64 ? `<p>${L.pdfJointSigne}</p>` : ''}</div>`;
      // Magasin + son animateur, ou à défaut son directeur pays (pas d'animateur dans tous les pays).
      const destinataires = [magasin.email, magasin.animateurEmail || magasin.directeurPaysEmail].filter((x, i, a) => x && a.indexOf(x) === i);
      for (const to of destinataires) {
      try {
      if (b.pdfBase64) await zimbraSendMailWithAttachment(env, { to, subject, bodyHtml, pdfBase64: b.pdfBase64, filename: b.pdfFilename || 'Reunion.pdf' });
      else await zimbraSendMail(env, { to, subject, bodyHtml });
      } catch (e) { console.error('Échec envoi mail réunion mensuelle à ' + to + ' :', e); }
      }
      return new Response(JSON.stringify({ ok: true, id: reunionId, lancementId }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur enregistrement réunion : ' + String(e), 500, corsHeaders);
      }
      }

      // Une réunion complète (avec signatures) pour régénérer son PDF depuis l'historique.
      if (url.pathname === '/reunion-get') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
      if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
      try {
      await ensureReunionTables(env);
      const id = Number(url.searchParams.get('id'));
      const r = await env.DB.prepare(`SELECT * FROM reunions_magasin WHERE id = ?`).bind(id).first();
      if (!r) return jsonError('Réunion introuvable', 404, corsHeaders);
      if (sessionAr !== 'ALL') {
      const stores = await getMagasinsServerSide();
      const m = stores.find(s => String(s.code) === String(r.magasin_code));
      if (!m || !(await getAllowedCodes(sessionAr, stores)).includes(String(m.code))) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
      }
      const sig = await lireSignaturesReunion(env, r);
      const presents = JSON.parse(r.presents_json || '[]').map((p, i) => ({ ...p, signature: sig[i] || null }));
      return new Response(JSON.stringify({ ok: true, reunion: { ...r, signatures_json: undefined, presents, absents: JSON.parse(r.absents_json || '[]'), points: JSON.parse(r.points_json || '[]'), libelle: libelleReunion(r) } }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur lecture réunion : ' + String(e), 500, corsHeaders);
      }
      }

      // Suppression d'un entretien ou d'un lancement de journée depuis l'Historique
      // de Suivi Managers (29/09) — réservée à Olivier (session AR 'ALL'), pour
      // retirer les doublons. Supprimer un entretien supprime aussi les suivis datés
      // qu'il avait créés (sinon ils resteraient en alerte « À suivre »). Les suivis
      // qu'il avait clôturés restent clôturés.
      if (url.pathname === '/historique-managers-supprimer') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
      if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
      if (sessionAr !== 'ALL') return jsonError('Suppression réservée à l\'accès réseau complet', 403, corsHeaders);
      try {
      const { kind, id } = await request.json();
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0 || !['entretien', 'lancement', 'reunion'].includes(kind)) return jsonError('Paramètres invalides', 400, corsHeaders);
      let suivisSupprimes = 0;
      if (kind === 'entretien') {
      try {
      const r = await env.DB.prepare(`DELETE FROM suivis_entretien WHERE entretien_id = ?`).bind(n).run();
      suivisSupprimes = (r && r.meta && r.meta.changes) || 0;
      } catch (e) { /* table absente : rien à supprimer */ }
      const del = await env.DB.prepare(`DELETE FROM entretiens_manager WHERE id = ?`).bind(n).run();
      if (!(del && del.meta && del.meta.changes)) return jsonError('Entretien introuvable', 404, corsHeaders);
      } else if (kind === 'reunion') {
      // Réunion supprimée : son lancement lié, ses objectifs datés, ses sujets
      // marqués traités (ils redeviennent à traiter) et ses signatures archivées.
      await ensureReunionTables(env);
      const del = await env.DB.prepare(`DELETE FROM reunions_magasin WHERE id = ?`).bind(n).run();
      if (!(del && del.meta && del.meta.changes)) return jsonError('Réunion introuvable', 404, corsHeaders);
      const r1 = await env.DB.prepare(`DELETE FROM suivis_entretien WHERE reunion_id = ?`).bind(n).run();
      suivisSupprimes = (r1 && r1.meta && r1.meta.changes) || 0;
      await env.DB.batch([
      env.DB.prepare(`DELETE FROM lancements_journee WHERE reunion_id = ?`).bind(n),
      env.DB.prepare(`DELETE FROM reunion_sujets_traites WHERE reunion_id = ?`).bind(n),
      ]);
      if (env.ARCHIVES) { try { await env.ARCHIVES.prepare(`DELETE FROM reunion_signatures WHERE reunion_id = ?`).bind(n).run(); } catch (e) {} }
      } else {
      const del = await env.DB.prepare(`DELETE FROM lancements_journee WHERE id = ?`).bind(n).run();
      if (!(del && del.meta && del.meta.changes)) return jsonError('Lancement introuvable', 404, corsHeaders);
      }
      return new Response(JSON.stringify({ ok: true, suivisSupprimes }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur suppression : ' + String(e), 500, corsHeaders);
      }
      }

      if (url.pathname === '/historique-managers') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

      const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
      if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

      try {
      let allowedCodes = null;
      if (sessionAr !== 'ALL') {
      const stores = await getMagasinsServerSide();
      allowedCodes = await getAllowedCodes(sessionAr, stores);
      }
      const magasinCode = url.searchParams.get('magasin_code');
      if (magasinCode && allowedCodes && !allowedCodes.includes(magasinCode)) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
      const type = url.searchParams.get('type');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

      const scopeClause = (col) => {
      if (magasinCode) return { sql: ` AND ${col} = ?`, binds: [magasinCode] };
      if (allowedCodes) return allowedCodes.length ? { sql: ` AND ${col} IN (${allowedCodes.map(() => '?').join(',')})`, binds: allowedCodes } : { sql: ' AND 0', binds: [] };
      return { sql: '', binds: [] };
      };

      const result = { entretiens: [], lancements: [] };

      if (type !== 'lancements') {
      const sc = scopeClause('magasin_code');
      const { results } = await env.DB.prepare(
      `SELECT * FROM entretiens_manager WHERE 1=1${sc.sql} ORDER BY date DESC, id DESC LIMIT ?`
      ).bind(...sc.binds, limit).all();
      result.entretiens = results.map(r => ({ ...r, data_json: JSON.parse(r.data_json || '{}') }));
      }
      if (type !== 'entretiens') {
      const sc = scopeClause('magasin_code');
      const { results } = await env.DB.prepare(
      `SELECT * FROM lancements_journee WHERE 1=1${sc.sql} ORDER BY date DESC, id DESC LIMIT ?`
      ).bind(...sc.binds, limit).all();
      result.lancements = results.map(r => ({ ...r, presents_json: JSON.parse(r.presents_json || '[]'), mensuel_json: JSON.parse(r.mensuel_json || '{}') }));
      }
      if (type !== 'entretiens' && type !== 'lancements') {
      try {
      await ensureReunionTables(env);
      const sc = scopeClause('magasin_code');
      const { results } = await env.DB.prepare(
      `SELECT id, magasin_code, magasin_libelle, animateur, type_reunion, sous_type, intitule, rempli_par, date, presents_json, absents_json, points_json FROM reunions_magasin WHERE 1=1${sc.sql} ORDER BY date DESC, id DESC LIMIT ?`
      ).bind(...sc.binds, limit).all();
      result.reunions = (results || []).map(r => ({ id: r.id, magasin_code: r.magasin_code, magasin_libelle: r.magasin_libelle, rempli_par: r.rempli_par, date: r.date, libelle: libelleReunion(r), nb_presents: JSON.parse(r.presents_json || '[]').length, nb_absents: JSON.parse(r.absents_json || '[]').length, nb_points: JSON.parse(r.points_json || '[]').length }));
      } catch (e) { result.reunions = []; console.error('Historique réunions :', e); }
      }

      return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur lecture historique : ' + String(e), 500, corsHeaders);
      }
      }

      if (url.pathname === '/collab-stats') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      const matricules = (url.searchParams.get('matricules') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!matricules.length) return new Response(JSON.stringify({ ok: true, collaborateurs: {} }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      // 23/09 : l'import RH stocke les matricules sur 10 chiffres ("0000002488"),
      // PEDLV sans les zéros de tête ("2488") — comparaison sur LTRIM(...,'0') des
      // deux côtés, réponse indexée par le matricule tel que demandé.
      const matKey = m => String(m).trim().replace(/^0+/, '');
      const keys = [...new Set(matricules.map(matKey))];
      const placeholders = keys.map(() => '?').join(',');
      const { results } = await env.DB.prepare(
      `SELECT c1.matricule, c1.periode, c1.nom_vendeur,
      c1.pm_opt AS pmOpt, c1.mdc AS mdc, c1.nb_vente_opt AS nbVenteOpt, c1.sop AS sop,
      c1.tx_concret_opt AS txConcretOpt, c1.pack_confort_pct AS packConfortPct, c1.pack_confort_pm AS packConfortPm,
      c1.pm_1ere_paire AS pm1erePaire, c1.pm_audio AS pmAudio, c1.tx_concret_audio AS txConcretAudio,
      c1.ap4 AS ap4, c1.pct_test_auditif AS pctTestAuditif, c1.ca_audio AS caAudio, c1.ca_accessoires_pct AS caAccessoiresPct
      FROM collab_stats_mensuel c1
      INNER JOIN (
      SELECT LTRIM(matricule, '0') AS mk, MAX(periode) AS maxp FROM collab_stats_mensuel WHERE LTRIM(matricule, '0') IN (${placeholders}) GROUP BY LTRIM(matricule, '0')
      ) c2 ON LTRIM(c1.matricule, '0') = c2.mk AND c1.periode = c2.maxp`
      ).bind(...keys).all();

      const parCle = {};
      for (const row of results) parCle[matKey(row.matricule)] = row;
      const collaborateurs = {};
      for (const m of matricules) { const row = parCle[matKey(m)]; if (row) collaborateurs[m] = { ...row, matricule: m }; }
      return new Response(JSON.stringify({ ok: true, collaborateurs }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur lecture stats collaborateur : ' + String(e), 500, corsHeaders);
      }
      }

      // Suivi Managers (17/09) — données mensuelles magasin, réutilisées à deux
      // endroits : le ratio "CA audio/CA mag" de Pilotage Audio, et le bloc de
      // données mensuelles en tête du Lancement de journée. Toujours la ligne
      // store_stats la plus récente pour ce magasin (même logique que
      // getStoreStatsMap, réutilisée telle quelle plutôt que dupliquée).
      if (url.pathname === '/store-monthly-stats') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      const magasinCode = url.searchParams.get('magasin_code');
      if (!magasinCode) return jsonError('magasin_code requis', 400, corsHeaders);
      const stores = await getMagasinsServerSide();
      const store = stores.find(s => String(s.code) === String(magasinCode));
      if (!store) return new Response(JSON.stringify({ ok: true, periode: null }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      // Positionnement annuel (26/09, trame de Valorisation) : ratio magasin repris
      // du DERNIER bilan de passage (colonne ca_annuel, même source que la fiche
      // magasin) — requête ciblée sur ce seul magasin, jamais bloquante.
      let positionnementAnnuel = null, positionnementAnnuelDate = null;
      try {
      const b = await env.DB.prepare(
      `SELECT date, ca_annuel FROM bilans WHERE magasin_code = ? AND ca_annuel IS NOT NULL AND ca_annuel != '' ORDER BY date DESC, id DESC LIMIT 1`
      ).bind(String(store.code)).first();
      if (b) { positionnementAnnuel = toNumOrNull(b.ca_annuel); positionnementAnnuelDate = b.date || null; }
      } catch (e) {}

      const statsMap = await getStoreStatsMap(env);
      const row = statsMap[String(store.code)];
      if (!row) return new Response(JSON.stringify({ ok: true, periode: null, positionnementAnnuel, positionnementAnnuelDate }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      const caTotal = row.ca_total != null ? Number(row.ca_total) : null;
      const caAudio = row.ca_audio != null ? Number(row.ca_audio) : null;
      // Positionnement (24/09) : repris tel quel de PEDLV (colonne positionnement),
      // voir la fiche magasin — raf est un RAF par jour, inutilisable pour ce calcul.
      const positionnementMensuel = row.positionnement != null
      ? Math.round(Number(row.positionnement) * 10) / 10
      : null;
      const caAudioMagPct = (caTotal && caTotal !== 0 && caAudio != null)
      ? Math.round((caAudio / caTotal) * 1000) / 10
      : null;
      // ca_total / ca_audio / ca_opt sont stockés en k€ dans store_stats (même
      // convention que le reste du Worker, ex. les digests "CA: Xk€") — convertis
      // ici en € entiers pour l'affichage Lancement/Pilotage, jamais montrés bruts.
      const toEurosRounded = (kMontant) => kMontant != null ? Math.round(kMontant * 1000) : null; // montants en devise locale du magasin

      return new Response(JSON.stringify({
      ok: true, periode: row.periode || null, devise: store.devise || null,
      caTotal: toEurosRounded(caTotal), caAudio: toEurosRounded(caAudio), caOpt: toEurosRounded(row.ca_opt != null ? Number(row.ca_opt) : null),
      nbVenteOpt: row.nb_vente_opt != null ? Number(row.nb_vente_opt) : null,
      protheses: row.protheses_vendues != null ? Number(row.protheses_vendues) : null,
      positionnementMensuel, caAudioMagPct, positionnementAnnuel, positionnementAnnuelDate,
      }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur lecture stats mensuelles magasin : ' + String(e), 500, corsHeaders);
      }
      }

      if (url.pathname === '/rh-collaborateurs') {
      { const _acces = await accesOutilOuSession(request, env, ['SUIVI_STORE_TOKEN']); if (!_acces.ok) return jsonError('Non autorisé', 401, corsHeaders); }
      if (env.DB) await ensureReunionTables(env);
      if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
      try {
      const magasinCode = url.searchParams.get('magasin_code');
      if (!magasinCode) return jsonError('magasin_code requis', 400, corsHeaders);

      const moisRow = await env.DB.prepare(
      `SELECT MAX(mois) as mois FROM rh_effectif_site_mensuel WHERE code_site = ? AND site_reconnu = 1`
      ).bind(magasinCode).first();
      const dernierMois = moisRow && moisRow.mois;
      if (!dernierMois) return new Response(JSON.stringify({ ok: true, mois: null, collaborateurs: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      const { results } = await env.DB.prepare(
      `SELECT es.matricule, (em.prenom || ' ' || em.nom) AS nom, em.poste
      FROM rh_effectif_site_mensuel es
      JOIN rh_effectif_mensuel em ON em.mois = es.mois AND em.matricule = es.matricule
      WHERE es.code_site = ? AND es.mois = ? AND es.site_reconnu = 1
      ORDER BY em.nom`
      ).bind(magasinCode, dernierMois).all();

      return new Response(JSON.stringify({ ok: true, mois: dernierMois, collaborateurs: results }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
      return jsonError('Erreur lecture collaborateurs : ' + String(e), 500, corsHeaders);
      }
      }


      // ---------- Score de santé du magasin (écran manager de Suivi Managers) ----------
      // Lot 5 : version hebdo reprise du calcul existant du Worker inter. Le score
      // mensuel (primes) arrive au lot 6 avec l'alignement complet sur la France.

      // ======================================================================
      // Lot 4 (25/10/2026) — Analyse statistique (PEDLV)
      // ======================================================================

      // ---------- Jours ouvrés + grille d'objectifs du magasin ----------
      // Jours du mois − jours de repos hebdomadaire du pays (pays_inter.csv)
      // − fermetures réseau (du pays ou de tout le réseau). Renvoie aussi la
      // grille d'objectifs applicable (région > pays > défaut) et la devise.
      if (url.pathname === '/jours-ouvres') {
        const acces = await accesOutilOuSession(request, env, ['PEDLV_STORE_TOKEN', 'BILAN_STORE_TOKEN']);
        if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders);
        const mois = url.searchParams.get('mois') || '';
        if (!/^\d{4}-\d{2}$/.test(mois)) return jsonError('Paramètre mois invalide (YYYY-MM)', 400, corsHeaders);
        const date = url.searchParams.get('date') || '';
        const store = await resoudreMagasinPedlv(url.searchParams.get('code'), url.searchParams.get('nom'));
        const pays = store ? store.pays : null;
        const repos = await joursReposPays(pays);
        const fermSet = env.DB ? fermeturesSetPourPays(await getFermeturesReseau(env), pays) : new Set();
        const joursMois = compterJoursOuvresInter(mois, repos, fermSet);
        const joursEcoules = /^\d{4}-\d{2}-\d{2}$/.test(date) && date.startsWith(mois) ? compterJoursOuvresInter(mois, repos, fermSet, date) : null;
        const objectifs = await grilleObjectifsPour(store);
        return new Response(JSON.stringify({ ok: true, mois, joursMois, joursEcoules, joursRepos: repos,
          magasin: store ? { code: store.code, libelle: store.libelle, pays: store.pays, region: store.region, devise: store.devise } : null,
          objectifs }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Archives des rapports (base séparée ARCHIVES) ----------
      if (url.pathname === '/pedlv-archive' && request.method === 'POST') {
        const acces = await accesOutilOuSession(request, env, ['PEDLV_STORE_TOKEN']);
        if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders);
        if (!env.ARCHIVES) return jsonError("Base d'archives non liée au Worker (binding ARCHIVES)", 503, corsHeaders);
        let b; try { b = await request.json(); } catch (e) { return jsonError('JSON invalide', 400, corsHeaders); }
        if (!b?.magasin || typeof b.contenu !== 'string' || !b.contenu) return jsonError('Champs magasin et contenu requis', 400, corsHeaders);
        if (b.contenu.length > 1800000) return jsonError('Rapport trop volumineux pour être archivé', 413, corsHeaders);
        const store = await resoudreMagasinPedlv(b.codeMagasin, b.magasin);
        const magasinKey = store ? 'code:' + store.code : 'nom:' + normalizeName(b.magasin);
        const dateEx = b.dateExtraction ? String(b.dateExtraction).slice(0, 40) : null;
        await ensureArchivesTable(env);
        await env.ARCHIVES.batch([
          env.ARCHIVES.prepare('DELETE FROM pedlv_rapports WHERE magasin_key = ? AND date_extraction IS ?').bind(magasinKey, dateEx),
          env.ARCHIVES.prepare(
            `INSERT INTO pedlv_rapports (magasin, magasin_key, code_magasin, periode, date_extraction, animateur, lang, encodage, taille_html, contenu)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(store ? store.libelle : String(b.magasin).slice(0, 120), magasinKey, store ? store.code : (b.codeMagasin ? String(b.codeMagasin).trim() : null),
            b.periode ? String(b.periode).slice(0, 60) : null, dateEx, b.animateur ? String(b.animateur).slice(0, 120) : null,
            b.lang ? String(b.lang).slice(0, 5) : null, b.encodage === 'gzip-b64' ? 'gzip-b64' : 'html',
            Number.isFinite(b.tailleHtml) ? b.tailleHtml : null, b.contenu),
        ]);
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      if (url.pathname === '/pedlv-archives' || url.pathname === '/pedlv-archive-get') {
        if (!env.ARCHIVES) return jsonError("L'archivage des rapports n'est pas encore activé (base d'archives non liée).", 503, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const allowedCodes = sessionAr === 'ALL' ? null : await getAllowedCodes(sessionAr, await getMagasinsServerSide());
        await ensureArchivesTable(env);
        if (url.pathname === '/pedlv-archives') {
          let query = 'SELECT id, magasin, code_magasin, periode, date_extraction, animateur, taille_html, created_at FROM pedlv_rapports WHERE 1=1';
          const binds = [];
          const codeFiltre = url.searchParams.get('code');
          if (codeFiltre) {
            if (allowedCodes && !allowedCodes.includes(codeFiltre)) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
            query += ' AND code_magasin = ?'; binds.push(codeFiltre);
          } else if (allowedCodes) {
            if (!allowedCodes.length) return new Response(JSON.stringify({ ok: true, ar: sessionAr, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            query += ' AND code_magasin IN (' + allowedCodes.map(() => '?').join(',') + ')'; binds.push(...allowedCodes);
          }
          query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
          binds.push(Math.min(parseInt(url.searchParams.get('limit') || '500'), 1000));
          const { results } = await env.ARCHIVES.prepare(query).bind(...binds).all();
          return new Response(JSON.stringify({ ok: true, ar: sessionAr, results: results || [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
        const id = parseInt(url.searchParams.get('id') || '');
        if (!id) return jsonError('Paramètre id requis', 400, corsHeaders);
        const row = await env.ARCHIVES.prepare('SELECT id, magasin, code_magasin, date_extraction, encodage, contenu FROM pedlv_rapports WHERE id = ?').bind(id).first();
        if (!row) return jsonError('Rapport introuvable', 404, corsHeaders);
        if (allowedCodes && !allowedCodes.includes(row.code_magasin)) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
        let html;
        try { html = await decoderArchivePedlv(row.encodage, row.contenu); }
        catch (e) { return jsonError('Rapport archivé illisible : ' + String(e), 500, corsHeaders); }
        return new Response(JSON.stringify({ ok: true, id: row.id, magasin: row.magasin, dateExtraction: row.date_extraction, html }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Statistiques par collaborateur (réutilisées par Suivi Managers) ----------
      if (url.pathname === '/collab-stats-capture') {
        const acces = await accesOutilOuSession(request, env, ['PEDLV_STORE_TOKEN']);
        if (!acces.ok) return jsonError('Non autorisé', 401, corsHeaders);
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        try {
          const { periode, rows } = await request.json();
          if (!periode || !Array.isArray(rows) || !rows.length) return jsonError('Données manquantes', 400, corsHeaders);
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS collab_stats_mensuel (matricule TEXT NOT NULL, periode TEXT NOT NULL, nom_vendeur TEXT, pm_opt REAL, mdc REAL, nb_vente_opt REAL, sop REAL, tx_concret_opt REAL, pack_confort_pct REAL, pack_confort_pm REAL, pm_1ere_paire REAL, pm_audio REAL, tx_concret_audio REAL, ap4 REAL, pct_test_auditif REAL, ca_audio REAL, ca_accessoires_pct REAL, updated_at TEXT, PRIMARY KEY (matricule, periode))`).run();
          const stmt = env.DB.prepare(
            `INSERT INTO collab_stats_mensuel (matricule, periode, nom_vendeur, pm_opt, mdc, nb_vente_opt, sop, tx_concret_opt, pack_confort_pct, pack_confort_pm,
               pm_1ere_paire, pm_audio, tx_concret_audio, ap4, pct_test_auditif, ca_audio, ca_accessoires_pct, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
             ON CONFLICT(matricule, periode) DO UPDATE SET nom_vendeur=excluded.nom_vendeur, pm_opt=excluded.pm_opt, mdc=excluded.mdc, nb_vente_opt=excluded.nb_vente_opt,
               sop=excluded.sop, tx_concret_opt=excluded.tx_concret_opt, pack_confort_pct=excluded.pack_confort_pct, pack_confort_pm=excluded.pack_confort_pm,
               pm_1ere_paire=excluded.pm_1ere_paire, pm_audio=excluded.pm_audio, tx_concret_audio=excluded.tx_concret_audio, ap4=excluded.ap4,
               pct_test_auditif=excluded.pct_test_auditif, ca_audio=excluded.ca_audio, ca_accessoires_pct=excluded.ca_accessoires_pct, updated_at=datetime('now')`);
          const batch = rows.filter(r => r.matricule && r.matricule !== 'null' && String(r.matricule).trim() !== '-')
            .map(r => stmt.bind(String(r.matricule), periode, r.nomVendeur || null, r.pmOpt ?? null, r.mdc ?? null, r.nbVenteOpt ?? null, r.sop ?? null, r.txConcretOpt ?? null,
              r.packConfortPct ?? null, r.packConfortPm ?? null, r.pm1erePaire ?? null, r.pmAudio ?? null, r.txConcretAudio ?? null, r.ap4 ?? null,
              r.pctTestAuditif ?? null, r.caAudio ?? null, r.caAccessoiresPct ?? null));
          if (batch.length) await env.DB.batch(batch);
          return new Response(JSON.stringify({ ok: true, count: batch.length }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur capture stats collaborateur : ' + String(e), 500, corsHeaders);
        }
      }

      // ======================================================================
      // Lot 3b (25/10/2026) — page d'accueil et fermetures réseau
      // ======================================================================
      if (url.pathname === '/accueil-login') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        await ensureAccueilTables(env);
        const { zimbraUser, zimbraPass } = await request.json();
        if (!zimbraUser || !zimbraPass) return jsonError('Identifiant et mot de passe requis', 400, corsHeaders);
        const user = String(zimbraUser).trim();
        const authResp = await fetch(ZIMBRA_SOAP_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
            Body: { AuthRequest: { _jsns: 'urn:zimbraAccount', account: { by: 'name', _content: user }, password: { _content: zimbraPass } } } }),
        });
        const authData = await authResp.json();
        if (!authData?.Body?.AuthResponse?.authToken?.[0]?._content) return jsonError('Identifiants Zimbra invalides', 401, corsHeaders);
        const emailLower = user.toLowerCase();
        const nom = emailLower.split('@')[0].split('.').map(p => p ? p.charAt(0).toUpperCase() + p.slice(1) : p).join(' ');
        const { ar, langueUI } = await resoudreIdentiteInter(emailLower);
        const sections = new Set(['tous']);
        if (ar === 'ALL') ACCUEIL_SECTIONS.forEach(x => sections.add(x));
        else if (ar) sections.add('animateurs');
        const { results: acces } = await env.DB.prepare(`SELECT section FROM accueil_acces WHERE lower(email) = ?`).bind(emailLower).all();
        for (const a of (acces || [])) if (ACCUEIL_SECTIONS_NOMINATIVES.includes(a.section)) sections.add(a.section);
        const sectionsList = ACCUEIL_SECTIONS.filter(x => sections.has(x));
        const token = await createAccueilSession(emailLower, nom, sectionsList);
        // Session AR standard en plus pour l'accès complet, les directeurs pays et
        // les animateurs : déposée par l'accueil pour que les applis soient déjà connectées.
        const arSession = ar ? { token: await createArSession(ar), ar, expiresInMs: AR_SESSION_TTL_MS } : null;
        return new Response(JSON.stringify({ ok: true, token, nom, sections: sectionsList, langueUI, expiresInMs: ACCUEIL_SESSION_TTL_MS, arSession }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      if (url.pathname === '/accueil-apps') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        try {
          await ensureAccueilTables(env);
          const session = await verifyAccueilSession(request.headers.get('X-Accueil-Session'));
          const sections = session ? session.sections : ['tous'];
          const { results } = await env.DB.prepare(`SELECT * FROM accueil_apps WHERE actif = 1 AND section IN (${sections.map(() => '?').join(',')}) ORDER BY section, ordre, nom`).bind(...sections).all();
          return new Response(JSON.stringify({ ok: true, sections, nom: session ? session.nom : null, sessionValide: !!session, apps: (results || []).map(accueilAppRow) }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture accueil : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/accueil-admin') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        if (!(await isAccueilAdmin(request))) return jsonError('Réservé à l\'accès réseau complet', 403, corsHeaders);
        try {
          await ensureAccueilTables(env);
          if (request.method === 'POST') {
            const body = await request.json();
            const now = new Date().toISOString();
            if (body.action === 'app-save') {
              const a = body.app || {};
              const nom = String(a.nom || '').trim().slice(0, 60);
              const lien = String(a.url || '').trim();
              const section = String(a.section || '');
              const icone = String(a.icone || '');
              if (!nom) return jsonError('Nom requis', 400, corsHeaders);
              if (!/^https:\/\/\S+$/.test(lien)) return jsonError('Lien invalide (doit commencer par https://)', 400, corsHeaders);
              if (!ACCUEIL_SECTIONS.includes(section)) return jsonError('Section inconnue', 400, corsHeaders);
              if (icone && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(icone) && !/^https:\/\/\S+$/.test(icone)) return jsonError('Icône invalide', 400, corsHeaders);
              if (icone.length > ACCUEIL_ICONE_MAX) return jsonError('Icône trop lourde (300 Ko maximum)', 400, corsHeaders);
              const champs = [nom, lien, section, icone || null, String(a.description || '').slice(0, 600), String(a.usage || '').slice(0, 600), String(a.frequence || '').slice(0, 200),
                parseInt(a.ordre, 10) || 0, a.actif === 0 || a.actif === false ? 0 : 1, now];
              if (a.id) await env.DB.prepare(`UPDATE accueil_apps SET nom = ?, url = ?, section = ?, icone = ?, description = ?, usage = ?, frequence = ?, ordre = ?, actif = ?, updated_at = ? WHERE id = ?`).bind(...champs, parseInt(a.id, 10)).run();
              else await env.DB.prepare(`INSERT INTO accueil_apps (nom, url, section, icone, description, usage, frequence, ordre, actif, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...champs).run();
            } else if (body.action === 'app-delete') {
              await env.DB.prepare(`DELETE FROM accueil_apps WHERE id = ?`).bind(parseInt(body.id, 10)).run();
            } else if (body.action === 'acces-add') {
              const email = String(body.email || '').trim().toLowerCase();
              const section = String(body.section || '');
              if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonError('Adresse email invalide', 400, corsHeaders);
              if (!ACCUEIL_SECTIONS_NOMINATIVES.includes(section)) return jsonError(section === 'admin' ? 'La section Administration est réservée à l\'accès complet' : 'Section inconnue', 400, corsHeaders);
              await env.DB.prepare(`INSERT OR IGNORE INTO accueil_acces (email, section, created_at) VALUES (?, ?, ?)`).bind(email, section, now).run();
            } else if (body.action === 'acces-delete') {
              await env.DB.prepare(`DELETE FROM accueil_acces WHERE id = ?`).bind(parseInt(body.id, 10)).run();
            } else {
              return jsonError('Action inconnue', 400, corsHeaders);
            }
          }
          const { results: apps } = await env.DB.prepare(`SELECT * FROM accueil_apps ORDER BY section, ordre, nom`).all();
          const { results: acces } = await env.DB.prepare(`SELECT id, email, section FROM accueil_acces ORDER BY section, email`).all();
          return new Response(JSON.stringify({ ok: true, apps: (apps || []).map(accueilAppRow), acces: acces || [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur administration accueil : ' + String(e), 500, corsHeaders);
        }
      }

      if (url.pathname === '/fermetures-reseau') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (sessionAr !== 'ALL') return jsonError('Réservé à l\'accès réseau complet', 403, corsHeaders);
        try {
          await ensureFermeturesTable(env);
          if (request.method === 'POST') {
            const body = await request.json();
            if (body.deleteId != null) {
              await env.DB.prepare(`DELETE FROM fermetures_reseau WHERE id = ?`).bind(parseInt(body.deleteId, 10)).run();
            } else {
              const intitule = String(body.intitule || '').trim().slice(0, 120);
              const dateDebut = String(body.date_debut || '').trim();
              const nbJours = parseInt(body.nb_jours, 10);
              const pays = String(body.pays || '').trim().slice(0, 60) || null;
              if (!intitule) return jsonError('Intitulé requis', 400, corsHeaders);
              if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDebut)) return jsonError('Date de début invalide', 400, corsHeaders);
              if (!(nbJours >= 1 && nbJours <= 31)) return jsonError('Nombre de jours invalide (1 à 31)', 400, corsHeaders);
              if (pays) {
                const connus = new Set((await getMagasinsServerSide()).map(x => x.pays).filter(Boolean));
                if (!connus.has(pays)) return jsonError('Pays inconnu dans magasins_inter.csv', 400, corsHeaders);
              }
              await env.DB.prepare(`INSERT INTO fermetures_reseau (intitule, date_debut, nb_jours, pays, created_at) VALUES (?, ?, ?, ?, ?)`).bind(intitule, dateDebut, nbJours, pays, new Date().toISOString()).run();
            }
          }
          const fermetures = await getFermeturesReseau(env);
          return new Response(JSON.stringify({ ok: true, fermetures }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur fermetures réseau : ' + String(e), 500, corsHeaders);
        }
      }

      // ======================================================================
      // Lot 3 (25/10/2026) — Bilan de Passage au niveau de la France
      // ======================================================================

      // ---------- Un bilan complet (photos comprises) pour régénérer le PDF ----------
      if (url.pathname === '/bilan-get') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const id = parseInt(url.searchParams.get('id') || '');
        if (!id) return jsonError('Paramètre id requis', 400, corsHeaders);
        const row = await env.DB.prepare('SELECT id, magasin_code, data_json FROM bilans WHERE id = ?').bind(id).first();
        if (!row) return jsonError('Bilan introuvable', 404, corsHeaders);
        if (sessionAr !== 'ALL') {
          const allowed = await getAllowedCodes(sessionAr, await getMagasinsServerSide());
          if (!allowed.includes(row.magasin_code)) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
        }
        let data; try { data = JSON.parse(row.data_json); } catch (e) { data = null; }
        return new Response(JSON.stringify({ ok: true, id: row.id, data }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Remontée des bilans restés sur l'appareil (anti-doublon) ----------
      if (url.pathname === '/import-bilans-local') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        let body; try { body = await request.json(); } catch (e) { return jsonError('JSON invalide', 400, corsHeaders); }
        const list = Array.isArray(body?.bilans) ? body.bilans.slice(0, 25) : [];
        if (!list.length) return jsonError('Aucun bilan à importer', 400, corsHeaders);
        const allowedCodes = sessionAr === 'ALL' ? null : await getAllowedCodes(sessionAr, await getMagasinsServerSide());
        let inserted = 0, skipped = 0, refused = 0;
        for (const data of list) {
          const code = data?.magasin?.code || null;
          const dateStr = typeof data?.date === 'string' ? data.date.slice(0, 10) : '';
          if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { refused++; continue; }
          if (allowedCodes && !allowedCodes.includes(code)) { refused++; continue; }
          const passage = data.passage !== undefined && data.passage !== null && data.passage !== '' ? String(data.passage) : null;
          const exists = await env.DB.prepare('SELECT id FROM bilans WHERE magasin_code = ? AND date = ? AND passage IS ? LIMIT 1').bind(code, dateStr, passage).first();
          if (exists) { skipped++; continue; }
          const clean = { ...data, date: dateStr, passage, photos: null, _importeDepuisAppareil: true };
          delete clean.pdfB64;
          await env.DB.prepare(
            `INSERT INTO bilans (magasin_code, magasin_libelle, ar, date, passage, humeur, ca_mensuel, ca_annuel, renta, data_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(code, data?.magasin?.libelle || null, data.ar || null, dateStr, passage,
            data.humeur !== undefined && data.humeur !== '' && data.humeur !== null && !isNaN(parseInt(data.humeur)) ? parseInt(data.humeur) : null,
            data.ca_mensuel || null, data.ca_annuel || null, data.renta || null, JSON.stringify(clean), dateStr + ' 12:00:00').run();
          inserted++;
        }
        return new Response(JSON.stringify({ ok: true, inserted, skipped, refused }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }

      // ---------- Écran de sélection : dernière saisie par appli + indicateurs connus ----------
      if (url.pathname === '/bilan-prefill') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
        const code = url.searchParams.get('magasin_code');
        if (!code) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);
        const stores = await getMagasinsServerSide();
        const store = stores.find(x => x.code === code);
        if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
        if (sessionAr !== 'ALL') {
          const allowed = await getAllowedCodes(sessionAr, stores);
          if (!allowed.includes(code)) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
        }
        try {
          const data = await buildBilanPrefill(env, store);
          return new Response(JSON.stringify({ ok: true, ...data }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur pré-remplissage bilan : ' + String(e), 500, corsHeaders);
        }
      }

      // ---------- Poids du score de santé (lecture libre, écriture accès complet) ----------
      if (url.pathname === '/health-weights' && request.method === 'GET') {
        try {
          const weights = await getHealthWeights(env);
          return new Response(JSON.stringify({ ok: true, weights }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur lecture health_weights : ' + String(e), 500, corsHeaders);
        }
      }
      if (url.pathname === '/health-weights' && request.method === 'POST') {
        if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
        const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
        if (sessionAr !== 'ALL') return jsonError('Réservé à l\'accès réseau complet', 403, corsHeaders);
        try {
          await ensureHealthWeightsTable(env);
          const body = await request.json();
          const now = new Date().toISOString();
          const stmts = [];
          for (const key of Object.keys(POIDS_SANTE_DEFAULT)) {
            if (!(key in body)) continue;
            const value = parseInt(body[key], 10);
            if (!Number.isFinite(value) || value < 0 || value > 10) return jsonError(`Poids invalide pour "${key}" (attendu 0-10)`, 400, corsHeaders);
            stmts.push(env.DB.prepare(`INSERT INTO health_weights (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, value, now));
          }
          if (!stmts.length) return jsonError('Aucun poids reconnu dans la requête', 400, corsHeaders);
          await env.DB.batch(stmts);
          const weights = await getHealthWeights(env);
          return new Response(JSON.stringify({ ok: true, weights }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        } catch (e) {
          return jsonError('Erreur écriture health_weights : ' + String(e), 500, corsHeaders);
        }
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

          // Lot 3 : absences longue durée RH du magasin (hors manager) — pré-remplit
          // la case du bilan de passage, modifiable par l'animateur.
          if (magasinCode) {
            try {
              const { results: ldRows } = await env.DB.prepare(
                `SELECT es.code_site, es.matricule, em.poste, em.prenom, em.nom, a.longue_duree
                 FROM rh_effectif_site_mensuel es
                 JOIN rh_effectif_mensuel em ON em.mois = es.mois AND em.matricule = es.matricule
                 LEFT JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
                 WHERE es.mois = ? AND es.site_reconnu = 1 AND es.code_site = ?`
              ).bind(dernierMois, magasinCode).all();
              const elig = rhEligiblesParMagasin(ldRows, await getMagasinsServerSide())[magasinCode];
              if (elig) (magasins[magasinCode] ??= { eff_opt: 0, eff_audio: 0 }).abs_ld = elig.ldRh;
            } catch (e) { console.error('Absences longue durée (rh-effectif) :', e); }
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
    await invaliderCalculs(env, false);
    const cron = event.cron;
    if (cron === '0 6 * * SUN') {
      ctx.waitUntil(withCronAlert(env, 'Snapshot score de santé', () => snapshotHealthScoreHistory(env)));
    } else if (cron === '0 8 1 * *') {
      // Le 1er : clôture Kaizen du mois écoulé, puis calcul provisoire du score
      // mensuel de ce mois (aucun mail, simple calcul visible dans le dashboard).
      ctx.waitUntil((async () => {
        await withCronAlert(env, 'Clôture Kaizen', () => cloturerAuditsKaizen(env));
        await withCronAlert(env, 'Score mensuel provisoire', () => calculerSanteMensuelProvisoireCron(env));
      })());
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
