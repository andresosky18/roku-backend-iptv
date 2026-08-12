export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Aura-Admin-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const FIREBASE_URL = 'https://roku-iptv-default-rtdb.firebaseio.com/dispositivos';

  const action = req.query.action || req.body?.action || 'get';
  const mac = normalizeMac(req.query.mac || req.body?.mac || '');
  const key = normalizeKey(req.query.key || req.body?.key || '');

  if (!mac) {
    return res.status(400).json({ error: 'MAC inválida.' });
  }

  const deviceUrl = `${FIREBASE_URL}/${mac}.json`;

  try {
    const deviceRes = await fetch(deviceUrl, { cache: 'no-store' });
    if (!deviceRes.ok) {
      return res.status(502).json({ error: 'No fue posible consultar Firebase.' });
    }

    let deviceData = await deviceRes.json();

    // ------------------------------------------------------------
    // 1. REGISTRAR DISPOSITIVO
    // ------------------------------------------------------------
    // Se usa cuando el Roku se presenta por primera vez.
    if (action === 'register') {
      if (key.length !== 6) {
        return res.status(400).json({ error: 'Device Key inválido.' });
      }

      if (!deviceData) {
        deviceData = {
          mac,
          key,
          playlists: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await saveDevice(deviceUrl, deviceData);

        return res.status(200).json({
          ok: true,
          created: true,
          mac,
          key,
          playlists: []
        });
      }

      if (!Array.isArray(deviceData.playlists)) deviceData.playlists = [];

      if (String(deviceData.key || '') !== key) {
        return res.status(409).json({
          error: 'Esta MAC ya está vinculada a otro Device Key.',
          code: 'DEVICE_KEY_MISMATCH',
          needsRelink: true,
          mac
        });
      }

      return res.status(200).json({
        ok: true,
        created: false,
        mac,
        key,
        playlists: deviceData.playlists
      });
    }

    // ------------------------------------------------------------
    // 2. REVINCULAR DESPUÉS DE REINSTALAR AURA TV
    // ------------------------------------------------------------
    // Protegido con una variable de entorno en Vercel:
    // AURA_ADMIN_TOKEN
    //
    // No borra las playlists: solo reemplaza el Device Key.
    if (action === 'relink') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Relink requiere POST.' });
      }

      if (key.length !== 6) {
        return res.status(400).json({ error: 'Nuevo Device Key inválido.' });
      }

      const suppliedToken =
        req.headers['x-aura-admin-token'] ||
        req.body?.adminToken ||
        '';

      const adminToken = process.env.AURA_ADMIN_TOKEN || '';

      if (!adminToken || suppliedToken !== adminToken) {
        return res.status(401).json({ error: 'No autorizado para revincular el dispositivo.' });
      }

      if (!deviceData) {
        deviceData = {
          mac,
          key,
          playlists: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      } else {
        if (!Array.isArray(deviceData.playlists)) deviceData.playlists = [];
        deviceData.key = key;
        deviceData.updatedAt = new Date().toISOString();
      }

      await saveDevice(deviceUrl, deviceData);

      return res.status(200).json({
        ok: true,
        relinked: true,
        mac,
        key,
        playlists: deviceData.playlists
      });
    }

    // Desde aquí todas las acciones necesitan MAC + Key válidas.
    if (key.length !== 6) {
      return res.status(400).json({ error: 'MAC o Device Key inválidos.' });
    }

    // Mantener compatibilidad con tu comportamiento anterior:
    // si no existe todavía, la primera llamada lo crea.
    if (!deviceData) {
      deviceData = {
        mac,
        key,
        playlists: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await saveDevice(deviceUrl, deviceData);
    } else {
      if (!Array.isArray(deviceData.playlists)) deviceData.playlists = [];

      if (String(deviceData.key || '') !== key) {
        return res.status(403).json({
          error: 'El Device Key no coincide con esta dirección MAC.',
          code: 'DEVICE_KEY_MISMATCH',
          needsRelink: true
        });
      }
    }

    // ------------------------------------------------------------
    // 3. LEER PLAYLISTS
    // ------------------------------------------------------------
    if (action === 'get') {
      return res.status(200).json({
        ok: true,
        mac: deviceData.mac || mac,
        playlists: deviceData.playlists
      });
    }

    // ------------------------------------------------------------
    // 4. CREAR / ACTUALIZAR PLAYLIST
    // ------------------------------------------------------------
    if (action === 'upsert') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Upsert requiere POST.' });
      }

      const p = req.body?.playlist;
      if (!p) {
        return res.status(400).json({ error: 'Faltan los datos de la playlist.' });
      }

      const id = p.id
        ? String(p.id).replace(/[^A-Za-z0-9._-]/g, '')
        : `pl-${Date.now()}`;

      const newPlaylist = {
        id,
        name: String(p.name || 'Tv').substring(0, 80),
        type: ['xtream', 'm3u'].includes(p.type) ? p.type : 'xtream',
        host: String(p.host || '').substring(0, 500),
        username: String(p.username || '').substring(0, 200),
        password: String(p.password || '').substring(0, 200),
        url: String(p.url || '').substring(0, 1200)
      };

      let found = false;

      deviceData.playlists = deviceData.playlists.map(existing => {
        if (existing.id === id) {
          found = true;
          return newPlaylist;
        }
        return existing;
      });

      if (!found) deviceData.playlists.push(newPlaylist);

      deviceData.updatedAt = new Date().toISOString();
      await saveDevice(deviceUrl, deviceData);

      return res.status(200).json({
        ok: true,
        playlist: newPlaylist,
        playlists: deviceData.playlists
      });
    }

    // ------------------------------------------------------------
    // 5. ELIMINAR PLAYLIST
    // ------------------------------------------------------------
    if (action === 'delete') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Delete requiere POST.' });
      }

      const id = String(req.body?.id || '');
      deviceData.playlists = deviceData.playlists.filter(p => p.id !== id);
      deviceData.updatedAt = new Date().toISOString();

      await saveDevice(deviceUrl, deviceData);

      return res.status(200).json({
        ok: true,
        playlists: deviceData.playlists
      });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });

  } catch (error) {
    console.error('AURA dispositivos API:', error);

    return res.status(500).json({
      error: 'Error interno conectando con la base de datos.'
    });
  }
}

function normalizeMac(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-F0-9]/g, '');
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/[^0-9]/g, '')
    .slice(0, 6);
}

async function saveDevice(url, data) {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  if (!r.ok) {
    throw new Error('No fue posible guardar el dispositivo en Firebase.');
  }
}

