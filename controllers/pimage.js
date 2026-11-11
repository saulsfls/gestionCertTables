// controllers/pimage.js - Procesamiento de imagen y llamada a GLM-OCR
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { JSDOM } = require('jsdom'); // npm install jsdom
const config = require('../config');

console.log(`🤖 Modelo inicial: ${config.modelName}`);

// ==================== PRIMER FILTRADO (SIMPLE) ====================
function preFilter(text) {
    if (!text) return text;
    let cleaned = text;
    // Une números separados por espacios (ej. "1 000" -> "1000")
    cleaned = cleaned.replace(/(\d)\s+(\d)/g, '$1$2');
    // Une números separados por espacios alrededor de comas o puntos
    cleaned = cleaned.replace(/(\d)\s+([,.])\s+(\d)/g, '$1$2$3');
    // Reemplaza comas por puntos para decimales
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

// ==================== PREPROCESAMIENTO AVANZADO PARA TABLAS ====================
/**
 * Mejora la imagen para que el modelo OCR vea las líneas de la tabla y el texto con mayor claridad.
 * Aplica: Redimensionado, Escala de grises, Normalización, Enfoque y Binarización.
 */
async function preprocessImageForTable(imageBuffer) {
    try {
        const metadata = await sharp(imageBuffer).metadata();
        
        // 1. Redimensionar si es muy grande (mantener legibilidad sin exceder límites del modelo)
        let width = metadata.width;
        let height = metadata.height;
        const maxDim = 2000;
        
        if (width > maxDim || height > maxDim) {
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.floor(width * ratio);
            height = Math.floor(height * ratio);
        }

        // 2. Pipeline de mejora
        let pipeline = sharp(imageBuffer)
            .resize(width, height, { fit: 'inside', withoutEnlargement: true })
            .grayscale() // Pasar a blanco y negro
            .normalize() // Estirar el histograma (mejora contraste global)
            .sharpen({ sigma: 1.5, m1: 1.0, m2: 2.0 }); // Enfocar el texto y líneas

        // 3. Binarización (Opcional pero muy útil para tablas con líneas tenues)
        // Un umbral de 180 suele funcionar bien para fondos blancos con texto negro.
        // Si tus imágenes son oscuras, considera quitar esta línea.
        pipeline = pipeline.threshold(180); 

        return await pipeline.jpeg({ quality: 95 }).toBuffer();
    } catch (error) {
        console.error('⚠️ Error en preprocesamiento, usando imagen original:', error.message);
        return imageBuffer; // Fallback a la imagen original
    }
}

// ==================== OPTIMIZAR IMAGEN (LEGACY) ====================
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
    const commonRules = `
CRITICAL RULES:
1. Output ONLY valid HTML starting with <table> and ending with </table>.
2. Use '.' as decimal separator. Do NOT use commas for decimals.
3. If a cell is empty, output <td></td>.
4. Preserve rowspan and colspan EXACTLY as seen in the image. If a cell spans multiple rows, use <td rowspan="N">. If it spans columns, use <td colspan="N">.
5. Do NOT invent new columns. If you see a thick line, it might just be a visual separator, not a new column. Only create a new column if there is distinct text in that column for multiple rows.
6. Read the numbers carefully. Do not hallucinate zeros.
`;

    if (isRightSide) {
        return `You are a table extraction engine. The image contains a DETACHED COLUMN or a RIGHT PART of a larger table.
Convert it into a valid HTML <table> element.
${commonRules}
7. Output ONLY the columns visible in this image. Do not try to guess the left columns.
Return ONLY the HTML.`;
    }

    return `You are an expert table extraction engine. Convert the table in the image to a single HTML <table> element.
${commonRules}
7. Scan from LEFT to RIGHT. Include ALL visible columns. If a column is separated by a thick vertical line but shares the same rows, include it.
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
            options: { 
                temperature: 0, 
                num_predict: 8000, 
                num_ctx: 8192, 
                top_p: 0.1 
            }
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

// ==================== SPLIT CON SOLAPAMIENTO ====================
/**
 * Corta la imagen a la mitad, pero con un 10% de solapamiento para no cortar columnas por la mitad.
 */
async function extractWithSplit(imageBuffer, metadata) {
    const width = metadata.width;
    const height = metadata.height;
    const overlap = Math.floor(width * 0.1); // 10% de solapamiento
    const splitX = Math.floor(width * 0.5);

    // Izquierda (0 a splitX + overlap)
    const leftBuffer = await sharp(imageBuffer)
        .extract({ left: 0, top: 0, width: splitX + overlap, height: height })
        .jpeg({ quality: 95 })
        .toBuffer();

    // Derecha (splitX - overlap a width)
    const rightBuffer = await sharp(imageBuffer)
        .extract({ left: splitX - overlap, top: 0, width: width - (splitX - overlap), height: height })
        .jpeg({ quality: 95 })
        .toBuffer();

    const [resLeft, resRight] = await Promise.all([
        callModel(leftBuffer, false),
        callModel(rightBuffer, true)
    ]);

    return { resLeft, resRight };
}

// ==================== VALIDACIÓN DE ESTRUCTURA (OPCIONAL) ====================
/**
 * Verifica que el número de columnas en el body coincida con el header.
 * Útil para detectar si el modelo alucinó columnas extra.
 */
function validateTableStructure(html) {
    try {
        const dom = new JSDOM(html);
        const table = dom.window.document.querySelector('table');
        if (!table) return false;
        
        const headers = table.querySelectorAll('thead th').length;
        if (headers === 0) return false;

        const rows = table.querySelectorAll('tbody tr');
        let validRows = 0;
        
        for (let row of rows) {
            const cells = row.querySelectorAll('td, th');
            let totalCols = 0;
            cells.forEach(cell => {
                const colspan = parseInt(cell.getAttribute('colspan')) || 1;
                totalCols += colspan;
            });
            
            // Si la fila tiene el mismo número de columnas que el header, es válida
            // (Ignoramos filas con rowspan complejo para esta validación básica)
            if (totalCols === headers) {
                validRows++;
            }
        }
        
        // Si al menos el 50% de las filas son válidas, consideramos la tabla aceptable
        return validRows >= (rows.length * 0.5);
    } catch (e) {
        return false;
    }
}

// ==================== FUNCIÓN PRINCIPAL ====================
async function extractTableFromImage(imagePath, retries = 3) {
    let attempt = 0;
    while (attempt <= retries) {
        try {
            console.log(`📸 Extrayendo tabla (intento ${attempt + 1}/${retries + 1})...`);
            const imageBuffer = fs.readFileSync(imagePath);
            
            // 1. PREPROCESAMIENTO AVANZADO
            const optimizedBuffer = await preprocessImageForTable(imageBuffer);
            const metadata = await sharp(optimizedBuffer).metadata();

            // 2. PRIMER INTENTO (Imagen completa)
            let rawResponse = await callModel(optimizedBuffer, false);
            
            if (!rawResponse.trim() || rawResponse.includes('NO_TABLE')) {
                throw new Error('No se encontró ninguna tabla en la imagen');
            }

            let table = rawResponse.trim();
            
            // 3. VERIFICAR SI EL MODELO OMITIÓ COLUMNAS
            let dom = new JSDOM(table);
            let tableEl = dom.window.document.querySelector('table');
            let colCount = tableEl ? tableEl.querySelectorAll('thead th').length : 0;

            // Heurística: Si el modelo detectó muy pocas columnas (ej. 2 o 3) 
            // pero la imagen es ancha (aspect ratio > 1.5), intentamos el split.
            const isWide = metadata.width > (metadata.height * 1.5);
            const likelyMissedColumns = colCount <= 4 && isWide;

            if (likelyMissedColumns) {
                console.log('⚠️ Posible columna omitida. Iniciando extracción con Split + Overlap...');
                
                const { resLeft, resRight } = await extractWithSplit(optimizedBuffer, metadata);

                if (looksLikeHtmlTable(resLeft) && looksLikeHtmlTable(resRight)) {
                    console.log('✅ Uniendo tablas izquierda y derecha...');
                    const mergedTable = mergeHtmlTables(resLeft, resRight);
                    
                    // Validar que la tabla unida tenga sentido
                    if (validateTableStructure(mergedTable)) {
                        table = mergedTable;
                    } else {
                        console.log('⚠️ Tabla unida no pasó la validación, usando respuesta original.');
                    }
                } else {
                    console.log('⚠️ Split falló (respuestas no son HTML), usando respuesta original.');
                }
            }

            // 4. Fallback a Markdown si no es HTML
            if (!looksLikeHtmlTable(table)) {
                const html = markdownTableToHtml(table);
                if (html) table = html;
                else throw new Error('La respuesta no es HTML ni markdown tabular convertible');
            }

            // 5. Aplicar filtro de limpieza
            const filtered = preFilter(table);
            
            return {
                success: true,
                table: filtered,
                raw: rawResponse,
                filtered: true,
                format: 'html',
                metadata: { 
                    characters: filtered.length,
                    columnsDetected: colCount,
                    usedSplit: likelyMissedColumns
                }
            };
        } catch (error) {
            attempt++;
            console.error(`❌ Intento ${attempt} fallido:`, error.message);
            if (attempt > retries) throw error;
            // Espera exponencial entre reintentos (3s, 6s, 9s...)
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