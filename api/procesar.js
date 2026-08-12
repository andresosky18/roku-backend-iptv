import { getAdminDb } from '../lib/firebaseAdmin.js';

const GITHUB_M3U_URL =
  'https://raw.githubusercontent.com/andresosky18/paty-tv/refs/heads/main/colombia.m3u';

export default async function handler(req, res) {
  try {
    const response = await fetch(GITHUB_M3U_URL);
    if (!response.ok) throw new Error('No se pudo descargar la lista de GitHub');

    const m3uText = await response.text();
    const datosEstructurados = parsearM3U(m3uText);

    const db = getAdminDb();
    await db.ref('categorias').set(datosEstructurados);

    return res.status(200).json({
      mensaje: 'Lista procesada y guardada en Firebase.',
      total_categorias: Object.keys(datosEstructurados).length
    });
  } catch (error) {
    console.error('AURA procesar API:', error);
    return res.status(500).json({ error: error.message });
  }
}

function parsearM3U(texto) {
  const lineas = texto.split('\n');
  const categorias = {};
  let canalActual = {};

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i].trim();
    if (!linea || linea === '#EXTM3U') continue;

    if (linea.startsWith('#EXTINF:')) {
      const logoMatch = linea.match(/tvg-logo="([^"]+)"/);
      const groupMatch = linea.match(/group-title="([^"]+)"/);
      const partesComa = linea.split(',');
      const nombreCanal = partesComa[partesComa.length - 1].trim();

      canalActual = {
        nombre: nombreCanal || 'Canal Sin Nombre',
        logo: logoMatch ? logoMatch[1] : '',
        grupo: groupMatch ? groupMatch[1] : 'General'
      };
    } else if (linea.startsWith('http') || linea.startsWith('rtmp')) {
      canalActual.url = linea;
      let grupoKey = String(canalActual.grupo || 'general')
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');

      if (!grupoKey) grupoKey = 'general';
      if (!categorias[grupoKey]) categorias[grupoKey] = [];
      categorias[grupoKey].push(canalActual);
      canalActual = {};
    }
  }

  return categorias;
}
