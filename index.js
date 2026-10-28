// index.js - Servidor principal (refactorizado)
const express = require('express');
const cors = require('cors');

const config = require('./config');
const routesTables = require('./routes/pimageroutes');
const routesText = require('./routes/ptextroutes');

const app = express();
const PORT = config.port;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100mb' }));

// Rutas de extracción de tablas por medio de una imagen
app.use('/api/tablas', routesTables);

// Rutas de extracción de texto por medio de una imagen
app.use('/api/texto', routesText);

// Manejador de errores global
app.use((err, req, res, next) => {
    console.error('❌ Error global:', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Error interno del servidor'
    });
});

// ==================== INICIO ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor en http://0.0.0.0:${PORT}\n`);
    console.log(`📋 Rutas disponibles:\n`);
    console.log(`  GET    /api/tablas/health                        → Estado del servicio de tablas`);
    console.log(`  POST   /api/tablas/extract-table                 → Extrae tabla desde imagen`);
    console.log(`  POST   /api/tablas/cambiar-modelo                → Cambia modelo Ollama (tablas)`);
    console.log(`  GET    /api/tablas/check-model                   → Verifica modelo activo (tablas)`);
    console.log(`  GET    /api/tablas/modelos-instalados            → Lista modelos en Ollama\n`);
    console.log(`  GET    /api/texto/health                  → Estado del servicio de texto`);
    console.log(`  POST   /api/texto/extract-text            → Extrae texto plano desde imagen`);
    console.log(`  POST   /api/texto/cambiar-modelo          → Cambia modelo Ollama (texto)`);
    console.log(`  GET    /api/texto/check-model             → Verifica modelo activo (texto)`);
    console.log(`  GET    /api/texto/modelos-instalados      → Lista modelos en Ollama\n`);
});