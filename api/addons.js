import { getAdminDb } from '../lib/firebaseAdmin.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 9000;
const MAX_REDIRECTS = 3;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = String(req.query.action || req.body?.action || 'list');
  const mac = normalizeMac(req.query.mac || req.body?.mac || '');
  const key = normalizeKey(req.query.key || req.body?.key || '');

  if (!mac || key.length !== 6) {
    return res.status(400).json({ error: 'MAC o Device Key inválidos.' });
  }

  try {
    const db = getAdminDb();
    const deviceRef = db.ref(`dispositivos/${mac}`);
    const snapshot = await deviceRef.get();

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: 'El dispositivo no está registrado.',
        code: 'DEVICE_NOT_FOUND'
      });
    }

    const device = snapshot.val() || {};

    if (String(device.key || '') !== key) {
      return res.status(403).json({
        error: 'El Device Key no coincide con esta dirección MAC.',
        code: 'DEVICE_KEY_MISMATCH'
      });
    }

    const addons = Array.isArray(device.addons) ? device.addons : [];

    // ----------------------------------------------------------
    // LISTAR ADD-ONS INSTALADOS
    // ----------------------------------------------------------
    if (action === 'list') {
      return res.status(200).json({
        ok: true,
        addons: addons.map(publicAddon)
      });
    }

    // ----------------------------------------------------------
    // INSTALAR / ACTUALIZAR ADD-ON DESDE manifest.json
    // ----------------------------------------------------------
    if (action === 'install') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Install requiere POST.' });
      }

      const manifestUrl = String(req.body?.manifestUrl || '').trim();

      if (!manifestUrl) {
        return res.status(400).json({ error: 'Falta la URL del manifest.json.' });
      }

      const manifest = await safeFetchJson(manifestUrl);
      const normalizedManifest = validateAndNormalizeManifest(manifest, manifestUrl);

      const addon = {
        id: normalizedManifest.id,
        manifestUrl: normalizedManifest.manifestUrl,
        baseUrl: normalizedManifest.baseUrl,
        name: normalizedManifest.name,
        version: normalizedManifest.version,
        description: normalizedManifest.description,
        logo: normalizedManifest.logo,
        resources: normalizedManifest.resources,
        types: normalizedManifest.types,
        catalogs: normalizedManifest.catalogs,
        installedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const next = [...addons];
      const idx = next.findIndex(a => String(a?.id || '') === addon.id);

      if (idx >= 0) {
        addon.installedAt = next[idx].installedAt || addon.installedAt;
        next[idx] = addon;
      } else {
        next.push(addon);
      }

      await deviceRef.child('addons').set(next);

      return res.status(200).json({
        ok: true,
        addon: publicAddon(addon),
        addons: next.map(publicAddon)
      });
    }

    // ----------------------------------------------------------
    // DESINSTALAR
    // ----------------------------------------------------------
    if (action === 'remove') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Remove requiere POST.' });
      }

      const addonId = String(req.body?.addonId || '').trim();
      if (!addonId) return res.status(400).json({ error: 'Falta addonId.' });

      const next = addons.filter(a => String(a?.id || '') !== addonId);
      await deviceRef.child('addons').set(next);

      return res.status(200).json({
        ok: true,
        addons: next.map(publicAddon)
      });
    }

    // Las siguientes acciones consultan el add-on remoto
    const addonId = String(req.query.addonId || req.body?.addonId || '').trim();
    const addon = addons.find(a => String(a?.id || '') === addonId);

    if (!addon) {
      return res.status(404).json({ error: 'Add-on no instalado.' });
    }

    // ----------------------------------------------------------
    // CATÁLOGO
    // /catalog/{type}/{catalogId}.json
    // /catalog/{type}/{catalogId}/{extra}.json
    // ----------------------------------------------------------
    if (action === 'catalog') {
      const type = safeSegment(req.query.type || '');
      const catalogId = safeSegment(req.query.catalogId || '');
      const extra = normalizeExtra(req.query.extra || '');

      if (!type || !catalogId) {
        return res.status(400).json({ error: 'Faltan type o catalogId.' });
      }

      const catalog = (addon.catalogs || []).find(c =>
        String(c.type) === type && String(c.id) === catalogId
      );

      if (!catalog) {
        return res.status(404).json({ error: 'Catálogo no declarado por el add-on.' });
      }

      let url = `${stripTrailingSlash(addon.baseUrl)}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}`;
      if (extra) url += `/${extra}`;
      url += '.json';

      const data = await safeFetchJson(url);

      return res.status(200).json({
        ok: true,
        addon: publicAddon(addon),
        catalog,
        metas: normalizeMetas(data?.metas)
      });
    }

    // ----------------------------------------------------------
    // META
    // /meta/{type}/{id}.json
    // ----------------------------------------------------------
    if (action === 'meta') {
      const type = safeSegment(req.query.type || '');
      const id = safeId(req.query.id || '');

      if (!type || !id) {
        return res.status(400).json({ error: 'Faltan type o id.' });
      }

      if (!supportsResource(addon.resources, 'meta', type)) {
        return res.status(400).json({ error: 'El add-on no declara recurso meta para este tipo.' });
      }

      const url = `${stripTrailingSlash(addon.baseUrl)}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
      const data = await safeFetchJson(url);

      return res.status(200).json({
        ok: true,
        meta: normalizeMeta(data?.meta || data)
      });
    }

    // ----------------------------------------------------------
    // STREAMS
    // /stream/{type}/{id}.json
    // En AURA v1 solo marcamos como reproducibles URLs HTTP(S)
    // directas, que luego podrá usar el Video node de Roku.
    // ----------------------------------------------------------
    if (action === 'streams') {
      const type = safeSegment(req.query.type || '');
      const id = safeId(req.query.id || '');

      if (!type || !id) {
        return res.status(400).json({ error: 'Faltan type o id.' });
      }

      if (!supportsResource(addon.resources, 'stream', type) &&
          !supportsResource(addon.resources, 'streams', type)) {
        return res.status(400).json({ error: 'El add-on no declara recurso stream.' });
      }

      const url = `${stripTrailingSlash(addon.baseUrl)}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
      const data = await safeFetchJson(url);
      const streams = normalizeStreams(data?.streams);

      return res.status(200).json({
        ok: true,
        streams,
        playableCount: streams.filter(s => s.playable).length
      });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });

  } catch (error) {
    console.error('AURA add-ons API:', error);

    return res.status(error?.statusCode || 500).json({
      error: error?.publicMessage || 'Error procesando el add-on.'
    });
  }
}

