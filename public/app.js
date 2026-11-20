// public/app.js
// Panel EXCLUSIVO para el tablero GESTIÓN DE COMPRA (18436902791) de TransTools Manufacturing
// Con sistema de CARRITO DE COMPRA persistente para filtrar por Familia, armar el pedido con seguridad
// y enviarlo a ÓRDENES DE COMPRA (18435123821) en Monday.com.

let estado = {
    gruposGestion: [],
    catalogoProveedores: [],
    gestionRaw: [],
    gestionFiltrada: [],
    gestionSeleccionadas: new Set(),
    carrito: new Map(), // Map<gestionItemId, itemObject>
    edicionesLocales: {}, // { [gestionItemId]: { campos editados localmente sin tocar Monday } }
    pendingUpload: null
};

const DRAFT_STORAGE_KEY = 'transtools_compras_borrador_v1';
const AUTH_STORAGE_KEY = 'transtools_compras_auth_token_v1';
let draftSaveTimer = null;

function getAuthToken() {
    try { return localStorage.getItem(AUTH_STORAGE_KEY) || ''; } catch { return ''; }
}

function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    const authToken = getAuthToken();
    if (authToken) {
        headers['x-auth-token'] = authToken;
    }
    return fetch(url, { ...options, headers });
}

// Carga el borrador local desde localStorage y desde el archivo borrador_compras.json del servidor
async function cargarBorradorLocal() {
    let localData = null;
    try {
        const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
        if (raw) localData = JSON.parse(raw);
    } catch { }

    try {
        const res = await apiFetch('/api/borrador');
        if (res.ok) {
            const serverData = await res.json();
            if (serverData && serverData.updatedAt) {
                if (!localData || !localData.updatedAt || serverData.updatedAt > localData.updatedAt) {
                    localData = serverData;
                }
            }
        }
    } catch { }

    if (localData) {
        estado.edicionesLocales = localData.ediciones || {};
        if (localData.filtros) {
            const selGrp = document.getElementById('selectGrupoGestion');
            if (localData.filtros.grupo && selGrp) selGrp.value = localData.filtros.grupo;
        }
        return localData.carritoIds || [];
    }
    return [];
}

function guardarBorradorLocal() {
    try {
        const carritoIds = [...estado.carrito.keys()];
        const payload = {
            ediciones: estado.edicionesLocales,
            carritoIds,
            filtros: {
                grupo: document.getElementById('selectGrupoGestion')?.value || 'group_mm7zxt4h',
                familia: document.getElementById('selectFamiliaGestion')?.value || 'ALL',
                of: document.getElementById('selectOFGestion')?.value || 'ALL',
                prov: document.getElementById('selectProvGestion')?.value || 'ALL'
            },
            updatedAt: new Date().toISOString()
        };

        localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));

        if (draftSaveTimer) clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(() => {
            apiFetch('/api/borrador', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => { });
        }, 400);
    } catch (e) {
        console.warn('No se pudo guardar borrador local:', e);
    }
}

function registrarEdicionLocal(it) {
    if (!it || !it.gestionItemId) return;
    const id = String(it.gestionItemId);
    estado.edicionesLocales[id] = {
        cantidadAComprar: it.cantidadAComprar,
        prioridad: it.prioridad,
        fechaRequerida: it.fechaRequerida,
        fechaAutorizacion: it.fechaAutorizacion,
        fechaInicioCotizacion: it.fechaInicioCotizacion,
        observaciones: it.observaciones,
        precioCotizadoP1: it.precioCotizadoP1,
        fechaPromesaP1: it.fechaPromesaP1,
        precioCotizadoP2: it.precioCotizadoP2,
        fechaPromesaP2: it.fechaPromesaP2,
        proveedorSeleccionadoId: it.proveedorSeleccionadoId,
        proveedorSeleccionadoNombre: it.proveedorSeleccionadoNombre,
        precioNegociado: it.precioNegociado,
        moneda: it.moneda,
        condicionesPago: it.condicionesPago,
        fechaCompromisoProveedor: it.fechaCompromisoProveedor,
        autorizacionCompra: it.autorizacionCompra,
        justificacionCompra: it.justificacionCompra,
        // Guardar copia completa del ítem por si está en el carrito y se cambia de grupo
        fullItemSnapshot: { ...it }
    };
    guardarBorradorLocal();
}

window.descartarBorradorLocal = async function () {
    const countEditados = Object.keys(estado.edicionesLocales).length;
    if (countEditados === 0 && estado.carrito.size === 0) {
        alert('No hay cambios pendientes en el borrador local.');
        return;
    }
    const ok = confirm(`¿Seguro que deseas limpiar el borrador local (${countEditados} artículos editados y ${estado.carrito.size} en el carrito) y recargar los datos originales desde Monday?`);
    if (!ok) return;

    estado.edicionesLocales = {};
    estado.carrito.clear();
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    await fetch('/api/borrador', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ediciones: {}, carritoIds: [] })
    }).catch(() => { });

    const badge = document.getElementById('draftStatusBadge');
    if (badge) badge.textContent = '💾 Borrador local limpio (Datos originales de Monday)';

    await cargarGestionDeCompra();
};

