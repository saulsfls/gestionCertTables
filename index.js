// index.js - Versión optimizada para GLM-OCR / modelos de visión
// Mejoras: preservación de decimales, preprocesamiento, post-proceso inteligente,
// validación cruzada por columnas, monotonía y soporte HTML/Texto.
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100mb' }));

// ==================== MULTER ====================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/tiff', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de archivo no soportado. Use JPEG, PNG, TIFF o WEBP.'));
        }
    }
});

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL_NAME = process.env.MODEL_NAME || 'glm-ocr';

console.log(`🤖 Usando modelo: ${MODEL_NAME}`);

// ==================== HELPERS DE LIMPIEZA DE TEXTO ====================

/**
 * Elimina espacios espurios dentro de números.
 * Ej: "10 000" -> "10000", "10 , 5" -> "10,5"
 */
function removeSpacesInNumbers(text) {
    if (!text) return text;

    let cleaned = text.replace(/(\d)\s+(\d)/g, '$1$2');
    cleaned = cleaned.replace(/(\d)\s+([,.])\s+(\d)/g, '$1$2$3');
    cleaned = cleaned.replace(/(\d)([,.])\s+(\d)/g, '$1$2$3');
    cleaned = cleaned.replace(/(\d)\s+([,.])(\d)/g, '$1$2$3');

    return cleaned;
}

/**
 * Convierte comas decimales a puntos sin romper separadores de miles.
 */
function convertCommasToDots(text) {
    if (!text) return text;

    const lines = text.split('\n');
    const convertedLines = lines.map(line => {
        if (line.includes('|') || line.includes('\t') || line.includes(';')) {
            let separator = '|';
            if (line.includes('\t')) separator = '\t';
            else if (line.includes(';')) separator = ';';

            const columns = line.split(separator);
            const processedColumns = columns.map(col => {
                let cleaned = col.trim();
                if (/\d[,.]\d/.test(cleaned)) {
                    cleaned = cleaned.replace(/\.(?=\d{3})/g, '');
                    cleaned = cleaned.replace(/,/g, '.');
                }
                if (/\d+,\d+/.test(cleaned) && !/,\s/.test(cleaned)) {
                    const decimalMatch = cleaned.match(/^(\d+)[,.](\d+)$/);
                    if (decimalMatch) {
                        cleaned = cleaned.replace(/,/g, '.');
                    }
                }
                return cleaned;
            });
            return processedColumns.join(separator);
        } else {
            return line.replace(/(\d+)[,.](\d+)/g, (match) => {
                if (match.includes('.') && match.match(/^\d{1,3}\.\d{3}/)) {
                    return match.replace(/\./g, '');
                }
                if (match.includes(',')) {
                    return match.replace(/,/g, '.');
                }
                return match;
            });
        }
    });
    return convertedLines.join('\n');
}

// ==================== PREPROCESAMIENTO DE IMAGEN ====================

/**
 * Prepara la imagen para el modelo de visión.
 * NUNCA reduce por debajo de 1600px (crítico para decimales pequeños).
 */
async function prepararImagenParaOCR(imageBuffer) {
    const stats = await sharp(imageBuffer).metadata();
    const anchoOriginal = stats.width || 0;
    const altoOriginal = stats.height || 0;
    const fileSizeMB = imageBuffer.length / (1024 * 1024);

    console.log(`📐 Imagen original: ${anchoOriginal}x${altoOriginal} (${fileSizeMB.toFixed(2)}MB)`);

    const necesitaUpscale = anchoOriginal < 1600;

    let pipeline = sharp(imageBuffer);

    if (necesitaUpscale) {
        const factor = Math.min(1600 / anchoOriginal, 3);
        const nuevoAncho = Math.round(anchoOriginal * factor);
        console.log(`🔍 Upscale: ${anchoOriginal} → ${nuevoAncho}px (factor ${factor.toFixed(2)})`);
        pipeline = pipeline.resize({
            width: nuevoAncho,
            kernel: 'lanczos3',
            withoutEnlargement: false
        });
    } else if (anchoOriginal > 3000) {
        console.log(`📉 Reducción controlada a 2400px`);
        pipeline = pipeline.resize({
            width: 2400,
            kernel: 'lanczos3',
            withoutEnlargement: true
        });
    } else {
        console.log(`✅ Tamaño adecuado, sin resize`);
    }

    pipeline = pipeline
        .grayscale()
        .normalize()
        .sharpen({ sigma: 1.2, m1: 0.5, m2: 2.0 });

    const bufferResultante = await pipeline
        .png({ compressionLevel: 9 })
        .toBuffer();

    const sizeFinal = bufferResultante.length / (1024 * 1024);
    console.log(`📦 Imagen procesada: ${sizeFinal.toFixed(2)}MB`);

    return bufferResultante;
}

