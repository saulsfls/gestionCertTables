// controllers/pimage.js - Procesamiento de imagen y llamada a GLM-OCR (filtrado conservador)
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');

console.log(`🤖 Modelo inicial: ${config.modelName}`);

// ==================== PRIMER FILTRADO (CONSERVADOR) ====================
/**
 * Filtrado inicial sobre la respuesta cruda del modelo:
 *   1. Elimina espacios en blanco entre números (ej: "10 000" -> "10000", "10 , 5" -> "10,5")
 *   2. Convierte comas decimales a puntos (ej: "10,5" -> "10.5")
 *
 * NO elimina puntos de millar (ej: "1.234" se mantiene como "1.234")
 * para evitar falsos positivos con decimales de 3 cifras.
 */
function preFilter(text) {
    if (!text) return text;

    let cleaned = text;

    // 1) Eliminar espacios en blanco entre números
    // "10 000" -> "10000"
    cleaned = cleaned.replace(/(\d)\s+(\d)/g, '$1$2');
    // "10 , 5" -> "10,5"
    cleaned = cleaned.replace(/(\d)\s+([,.])\s+(\d)/g, '$1$2$3');
    // "10, 5" -> "10,5"
    cleaned = cleaned.replace(/(\d)([,.])\s+(\d)/g, '$1$2$3');
    // "10 ,5" -> "10,5"
    cleaned = cleaned.replace(/(\d)\s+([,.])(\d)/g, '$1$2$3');

    // 2) Convertir comas decimales a puntos (solo entre dígitos)
    // "10,5" -> "10.5"
    cleaned = cleaned.replace(/(\d),(\d)/g, '$1.$2');

    return cleaned;
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

// ==================== FUNCIÓN PRINCIPAL: Extraer tabla ====================
async function extractTableFromImage(imagePath, retries = 3) {
    let attempt = 0;
    const modelName = config.modelName;
    const ollamaUrl = config.ollamaUrl;

    while (attempt <= retries) {
        try {
            console.log(`📸 Extrayendo tabla (intento ${attempt + 1}/${retries + 1})...`);
            console.log(`🤖 Modelo en uso: ${modelName}`);

            const imageBuffer = fs.readFileSync(imagePath);
            const stats = fs.statSync(imagePath);
            const fileSizeMB = stats.size / (1024 * 1024);

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

            const prompt = `Table Recognition: Extract ONLY the data rows from the table in this image.
            CRITICAL INSTRUCTIONS:
            - DO NOT include the header row(s) in your output.
            - IGNORE all column titles, field names, or header labels completely.
            - Skip any row that contains only text labels or titles.
            - Start directly with the first row of actual data (numeric or value rows).
            - Include ALL data rows and ALL columns.
            - Preserve the table structure (separator |, tab, or ;).
            - Do NOT add any header, title, or column name to the output.
            Return ONLY the data rows in a clear tabular format.`;

            console.log('📤 Enviando a GLM-OCR (ignorando encabezados)...');

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

            if (!rawResponse.trim() || rawResponse.includes('NO_TABLE')) {
                throw new Error('No se encontró ninguna tabla en la imagen');
            }

            // ===== PRIMER FILTRADO (CONSERVADOR) =====
            const filtered = preFilter(rawResponse);
            console.log('🧹 Primer filtrado aplicado (comas → puntos, espacios en números eliminados)');

            return {
                success: true,
                table: filtered,
                raw: rawResponse,
                filtered: true,
                metadata: {
                    characters: filtered.length,
                    lines: filtered.split('\n').length
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
    extractTableFromImage,
    optimizeImage,
    cleanupFiles,
    preFilter
};