function fmtMoney(n) {
    const num = Number(n) || 0;
    return '$ ' + num.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizeStr(s) {
    if (!s) return '';
    return String(s)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function showLoading(msg = 'Procesando...') {
    document.getElementById('loadingMessage').textContent = msg;
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

window.addEventListener('DOMContentLoaded', async () => {
    await verificarSesionYConectar();
});

async function verificarSesionYConectar() {
    const authToken = getAuthToken();
    if (!authToken) {
        mostrarPantallaLogin();
        return;
    }
    try {
        const res = await apiFetch('/api/session');
        if (!res.ok) {
            mostrarPantallaLogin();
            return;
        }
        const sess = await res.json();
        if (sess.authenticated) {
            document.getElementById('loginScreen').classList.add('hidden');
            const userEl = document.getElementById('userLoggedText');
            if (userEl) userEl.textContent = sess.user || 'Monday Conectado';
            await sincronizarTodo();
        } else {
            mostrarPantallaLogin();
        }
    } catch {
        mostrarPantallaLogin();
    }
}

function mostrarPantallaLogin() {
    document.getElementById('loginScreen').classList.remove('hidden');
}

window.iniciarSesion = async function (event) {
    event.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    const errBox = document.getElementById('loginErrorBox');
    errBox.classList.add('hidden');

    showLoading('Iniciando sesión...');
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        hideLoading();

        if (!res.ok || data.error) {
            errBox.textContent = data.error || 'Credenciales incorrectas';
            errBox.classList.remove('hidden');
            return;
        }

        localStorage.setItem(AUTH_STORAGE_KEY, data.authToken);
        document.getElementById('loginScreen').classList.add('hidden');
        const userEl = document.getElementById('userLoggedText');
        if (userEl) userEl.textContent = data.user || 'Monday Conectado';
        await sincronizarTodo();
    } catch (e) {
        hideLoading();
        errBox.textContent = 'Error de conexión: ' + e.message;
        errBox.classList.remove('hidden');
    }
};

window.cerrarSesion = function () {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    mostrarPantallaLogin();
};

window.sincronizarTodo = async function () {
    showLoading('Sincronizando GESTIÓN DE COMPRA (18436902791) y Catálogo de Proveedores...');
    try {
        const res = await apiFetch('/api/init');
        if (res.status === 401) {
            hideLoading();
            mostrarPantallaLogin();
            return;
        }
        const data = await res.json();
        if (!res.ok || data.error) {
            hideLoading();
            alert(data.error || 'No se pudo conectar con Monday');
            return;
        }

        estado.gruposGestion = data.gruposGestion || [];
        estado.catalogoProveedores = data.proveedores || [];

        const carritoGuardadoIds = await cargarBorradorLocal();
        hideLoading();

        await cargarGestionDeCompra(carritoGuardadoIds);
    } catch (e) {
        hideLoading();
        alert('Error al sincronizar: ' + e.message);
    }
};

function poblarSelectProveedoresLote() {
    const sel = document.getElementById('batchGesProveedor');
    sel.innerHTML = `<option value="">-- Elegir Proveedor (${estado.catalogoProveedores.length}) --</option>`;
    for (const p of estado.catalogoProveedores) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.nombre;
        sel.appendChild(opt);
    }
}

window.cargarGestionDeCompra = async function (carritoGuardadoIds = null) {
    const groupId = document.getElementById('selectGrupoGestion').value || 'group_mm7zxt4h';
    showLoading('Consultando GESTIÓN DE COMPRA (18436902791)...');
    try {
        const res = await apiFetch(`/api/gestion-compra?groupId=${encodeURIComponent(groupId)}`);
        if (res.status === 401) {
            hideLoading();
            mostrarPantallaLogin();
            return;
        }
        const data = await res.json();
        hideLoading();

        if (!res.ok || data.error) {
            alert('Error al cargar Gestión de Compra: ' + (data.error || 'Error desconocido'));
            return;
        }

        const idsParaCarritoSet = Array.isArray(carritoGuardadoIds)
            ? new Set(carritoGuardadoIds.map(String))
            : null;

        // Si había ítems en el carrito de otros grupos que ya teníamos guardados en snapshot, restaurarlos primero
        if (idsParaCarritoSet) {
            for (const cId of idsParaCarritoSet) {
                const ed = estado.edicionesLocales[cId];
                if (ed && ed.fullItemSnapshot) {
                    estado.carrito.set(String(cId), { ...ed.fullItemSnapshot });
                }
            }
        }

        estado.gestionRaw = (data.items || []).map(it => {
            const idStr = String(it.gestionItemId);

            let provSelId = it.proveedorSeleccionadoId || '';
            let provSelNom = it.proveedorSeleccionadoNombre || '';
            if (!provSelId && it.proveedorPrincipal && it.proveedorPrincipal !== '-') {
                const match = estado.catalogoProveedores.find(
                    cp => normalizeStr(cp.nombre) === normalizeStr(it.proveedorPrincipal)
                );
                if (match) {
                    provSelId = match.id;
                    provSelNom = match.nombre;
                }
            }

            let merged = {
                ...it,
                proveedorSeleccionadoId: provSelId,
                proveedorSeleccionadoNombre: provSelNom
            };

            // Aplicar cualquier edición local pendiente del borrador (sin haber tocado Monday)
            if (estado.edicionesLocales[idStr]) {
                const { fullItemSnapshot, ...camposEditados } = estado.edicionesLocales[idStr];
                merged = { ...merged, ...camposEditados };
            }

            // Si está en el carrito (o venía en carritoGuardadoIds), actualizar el objeto del carrito
            if (estado.carrito.has(idStr) || (idsParaCarritoSet && idsParaCarritoSet.has(idStr))) {
                estado.carrito.set(idStr, { ...merged });
            }

            return merged;
        });

        estado.gestionSeleccionadas = new Set();
        document.getElementById('checkAllGestion').checked = false;

        poblarFiltrosGestion();
        filtrarGestionLocal();
        guardarBorradorLocal();
    } catch (e) {
        hideLoading();
        alert('Error cargando Gestión de Compra: ' + e.message);
    }
};

function poblarFiltrosGestion() {
    const ofsSet = new Set();
    const famsSet = new Set();
    const provsSet = new Set();

    for (const it of estado.gestionRaw) {
        const ofDisplay = it.ofFolioDetectado ? `${it.ofFolioDetectado} | ${it.ofRelacionada}` : it.ofRelacionada;
        if (ofDisplay) ofsSet.add(ofDisplay);
        if (it.familia) famsSet.add(it.familia);
        const pr = it.proveedorSeleccionadoNombre || it.proveedorPrincipal;
        if (pr && pr !== '-') provsSet.add(pr);
    }

    const selFam = document.getElementById('selectFamiliaGestion');
    const prevFam = selFam.value;
    selFam.innerHTML = `<option value="ALL">Todas las Familias (${famsSet.size})</option>`;
    [...famsSet].sort().forEach(f => {
        const countFam = estado.gestionRaw.filter(x => x.familia === f).length;
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = `${f} (${countFam})`;
        selFam.appendChild(opt);
    });
    if (prevFam && [...famsSet].includes(prevFam)) selFam.value = prevFam;

    const selOF = document.getElementById('selectOFGestion');
    selOF.innerHTML = `<option value="ALL">Todas las Órdenes de Fabricación (${ofsSet.size})</option>`;
    [...ofsSet].sort().forEach(o => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        selOF.appendChild(opt);
    });

    const selProv = document.getElementById('selectProvGestion');
    selProv.innerHTML = `<option value="ALL">Todos los Proveedores (${provsSet.size})</option>`;
    [...provsSet].sort().forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        selProv.appendChild(opt);
    });
}

window.filtrarGestionLocal = function () {
    const ofFiltro = document.getElementById('selectOFGestion').value;
    const famFiltro = document.getElementById('selectFamiliaGestion').value;
    const provFiltro = document.getElementById('selectProvGestion').value;
    const q = normalizeStr(document.getElementById('inputBusquedaGestion').value);

    document.getElementById('kpiFamiliaActivaFoot').textContent = famFiltro === 'ALL' ? 'Todas las familias' : `Familia: ${famFiltro}`;

    estado.gestionFiltrada = estado.gestionRaw.filter(it => {
        const ofDisplay = it.ofFolioDetectado ? `${it.ofFolioDetectado} | ${it.ofRelacionada}` : it.ofRelacionada;
        if (ofFiltro !== 'ALL' && ofDisplay !== ofFiltro) return false;
        if (famFiltro !== 'ALL' && it.familia !== famFiltro) return false;

        const pr = it.proveedorSeleccionadoNombre || it.proveedorPrincipal;
        if (provFiltro !== 'ALL' && pr !== provFiltro) return false;

        if (q) {
            const hay = normalizeStr(`${it.name} ${it.articuloNombre} ${it.sku} ${it.codigoProveedor} ${it.familia} ${it.subfamilia} ${it.ofRelacionada} ${it.ofFolioDetectado} ${pr}`);
            if (!hay.includes(q)) return false;
        }
        return true;
    });

    renderizarTablaGestion();
    actualizarKpisYCarrito();
};

