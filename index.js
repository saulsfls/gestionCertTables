// index.js - Versión optimizada para GLM-OCR (con soporte para tablas largas y limpieza de espacios)
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

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '100mb' }));

// Configuración de almacenamiento
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

// ==================== FUNCIÓN PARA ELIMINAR ESPACIOS EN NÚMEROS ====================
function removeSpacesInNumbers(text) {
    if (!text) return text;
    
    // Elimina espacios entre dígitos (ej: "10 000" -> "10000")
    let cleaned = text.replace(/(\d)\s+(\d)/g, '$1$2');
    
    // Elimina espacios alrededor de coma o punto decimal (ej: "10 , 5" -> "10,5")
    cleaned = cleaned.replace(/(\d)\s+([,.])\s+(\d)/g, '$1$2$3');
    
    // Elimina espacios entre dígitos y coma/punto (ej: "10, 5" -> "10,5")
    cleaned = cleaned.replace(/(\d)([,.])\s+(\d)/g, '$1$2$3');
    
    // Elimina espacios entre dígitos y coma/punto (ej: "10 ,5" -> "10,5")
    cleaned = cleaned.replace(/(\d)\s+([,.])(\d)/g, '$1$2$3');
    
    return cleaned;
}

// ==================== FUNCIÓN PARA CONVERTIR COMAS A PUNTOS ====================
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
                // Eliminar puntos de millar y convertir coma decimal a punto
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
            return line.replace(/(\d+)[,.](\d+)/g, (match, before, after) => {
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

// ==================== FUNCIÓN PRINCIPAL: Extraer tabla ====================
async function extractTableFromImage(imagePath, retries = 3) {
    let attempt = 0;
    
    while (attempt <= retries) {
        try {
            console.log(`📸 Extrayendo tabla (intento ${attempt + 1}/${retries + 1})...`);
            
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

            const prompt = `Table Recognition: Extract the complete table from this image. 
            Include ALL rows and columns. Preserve the table structure.
            Return the data in a clear tabular format.`;

            console.log('📤 Enviando a GLM-OCR...');

            const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
                model: MODEL_NAME,
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

            let rawResponse = response.data.response.trim();
            rawResponse = rawResponse.replace(/```/g, '').replace(/markdown/g, '').trim();
            
            if (rawResponse.includes('NO_TABLE') || rawResponse.length < 10) {
                throw new Error('No se encontró ninguna tabla en la imagen');
            }

            const lines = rawResponse.split('\n');
            const startIdx = lines.findIndex(line => 
                line.includes('|') || line.includes('\t') || line.includes(';')
            );
            
            if (startIdx === -1) {
                // Limpiar espacios en números y convertir comas a puntos
                const cleaned = removeSpacesInNumbers(rawResponse);
                const convertedText = convertCommasToDots(cleaned);
                return {
                    success: true,
                    table: convertedText,
                    raw: rawResponse,
                    converted: true
                };
            }
            
            let tableLines = lines.slice(startIdx);
            tableLines = tableLines.filter(line => line.trim() !== '');
            const tableText = tableLines.join('\n');

            if (tableText.length < 10) {
                throw new Error('La tabla extraída está vacía o es demasiado corta');
            }

            // Limpiar espacios en números y luego convertir comas a puntos
            const cleanedTable = removeSpacesInNumbers(tableText);
            const convertedTable = convertCommasToDots(cleanedTable);

            const lineCount = convertedTable.split('\n').length;
            console.log(`📊 Tabla extraída: ${lineCount} líneas`);
            console.log('📊 Primeras 3 líneas:');
            console.log(convertedTable.split('\n').slice(0, 3).join('\n'));

            return {
                success: true,
                table: convertedTable,
                raw: rawResponse,
                converted: true,
                metadata: {
                    lines: lineCount,
                    characters: convertedTable.length
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

// ==================== FUNCIONES DE SOPORTE ====================
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
        modelos_disponibles: ['glm-ocr', 'llava:7b', 'qwen2.5-coder:7b']
    });
});

app.post('/api/extract-table', upload.single('image'), async (req, res) => {
    let optimizedPath = null;
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No se subió ninguna imagen'
            });
        }

        console.log(`\n📸 Procesando: ${req.file.originalname}`);
        console.log(`📏 Tamaño: ${(req.file.size / 1024).toFixed(2)}KB`);
        console.log(`🤖 Usando modelo: ${MODEL_NAME}`);
        console.log(`🔄 Conversión automática: comas -> puntos y eliminación de espacios en números`);
        
        optimizedPath = await optimizeImage(req.file.path);
        const imageToProcess = optimizedPath || req.file.path;
        
        const result = await extractTableFromImage(imageToProcess);
        
        cleanupFiles([req.file.path, optimizedPath]);
        
        res.json({
            success: true,
            table: result.table,            
            modelo_usado: MODEL_NAME,
            conversion_aplicada: true,
            metadata: {
                filename: req.file.originalname,
                size: req.file.size,
                optimized: !!optimizedPath,
                lines: result.metadata?.lines || 0,
                characters: result.metadata?.characters || 0
            }
        });
        console.log(res.table);

    } catch (error) {
        console.error('❌ Error:', error);
        cleanupFiles([req.file.path, optimizedPath]);
        res.status(500).json({
            success: false,
            error: error.message || 'Error procesando la imagen',
            suggestion: 'Asegúrate de que la imagen contenga una tabla clara y visible'
        });
    }
});

app.post('/api/cambiar-modelo', (req, res) => {
    const { model } = req.body;
    const modelosValidos = ['glm-ocr', 'llava:7b', 'qwen2.5-coder:7b'];
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
        message: `Modelo cambiado a: ${model}`,
        modelo_actual: model
    });
});

app.get('/api/check-model', async (req, res) => {
    try {
        const startTime = Date.now();
        const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
            model: MODEL_NAME,
            prompt: 'OK',
            stream: false
        }, { timeout: 30000 });
        const responseTime = Date.now() - startTime;
        res.json({
            success: true,
            model: MODEL_NAME,
            status: 'OK',
            responseTime: `${responseTime}ms`,
            version: response.data?.version || 'desconocida'
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

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║   🚀 SERVIDOR DE EXTRACCIÓN DE TABLAS               ║');
    console.log('║   🔄 CONVERSIÓN COMAS → PUNTOS Y LIMPIEZA DE ESPACIOS║');
    console.log('║   📋 SOPORTE PARA TABLAS LARGAS                     ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`\n📡 Servidor: http://0.0.0.0:${PORT}`);
    console.log(`🔗 Ollama: ${OLLAMA_URL}`);
    console.log(`🤖 Modelo actual: ${MODEL_NAME}`);
    console.log(`🔄 Conversión: comas decimales → puntos`);
    console.log(`🔄 Limpieza: eliminación de espacios en números`);
    console.log(`📋 Límites:`);
    console.log(`   - Archivo: 20MB`);
    console.log(`   - Respuesta: 100MB`);
    console.log(`   - Tokens: 8000`);
    console.log(`   - Contexto: 4096`);
    console.log(`   - Timeout: 10 minutos`);
    console.log('\n📌 Comandos útiles:');
    console.log(`   Health:   curl http://localhost:${PORT}/api/health`);
    console.log(`   Modelos:  curl http://localhost:${PORT}/api/modelos-instalados`);
    console.log(`   Imagen:   curl -X POST http://localhost:${PORT}/api/extract-table -F "image=@foto.jpg"`);
    console.log(`   Cambiar:  curl -X POST http://localhost:${PORT}/api/cambiar-modelo -H "Content-Type: application/json" -d '{"model":"llava:7b"}'`);
    console.log('\n✅ Servidor listo!\n');
});