function normalizeMac(value) {
  return String(value || '').toUpperCase().replace(/[^A-F0-9]/g, '');
}

function normalizeKey(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 6);
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function safeSegment(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 120) return '';
  if (!/^[A-Za-z0-9._:-]+$/.test(v)) return '';
  return v;
}

function safeId(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 500) return '';
  if (/[\r\n]/.test(v)) return '';
  return v;
}

function normalizeExtra(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const pieces = raw.split('&').slice(0, 8);
  const normalized = [];

  for (const piece of pieces) {
    const [key, ...rest] = piece.split('=');
    const val = rest.join('=');

    if (!key || key.length > 80 || val.length > 300) continue;
    normalized.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
  }

  return normalized.join('&');
}

function validateAndNormalizeManifest(manifest, manifestUrl) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw publicError(400, 'El manifest.json no contiene un objeto JSON válido.');
  }

  const id = String(manifest.id || '').trim();
  const name = String(manifest.name || '').trim();
  const version = String(manifest.version || '').trim();
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const types = Array.isArray(manifest.types) ? manifest.types.map(String) : [];
  const catalogs = Array.isArray(manifest.catalogs) ? manifest.catalogs : [];

  if (!id || !name || !version) {
    throw publicError(400, 'El manifest debe incluir id, name y version.');
  }

  if (!resources.length && !catalogs.length) {
    throw publicError(400, 'El manifest no declara resources ni catalogs.');
  }

  const parsed = new URL(manifestUrl);
  const pathname = parsed.pathname.replace(/\/+$/, '');

  if (!pathname.toLowerCase().endsWith('/manifest.json')) {
    throw publicError(400, 'La URL debe apuntar a un manifest.json.');
  }

  const basePath = pathname.slice(0, -'/manifest.json'.length);
  parsed.pathname = basePath || '/';
  parsed.search = '';
  parsed.hash = '';

  return {
    id: id.substring(0, 200),
    name: name.substring(0, 120),
    version: version.substring(0, 60),
    description: String(manifest.description || '').substring(0, 800),
    logo: safeHttpUrlOrEmpty(manifest.logo),
    resources: normalizeResources(resources),
    types: types.slice(0, 30).map(v => v.substring(0, 60)),
    catalogs: normalizeCatalogs(catalogs),
    manifestUrl: String(manifestUrl).substring(0, 1800),
    baseUrl: stripTrailingSlash(parsed.toString())
  };
}

