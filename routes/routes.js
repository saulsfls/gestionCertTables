// routes/routes.js - Definición de rutas
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const {
    extractTableFromImage,
    optimizeImage,
    cleanupFiles
} = require('../controllers/pimage');

const router = express.Router();

// ==================== CONFIGURACIÓN DE MULTER ====================
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

// ==================== ENDPOINTS ====================

// Health check
router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        ollama_url: config.ollamaUrl,
        model_actual: config.modelName,
        modelos_disponibles: config.modelosValidos,
        ignorar_encabezados: true
    });
});

// Extraer tabla de imagen
router.post('/extract-table', upload.single('image'), async (req, res) => {
    let optimizedPath = null;
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No se subió ninguna imagen'
            });
        }

        const modelUsado = config.modelName;

        console.log(`\n📸 Procesando: ${req.file.originalname}`);
        console.log(`📏 Tamaño: ${(req.file.size / 1024).toFixed(2)}KB`);
        console.log(`🤖 Usando modelo: ${modelUsado}`);
        console.log(`🚫 Ignorando encabezados de tabla`);
        console.log(`🔄 Conversión automática: comas -> puntos y eliminación de espacios en números`);

        optimizedPath = await optimizeImage(req.file.path);
        const imageToProcess = optimizedPath || req.file.path;

        const result = await extractTableFromImage(imageToProcess);

        cleanupFiles([req.file.path, optimizedPath]);

        res.json({
            success: true,
            table: result.table,
            modelo_usado: modelUsado,
            conversion_aplicada: true,
            encabezados_ignorados: true,
            metadata: {
                filename: req.file.originalname,
                size: req.file.size,
                optimized: !!optimizedPath,
                lines: result.metadata?.lines || 0,
                characters: result.metadata?.characters || 0
            }
        });

    } catch (error) {
        console.error('❌ Error:', error);
        if (req.file) cleanupFiles([req.file.path, optimizedPath]);
        res.status(500).json({
            success: false,
            error: error.message || 'Error procesando la imagen',
            suggestion: 'Asegúrate de que la imagen contenga una tabla clara y visible'
        });
    }
});

// Cambiar modelo (ahora sí funciona)
router.post('/cambiar-modelo', (req, res) => {
    try {
        const { model } = req.body;
        if (!model) {
            return res.status(400).json({
                success: false,
                error: `Debe indicar un modelo. Opciones: ${config.modelosValidos.join(', ')}`
            });
        }
        const nuevoModelo = config.setModel(model);
        console.log(`🔄 Modelo cambiado a: ${nuevoModelo}`);
        res.json({
            success: true,
            message: `Modelo cambiado a: ${nuevoModelo}`,
            modelo_actual: nuevoModelo
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            error: error.message
        });
    }
});

// Verificar modelo
router.get('/check-model', async (req, res) => {
    try {
        const startTime = Date.now();
        const response = await axios.post(`${config.ollamaUrl}/api/generate`, {
            model: config.modelName,
            prompt: 'OK',
            stream: false
        }, { timeout: 30000 });
        const responseTime = Date.now() - startTime;
        res.json({
            success: true,
            model: config.modelName,
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

// Modelos instalados en Ollama
router.get('/modelos-instalados', async (req, res) => {
    try {
        const response = await axios.get(`${config.ollamaUrl}/api/tags`);
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

module.exports = router;