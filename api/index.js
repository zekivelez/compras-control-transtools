// api/index.js
// Handler unificado de API compatible con Vercel Serverless Functions y con el servidor local (server.js)

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createMondayClient } from '../services/mondayClient.js';
import {
    getGruposGestionCompra,
    getCatalogoProveedores,
    getItemsGestionDeCompra,
    actualizarItemsGestionDeCompra,
    subirArchivoCotizacionGestion,
    generarOrdenesDeCompraDesdeGestion
} from '../services/panelComprasService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFile() {
    const envPath = path.join(ROOT_DIR, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (val && !process.env[key]) {
                process.env[key] = val;
            }
        }
    }
}

loadEnvFile();

// Token de Monday preconfigurado en servidor/Vercel para que el usuario nunca tenga que pegarlo en la web
const FALLBACK_MONDAY_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjM4MDk5MjcyMiwiYWFpIjoxMSwidWlkIjo0MDY5NzEwMSwiaWFkIjoiMjAyNC0wNy0wNVQyMTowMjozMi4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MTA5Mjg0OTUsInJnbiI6InVzZTEifQ.55PVw2YfNZ7d7DUgqfEOl4vLHlh3MU5QGnwReMl-NpQ";

function getMondayToken() {
    loadEnvFile();
    return (process.env.MONDAY_API_KEY || process.env.MONDAY_API_TOKEN || FALLBACK_MONDAY_TOKEN).trim();
}

function getPanelCredentials() {
    loadEnvFile();
    return {
        user: (process.env.PANEL_USER || "compras@transtools.com.mx").trim(),
        pass: (process.env.PANEL_PASS || "Transtools2026").trim()
    };
}

function createAuthToken(user) {
    const secret = getMondayToken().slice(-24) || "transtools_secret_2026";
    const sig = crypto.createHmac('sha256', secret).update(user).digest('hex');
    return `${Buffer.from(user).toString('base64')}.${sig}`;
}

function verifyAuthToken(authToken) {
    if (!authToken || typeof authToken !== 'string') return null;
    const parts = authToken.split('.');
    if (parts.length !== 2) return null;
    try {
        const user = Buffer.from(parts[0], 'base64').toString('utf-8');
        const expected = createAuthToken(user);
        if (expected === authToken) return user;
    } catch {}
    return null;
}

function sendJson(res, status, data) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.end(JSON.stringify(data));
}

