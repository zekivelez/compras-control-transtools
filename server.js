// server.js
// Servidor HTTP local que delega /api/* a api/index.js (mismo handler que usa Vercel) y sirve public/

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import apiHandler from './api/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Copiar Logo-azul.png a public/ si aún no existe allí (para que Vercel lo sirva como estático)
const rootLogo = path.join(__dirname, 'Logo-azul.png');
const publicLogo = path.join(__dirname, 'public', 'Logo-azul.png');
if (fs.existsSync(rootLogo) && !fs.existsSync(publicLogo)) {
    try { fs.copyFileSync(rootLogo, publicLogo); } catch {}
}

const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
        return apiHandler(req, res);
    }

    if (pathname === '/Logo-azul.png') {
        const logoPath = fs.existsSync(publicLogo) ? publicLogo : rootLogo;
        if (fs.existsSync(logoPath)) {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return fs.createReadStream(logoPath).pipe(res);
        }
    }

    const safeFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.join(__dirname, 'public', safeFile);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        return fs.createReadStream(filePath).pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ruta no encontrada');
});

server.listen(PORT, () => {
    console.log(`=============================================================`);
    console.log(` PANEL GESTION DE COMPRA — TRANSTOOLS MANUFACTURING`);
    console.log(` Servidor corriendo en: http://localhost:${PORT}`);
    console.log(`=============================================================`);
});