function actualizarKpisYCarrito() {
    const ofsEnVista = new Set();
    for (const it of estado.gestionFiltrada) {
        if (it.ofRelacionada) ofsEnVista.add(it.ofRelacionada);
    }

    // Calcular métricas del Carrito único
    const itemsCarrito = [...estado.carrito.values()];
    const provsCarrito = new Set();
    for (const c of itemsCarrito) {
        const pr = c.proveedorSeleccionadoNombre || c.proveedorPrincipal || 'SIN PROVEEDOR';
        provsCarrito.add(pr);
    }

    document.getElementById('kpiGesTotal').textContent = estado.gestionFiltrada.length;
    document.getElementById('kpiGesOFs').textContent = ofsEnVista.size;

    // Contadores del Carrito Único
    document.getElementById('kpiCartItemsCount').textContent = itemsCarrito.length;
    document.getElementById('kpiCartProvsFoot').textContent = itemsCarrito.length > 0
        ? `${provsCarrito.size} proveedor(es) • Clic para revisar`
        : 'Haz clic para revisar tu carrito';
    document.getElementById('kpiCartOCsCount').textContent = `${provsCarrito.size} OCs`;
    document.getElementById('btnCountInCart').textContent = itemsCarrito.length;
}

/**
 * Renderiza la tabla de GESTIÓN DE COMPRA quitando:
 *   - Subelementos (subtasks_mm84sd07)
 *   - ESTATUS COMPRA (color_mm7xcyf0)
 *   - GENERAR OC (color_mm8f3fnj)
 *   - CANTIDAD REQUERIDA (numeric_mm7xthfb)
 * Y agregando el botón directo de Carrito por fila.
 */
