export default async function handler(req, res) {
  // URL cruda de tu lista M3U en GitHub
  const GITHUB_M3U_URL = "https://raw.githubusercontent.com/andresosky18/paty-tv/refs/heads/main/colombia.m3u";
  
  try {
    const response = await fetch(GITHUB_M3U_URL);
    if (!response.ok) throw new Error("No se pudo descargar la lista de GitHub");
    
    const m3uText = await response.text();
    const datosEstructurados = parsearM3U(m3uText);

    // TODO: En el futuro, aquí agregaremos el código para enviar a Firebase.
    // Por ahora, devolvemos el JSON al navegador para probar que funciona.
    res.status(200).json({ 
      mensaje: "Procesamiento exitoso", 
      total_categorias: Object.keys(datosEstructurados).length,
      datos: datosEstructurados 
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