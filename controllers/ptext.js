//Va realizar el procesmiento de texto, pasandole una imagen
// controllers/ptexto.js - Extracción de texto plano desde imagen (GLM-OCR)
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');

console.log(`🤖 Modelo inicial (ptexto): ${config.modelName}`);

// ==================== LIMPIEZA SUAVE DE TEXTO ====================
/**
 * Normaliza la respuesta del modelo sin alterar el contenido semántico:
 *   - Colapsa espacios múltiples en uno solo (excepto saltos de línea)
 *   - Elimina espacios al inicio/fin de cada línea
 *   - Elimina líneas vacías repetidas
 *   - Normaliza saltos de línea Windows -> Unix
 *
 * NO convierte comas a puntos ni toca números: es texto libre.
 */
function cleanText(text) {
    if (!text) return '';

    let cleaned = text.replace(/\r\n/g, '\n');

    // Trim por línea
    cleaned = cleaned
        .split('\n')
        .map(line => line.replace(/[ \t]+/g, ' ').trim())
        .join('\n');

    // Colapsar líneas vacías múltiples
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

// ==================== OPTIMIZAR IMAGEN EN DISCO ====================
async function optimizeImage(imagePath) {
    try {
        const stats = fs.statSync(imagePath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        if (fileSizeInMB > 1) {
            console.log(`📦 Imagen grande (${fileSizeInMB.toFixed(2)}MB), optimizando...`);
            const optimizedPath = imagePath.replace(/\.[^.]+$/, '_optimized.jpg');
            await sharp(imagePath)
                .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toFile(optimizedPath);
            console.log('✅ Imagen optimizada');
            return optimizedPath;
        }
        return null;
    } catch (error) {
        console.warn('⚠️ No se pudo optimizar:', error.message);
        return null;
    }
}

// ==================== LIMPIEZA DE ARCHIVOS ====================
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

// ==================== FUNCIÓN PRINCIPAL: Extraer texto ====================
/**
 * Extrae únicamente el texto visible en una imagen, sin estructura de tabla.
 *
 * @param {string} imagePath - Ruta al archivo de imagen
 * @param {number} retries   - Número de reintentos (default 3)
 * @returns {Promise<{success:boolean, text:string, raw:string, metadata:object}>}
 */
async function extractTextFromImage(imagePath, retries = 3) {
    let attempt = 0;
    const modelName = config.modelName;
    const ollamaUrl = config.ollamaUrl;

    while (attempt <= retries) {
        try {
            console.log(`📸 Extrayendo texto (intento ${attempt + 1}/${retries + 1})...`);
            console.log(`🤖 Modelo en uso: ${modelName}`);

            const imageBuffer = fs.readFileSync(imagePath);
            const stats = fs.statSync(imagePath);
            const fileSizeMB = stats.size / (1024 * 1024);

            // Optimización en memoria (misma política que pimage.js)
            let optimizedBuffer;
            if (fileSizeMB > 2) {
                optimizedBuffer = await sharp(imageBuffer)
                    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 85 })
                    .toBuffer();
            } else {
                optimizedBuffer = await sharp(imageBuffer)
                    .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 75 })
                    .toBuffer();
            }

            const base64Image = optimizedBuffer.toString('base64');
            console.log(`📦 Imagen optimizada: ${(optimizedBuffer.length / 1024).toFixed(2)}KB`);

            const prompt = `Text Recognition: Extract ALL the visible text from this image.
            CRITICAL INSTRUCTIONS:
            - Return ONLY the plain text as it appears in the image.
            - Preserve line breaks and paragraph structure.
            - Do NOT add headers, titles, comments, or explanations of your own.
            - Do NOT describe the image, do NOT translate, do NOT summarize.
            - Do NOT wrap the output in markdown code blocks or quotes.
            - If a word is illegible, keep the closest visual approximation or omit it.
            - If there is no readable text, return exactly: NO_TEXT
            Return the raw text only.`;

            console.log('📤 Enviando a GLM-OCR (texto plano)...');

            const response = await axios.post(`${ollamaUrl}/api/generate`, {
                model: modelName,
                prompt: prompt,
                images: [base64Image],
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 8000,
                    num_ctx: 4096,
                    repeat_penalty: 1.1
                }
            }, {
                timeout: 600000
            });

            console.log('✅ Respuesta recibida');

            const rawResponse = response.data.response || '';

            if (!rawResponse.trim() || rawResponse.trim() === 'NO_TEXT' || rawResponse.includes('NO_TEXT')) {
                throw new Error('No se encontró texto legible en la imagen');
            }

            const cleaned = cleanText(rawResponse);
            console.log('🧹 Texto normalizado');

            return {
                success: true,
                text: cleaned,
                raw: rawResponse,
                metadata: {
                    characters: cleaned.length,
                    words: cleaned.split(/\s+/).filter(Boolean).length,
                    lines: cleaned.split('\n').length
                }
            };

        } catch (error) {
            attempt++;
            console.error(`❌ Intento ${attempt} fallido:`, error.message);
            if (attempt > retries) throw error;
            const waitTime = Math.min(attempt * 3, 15);
            console.log(`⏳ Esperando ${waitTime} segundos...`);
            await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        }
    }
}

module.exports = {
    extractTextFromImage,
    optimizeImage,
    cleanupFiles,
    cleanText
};