function renderizarTablaGestion() {
    const tbody = document.getElementById('tbodyGestion');

    if (estado.gestionFiltrada.length === 0) {
        tbody.innerHTML = `<tr><td colspan="36" class="empty-state">No hay artículos en este grupo o familia de GESTIÓN DE COMPRA.</td></tr>`;
        return;
    }

    tbody.innerHTML = estado.gestionFiltrada.map(it => {
        const inCart = estado.carrito.has(it.gestionItemId);
        const esAcero = normalizeStr(it.familia).includes('acero');
        const rowClass = `${esAcero ? 'row-acero' : ''} ${inCart ? 'row-in-cart' : ''}`.trim();

        const provOptions = [`<option value="">-- Seleccionar Proveedor --</option>`]
            .concat(estado.catalogoProveedores.map(cp => {
                const sel = String(cp.id) === String(it.proveedorSeleccionadoId) ? 'selected' : '';
                return `<option value="${cp.id}" ${sel}>${escapeHtml(cp.nombre)}</option>`;
            })).join('');

        const bomHtml = it.bomFabricacionUrl
            ? `<a href="${escapeHtml(it.bomFabricacionUrl)}" target="_blank" class="badge-of" style="text-decoration:none;">PDF BOM (${escapeHtml(it.ofFolioDetectado || 'Ver')})</a>`
            : '-';

        const cotP1Html = `
            <div style="display:flex;align-items:center;gap:4px;">
                ${it.cotizacionP1Url ? `<a href="${escapeHtml(it.cotizacionP1Url)}" target="_blank" class="badge-of" style="text-decoration:none;">Ver P1</a>` : '<span style="color:#94A3B8;font-size:11px;">Sin archivo</span>'}
                <button class="btn btn-sm btn-secondary" style="padding:2px 6px;font-size:10.5px;" onclick="triggerUploadCotizacion('${it.gestionItemId}', 'file_mm8fbwc3')">Subir</button>
            </div>
        `;

        const cotP2Html = `
            <div style="display:flex;align-items:center;gap:4px;">
                ${it.cotizacionP2Url ? `<a href="${escapeHtml(it.cotizacionP2Url)}" target="_blank" class="badge-of" style="text-decoration:none;">Ver P2</a>` : '<span style="color:#94A3B8;font-size:11px;">Sin archivo</span>'}
                <button class="btn btn-sm btn-secondary" style="padding:2px 6px;font-size:10.5px;" onclick="triggerUploadCotizacion('${it.gestionItemId}', 'file_mm8fv0gq')">Subir</button>
            </div>
        `;

        return `<tr class="${rowClass}" data-ges-id="${it.gestionItemId}">
            <!-- Check directo al Carrito -->
            <td class="col-check sticky-col-check">
                <input type="checkbox" ${inCart ? 'checked' : ''} onchange="onToggleGestion('${it.gestionItemId}', this.checked, this)" title="Marcar para agregar al Carrito" />
            </td>
            <!-- 1. name: Name -->
            <td class="sticky-col-name"><div style="font-weight:700;min-width:220px;">${escapeHtml(it.name)}</div></td>
            <!-- 2. board_relation_mm7x4419: ARTICULOS -->
            <td><div style="min-width:170px;">${escapeHtml(it.articuloNombre || '-')}</div></td>
            <!-- 3. lookup_mm93ggeq: Lead Time -->
            <td class="num-col">${escapeHtml(it.leadTime)}</td>
            <!-- 4. lookup_mm8fqjk0: BOM DE FABRICACION -->
            <td>${bomHtml}</td>
            <!-- 5. board_relation_mm8f16zw: ORDENES DE FABRICACION RELACIONADA -->
            <td>
                <div style="min-width:190px;">
                    ${it.ofFolioDetectado ? `<span class="badge-of">${escapeHtml(it.ofFolioDetectado)}</span> ` : ''}
                    <span style="font-weight:600;font-size:11.5px;">${escapeHtml(it.ofRelacionada)}</span>
                </div>
            </td>
            <!-- 6. lookup_mm7xk0bp: SKU -->
            <td><strong>${escapeHtml(it.sku)}</strong></td>
            <!-- 7. lookup_mm93k64h: CODIGO PROVEEDOR -->
            <td>${escapeHtml(it.codigoProveedor)}</td>
            <!-- 8. lookup_mm7xg873: FAMILIA -->
            <td><span class="badge-familia ${esAcero ? 'acero' : ''}">${escapeHtml(it.familia)}</span></td>
            <!-- 9. lookup_mm7xjepq: SUBFAMILIA -->
            <td><div style="min-width:130px;font-size:11.5px;">${escapeHtml(it.subfamilia)}</div></td>
            <!-- 10. lookup_mm7xmv8h: NATURALEZA -->
            <td><div style="min-width:130px;font-size:11.5px;">${escapeHtml(it.naturaleza)}</div></td>
            <!-- 11. numeric_mm7xdfcn: CANTIDAD A COMPRAR -->
            <td class="num-col">
                <input type="number" class="table-input" style="width:76px;" step="any" min="0" value="${it.cantidadAComprar}"
                    oninput="onChangeGesField('${it.gestionItemId}', 'cantidadAComprar', this.value)" />
            </td>
            <!-- 12. lookup_mm7xf9jm: UNIDAD -->
            <td>${escapeHtml(it.unidad)}</td>
            <!-- 13. color_mm7xmvpf: PRIORIDAD -->
            <td>
                <select class="table-select" style="width:95px;" onchange="onChangeGesField('${it.gestionItemId}', 'prioridad', this.value)">
                    <option value="BAJA" ${it.prioridad === 'BAJA' ? 'selected' : ''}>BAJA</option>
                    <option value="NORMAL" ${it.prioridad === 'NORMAL' ? 'selected' : ''}>NORMAL</option>
                    <option value="ALTA" ${it.prioridad === 'ALTA' ? 'selected' : ''}>ALTA</option>
                    <option value="CRÍTICA" ${it.prioridad === 'CRÍTICA' ? 'selected' : ''}>CRÍTICA</option>
                </select>
            </td>
            <!-- 14. date_mm7xzcec: FECHA REQUERIDA -->
            <td>
                <input type="date" class="table-input" style="width:124px;text-align:left;" value="${it.fechaRequerida}"
                    onchange="onChangeGesField('${it.gestionItemId}', 'fechaRequerida', this.value)" />
            </td>
            <!-- 15. date_mm7xe5hm: FECHA AUTORIZACIÓN -->
            <td>
                <input type="date" class="table-input" style="width:124px;text-align:left;" value="${it.fechaAutorizacion}"
                    onchange="onChangeGesField('${it.gestionItemId}', 'fechaAutorizacion', this.value)" />
            </td>
            <!-- 16. multiple_person_mm7xm663: SOLICITANTE RESPONSABLE -->
            <td><div style="min-width:130px;font-size:11.5px;">${escapeHtml(it.solicitanteResponsable)}</div></td>
            <!-- 17. date_mm8f1mjd: FECHA DE INICIO DE COTIZACION -->
            <td>
                <input type="date" class="table-input" style="width:124px;text-align:left;" value="${it.fechaInicioCotizacion}"
                    onchange="onChangeGesField('${it.gestionItemId}', 'fechaInicioCotizacion', this.value)" />
            </td>
            <!-- 18. lookup_mm8f4s7f: PROVEEDOR PRINCIPAL -->
            <td><strong style="min-width:120px;display:inline-block;">${escapeHtml(it.proveedorPrincipal)}</strong></td>
            <!-- 19. long_text_mm7xeqbm: OBSERVACIONES/PROBLEMA/ACLARACION -->
            <td>
                <input type="text" class="table-input" style="width:160px;text-align:left;font-weight:400;" placeholder="Observaciones..."
                    value="${escapeHtml(it.observaciones)}"
                    oninput="onChangeGesField('${it.gestionItemId}', 'observaciones', this.value)" />
            </td>
            <!-- 20. numeric_mm7x8wd4: PRECIO COTIZADO P1 -->
            <td class="num-col">
                <input type="number" class="table-input" style="width:88px;" step="0.01" min="0" placeholder="$ P1"
                    value="${it.precioCotizadoP1 > 0 ? it.precioCotizadoP1 : ''}"
                    oninput="onChangeGesField('${it.gestionItemId}', 'precioCotizadoP1', this.value)" />
            </td>
            <!-- 21. date_mm8f4htg: FECHA PROMESA DE ENTREGA P1 -->
            <td>
                <input type="date" class="table-input" style="width:124px;text-align:left;" value="${it.fechaPromesaP1}"
                    onchange="onChangeGesField('${it.gestionItemId}', 'fechaPromesaP1', this.value)" />
            </td>
            <!-- 22. file_mm8fbwc3: COTIZACION P1 -->
            <td>${cotP1Html}</td>
            <!-- 23. lookup_mm8fgaym: PROVEEDOR ALTERNO -->
            <td><span style="min-width:110px;display:inline-block;">${escapeHtml(it.proveedorAlterno)}</span></td>
            <!-- 24. numeric_mm8fenqz: PRECIO COTIZADO P2 -->
            <td class="num-col">
                <input type="number" class="table-input" style="width:88px;" step="0.01" min="0" placeholder="$ P2"
                    value="${it.precioCotizadoP2 > 0 ? it.precioCotizadoP2 : ''}"
                    oninput="onChangeGesField('${it.gestionItemId}', 'precioCotizadoP2', this.value)" />
            </td>
            <!-- 25. date_mm8fbg8q: FECHA PROMESA DE ENTREGA P2 -->
            <td>
                <input type="date" class="table-input" style="width:124px;text-align:left;" value="${it.fechaPromesaP2}"
                    onchange="onChangeGesField('${it.gestionItemId}', 'fechaPromesaP2', this.value)" />
            </td>
            <!-- 26. file_mm8fv0gq: COTIZACION P2 -->
            <td>${cotP2Html}</td>
            <!-- 27. board_relation_mm8fcme: PROVEEDOR SELECCIONADO -->
            <td>
                <select class="table-select" style="width:175px;" onchange="onChangeGesProveedor('${it.gestionItemId}', this.value)">
                    ${provOptions}
                </select>
            </td>
            <!-- 28. lookup_mm8fmn8y: PRECIO CON IVA -->
            <td class="num-col">${escapeHtml(it.precioConIva)}</td>
            <!-- 29. numeric_mm8fwa7d: PRECIO NEGOCIADO -->
            <td class="num-col">
                <input type="number" class="table-input" style="width:92px;background:#FEF9C3;" step="0.01" min="0" placeholder="$ Negociado"
                    value="${it.precioNegociado > 0 ? it.precioNegociado : ''}"
                    oninput="onChangeGesField('${it.gestionItemId}', 'precioNegociado', this.value)" />
            </td>
            <!-- 30. color_mm8ffj9m: MONEDA -->
            <td>
                <select class="table-select" style="width:110px;" onchange="onChangeGesField('${it.gestionItemId}', 'moneda', this.value)">
                    <option value="" ${!it.moneda ? 'selected' : ''}>-- Seleccionar --</option>
                    <option value="MXN" ${it.moneda === 'MXN' ? 'selected' : ''}>MXN</option>
                    <option value="USD" ${it.moneda === 'USD' ? 'selected' : ''}>USD</option>
                </select>
            </td>
            <!-- 31. color_mm8f3rp1: CONDICIONES DE PAGO -->
            <td>
                <select class="table-select" style="width:150px;" onchange="onChangeGesField('${it.gestionItemId}', 'condicionesPago', this.value)">
                    <option value="" ${!it.condicionesPago ? 'selected' : ''}>-- Seleccionar --</option>
                    <option value="CONTADO" ${it.condicionesPago === 'CONTADO' ? 'selected' : ''}>CONTADO</option>
                    <option value="CREDITO 15 DIAS" ${it.condicionesPago === 'CREDITO 15 DIAS' ? 'selected' : ''}>CREDITO 15 DIAS</option>
                    <option value="CREDITO 30 DIAS" ${it.condicionesPago === 'CREDITO 30 DIAS' ? 'selected' : ''}>CREDITO 30 DIAS</option>
                    <option value="CREDITO 60 DIAS" ${it.condicionesPago === 'CREDITO 60 DIAS' ? 'selected' : ''}>CREDITO 60 DIAS</option>
                    <option value="CREDITO 90 DIAS" ${it.condicionesPago === 'CREDITO 90 DIAS' ? 'selected' : ''}>CREDITO 90 DIAS</option>
                    <option value="FIN DE MES" ${it.condicionesPago === 'FIN DE MES' ? 'selected' : ''}>FIN DE MES</option>
                </select>
            </td>
            <!-- 32. date_mm7xzqpd: FECHA COMPROMISO PROVEEDOR -->
            <td>
                <input type="date" class="table-input" style="width:124px;text-align:left;" value="${it.fechaCompromisoProveedor}"
                    onchange="onChangeGesField('${it.gestionItemId}', 'fechaCompromisoProveedor', this.value)" />
            </td>
            <!-- 33. color_mm7xh28f: AUTORIZACION DE COMPRA -->
            <td>
                <select class="table-select" style="width:130px;" onchange="onChangeGesField('${it.gestionItemId}', 'autorizacionCompra', this.value)">
                    <option value="" ${!it.autorizacionCompra ? 'selected' : ''}>-- Seleccionar --</option>
                    <option value="PENDIENTE" ${it.autorizacionCompra === 'PENDIENTE' ? 'selected' : ''}>PENDIENTE</option>
                    <option value="AUTORIZADO" ${it.autorizacionCompra === 'AUTORIZADO' ? 'selected' : ''}>AUTORIZADO</option>
                    <option value="RECHAZADO" ${it.autorizacionCompra === 'RECHAZADO' ? 'selected' : ''}>RECHAZADO</option>
                </select>
            </td>
            <!-- 34. text_mm8fnwcp: JUSTIFICACION DE COMPRA -->
            <td>
                <input type="text" class="table-input" style="width:155px;text-align:left;font-weight:400;" placeholder="Justificación..."
                    value="${escapeHtml(it.justificacionCompra)}"
                    oninput="onChangeGesField('${it.gestionItemId}', 'justificacionCompra', this.value)" />
            </td>
        </tr>`;
    }).join('');
}