function normalizeResources(resources) {
  return resources.slice(0, 50).map(r => {
    if (typeof r === 'string') {
      return r.substring(0, 80);
    }

    if (r && typeof r === 'object') {
      return {
        name: String(r.name || '').substring(0, 80),
        types: Array.isArray(r.types) ? r.types.slice(0, 30).map(String) : [],
        idPrefixes: Array.isArray(r.idPrefixes) ? r.idPrefixes.slice(0, 40).map(String) : []
      };
    }

    return '';
  }).filter(Boolean);
}

function normalizeCatalogs(catalogs) {
  return catalogs.slice(0, 100).map(c => {
    if (!c || typeof c !== 'object') return null;

    return {
      id: String(c.id || '').substring(0, 160),
      type: String(c.type || '').substring(0, 80),
      name: String(c.name || c.id || '').substring(0, 160),
      genres: Array.isArray(c.genres) ? c.genres.slice(0, 100).map(String) : [],
      extra: Array.isArray(c.extra) ? c.extra.slice(0, 30).map(x => ({
        name: String(x?.name || '').substring(0, 80),
        isRequired: Boolean(x?.isRequired),
        options: Array.isArray(x?.options) ? x.options.slice(0, 100).map(String) : []
      })) : []
    };
  }).filter(c => c && c.id && c.type);
}

function supportsResource(resources, resourceName, type) {
  return (resources || []).some(r => {
    if (typeof r === 'string') return r === resourceName;

    if (!r || typeof r !== 'object') return false;
    if (String(r.name || '') !== resourceName) return false;

    if (!Array.isArray(r.types) || !r.types.length) return true;
    return r.types.map(String).includes(type);
  });
}

function publicAddon(addon) {
  return {
    id: String(addon?.id || ''),
    name: String(addon?.name || ''),
    version: String(addon?.version || ''),
    description: String(addon?.description || ''),
    logo: safeHttpUrlOrEmpty(addon?.logo),
    manifestUrl: String(addon?.manifestUrl || ''),
    resources: Array.isArray(addon?.resources) ? addon.resources : [],
    types: Array.isArray(addon?.types) ? addon.types : [],
    catalogs: Array.isArray(addon?.catalogs) ? addon.catalogs : [],
    installedAt: addon?.installedAt || ''
  };
}