/**
 * Variante con binarización agresiva: útil para tablas con fondo blanco
 * y texto claro. Reduce ruido que confunde puntos decimales.
 */
async function prepararImagenBinarizada(imageBuffer) {
    return await sharp(imageBuffer)
        .grayscale()
        .normalize()
        .resize({ width: 2400, kernel: 'lanczos3', withoutEnlargement: false })
        .threshold(175)
        .png({ compressionLevel: 9 })
        .toBuffer();
}

// ==================== POST-PROCESO NUMÉRICO ====================

/**
 * Intenta corregir un valor numérico que perdió el punto decimal.
 * Prueba insertar el punto en cada posición y elige el que cumple:
 *      low ≤ candidato ≤ high
 * Si no hay rango (low=NaN o high=NaN), devuelve el valor sin tocar.
 */
function corregirValorPorRango(valorStr, lowStr, highStr) {
    const v = Number(valorStr);
    const low = Number(lowStr);
    const high = Number(highStr);

    if (isNaN(v)) return valorStr;
    if (isNaN(low) || isNaN(high)) return valorStr;

    // Si ya está dentro del rango, no tocar
    if (v >= low && v <= high) return valorStr;

    const digitos = String(Math.abs(v));
    const signo = v < 0 ? '-' : '';

    // Probar insertar el punto en cada posición
    for (let pos = 1; pos < digitos.length; pos++) {
        const candidato = Number(
            signo + digitos.slice(0, pos) + '.' + digitos.slice(pos)
        );
        if (candidato >= low && candidato <= high) {
            return String(candidato);
        }
    }

    // Último recurso: insertar ceros tras el punto ("99935" -> "0.99935")
    for (let pos = 1; pos < digitos.length; pos++) {
        for (let ceros = 1; ceros <= 3; ceros++) {
            const candidato = Number(
                signo + '0.' + '0'.repeat(ceros - 1) + digitos.slice(0, pos) + digitos.slice(pos)
            );
            if (candidato >= low && candidato <= high) {
                return String(candidato);
            }
        }
    }

    return valorStr;
}

/**
 * Detecta índices de columnas por nombre (español / inglés).
 */
function detectarColumnas(headers) {
    return {
        low: headers.findIndex(h => /low|mínimo|minimo|min\b/i.test(h)),
        high: headers.findIndex(h => /high|máximo|maximo|max\b/i.test(h)),
        measured: headers.findIndex(h => /measured|medida|valor|reading|lectura/i.test(h)),
        unc: headers.findIndex(h => /uncertain|incertid|u\b/i.test(h)),
        calPoint: headers.findIndex(h => /cal|punto|point/i.test(h))
    };
}

/**
 * Corrige valores sospechosos en una fila.
 * Aplica:
 *  1. low ≤ measured ≤ high
 *  2. uncertainty < (high - low)
 *  3. uncertainty > 0
 */
function corregirFilaNumerica(valores, headers) {
    const idx = detectarColumnas(headers);
    const nuevos = [...valores];

    // Regla 1: measured dentro de [low, high]
    if (idx.low !== -1 && idx.high !== -1 && idx.measured !== -1) {
        const low = valores[idx.low];
        const high = valores[idx.high];
        const measured = valores[idx.measured];

        if (low && high && measured) {
            nuevos[idx.measured] = corregirValorPorRango(measured, low, high);
        }
    }

    // Regla 2: uncertainty razonable
    if (idx.unc !== -1 && valores[idx.unc] && idx.measured !== -1) {
        const u = Number(valores[idx.unc]);
        const m = Number(nuevos[idx.measured]);

        // Caso 2a: incertidumbre absurdamente grande (>1000) => decimal perdido
        if (!isNaN(u) && u > 1000) {
            for (const div of [10, 100, 1000, 10000, 100000]) {
                const cand = u / div;
                if (cand < 1000 && (isNaN(m) || cand < Math.abs(m))) {
                    nuevos[idx.unc] = String(cand);
                    break;
                }
            }
        }
        // Caso 2b: incertidumbre mayor que el valor medido (imposible)
        else if (!isNaN(u) && !isNaN(m) && Math.abs(m) > 0 && u > Math.abs(m)) {
            const corregido = corregirValorPorRango(
                valores[idx.unc],
                '0',
                String(Math.abs(m))
            );
            nuevos[idx.unc] = corregido;
        }
    }

    return nuevos;
}