function findGesItem(id) {
    return estado.gestionRaw.find(x => x.gestionItemId === String(id)) || estado.carrito.get(String(id));
}

function syncItemIfInCart(it) {
    if (it && estado.carrito.has(String(it.gestionItemId))) {
        estado.carrito.set(String(it.gestionItemId), { ...it });
    }
}

function validarCamposObligatoriosCarrito(it) {
    const faltantes = [];
    if (!it.proveedorSeleccionadoId && !it.proveedorSeleccionadoNombre) {
        faltantes.push('• PROVEEDOR SELECCIONADO');
    }
    if (!it.precioNegociado || Number(it.precioNegociado) <= 0) {
        faltantes.push('• PRECIO NEGOCIADO (mayor a $0)');
    }
    if (!it.moneda || String(it.moneda).trim() === '') {
        faltantes.push('• MONEDA (MXN o USD)');
    }
    if (!it.condicionesPago || String(it.condicionesPago).trim() === '') {
        faltantes.push('• CONDICIONES DE PAGO');
    }
    if (!it.fechaCompromisoProveedor || String(it.fechaCompromisoProveedor).trim() === '') {
        faltantes.push('• FECHA COMPROMISO PROVEEDOR');
    }
    if (!it.autorizacionCompra || String(it.autorizacionCompra).trim() === '') {
        faltantes.push('• AUTORIZACION DE COMPRA');
    }
    return faltantes;
}

window.onToggleGestion = function (id, checked, checkboxElem) {
    const strId = String(id);
    const it = findGesItem(strId);
    if (checked) {
        if (!it) return;
        const faltantes = validarCamposObligatoriosCarrito(it);
        if (faltantes.length > 0) {
            if (checkboxElem) checkboxElem.checked = false;
            alert(`⚠️ Para agregar "${it.name}" al Carrito debes rellenar obligatoriamente:\n\n${faltantes.join('\n')}`);
            return;
        }
        estado.carrito.set(strId, { ...it });
        registrarEdicionLocal(it);
    } else {
        estado.carrito.delete(strId);
        guardarBorradorLocal();
    }
    const tr = document.querySelector(`tr[data-ges-id="${strId}"]`);
    if (tr) tr.classList.toggle('row-in-cart', checked);
    actualizarKpisYCarrito();
};

window.toggleSelectAllGestion = function (checked) {
    let omitidos = 0;
    let agregados = 0;
    for (const it of estado.gestionFiltrada) {
        if (checked) {
            const faltantes = validarCamposObligatoriosCarrito(it);
            if (faltantes.length === 0) {
                estado.carrito.set(String(it.gestionItemId), { ...it });
                registrarEdicionLocal(it);
                agregados++;
            } else {
                omitidos++;
            }
        } else {
            estado.carrito.delete(String(it.gestionItemId));
        }
    }
    if (checked && omitidos > 0) {
        document.getElementById('checkAllGestion').checked = agregados > 0;
        alert(`⚠️ Se agregaron ${agregados} artículo(s) completos al Carrito.\n\nSe omitieron ${omitidos} artículo(s) porque les falta rellenar alguno de los datos obligatorios:\n• PROVEEDOR SELECCIONADO\n• PRECIO NEGOCIADO\n• MONEDA\n• CONDICIONES DE PAGO\n• FECHA COMPROMISO PROVEEDOR\n• AUTORIZACION DE COMPRA`);
    }
    guardarBorradorLocal();
    renderizarTablaGestion();
    actualizarKpisYCarrito();
};

window.onChangeGesField = function (id, field, val) {
    const it = findGesItem(id);
    if (!it) return;
    if (['cantidadAComprar', 'precioCotizadoP1', 'precioCotizadoP2', 'precioNegociado'].includes(field)) {
        it[field] = Number(val) || 0;
        if (field === 'precioCotizadoP1' && (!it.precioNegociado || it.precioNegociado <= 0)) {
            it.precioNegociado = Number(val) || 0;
        }
    } else {
        it[field] = val;
    }
    syncItemIfInCart(it);
    registrarEdicionLocal(it);
    actualizarKpisYCarrito();
};

window.onChangeGesProveedor = function (id, provId) {
    const it = findGesItem(id);
    if (!it) return;
    it.proveedorSeleccionadoId = provId;
    const found = estado.catalogoProveedores.find(cp => String(cp.id) === String(provId));
    it.proveedorSeleccionadoNombre = found ? found.nombre : '';
    syncItemIfInCart(it);
    registrarEdicionLocal(it);
    actualizarKpisYCarrito();
};

// =========================================================================
// LÓGICA DEL CARRITO DE COMPRA
// =========================================================================
window.toggleItemCarrito = function (id) {
    const strId = String(id);
    if (estado.carrito.has(strId)) {
        estado.carrito.delete(strId);
    } else {
        const it = findGesItem(strId);
        if (it) {
            estado.carrito.set(strId, { ...it });
        }
    }
    renderizarTablaGestion();
    actualizarKpisYCarrito();
    if (!document.getElementById('cartDrawerBackdrop').classList.contains('hidden')) {
        renderizarContenidoCarrito();
    }
};

window.agregarSeleccionadosAlCarrito = function () {
    if (estado.gestionSeleccionadas.size === 0) {
        alert('Marca con la casilla ✔ los artículos de la tabla que quieras agregar al Carrito de Compra (o usa el botón "🛒 + Carrito" de cada fila).');
        return;
    }
    let agregados = 0;
    for (const id of estado.gestionSeleccionadas) {
        const it = findGesItem(id);
        if (it) {
            estado.carrito.set(String(id), { ...it });
            agregados++;
        }
    }
    renderizarTablaGestion();
    actualizarKpisYCarrito();
    openCartDrawer();
};

window.quitarDelCarrito = function (id) {
    estado.carrito.delete(String(id));
    guardarBorradorLocal();
    renderizarTablaGestion();
    actualizarKpisYCarrito();
    renderizarContenidoCarrito();
};

