export default async function handler(req, res) {
  // URL cruda de tu lista M3U en GitHub
  const GITHUB_M3U_URL = "https://raw.githubusercontent.com/andresosky18/paty-tv/refs/heads/main/colombia.m3u";
  
  // Tu URL real de Firebase
  const FIREBASE_URL = "https://roku-iptv-default-rtdb.firebaseio.com/categorias.json";

  try {
    // 1. Descargar la lista
    const response = await fetch(GITHUB_M3U_URL);
    if (!response.ok) throw new Error("No se pudo descargar la lista de GitHub");
    
    const m3uText = await response.text();
    
    // 2. Procesar el texto
    const datosEstructurados = parsearM3U(m3uText);

    // 3. Enviar a Firebase (Método PUT para sobrescribir)
    const firebaseConfig = {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datosEstructurados)
    };

    const firebaseResponse = await fetch(FIREBASE_URL, firebaseConfig);
    
    if (!firebaseResponse.ok) {
        throw new Error("Hubo un problema al guardar en Firebase");
    }

    // Respuesta final al navegador
    res.status(200).json({ 
      mensaje: "¡Magia pura! Lista procesada y guardada en Firebase exitosamente.", 
      total_categorias: Object.keys(datosEstructurados).length
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Función que lee el texto M3U y lo convierte en JSON estructurado
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
        nombre: nombreCanal || "Canal Sin Nombre",
        logo: logoMatch ? logoMatch[1] : "",
        grupo: groupMatch ? groupMatch[1] : "General"
      };
    } else if (linea.startsWith('http') || linea.startsWith('rtmp')) {
      canalActual.url = linea;
      
      const grupoKey = canalActual.grupo.toLowerCase().replace(/\s+/g, '_');
      
      if (!categorias[grupoKey]) {
        categorias[grupoKey] = [];
      }
      
      categorias[grupoKey].push(canalActual);
      canalActual = {};
    }
  }

  return categorias;
}