/**
 * Regla de monotonía: si low crece fila a fila, uncertainty también.
 * Cuando una fila rompe la monotonía, intenta multiplicar por 10/100/1000.
 * Devuelve las filas corregidas.
 */
function corregirMonotonia(filas, headers) {
    const idx = detectarColumnas(headers);
    if (idx.low === -1 || idx.unc === -1) return filas;

    const corregidas = filas.map(f => [...f]);

    for (let i = 1; i < corregidas.length; i++) {
        const lowPrev = parseNum(corregidas[i - 1][idx.low]);
        const lowCurr = parseNum(corregidas[i][idx.low]);
        const uncPrev = parseNum(corregidas[i - 1][idx.unc]);
        const uncCurr = parseNum(corregidas[i][idx.unc]);

        if ([lowPrev, lowCurr, uncPrev, uncCurr].some(isNaN)) continue;

        // Si low crece al menos 5x y uncertainty decrece → sospechoso
        if (lowCurr > lowPrev * 5 && uncCurr < uncPrev) {
            for (const factor of [10, 100, 1000]) {
                const candidato = uncCurr * factor;
                if (candidato >= uncPrev && candidato < lowCurr) {
                    corregidas[i][idx.unc] = String(candidato);
                    console.log(
                        `🔧 Monotonía: fila ${i} uncertainty ${uncCurr} → ${candidato} ` +
                        `(prev=${uncPrev}, low×${(lowCurr / lowPrev).toFixed(1)})`
                    );
                    break;
                }
            }
        }
    }

    return corregidas;
}

function parseNum(v) {
    if (v === null || v === undefined || v === '') return NaN;
    const s = String(v).trim().replace(',', '.');
    const n = Number(s);
    return isNaN(n) ? NaN : n;
}

// ==================== PROCESAMIENTO DE HTML ====================

/**
 * Extrae filas de datos de un HTML de tabla (solo <td>).
 */
function extraerFilasHtml(html) {
    const filasMatch = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    if (filasMatch.length < 2) return { headers: [], filas: [], filasRaw: [] };

    const headerMatch = filasMatch[0].match(/<th[^>]*>[\s\S]*?<\/th>/gi) || [];
    if (headerMatch.length === 0) return { headers: [], filas: [], filasRaw: [] };

    const headers = headerMatch.map(h => h.replace(/<[^>]+>/g, '').trim());

    const filas = [];
    const filasRaw = [];
    for (let i = 1; i < filasMatch.length; i++) {
        const celdasMatch = filasMatch[i].match(/<td[^>]*>[\s\S]*?<\/td>/gi);
        if (!celdasMatch) continue;
        const valores = celdasMatch.map(c => c.replace(/<[^>]+>/g, '').trim());
        filas.push(valores);
        filasRaw.push({ fila: filasMatch[i], celdasMatch, valores });
    }

    return { headers, filas, filasRaw };
}

/**
 * Reconstruye el HTML con las filas corregidas.
 */
function reconstruirHtml(html, filasRaw, filasCorregidas) {
    let resultado = html;
    filasRaw.forEach((f, i) => {
        const corregidos = filasCorregidas[i];
        if (!corregidos) return;

        let filaNueva = f.fila;
        f.celdasMatch.forEach((celdaOrig, j) => {
            const atributos = (celdaOrig.match(/<td([^>]*)>/i) || ['', ''])[1];
            const nuevaCelda = `<td${atributos}>${corregidos[j]}</td>`;
            filaNueva = filaNueva.replace(celdaOrig, nuevaCelda);
        });

        resultado = resultado.replace(f.fila, filaNueva);
    });
    return resultado;
}

/**
 * Corrige decimales en una tabla HTML: aplica reglas por fila + monotonía.
 */