window.vaciarCarrito = function () {
    if (estado.carrito.size === 0) return;
    if (!confirm('¿Seguro que deseas vaciar todos los artículos del Carrito de Compra?')) return;
    estado.carrito.clear();
    guardarBorradorLocal();
    renderizarTablaGestion();
    actualizarKpisYCarrito();
    renderizarContenidoCarrito();
};

window.openCartDrawer = function () {
    renderizarContenidoCarrito();
    document.getElementById('cartDrawerBackdrop').classList.remove('hidden');
};

window.closeCartDrawer = function () {
    document.getElementById('cartDrawerBackdrop').classList.add('hidden');
};

window.onCartBackdropClick = function (event) {
    if (event.target && event.target.id === 'cartDrawerBackdrop') {
        closeCartDrawer();
    }
};

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const backdrop = document.getElementById('cartDrawerBackdrop');
        if (backdrop && !backdrop.classList.contains('hidden')) {
            closeCartDrawer();
        }
    }
});

function renderizarContenidoCarrito() {
    const body = document.getElementById('cartDrawerBody');
    const itemsCarrito = [...estado.carrito.values()];

    if (itemsCarrito.length === 0) {
        document.getElementById('cartFooterSummary').textContent = '0 artículos en el carrito';
        body.innerHTML = `
            <div class="empty-state" style="background:#fff;border:1px dashed #CBD5E1;border-radius:8px;padding:48px;">
                <h3 style="margin-bottom:8px;color:#0A3C64;">Tu Carrito de Compra está vacío</h3>
                <p>Filtra por <strong>Familia</strong> (ej. ACEROS, SISTEMAS NEUMATICOS, SUSPENSION), rellena los precios o proveedor y marca la casilla de la fila para agregarlos al carrito.</p>
            </div>
        `;
        return;
    }

    // Agrupar artículos del carrito por Proveedor Seleccionado (así se van a crear las Órdenes de Compra)
    const gruposPorProv = new Map();
    for (const it of itemsCarrito) {
        const provNombre = (it.proveedorSeleccionadoNombre || it.proveedorPrincipal || 'SIN PROVEEDOR ASIGNADO').trim();
        if (!gruposPorProv.has(provNombre)) {
            gruposPorProv.set(provNombre, []);
        }
        gruposPorProv.get(provNombre).push(it);
    }

    document.getElementById('cartFooterSummary').textContent =
        `${itemsCarrito.length} artículo(s) listos → Se generarán ${gruposPorProv.size} Orden(es) de Compra en Monday`;

    let html = '';
    let ocIndex = 1;

    for (const [provNombre, lista] of gruposPorProv.entries()) {
        const sinProveedor = provNombre === 'SIN PROVEEDOR ASIGNADO' || provNombre === '-';
        const ofsSet = new Set();
        const famsSet = new Set();

        // Consolidar partidas con el mismo SKU dentro del mismo proveedor (ej. 10 PIEZAS de OF6-010 + 1 PIEZA de OF6-011 => 11 PIEZAS)
        const consolidadosPorSku = new Map();

        lista.forEach(x => {
            const ofLabel = x.ofFolioDetectado || x.ofRelacionada || '-';
            if (ofLabel && ofLabel !== '-') ofsSet.add(ofLabel);
            if (x.familia) famsSet.add(x.familia);

            const skuKey = (x.sku && x.sku !== '-' && x.sku !== 'S/SKU')
                ? normalizeStr(x.sku)
                : (x.articuloId ? `ART_${x.articuloId}` : normalizeStr(x.name));

            const cant = Number(x.cantidadAComprar) || 0;
            const precioFinal = Number(x.precioNegociado) > 0
                ? Number(x.precioNegociado)
                : (Number(x.precioCotizadoP1) > 0 ? Number(x.precioCotizadoP1) : Number(x.precioCotizadoP2) || 0);

            if (consolidadosPorSku.has(skuKey)) {
                const ex = consolidadosPorSku.get(skuKey);
                ex.cantidadTotal += cant;
                ex.ofsItemSet.add(ofLabel);
                ex.desgloseOFs.push(`${ofLabel}: ${cant}`);
                ex.gestionItemIds.push(String(x.gestionItemId));
                if (precioFinal > 0 && ex.precioFinal <= 0) {
                    ex.precioFinal = precioFinal;
                }
            } else {
                consolidadosPorSku.set(skuKey, {
                    sku: x.sku,
                    codigoProveedor: x.codigoProveedor,
                    name: x.name,
                    familia: x.familia,
                    unidad: x.unidad,
                    cantidadTotal: cant,
                    precioFinal,
                    moneda: x.moneda || '',
                    condicionesPago: x.condicionesPago || '',
                    fechaCompromiso: x.fechaCompromisoProveedor || x.fechaRequerida || '',
                    autorizacionCompra: x.autorizacionCompra || '',
                    ofsItemSet: new Set([ofLabel]),
                    desgloseOFs: [`${ofLabel}: ${cant}`],
                    gestionItemIds: [String(x.gestionItemId)]
                });
            }
        });

        const listaConsolidada = [...consolidadosPorSku.values()];

        const rowsHtml = listaConsolidada.map((item, idx) => {
            const idsJson = escapeHtml(JSON.stringify(item.gestionItemIds));
            const esAgrupado = item.gestionItemIds.length > 1;
            const ofsBadges = [...item.ofsItemSet].map(ofTxt => `<span class="badge-of" style="margin-right:3px;">${escapeHtml(ofTxt)}</span>`).join('');
            const desgloseBadge = esAgrupado
                ? `<div style="font-size:10.5px;color:#047857;font-weight:700;margin-top:2px;">Suma de ${item.gestionItemIds.length} solicitudes (${escapeHtml(item.desgloseOFs.join(' + '))})</div>`
                : '';

            return `<tr>
                <td>${idx + 1}</td>
                <td>${ofsBadges}</td>
                <td><strong>${escapeHtml(item.sku)}</strong><div style="font-size:10.5px;color:#64748B;">${escapeHtml(item.codigoProveedor)}</div></td>
                <td>
                    <strong>${escapeHtml(item.name)}</strong>
                    ${desgloseBadge}
                </td>
                <td><span class="badge-familia">${escapeHtml(item.familia)}</span></td>
                <td class="num-col">
                    <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;">
                        <input type="number" class="table-input" style="width:68px;" step="any" min="0" value="${item.cantidadTotal}"
                            ${esAgrupado ? 'title="Al editar esta cantidad total se asignará a la partida consolidada"' : ''}
                            oninput="onChangeCartGroupField(${idsJson}, 'cantidadAComprar', this.value)" />
                        <span style="font-size:11px;font-weight:700;color:#475569;">${escapeHtml(item.unidad)}</span>
                    </div>
                </td>
                <td class="num-col">
                    <input type="number" class="table-input" style="width:86px;background:#FEF9C3;" step="0.01" min="0" placeholder="$ Negociado"
                        value="${item.precioFinal > 0 ? item.precioFinal : ''}"
                        oninput="onChangeCartGroupField(${idsJson}, 'precioNegociado', this.value)" />
                </td>
                <td>
                    <select class="table-select" style="width:80px;" onchange="onChangeCartGroupField(${idsJson}, 'moneda', this.value)">
                        <option value="MXN" ${item.moneda === 'MXN' ? 'selected' : ''}>MXN</option>
                        <option value="USD" ${item.moneda === 'USD' ? 'selected' : ''}>USD</option>
                    </select>
                </td>
                <td>
                    <select class="table-select" style="width:135px;" onchange="onChangeCartGroupField(${idsJson}, 'condicionesPago', this.value)">
                        <option value="CONTADO" ${item.condicionesPago === 'CONTADO' ? 'selected' : ''}>CONTADO</option>
                        <option value="CREDITO 15 DIAS" ${item.condicionesPago === 'CREDITO 15 DIAS' ? 'selected' : ''}>CREDITO 15 DIAS</option>
                        <option value="CREDITO 30 DIAS" ${item.condicionesPago === 'CREDITO 30 DIAS' ? 'selected' : ''}>CREDITO 30 DIAS</option>
                        <option value="CREDITO 60 DIAS" ${item.condicionesPago === 'CREDITO 60 DIAS' ? 'selected' : ''}>CREDITO 60 DIAS</option>
                        <option value="CREDITO 90 DIAS" ${item.condicionesPago === 'CREDITO 90 DIAS' ? 'selected' : ''}>CREDITO 90 DIAS</option>
                        <option value="FIN DE MES" ${item.condicionesPago === 'FIN DE MES' ? 'selected' : ''}>FIN DE MES</option>
                    </select>
                </td>
                <td>
                    <input type="date" class="table-input" style="width:124px;text-align:left;" value="${item.fechaCompromiso}"
                        onchange="onChangeCartGroupField(${idsJson}, 'fechaCompromisoProveedor', this.value)" />
                </td>
                <td>
                    <select class="table-select" style="width:118px;" onchange="onChangeCartGroupField(${idsJson}, 'autorizacionCompra', this.value)">
                        <option value="PENDIENTE" ${item.autorizacionCompra === 'PENDIENTE' ? 'selected' : ''}>PENDIENTE</option>
                        <option value="AUTORIZADO" ${item.autorizacionCompra === 'AUTORIZADO' ? 'selected' : ''}>AUTORIZADO</option>
                        <option value="RECHAZADO" ${item.autorizacionCompra === 'RECHAZADO' ? 'selected' : ''}>RECHAZADO</option>
                    </select>
                </td>
                <td class="num-col">
                    <button class="btn btn-sm btn-danger" style="padding:2px 7px;" onclick="quitarGrupoSkuDelCarrito(${idsJson})">✕</button>
                </td>
            </tr>`;
        }).join('');

        html += `
            <div class="cart-provider-card ${sinProveedor ? 'warn-card' : ''}">
                <div class="cart-provider-header">
                    <div>
                        <h4 style="font-size:15px;color:#0A3C64;">
                            Orden de Compra #${ocIndex++} → Proveedor: <strong>${escapeHtml(provNombre)}</strong>
                        </h4>
                        <div style="font-size:12px;color:#64748B;margin-top:2px;">
                            <strong>Órdenes de Fabricación:</strong> ${escapeHtml([...ofsSet].join(', ') || '-')} •
                            <strong>Familias incluidas:</strong> ${escapeHtml([...famsSet].join(', ') || '-')} •
                            <strong>Partidas consolidadas por SKU:</strong> ${listaConsolidada.length} <span style="color:#64748B;">(de ${lista.length} solicitudes)</span>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <button class="btn btn-danger btn-sm" onclick="quitarProveedorDelCarrito('${escapeHtml(provNombre)}')" title="Vaciar solo las partidas de este proveedor">
                            Quitar Proveedor
                        </button>
                        <button class="btn btn-success btn-sm" style="padding:7px 14px;font-size:12.5px;" onclick="enviarProveedorDelCarritoAMonday('${escapeHtml(provNombre)}')">
                            Enviar OC de ${escapeHtml(provNombre)} (${listaConsolidada.length} SKU${listaConsolidada.length === 1 ? '' : 's'})
                        </button>
                    </div>
                </div>
                <div style="overflow-x:auto;">
                    <table class="data-table" style="border:1px solid #E2E8F0;">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>OF</th>
                                <th>SKU / CÓD</th>
                                <th>ARTÍCULO</th>
                                <th>FAMILIA</th>
                                <th class="num-col">CANTIDAD TOTAL</th>
                                <th class="num-col">PRECIO NEGOCIADO *</th>
                                <th>MONEDA *</th>
                                <th>CONDICIONES DE PAGO *</th>
                                <th>FECHA COMPROMISO *</th>
                                <th>AUTORIZACION *</th>
                                <th>QUITAR</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    body.innerHTML = html;
}

window.onChangeCartGroupField = function (idsArray, field, val) {
    if (!Array.isArray(idsArray) || idsArray.length === 0) return;

    if (field === 'cantidadAComprar') {
        const nuevaCantTotal = Math.max(0, Number(val) || 0);
        // Si es 1 solo ítem se actualiza directo; si son varios consolidados por SKU, se asigna al primero y los demás en 0 para que la suma total sea exactamente nuevaCantTotal
        idsArray.forEach((idStr, idx) => {
            const cantItem = idx === 0 ? nuevaCantTotal : 0;
            const rawIt = estado.gestionRaw.find(x => x.gestionItemId === String(idStr));
            if (rawIt) rawIt.cantidadAComprar = cantItem;
            if (estado.carrito.has(String(idStr))) {
                const cIt = estado.carrito.get(String(idStr));
                cIt.cantidadAComprar = cantItem;
                estado.carrito.set(String(idStr), cIt);
                registrarEdicionLocal(cIt);
            }
        });
    } else {
        const parsedVal = field === 'precioNegociado' ? (Number(val) || 0) : val;
        idsArray.forEach(idStr => {
            const rawIt = estado.gestionRaw.find(x => x.gestionItemId === String(idStr));
            if (rawIt) rawIt[field] = parsedVal;
            if (estado.carrito.has(String(idStr))) {
                const cIt = estado.carrito.get(String(idStr));
                cIt[field] = parsedVal;
                estado.carrito.set(String(idStr), cIt);
                registrarEdicionLocal(cIt);
            }
        });
    }

    renderizarTablaGestion();
    actualizarKpisYCarrito();
};

window.quitarGrupoSkuDelCarrito = function (idsArray) {
    if (!Array.isArray(idsArray)) return;
    idsArray.forEach(id => estado.carrito.delete(String(id)));
    guardarBorradorLocal();
    renderizarTablaGestion();
    actualizarKpisYCarrito();
    renderizarContenidoCarrito();
};

window.quitarProveedorDelCarrito = function (provNombre) {
    const itemsCarrito = [...estado.carrito.values()];
    const delProv = itemsCarrito.filter(it => (it.proveedorSeleccionadoNombre || it.proveedorPrincipal || 'SIN PROVEEDOR ASIGNADO').trim() === provNombre);
    if (delProv.length === 0) return;
    if (!confirm(`¿Quitar las ${delProv.length} partida(s) del proveedor "${provNombre}" del carrito?`)) return;

    delProv.forEach(it => estado.carrito.delete(String(it.gestionItemId)));
    guardarBorradorLocal();
    renderizarTablaGestion();
    actualizarKpisYCarrito();
    renderizarContenidoCarrito();
};

window.enviarProveedorDelCarritoAMonday = async function (provNombre) {
    const itemsCarrito = [...estado.carrito.values()];
    const itemsProveedor = itemsCarrito.filter(
        it => (it.proveedorSeleccionadoNombre || it.proveedorPrincipal || 'SIN PROVEEDOR ASIGNADO').trim() === provNombre
    );

    if (itemsProveedor.length === 0) {
        alert(`No hay artículos para el proveedor "${provNombre}".`);
        return;
    }

    const ok = confirm(`¿Confirmas enviar únicamente la Orden de Compra del proveedor "${provNombre}" (${itemsProveedor.length} partida(s)) a ÓRDENES DE COMPRA (18435123821)?\n\n(Los demás proveedores de tu carrito permanecerán intactos para que los envíes por separado).`);
    if (!ok) return;

    showLoading(`Enviando Orden de Compra exclusiva de "${provNombre}" (${itemsProveedor.length} partidas) a Monday.com...`);
    try {
        const res = await apiFetch('/api/gestion-compra/generar-oc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: itemsProveedor,
                proveedores: estado.catalogoProveedores
            })
        });
        const data = await res.json();
        hideLoading();

        if (!res.ok || data.error) {
            alert('Error al enviar la Orden de Compra de ' + provNombre + ': ' + (data.error || 'Error desconocido'));
            return;
        }

        // Quitar del carrito y del borrador local ÚNICAMENTE los artículos de este proveedor que ya se enviaron
        itemsProveedor.forEach(it => {
            const idStr = String(it.gestionItemId);
            estado.carrito.delete(idStr);
            delete estado.edicionesLocales[idStr];
        });
        guardarBorradorLocal();

        renderizarContenidoCarrito();
        if (estado.carrito.size === 0) {
            closeCartDrawer();
        }
        mostrarModalOCGeneradas(data.resultadosOC || []);
        await cargarGestionDeCompra();
    } catch (e) {
        hideLoading();
        alert('Error al enviar Orden de Compra: ' + e.message);
    }
};

// =========================================================================
// SUBIDA DE COTIZACIONES Y GUARDADO DE AVANCES EN GESTIÓN DE COMPRA
// =========================================================================
window.triggerUploadCotizacion = function (gestionItemId, columnId) {
    estado.pendingUpload = { gestionItemId, columnId };
    const inp = document.getElementById('hiddenFileInput');
    inp.value = '';
    inp.click();
};

window.onFileSelectedForUpload = async function (event) {
    const file = event.target.files?.[0];
    if (!file || !estado.pendingUpload) return;

    const { gestionItemId, columnId } = estado.pendingUpload;
    showLoading(`Subiendo archivo "${file.name}" a Monday (${columnId})...`);

    try {
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const res = String(reader.result || '');
                const commaIdx = res.indexOf(',');
                resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

        const resp = await apiFetch('/api/gestion-compra/subir-cotizacion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                gestionItemId,
                columnId,
                fileName: file.name,
                fileBase64: base64,
                mimeType: file.type || 'application/octet-stream'
            })
        });
        const data = await resp.json();
        hideLoading();

        if (!resp.ok || data.error) {
            alert('Error al subir archivo: ' + (data.error || 'Error desconocido'));
            return;
        }

        alert(`✅ Archivo "${file.name}" subido exitosamente a Monday.`);
        await cargarGestionDeCompra();
    } catch (e) {
        hideLoading();
        alert('Error subiendo archivo: ' + e.message);
    }
};

window.aplicarLoteGestion = function () {
    if (estado.gestionSeleccionadas.size === 0) {
        alert('Marca con la casilla ✔ las filas a las que quieras aplicar estos valores en lote.');
        return;
    }
    const provId = document.getElementById('batchGesProveedor').value;
    const moneda = document.getElementById('batchGesMoneda').value;
    const cond = document.getElementById('batchGesCondiciones').value;
    const aut = document.getElementById('batchGesAutorizacion').value;

    const foundProv = provId ? estado.catalogoProveedores.find(cp => String(cp.id) === String(provId)) : null;

    for (const it of estado.gestionFiltrada) {
        if (estado.gestionSeleccionadas.has(it.gestionItemId)) {
            if (foundProv) {
                it.proveedorSeleccionadoId = foundProv.id;
                it.proveedorSeleccionadoNombre = foundProv.nombre;
            }
            if (moneda) it.moneda = moneda;
            if (cond) it.condicionesPago = cond;
            if (aut) it.autorizacionCompra = aut;
            syncItemIfInCart(it);
        }
    }
    renderizarTablaGestion();
    actualizarKpisYCarrito();
};

window.guardarAvancesEnGestionMonday = async function () {
    const itemsCarrito = [...estado.carrito.values()];
    if (itemsCarrito.length === 0) {
        alert('Marca con la casilla ✔ los artículos cuyos avances quieras guardar en GESTIÓN DE COMPRA.');
        return;
    }

    showLoading(`Guardando avances de ${itemsCarrito.length} artículo(s) en GESTIÓN DE COMPRA (18436902791)...`);
    try {
        const res = await fetch('/api/gestion-compra/actualizar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: itemsCarrito })
        });
        const data = await res.json();
        hideLoading();

        if (!res.ok || data.error) {
            alert('Error al guardar en Monday: ' + (data.error || 'Error desconocido'));
            return;
        }

        alert(`✅ Se guardaron correctamente ${data.totalActualizados} artículo(s) en GESTIÓN DE COMPRA.`);
    } catch (e) {
        hideLoading();
        alert('Error guardando avances: ' + e.message);
    }
};

function mostrarModalOCGeneradas(resultados) {
    const body = document.getElementById('modalResultadosBody');

    const rows = resultados.map(r => `
        <tr>
            <td><strong>${escapeHtml(r.nombreOC)}</strong></td>
            <td>${escapeHtml(r.proveedor)}</td>
            <td><span class="badge-of">${escapeHtml(r.ordenesFabricacion)}</span></td>
            <td class="num-col"><strong>${r.partidasCreadas} partidas</strong></td>
            <td>${escapeHtml(r.moneda)} / ${escapeHtml(r.condicionesPago)}</td>
            <td><code>${r.ocItemId}</code></td>
        </tr>
    `).join('');

    body.innerHTML = `
        <p style="margin-bottom:12px;">
            Se enviaron los artículos de tu Carrito de Compra y se crearon exitosamente <strong>${resultados.length}</strong> Orden(es) de Compra en el tablero
            <strong>ÓRDENES DE COMPRA (18435123821)</strong> vinculadas a sus respectivas <strong>Órdenes de Fabricación</strong>:
        </p>
        <table class="data-table" style="border:1px solid #CBD5E1;">
            <thead>
                <tr>
                    <th>ORDEN DE COMPRA</th>
                    <th>PROVEEDOR</th>
                    <th>ÓRDENES DE FABRICACIÓN</th>
                    <th class="num-col">PARTIDAS</th>
                    <th>CONDICIONES</th>
                    <th>MONDAY ID</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
    document.getElementById('modalResultados').classList.remove('hidden');
}

window.closeResultadosModal = function () {
    document.getElementById('modalResultados').classList.add('hidden');
};

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
