// index.js - Servidor principal (refactorizado)
const express = require('express');
const cors = require('cors');

const config = require('./config');
const routes = require('./routes/routes');

const app = express();
const PORT = config.port;

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100mb' }));

// Rutas
app.use('/api', routes);

// Manejador de errores global
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
    console.log('║   🚫 IGNORA ENCABEZADOS DE TABLA                    ║');
    console.log('║   🔄 CONVERSIÓN COMAS → PUNTOS Y LIMPIEZA DE ESPACIOS║');
    console.log('║   📋 SOPORTE PARA TABLAS LARGAS                     ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`\n📡 Servidor: http://0.0.0.0:${PORT}`);
    console.log(`🔗 Ollama: ${config.ollamaUrl}`);
    console.log(`🤖 Modelo actual: ${config.modelName}`);
    console.log(`🚫 Encabezados: IGNORADOS`);
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