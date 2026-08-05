export default async function handler(req, res) {
  // 1. Configurar reglas de seguridad (CORS) para permitir acceso desde tu web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. Conexión a tu Firebase (usamos una carpeta nueva llamada 'dispositivos')
  const FIREBASE_URL = "https://roku-iptv-default-rtdb.firebaseio.com/dispositivos";

  // 3. Extraer y limpiar parámetros
  const action = req.query.action || req.body?.action || 'get';
  const mac = (req.query.mac || req.body?.mac || '').toUpperCase().replace(/[^A-F0-9]/g, '');
  const key = (req.query.key || req.body?.key || '').replace(/[^0-9]/g, '');

  if (!mac || key.length !== 6) {
    return res.status(400).json({ error: 'MAC o código de dispositivo inválidos.' });
  }

  const deviceUrl = `${FIREBASE_URL}/${mac}.json`;

  try {
    // 4. Obtener datos actuales del dispositivo desde Firebase
    let deviceRes = await fetch(deviceUrl);
    let deviceData = await deviceRes.json();

    // Si el dispositivo es nuevo, lo registramos
    if (!deviceData) {
      deviceData = { mac, key, playlists: [] };
      await fetch(deviceUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceData)
      });
    } else {
      // Si ya existe, validamos que el PIN coincida por seguridad
      if (deviceData.key !== key) {
        return res.status(403).json({ error: 'El código no coincide con esta dirección MAC.' });
      }
      if (!deviceData.playlists) deviceData.playlists = [];
    }

    // ACCIÓN A: LEER LISTAS (Para que el Roku las descargue)
    if (action === 'get') {
      return res.status(200).json({ ok: true, mac: deviceData.mac, playlists: deviceData.playlists });
    }

    // ACCIÓN B: GUARDAR O ACTUALIZAR LISTA (Desde tu página web)
    if (action === 'upsert') {
      const p = req.body?.playlist;
      if (!p) return res.status(400).json({ error: 'Faltan los datos de la playlist.' });

      const id = p.id ? p.id.replace(/[^A-Za-z0-9._-]/g, '') : `pl-${Date.now()}`;
      const newPlaylist = {
        id: id,
        name: (p.name || 'Tv').substring(0, 80),
        type: ['xtream', 'm3u'].includes(p.type) ? p.type : 'xtream',
        host: (p.host || '').substring(0, 500),
        username: (p.username || '').substring(0, 200),
        password: (p.password || '').substring(0, 200),
        url: (p.url || '').substring(0, 1200)
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

      // Enviar la actualización a Firebase
      await fetch(deviceUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceData)
      });

      return res.status(200).json({ ok: true, playlist: newPlaylist, playlists: deviceData.playlists });
    }

    // ACCIÓN C: BORRAR LISTA (Desde tu página web o Roku)
    if (action === 'delete') {
      const id = req.body?.id || '';
      deviceData.playlists = deviceData.playlists.filter(p => p.id !== id);

      await fetch(deviceUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceData)
      });

      return res.status(200).json({ ok: true, playlists: deviceData.playlists });
    }

    return res.status(400).json({ error: 'Acción desconocida.' });

  } catch (error) {
    return res.status(500).json({ error: 'Error interno conectando con la base de datos.' });
  }
}