function normalizeMetas(metas) {
  if (!Array.isArray(metas)) return [];
  return metas.slice(0, 300).map(normalizeMeta).filter(m => m.id && m.name);
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};

  return {
    id: String(meta.id || '').substring(0, 500),
    type: String(meta.type || '').substring(0, 80),
    name: String(meta.name || '').substring(0, 240),
    description: String(meta.description || '').substring(0, 4000),
    poster: safeHttpUrlOrEmpty(meta.poster),
    background: safeHttpUrlOrEmpty(meta.background),
    logo: safeHttpUrlOrEmpty(meta.logo),
    releaseInfo: String(meta.releaseInfo || '').substring(0, 120),
    imdbRating: String(meta.imdbRating || '').substring(0, 30),
    runtime: String(meta.runtime || '').substring(0, 80),
    genres: Array.isArray(meta.genres) ? meta.genres.slice(0, 30).map(String) : [],
    videos: Array.isArray(meta.videos) ? meta.videos.slice(0, 500).map(v => ({
      id: String(v?.id || '').substring(0, 500),
      title: String(v?.title || v?.name || '').substring(0, 240),
      season: Number.isFinite(Number(v?.season)) ? Number(v.season) : null,
      episode: Number.isFinite(Number(v?.episode)) ? Number(v.episode) : null,
      released: v?.released || ''
    })) : []
  };
}

function normalizeStreams(streams) {
  if (!Array.isArray(streams)) return [];

  return streams.slice(0, 100).map((s, index) => {
    const directUrl = safeHttpUrlOrEmpty(s?.url);

    if (directUrl) {
      return {
        index,
        name: String(s?.name || '').substring(0, 160),
        title: String(s?.title || '').substring(0, 300),
        url: directUrl,
        playable: true,
        protocol: new URL(directUrl).protocol.replace(':', '')
      };
    }

    return {
      index,
      name: String(s?.name || '').substring(0, 160),
      title: String(s?.title || '').substring(0, 300),
      url: '',
      playable: false,
      reason: 'AURA TV v1 solo reproduce streams directos HTTP/HTTPS.'
    };
  });
}

function safeHttpUrlOrEmpty(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

async function safeFetchJson(inputUrl, redirects = 0) {
  if (redirects > MAX_REDIRECTS) {
    throw publicError(400, 'El add-on produjo demasiadas redirecciones.');
  }

  const url = await validatePublicRemoteUrl(inputUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json, text/json;q=0.9, */*;q=0.2',
        'User-Agent': 'AuraTV-AddonAdapter/1.0'
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw publicError(502, 'Redirección inválida del add-on.');

      const next = new URL(location, url);
      return safeFetchJson(next.toString(), redirects + 1);
    }

    if (!response.ok) {
      throw publicError(502, `El add-on respondió HTTP ${response.status}.`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_JSON_BYTES) {
      throw publicError(413, 'La respuesta JSON del add-on es demasiado grande.');
    }

    const text = await response.text();

    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) {
      throw publicError(413, 'La respuesta JSON del add-on es demasiado grande.');
    }

    try {
      return JSON.parse(text);
    } catch {
      throw publicError(502, 'El add-on no devolvió JSON válido.');
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw publicError(504, 'El add-on tardó demasiado en responder.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function validatePublicRemoteUrl(value) {
  let url;

  try {
    url = new URL(String(value || ''));
  } catch {
    throw publicError(400, 'URL de add-on inválida.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw publicError(400, 'Solo se permiten URLs HTTP o HTTPS.');
  }

  const host = url.hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    throw publicError(400, 'Host privado no permitido.');
  }

  if (isIP(host)) {
    if (isPrivateIp(host)) throw publicError(400, 'IP privada no permitida.');
    return url;
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw publicError(400, 'No fue posible resolver el dominio del add-on.');
  }

  if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) {
    throw publicError(400, 'El dominio del add-on resuelve a una red privada no permitida.');
  }

  return url;
}

function isPrivateIp(ip) {
  if (!ip) return true;

  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80:')
    );
  }

  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;

  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    p[0] >= 224
  );
}

function publicError(statusCode, publicMessage) {
  const e = new Error(publicMessage);
  e.statusCode = statusCode;
  e.publicMessage = publicMessage;
  return e;
}