function corregirDecimalesEnTablaHtml(html) {
    const { headers, filas, filasRaw } = extraerFilasHtml(html);
    if (filas.length === 0) return html;

    // Paso 1: corrección por fila (low ≤ measured ≤ high, uncertainty)
    let filasCorregidas = filas.map(fila => corregirFilaNumerica(fila, headers));

    // Paso 2: corrección por monotonía entre filas
    filasCorregidas = corregirMonotonia(filasCorregidas, headers);

    // Paso 3: reconstruir el HTML
    return reconstruirHtml(html, filasRaw, filasCorregidas);
}

/**
 * Convierte texto tabular con "|" a HTML válido.
 */
function textoAHtmlTabla(texto) {
    const lineas = texto.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && l.includes('|'));

    if (lineas.length < 2) return texto;

    const filas = lineas.map(l =>
        l.split('|').map(c => c.trim()).filter(c => c.length > 0)
    );

    let dataStart = 1;
    if (filas[1] && filas[1].every(c => /^[-:]+$/.test(c))) {
        dataStart = 2;
    }

    const header = filas[0];
    const body = filas.slice(dataStart);

    let html = '<table>\n<thead>\n<tr>';
    header.forEach(h => html += `<th>${h}</th>`);
    html += '</tr>\n</thead>\n<tbody>\n';
    body.forEach(row => {
        html += '<tr>';
        row.forEach(c => html += `<td>${c}</td>`);
        html += '</tr>\n';
    });
    html += '</tbody>\n</table>';

    return html;
}

// ==================== LLAMADA AL MODELO ====================

const PROMPT_OCR = `You are a precise table extraction engine for calibration certificates.

Extract the complete table from this image as valid HTML.

CRITICAL RULES — FOLLOW EXACTLY:
1. Preserve ALL decimal points EXACTLY as they appear.
2. NEVER drop a decimal point. Example: "0.999935" must be "0.999935", NOT "999935".
3. Preserve scientific notation exactly (e.g., "9e-7", "8.5e-7", "-1.2e-3").
4. Preserve negative signs (e.g., "-0.000055").
5. Preserve all rows and columns, do not truncate.
6. Do not add, remove, or reorder any cell.
7. Do not invent data. If a cell is empty, leave it empty.
8. Output ONLY the HTML <table>, nothing else. No markdown, no explanations.

REQUIRED OUTPUT FORMAT:
<table>
  <thead>
    <tr><th>HEADER1</th><th>HEADER2</th>...</tr>
  </thead>
  <tbody>
    <tr><td>value1</td><td>value2</td>...</tr>
    ...
  </tbody>
</table>`;

/**
 * Ejecuta una llamada al modelo con un buffer concreto.
 */
async function llamarModelo(bufferImagen, opciones = {}) {
    const base64Image = bufferImagen.toString('base64');

    const response = await axios.post(
        `${OLLAMA_URL}/api/generate`,
        {
            model: MODEL_NAME,
            prompt: PROMPT_OCR,
            images: [base64Image],
            stream: false,
            options: {
                temperature: opciones.temperature ?? 0.05,
                top_p: 0.9,
                top_k: 20,
                repeat_penalty: 1.05,
                num_predict: 8000,
                num_ctx: 8192
            }
        },
        { timeout: 600000 }
    );

    let raw = (response.data.response || '').trim();
    raw = raw
        .replace(/```html/gi, '')
        .replace(/```/g, '')
        .replace(/^markdown\s*/i, '')
        .trim();

    return raw;
}

/**
 * Ejecuta múltiples pases con distintas imágenes y devuelve
 * el que tenga MÁS celdas detectadas (proxy de calidad).
 */