function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') {
        return Promise.resolve(req.body);
    }
    if (req.body && typeof req.body === 'string') {
        try { return Promise.resolve(JSON.parse(req.body)); } catch {}
    }
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('JSON inválido en el cuerpo de la petición'));
            }
        });
        req.on('error', reject);
    });
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = parsedUrl.pathname;

    // Compatibilidad con Vercel rewrites (cuando Vercel reescribe /api/login -> /api/index.js?__path=login)
    const rewritePath = parsedUrl.searchParams.get('__path') || req.query?.__path;
    if (rewritePath) {
        const cleanPath = Array.isArray(rewritePath) ? rewritePath.join('/') : String(rewritePath).replace(/^\/+/, '');
        pathname = `/api/${cleanPath}`;
    } else if (req.headers['x-matched-path'] && pathname === '/api/index.js') {
        pathname = req.headers['x-matched-path'];
    }

    try {
        // 1. Login de usuario
        if (pathname === '/api/login' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const inputUser = String(body.username || '').trim().toLowerCase();
            const inputPass = String(body.password || '').trim();
            const creds = getPanelCredentials();

            const validUser = inputUser === creds.user.toLowerCase() || inputUser === 'compras' || inputUser === 'admin';
            const validPass = inputPass === creds.pass;

            if (!validUser || !validPass) {
                return sendJson(res, 401, { error: 'Usuario o contraseña incorrectos' });
            }

            const authToken = createAuthToken(creds.user);
            return sendJson(res, 200, {
                success: true,
                user: creds.user,
                authToken
            });
        }

        // 2. Verificar sesión actual
        if (pathname === '/api/session' && req.method === 'GET') {
            const authHeader = req.headers['x-auth-token'] || '';
            const user = verifyAuthToken(authHeader);
            if (!user) {
                return sendJson(res, 401, { authenticated: false });
            }
            return sendJson(res, 200, {
                authenticated: true,
                user
            });
        }

        // Validar sesión en las rutas protegidas
        const authHeader = req.headers['x-auth-token'] || '';
        const activeUser = verifyAuthToken(authHeader);
        if (!activeUser) {
            return sendJson(res, 401, { error: 'Sesión no iniciada o expirada' });
        }

        const token = getMondayToken();

        // 3. Inicialización: Grupos de GESTION DE COMPRA (18436902791) y Catálogo de Proveedores (18434817715)
        if (pathname === '/api/init' && req.method === 'GET') {
            const fetchMonday = createMondayClient(token);
            const [gruposGestion, proveedores] = await Promise.all([
                getGruposGestionCompra({ fetchMonday }),
                getCatalogoProveedores({ fetchMonday })
            ]);
            return sendJson(res, 200, {
                gruposGestion,
                proveedores
            });
        }

        // 4. Borrador local (en local usa borrador_compras.json; en Vercel usa /tmp/borrador_compras.json + localStorage del navegador)
        if (pathname === '/api/borrador' && req.method === 'GET') {
            const localDraft = path.join(ROOT_DIR, 'borrador_compras.json');
            const tmpDraft = '/tmp/borrador_compras.json';
            const draftPath = fs.existsSync(localDraft) ? localDraft : (fs.existsSync(tmpDraft) ? tmpDraft : null);
            if (draftPath) {
                try {
                    const raw = fs.readFileSync(draftPath, 'utf-8');
                    return sendJson(res, 200, JSON.parse(raw));
                } catch {}
            }
            return sendJson(res, 200, { ediciones: {}, carritoIds: [], updatedAt: null });
        }

        if (pathname === '/api/borrador' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const payload = {
                ediciones: body.ediciones || {},
                carritoIds: body.carritoIds || [],
                filtros: body.filtros || {},
                updatedAt: new Date().toISOString()
            };
            try {
                fs.writeFileSync(path.join(ROOT_DIR, 'borrador_compras.json'), JSON.stringify(payload, null, 2), 'utf-8');
            } catch {
                try {
                    fs.writeFileSync('/tmp/borrador_compras.json', JSON.stringify(payload, null, 2), 'utf-8');
                } catch {}
            }
            return sendJson(res, 200, { success: true, updatedAt: payload.updatedAt });
        }

        // 5. Consultar artículos en GESTION DE COMPRA (18436902791)
        if (pathname === '/api/gestion-compra' && req.method === 'GET') {
            const groupId = parsedUrl.searchParams.get('groupId') || 'ALL';
            const fetchMonday = createMondayClient(token);
            const data = await getItemsGestionDeCompra({ fetchMonday, groupId });
            return sendJson(res, 200, data);
        }

        // 6. Guardar cambios en GESTION DE COMPRA (18436902791)
        if (pathname === '/api/gestion-compra/actualizar' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const cambios = body.items || [];
            const fetchMonday = createMondayClient(token);
            const resUpd = await actualizarItemsGestionDeCompra({ fetchMonday, cambios });
            return sendJson(res, 200, { success: true, ...resUpd });
        }

        // 7. Subir archivo a COTIZACION P1 (file_mm8fbwc3) o COTIZACION P2 (file_mm8fv0gq)
        if (pathname === '/api/gestion-compra/subir-cotizacion' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const resUpload = await subirArchivoCotizacionGestion({
                token,
                gestionItemId: body.gestionItemId,
                columnId: body.columnId,
                fileName: body.fileName,
                fileBase64: body.fileBase64,
                mimeType: body.mimeType
            });
            return sendJson(res, 200, { success: true, resUpload });
        }

        // 8. Generar Órdenes de Compra (18435123821) por Proveedor desde el Carrito
        if (pathname === '/api/gestion-compra/generar-oc' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const itemsGestion = body.items || [];
            const catalogoProveedores = body.proveedores || [];

            if (!Array.isArray(itemsGestion) || itemsGestion.length === 0) {
                return sendJson(res, 400, { error: 'Selecciona al menos un artículo para generar su Orden de Compra' });
            }

            const fetchMonday = createMondayClient(token);
            await actualizarItemsGestionDeCompra({ fetchMonday, cambios: itemsGestion });
            const resultadosOC = await generarOrdenesDeCompraDesdeGestion({
                fetchMonday,
                itemsGestion,
                catalogoProveedores
            });

            return sendJson(res, 200, {
                success: true,
                totalOCs: resultadosOC.length,
                resultadosOC
            });
        }

        return sendJson(res, 404, { error: 'Endpoint de API no encontrado' });
    } catch (err) {
        console.error('[API Error]:', err);
        return sendJson(res, 500, { error: err.message || 'Error interno en el servidor' });
    }
}
