// filepath: /home/dno/ai-nB/server.js
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors'); // Import the cors middleware

dotenv.config({ path: './functions/.env' });

const app = express();
const port = 3000;

app.use(cors()); // Enable CORS for all routes

app.get('/api/openrouter-key', (req, res) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) {
        res.json({ apiKey });
    } else {
        res.status(500).json({ error: 'OpenRouter API key not found' });
    }
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});