async function extraerConMultiPass(imageBuffer, retries = 3) {
    const buffers = [
        { id: 'normal', buffer: await prepararImagenParaOCR(imageBuffer) },
        { id: 'binarizada', buffer: await prepararImagenBinarizada(imageBuffer) }
    ];

    let mejorResultado = null;
    let mejorPuntaje = -1;

    for (const { id, buffer } of buffers) {
        let attempt = 0;
        while (attempt <= retries) {
            try {
                console.log(`📸 Pase "${id}" intento ${attempt + 1}/${retries + 1}`);
                const raw = await llamarModelo(buffer);
                if (!raw || raw.length < 10 || raw.includes('NO_TABLE')) {
                    throw new Error('Respuesta vacía o sin tabla');
                }

                // Puntaje: cantidad de <td> detectados
                const celdas = (raw.match(/<td/gi) || []).length;
                const filas = (raw.match(/<tr/gi) || []).length;
                const puntaje = celdas + filas * 0.5;

                console.log(`   ↳ celdas=${celdas}, filas=${filas}, puntaje=${puntaje.toFixed(1)}`);

                if (puntaje > mejorPuntaje) {
                    mejorPuntaje = puntaje;
                    mejorResultado = { id, raw };
                }
                break; // este pase terminó OK
            } catch (err) {
                attempt++;
                console.error(`   ❌ Pase "${id}" intento ${attempt} falló: ${err.message}`);
                if (attempt > retries) break;
                await new Promise(r => setTimeout(r, Math.min(attempt * 3, 15) * 1000));
            }
        }
    }

    if (!mejorResultado) throw new Error('Todos los pases fallaron');
    return mejorResultado;
}

async function extractTableFromImage(imagePath, retries = 3) {
    console.log(`\n📸 Extrayendo tabla...`);

    const imageBuffer = fs.readFileSync(imagePath);

    // Multi-pass: prueba variantes y elige la mejor
    const { id: mejorPase, raw: rawResponse } = await extraerConMultiPass(imageBuffer, retries);
    console.log(`✅ Mejor pase: ${mejorPase}`);

    // ========== PROCESAMIENTO POST-RESPUESTA ==========
    let finalTable;

    if (rawResponse.toLowerCase().includes('<table')) {
        finalTable = removeSpacesInNumbers(rawResponse);
        finalTable = corregirDecimalesEnTablaHtml(finalTable);
        console.log('🔧 HTML detectado, correcciones aplicadas');
    } else {
        const cleaned = removeSpacesInNumbers(rawResponse);
        const converted = convertCommasToDots(cleaned);
        finalTable = textoAHtmlTabla(converted);

        if (finalTable.toLowerCase().includes('<table')) {
            finalTable = corregirDecimalesEnTablaHtml(finalTable);
            console.log('🔧 Texto→HTML convertido y corregido');
        } else {
            console.log('⚠️ No se pudo convertir a HTML, devolviendo texto');
        }
    }

    const lineCount = finalTable.split('\n').length;
    console.log(`📊 Tabla procesada: ${lineCount} líneas`);

    return {
        success: true,
        table: finalTable,
        raw: rawResponse,
        converted: true,
        metadata: {
            lines: lineCount,
            characters: finalTable.length,
            formato: finalTable.toLowerCase().includes('<table') ? 'html' : 'texto',
            mejor_pase: mejorPase
        }
    };
}

// ==================== FUNCIONES DE SOPORTE ====================

function cleanupFiles(files) {
    files.forEach(file => {
        if (file && fs.existsSync(file)) {
            try {
                fs.unlinkSync(file);
                console.log(`🗑️ Eliminado: ${path.basename(file)}`);
            } catch (error) {
                console.error(`❌ Error eliminando ${file}:`, error.message);
            }
        }
    });
}

// ==================== ENDPOINTS ====================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        ollama_url: OLLAMA_URL,
        model_actual: MODEL_NAME,
        mejoras: [
            'Multi-pass OCR (normal + binarizada)',
            'Upscale a 1600px mínimo',
            'Preprocesamiento (grayscale + normalize + sharpen)',
            'Prompt estricto sobre decimales',
            'Temperatura 0.05',
            'num_ctx 8192',
            'Post-proceso con low ≤ measured ≤ high',
            'Post-proceso de uncertainty',
            'Corrección por monotonía entre filas',
            'Conversión texto→HTML automática'
        ]
    });
});

