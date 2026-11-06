// controllers/pimage.js - Procesamiento de imagen y llamada a GLM-OCR
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { JSDOM } = require('jsdom'); // Necesitarás instalar: npm install jsdom
const config = require('../config');

console.log(`🤖 Modelo inicial: ${config.modelName}`);

// ==================== PRIMER FILTRADO (SIMPLE) ====================
function preFilter(text) {
    if (!text) return text;
    let cleaned = text;
    cleaned = cleaned.replace(/(\d)\s+(\d)/g, '$1$2');
    cleaned = cleaned.replace(/(\d)\s+([,.])\s+(\d)/g, '$1$2$3');
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
    const lines = md.split('\n').map(l => l.trim()).filter(l => l.startsWith('|') && l.includes('|', 1));
    if (lines.length === 0) return null;
    const parseRow = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const isSeparator = (cells) => cells.every(c => /^:?-{2,}:?$/.test(c));
    let header = null;
    const rows = [];
    for (const line of lines) {
        const cells = parseRow(line);
        if (isSeparator(cells)) continue;
        if (header === null) header = cells;
        else rows.push(cells);
    }
    if (!header && rows.length === 0) return null;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const th = header ? `<thead><tr>${header.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : '';
    const tb = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    return `<table>${th}${tb}</table>`;
}

// ==================== OPTIMIZAR IMAGEN ====================
async function optimizeImage(imagePath) {
    try {
        const stats = fs.statSync(imagePath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        if (fileSizeInMB > 1) {
            const optimizedPath = imagePath.replace(/\.[^.]+$/, '_optimized.jpg');
            await sharp(imagePath)
                .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toFile(optimizedPath);
            return optimizedPath;
        }
        return null;
    } catch (error) {
        return null;
    }
}

function cleanupFiles(files) {
    files.forEach(file => {
        if (file && fs.existsSync(file)) {
            try { fs.unlinkSync(file); } catch (error) {}
        }
    });
}

// ==================== PROMPT GENÉRICO MEJORADO ====================
function buildPrompt(isRightSide = false) {
    if (isRightSide) {
        return `You are a table extraction engine. The image contains a single vertical column (or a small detached block) that belongs to a larger table.
Convert it into a valid HTML <table> element with a single <tr> per row.
RULES:
1. Output ONLY valid HTML.
2. Include the header row in <thead>.
3. Output <td></td> if a cell is empty.
4. Do NOT add extra text.`;
    }

    return `You are an expert table extraction engine. Convert the table in the image to a single HTML <table> element.

CRITICAL RULES:
1. Output ONLY valid HTML starting with <table> and ending with </table>.
2. Scan the image from LEFT to RIGHT edge. Include ALL visible columns, even if they are separated by a thick vertical line, a large white gap, or appear visually detached (e.g., a calculated value on the far right).
3. If a cell is empty, output <td></td>.
4. Use '.' as decimal separator.
5. Preserve rowspan/colspan if merged cells are visible.
6. Do NOT omit columns just because they look like a separate table. If it shares the same rows, include it as a column.

EXAMPLE:
If you see a main table with 3 columns, and a separated column on the right with a thick line, the output MUST have 4 columns: <th>Col1</th><th>Col2</th><th>Col3</th><th>DetachedCol</th>.
The row must be: <tr><td>data1</td><td>data2</td><td>data3</td><td>data4</td></tr>

Return ONLY the HTML.`;
}

// ==================== LLAMADA AL MODELO (REUTILIZABLE) ====================
async function callModel(imageBuffer, isRightSide = false) {
    const base64Image = imageBuffer.toString('base64');
    const prompt = buildPrompt(isRightSide);
    const response = await axios.post(
        `${config.ollamaUrl}/api/generate`,
        {
            model: config.modelName,
            prompt: prompt,
            images: [base64Image],
            stream: false,
            options: { temperature: 0, num_predict: 8000, num_ctx: 8192, top_p: 0.1 }
        },
        { timeout: 600000 }
    );
    return response.data.response || '';
}

// ==================== UNIÓN GENÉRICA DE DOS TABLAS HTML ====================
function mergeHtmlTables(htmlLeft, htmlRight) {
    try {
        const domLeft = new JSDOM(htmlLeft);
        const domRight = new JSDOM(htmlRight);
        
        const tableLeft = domLeft.window.document.querySelector('table');
        const tableRight = domRight.window.document.querySelector('table');

        if (!tableLeft || !tableRight) return htmlLeft; // Fallback si no hay tabla

        const rowsLeft = Array.from(tableLeft.querySelectorAll('tr'));
        const rowsRight = Array.from(tableRight.querySelectorAll('tr'));

        // Asumimos que la primera fila de ambos es el encabezado
        const maxRows = Math.max(rowsLeft.length, rowsRight.length);
        
        let mergedHtml = '<table><thead><tr>';
        
        // Unir encabezados
        const thLeft = Array.from(rowsLeft[0]?.querySelectorAll('th, td') || []).map(th => th.outerHTML);
        const thRight = Array.from(rowsRight[0]?.querySelectorAll('th, td') || []).map(th => th.outerHTML);
        mergedHtml += thLeft.join('') + thRight.join('') + '</tr></thead><tbody>';

        // Unir filas de datos
        for (let i = 1; i < maxRows; i++) {
            mergedHtml += '<tr>';
            const cellsLeft = Array.from(rowsLeft[i]?.querySelectorAll('td, th') || []).map(td => td.outerHTML);
            const cellsRight = Array.from(rowsRight[i]?.querySelectorAll('td, th') || []).map(td => td.outerHTML);
            
            // Si una fila no existe en un lado, rellenamos con vacíos
            const numColsLeft = rowsLeft[0]?.querySelectorAll('th, td').length || 0;
            const numColsRight = rowsRight[0]?.querySelectorAll('th, td').length || 0;
            
            const finalLeft = cellsLeft.length ? cellsLeft : new Array(numColsLeft).fill('<td></td>');
            const finalRight = cellsRight.length ? cellsRight : new Array(numColsRight).fill('<td></td>');
            
            mergedHtml += finalLeft.join('') + finalRight.join('') + '</tr>';
        }
        
        mergedHtml += '</tbody></table>';
        return mergedHtml;
    } catch (error) {
        console.error('Error mergeando tablas:', error);
        return htmlLeft; // Si falla, devolvemos al menos la tabla izquierda
    }
}

// ==================== FUNCIÓN PRINCIPAL ====================
async function extractTableFromImage(imagePath, retries = 3) {
    let attempt = 0;
    while (attempt <= retries) {
        try {
            console.log(`📸 Extrayendo tabla (intento ${attempt + 1}/${retries + 1})...`);
            const imageBuffer = fs.readFileSync(imagePath);
            const stats = fs.statSync(imagePath);
            const fileSizeMB = stats.size / (1024 * 1024);

            const targetSize = fileSizeMB > 4 ? 1400 : 1600;
            const optimizedBuffer = await sharp(imageBuffer)
                .resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 88 })
                .toBuffer();

            // 1. Intento con la imagen completa
            let rawResponse = await callModel(optimizedBuffer, false);
            
            if (!rawResponse.trim() || rawResponse.includes('NO_TABLE')) {
                throw new Error('No se encontró ninguna tabla en la imagen');
            }

            let table = rawResponse.trim();

            // 2. Verificar si el modelo omitió la columna separada
            // Una heurística: si el modelo detectó pocas columnas en tablas muy anchas, o si falló.
            // Para ser genéricos, haremos un split de la imagen a la mitad (50%) y compararemos.
            const dom = new JSDOM(table);
            const tableEl = dom.window.document.querySelector('table');
            const colCount = tableEl ? tableEl.querySelectorAll('thead th').length : 0;

            // Si tiene 6 columnas o menos y la imagen es ancha (aspect ratio > 1.5), intentamos el split
            const metadata = await sharp(imageBuffer).metadata();
            const isWide = metadata.width > (metadata.height * 1.2);

            if (colCount <= 6 && isWide) {
                console.log('⚠️ Posible columna omitida. Iniciando extracción por partes (Split 50/50)...');
                
                const width = metadata.width;
                const height = metadata.height;
                const splitX = Math.floor(width * 0.5); // Cortar a la mitad

                const leftBuffer = await sharp(imageBuffer).extract({ left: 0, top: 0, width: splitX, height: height }).jpeg().toBuffer();
                const rightBuffer = await sharp(imageBuffer).extract({ left: splitX, top: 0, width: width - splitX, height: height }).jpeg().toBuffer();

                const [resLeft, resRight] = await Promise.all([
                    callModel(leftBuffer, false),
                    callModel(rightBuffer, true)
                ]);

                if (looksLikeHtmlTable(resLeft) && looksLikeHtmlTable(resRight)) {
                    console.log('✅ Uniendo tablas izquierda y derecha...');
                    table = mergeHtmlTables(resLeft, resRight);
                }
            }

            // 3. Si no era HTML, intentar Markdown
            if (!looksLikeHtmlTable(table)) {
                const html = markdownTableToHtml(table);
                if (html) table = html;
                else throw new Error('La respuesta no es HTML ni markdown tabular convertible');
            }

            const filtered = preFilter(table);
            return {
                success: true,
                table: filtered,
                raw: rawResponse,
                filtered: true,
                format: 'html',
                metadata: { characters: filtered.length }
            };
        } catch (error) {
            attempt++;
            console.error(`❌ Intento ${attempt} fallido:`, error.message);
            if (attempt > retries) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(attempt * 3, 15) * 1000));
        }
    }
}

module.exports = {
    extractTableFromImage,
    optimizeImage,
    cleanupFiles,
    preFilter,
    looksLikeHtmlTable,
    markdownTableToHtml
};