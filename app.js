// filepath: /home/dno/ai-nB/app.js
const path = require('path');
require('dotenv').config({ path: './functions/.env' }); // Load .env file

console.log('OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY); // Check if the variable is loaded

const fs = require('fs');
const ini = require('ini');

const config = ini.parse(fs.readFileSync('./functions/project.ini', 'utf-8'));

console.log('Config:', config); // Check if the config is loaded

// Access config values
const debugMode = config.system.debug;
console.log('Debug Mode:', debugMode);