// controllers/pimage.js - Procesamiento de imagen y llamada a GLM-OCR
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');

console.log(`🤖 Modelo inicial: ${config.modelName}`);

// ==================== PRIMER FILTRADO (SIMPLE) ====================
/**
 * Filtrado simple:
 *   1. Elimina espacios en blanco entre números.
 *   2. Cambia TODAS las comas por puntos.
 */
function preFilter(text) {
    if (!text) return text;

    let cleaned = text;

    // 1) Eliminar espacios entre números: "10 000" -> "10000"
    cleaned = cleaned.replace(/(\d)\s+(\d)/g, '$1$2');
    // Espacios alrededor de separadores: "10 , 5" -> "10,5"
    cleaned = cleaned.replace(/(\d)\s+([,.])\s+(\d)/g, '$1$2$3');

    // 2) Todas las comas -> puntos
    cleaned = cleaned.replace(/,/g, '.');

    return cleaned;
}

// ==================== DETECCIÓN DE HTML VÁLIDO ====================
function looksLikeHtmlTable(s) {
    const t = (s || '').trim().toLowerCase();
    return t.startsWith('<table') && t.includes('</table>');
}

// ==================== FALLBACK: MARKDOWN -> HTML ====================
function markdownTableToHtml(md) {
    if (!md) return null;

    const lines = md
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('|') && l.includes('|', 1));

    if (lines.length === 0) return null;

    const parseRow = (line) =>
        line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

    const isSeparator = (cells) =>
        cells.every(c => /^:?-{2,}:?$/.test(c));

    let header = null;
    const rows = [];

    for (const line of lines) {
        const cells = parseRow(line);
        if (isSeparator(cells)) continue;
        if (header === null) {
            header = cells;
        } else {
            rows.push(cells);
        }
    }

    if (!header && rows.length === 0) return null;

    const esc = (s) =>
        String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

    const th = header
        ? `<thead><tr>${header.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>`
        : '';
    const tb = `<tbody>${rows
        .map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;

    return `<table>${th}${tb}</table>`;
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
                .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
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

// ==================== PROMPT (FEW-SHOT, PIDE HTML) ====================
function buildPrompt() {
    return `You are a table extraction engine. Convert the table in the image to a single HTML <table> element.

RULES (follow exactly):
1. Output ONLY valid HTML starting with <table> and ending with </table>. No markdown, no code fences, no explanations, no extra text.
2. Include the header row inside <thead><tr><th>...</th></tr></thead>.
3. Include all data rows inside <tbody><tr><td>...</td></tr></tbody>.
4. Preserve rowspan/colspan ONLY if merged cells are clearly visible in the image.
5. Copy numbers EXACTLY as printed in the image. Do NOT compute, round, or invent values.
6. If a cell is empty in the image, output <td></td>.
7. Use '.' as decimal separator. Do NOT convert to commas.
8. Do NOT add columns, units, titles, or labels that are not present in the image.
9. Do NOT repeat the header row inside <tbody>.

EXAMPLE of the exact expected output format:
<table>
<thead><tr><th>Col A</th><th>Col B</th><th>Col C</th></tr></thead>
<tbody>
<tr><td>1.234</td><td>-0.05 ± 0.01</td><td>5.678</td></tr>
<tr><td>9.999</td><td>0.00 ± 0.02</td><td>10.001</td></tr>
</tbody>
</table>

Now extract the table from the image and return ONLY the HTML.`;
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

            const targetSize = fileSizeMB > 4 ? 1400 : 1600;
            const optimizedBuffer = await sharp(imageBuffer)
                .resize(targetSize, targetSize, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({ quality: 88 })
                .toBuffer();

            const base64Image = optimizedBuffer.toString('base64');
            console.log(
                `📦 Imagen optimizada: ${(optimizedBuffer.length / 1024).toFixed(2)}KB ` +
                `(lado máx ${targetSize}px)`
            );

            const prompt = buildPrompt();
            console.log('📤 Enviando a GLM-OCR (HTML + few-shot)...');

            const response = await axios.post(
                `${ollamaUrl}/api/generate`,
                {
                    model: modelName,
                    prompt: prompt,
                    images: [base64Image],
                    stream: false,
                    options: {
                        temperature: 0,
                        num_predict: 8000,
                        num_ctx: 8192,
                        repeat_penalty: 1.0,
                        top_p: 0.1,
                        top_k: 10
                    }
                },
                { timeout: 600000 }
            );

            console.log('✅ Respuesta recibida');

            const rawResponse = response.data.response || '';

            if (!rawResponse.trim() || rawResponse.includes('NO_TABLE')) {
                throw new Error('No se encontró ninguna tabla en la imagen');
            }

            let table = rawResponse.trim();

            if (!looksLikeHtmlTable(table)) {
                console.warn('⚠️ La respuesta no es HTML. Intentando convertir desde markdown...');
                const html = markdownTableToHtml(table);
                if (html) {
                    console.log('🔁 Markdown convertido a HTML correctamente');
                    table = html;
                } else {
                    throw new Error('La respuesta no es HTML ni markdown tabular convertible');
                }
            }

            const filtered = preFilter(table);
            console.log('🧹 Primer filtrado aplicado (comas -> puntos, espacios en números eliminados)');

            return {
                success: true,
                table: filtered,
                raw: rawResponse,
                filtered: true,
                format: 'html',
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

// ==================== EXPORTS ====================
module.exports = {
    extractTableFromImage,
    optimizeImage,
    cleanupFiles,
    preFilter,
    looksLikeHtmlTable,
    markdownTableToHtml
};