app.post('/api/extract-table', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No se subió ninguna imagen'
            });
        }

        console.log(`\n📸 Procesando: ${req.file.originalname}`);
        console.log(`📏 Tamaño: ${(req.file.size / 1024).toFixed(2)}KB`);
        console.log(`🤖 Modelo: ${MODEL_NAME}`);

        const result = await extractTableFromImage(req.file.path);

        cleanupFiles([req.file.path]);

        res.json({
            success: true,
            table: result.table,
            modelo_usado: MODEL_NAME,
            conversion_aplicada: true,
            metadata: {
                filename: req.file.originalname,
                size: req.file.size,
                lines: result.metadata?.lines || 0,
                characters: result.metadata?.characters || 0,
                formato: result.metadata?.formato || 'html',
                mejor_pase: result.metadata?.mejor_pase || 'normal'
            }
        });

    } catch (error) {
        console.error('❌ Error:', error);
        cleanupFiles([req.file?.path]);
        res.status(500).json({
            success: false,
            error: error.message || 'Error procesando la imagen',
            suggestion: 'Asegúrate de que la imagen contenga una tabla clara y visible'
        });
    }
});

app.post('/api/cambiar-modelo', (req, res) => {
    const { model } = req.body;
    const modelosValidos = [
        'glm-ocr',
        'llava:7b',
        'llava:13b',
        'minicpm-v:8b',
        'qwen2.5-vl:7b',
        'llama3.2-vision:11b',
        'qwen2.5-coder:7b'
    ];
    if (!model || !modelosValidos.includes(model)) {
        return res.status(400).json({
            success: false,
            error: `Modelo inválido. Opciones: ${modelosValidos.join(', ')}`
        });
    }
    process.env.MODEL_NAME = model;
    global.MODEL_NAME = model;
    res.json({
        success: true,
        message: `Modelo cambiado a: ${model} (requiere reinicio para aplicar completamente)`,
        modelo_actual: model
    });
});

app.get('/api/check-model', async (req, res) => {
    try {
        const startTime = Date.now();
        const response = await axios.post(
            `${OLLAMA_URL}/api/generate`,
            { model: MODEL_NAME, prompt: 'OK', stream: false },
            { timeout: 30000 }
        );
        const responseTime = Date.now() - startTime;
        res.json({
            success: true,
            model: MODEL_NAME,
            status: 'OK',
            responseTime: `${responseTime}ms`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            suggestion: 'Verifica que Ollama esté corriendo: docker ps | grep ollama'
        });
    }
});

app.get('/api/modelos-instalados', async (req, res) => {
    try {
        const response = await axios.get(`${OLLAMA_URL}/api/tags`);
        res.json({
            success: true,
            modelos: response.data.models || []
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'No se pudo obtener la lista de modelos'
        });
    }
});

app.use((err, req, res, next) => {
    console.error('❌ Error global:', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Error interno del servidor'
    });
});

// ==================== INICIO ====================

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║   🚀 SERVIDOR DE EXTRACCIÓN DE TABLAS v3               ║');
    console.log('║   🔍 Preservación de decimales y notación científica   ║');
    console.log('║   🧠 Multi-pass + Post-proceso inteligente             ║');
    console.log('║   📐 Validación cruzada y monotonía                    ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`\n📡 Servidor: http://0.0.0.0:${PORT}`);
    console.log(`🔗 Ollama: ${OLLAMA_URL}`);
    console.log(`🤖 Modelo actual: ${MODEL_NAME}`);
    console.log('\n🎯 MEJORAS APLICADAS:');
    console.log('   ✅ Multi-pass: imagen normal + binarizada');
    console.log('   ✅ Upscale a 1600px mínimo (crítico para decimales)');
    console.log('   ✅ Grayscale + normalize + sharpen');
    console.log('   ✅ Prompt con reglas explícitas sobre decimales');
    console.log('   ✅ Temperatura 0.05 (determinista)');
    console.log('   ✅ num_ctx 8192 (tablas largas)');
    console.log('   ✅ Corrección low ≤ measured ≤ high');
    console.log('   ✅ Corrección de uncertainty (casos 790 → 79000)');
    console.log('   ✅ Corrección por monotonía entre filas');
    console.log('   ✅ Texto→HTML automático');
    console.log('\n📌 Comandos útiles:');
    console.log(`   Health:   curl http://localhost:${PORT}/api/health`);
    console.log(`   Modelos:  curl http://localhost:${PORT}/api/modelos-instalados`);
    console.log(`   Imagen:   curl -X POST http://localhost:${PORT}/api/extract-table -F "image=@foto.jpg"`);
    console.log('\n💡 SUGERENCIA: si GLM-OCR sigue fallando con decimales,');
    console.log('   prueba con: ollama pull minicpm-v:8b');
    console.log('   y luego:    MODEL_NAME=minicpm-v:8b npm start\n');
});