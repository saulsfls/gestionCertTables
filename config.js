// config.js - Configuración centralizada y mutable en runtime
require('dotenv').config();

const config = {
    PORT: parseInt(process.env.PORT, 10) || 3000,
    OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434',
    MODEL_NAME: process.env.MODEL_NAME || 'glm-ocr',
    MODELOS_VALIDOS: ['glm-ocr', 'llava:7b', 'qwen2.5-coder:7b']
};

module.exports = {
    // Lectura dinámica (siempre devuelve el valor actual)
    get port() { return config.PORT; },
    get ollamaUrl() { return config.OLLAMA_URL; },
    get modelName() { return config.MODEL_NAME; },
    get modelosValidos() { return config.MODELOS_VALIDOS; },

    // Setters
    setModel(model) {
        if (!config.MODELOS_VALIDOS.includes(model)) {
            throw new Error(`Modelo inválido. Opciones: ${config.MODELOS_VALIDOS.join(', ')}`);
        }
        config.MODEL_NAME = model;
        process.env.MODEL_NAME = model; // mantener coherencia con el .env en runtime
        return config.MODEL_NAME;
    }
};