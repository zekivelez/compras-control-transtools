// services/panelComprasService.js
// Servicio EXCLUSIVO para el tablero GESTION DE COMPRA (18436902791) de Transtools Manufacturing.
// NO consulta ni muestra SOLICITUDES DE COMPRA.
// Lee todas las columnas oficiales de GESTION DE COMPRA (18436902791), permite editar/guardar todo el proceso de compra,
// y una vez rellenado carga las Órdenes de Compra (18435123821) vinculadas a las Órdenes de Fabricación.

import {
    normalizeStr,
    extractColText,
    extractColNumber,
    getLinkedIds,
    uploadFileToMonday
} from './mondayClient.js';

import {
    BOARD_ORDENES_DE_COMPRA,
    BOARD_CATALOGO_PROVEEDORES
} from './ordenCompraService.js';

export const BOARD_GESTION_COMPRA = "18436902791";
export const BOARD_ORDENES_FABRICACION = "18434500734";
export const BOARD_CATALOGO_ARTICULOS = "18432236328";

// Grupos oficiales de GESTION DE COMPRA (18436902791)
export const GRUPOS_GESTION_COMPRA = {
    NUEVAS_SOLICITUDES: "group_mm7zxt4h",
    COTIZANDO: "group_mm8gqevc",
    NEGOCIACION_Y_SELECCION: "group_mm8g7kr6",
    BLOQUEADOS: "group_mm8g6k1f",
    LISTOS_PARA_OC: "group_mm8g9gb2",
    OC_GENERADA: "group_mm8gy8gv"
};

export const MAP_ESTATUS_A_GRUPO_GESTION = {
    "NO INICIADA": "group_mm7zxt4h",
    "COTIZANDO": "group_mm8gqevc",
    "NEGOCIACION Y SELECCION": "group_mm8g7kr6",
    "BLOQUEO/ACLARACION": "group_mm8g6k1f",
    "LISTO PARA GENERAR OC": "group_mm8g9gb2",
    "OC GENERADA": "group_mm8gy8gv"
};

/**
 * Obtiene únicamente los grupos del tablero GESTION DE COMPRA (18436902791)
 */
export async function getGruposGestionCompra({ fetchMonday }) {
    const query = `query {
        boards(ids: [${BOARD_GESTION_COMPRA}]) {
            id
            name
            groups {
                id
                title
                color
            }
        }
    }`;
    const res = await fetchMonday(query);
    if (res.errors) {
        throw new Error(`Error al consultar GESTION DE COMPRA: ${res.errors.map(e => e.message).join(', ')}`);
    }
    const groups = res.data?.boards?.[0]?.groups || [];
    return groups.map(g => ({
        groupId: g.id,
        title: g.title,
        color: g.color
    }));
}

/**
 * Obtiene todo el Catálogo de Proveedores (18434817715)
 */
export async function getCatalogoProveedores({ fetchMonday }) {
    const query = `query {
        boards(ids: [${BOARD_CATALOGO_PROVEEDORES}]) {
            items_page(limit: 500) {
                items {
                    id
                    name
                }
            }
        }
    }`;
    const res = await fetchMonday(query);
    if (res.errors) {
        throw new Error(`Error al consultar Catálogo de Proveedores: ${res.errors.map(e => e.message).join(', ')}`);
    }
    const items = res.data?.boards?.[0]?.items_page?.items || [];
    return items.map(item => ({
        id: String(item.id),
        nombre: item.name
    })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/**
 * Extrae las URLs/archivos de una columna tipo file de Monday
 */
function extractFileAssets(col) {
    if (!col) return [];
    const out = [];
    if (col.value) {
        try {
            const v = JSON.parse(col.value);
            if (Array.isArray(v?.files)) {
                for (const f of v.files) {
                    out.push({
                        name: f.name || "Archivo",
                        assetId: f.assetId || null,
                        url: col.text || ""
                    });
                }
            }
        } catch {}
    }
    if (out.length === 0 && col.text) {
        out.push({ name: "Ver archivo", url: col.text });
    }
    return out;
}

/**
 * Consulta todos los artículos del tablero GESTION DE COMPRA (18436902791)
 * con las 38 columnas exactas especificadas por el usuario.
 */
export async function getItemsGestionDeCompra({ fetchMonday, groupId = "ALL" }) {
    let rawItems = [];

    const itemFields = `
        id
        name
        group { id title color }
        subitems { id name }
        column_values {
            id
            type
            text
            value
            ... on MirrorValue { display_value }
            ... on BoardRelationValue {
                display_value
                linked_item_ids
                linked_items { id name }
            }
        }
    `;

    if (groupId && groupId !== "ALL") {
        const query = `query ($boardId: [ID!], $groupId: [String!]) {
            boards(ids: $boardId) {
                groups(ids: $groupId) {
                    id
                    title
                    items_page(limit: 500) {
                        items { ${itemFields} }
                    }
                }
            }
        }`;
        const res = await fetchMonday(query, {
            boardId: [BOARD_GESTION_COMPRA],
            groupId: [String(groupId)]
        });
        rawItems = res.data?.boards?.[0]?.groups?.[0]?.items_page?.items || [];
    } else {
        const query = `query ($boardId: [ID!]) {
            boards(ids: $boardId) {
                items_page(limit: 500) {
                    items { ${itemFields} }
                }
            }
        }`;
        const res = await fetchMonday(query, {
            boardId: [BOARD_GESTION_COMPRA]
        });
        rawItems = res.data?.boards?.[0]?.items_page?.items || [];
    }

    const items = rawItems.map((item, idx) => {
        const cols = item.column_values || [];
        const getCol = (id) => cols.find(c => c.id === id);

        // 1. name (Name)
        const name = item.name || "";
        // 2. subtasks_mm84sd07 (Subelementos)
        const subelementosCount = (item.subitems || []).length;
        // 3. board_relation_mm7x4419 (ARTICULOS)
        const articuloIds = getLinkedIds(getCol("board_relation_mm7x4419"));
        const articuloNombre = extractColText(getCol("board_relation_mm7x4419")) || "";
        // 4. lookup_mm93ggeq (Lead Time)
        const leadTime = extractColText(getCol("lookup_mm93ggeq")) || "-";
        // 5. lookup_mm8fqjk0 (BOM DE FABRICACION)
        const bomFabricacionUrl = extractColText(getCol("lookup_mm8fqjk0")) || "";
        // 6. board_relation_mm8f16zw (ORDENES DE FABRICACION RELACIONADA)
        const ofIds = getLinkedIds(getCol("board_relation_mm8f16zw"));
        const ofRelacionada = extractColText(getCol("board_relation_mm8f16zw")) || "SIN OF";
        let ofFolioDetectado = "";
        const mFolio = bomFabricacionUrl.match(/OF\d*-\d+/i);
        if (mFolio) ofFolioDetectado = mFolio[0].toUpperCase();

        // 7. lookup_mm7xk0bp (SKU)
        const sku = extractColText(getCol("lookup_mm7xk0bp")) || "-";
        // 8. lookup_mm93k64h (CODIGO PROVEEDOR)
        const codigoProveedor = extractColText(getCol("lookup_mm93k64h")) || "-";
        // 9. lookup_mm7xg873 (FAMILIA)
        const familia = (extractColText(getCol("lookup_mm7xg873")) || "-").toUpperCase();
        // 10. lookup_mm7xjepq (SUBFAMILIA)
        const subfamilia = extractColText(getCol("lookup_mm7xjepq")) || "-";
        // 11. lookup_mm7xmv8h (NATURALEZA)
        const naturaleza = extractColText(getCol("lookup_mm7xmv8h")) || "-";
        // 12. numeric_mm7xdfcn (CANTIDAD A COMPRAR)
        const cantidadAComprar = extractColNumber(getCol("numeric_mm7xdfcn"), 0);
        // 13. lookup_mm7xf9jm (UNIDAD)
        const unidad = extractColText(getCol("lookup_mm7xf9jm")) || "PIEZA";
        // 14. color_mm7xmvpf (PRIORIDAD)
        const prioridad = extractColText(getCol("color_mm7xmvpf")) || "ALTA";
        // 15. date_mm7xzcec (FECHA REQUERIDA)
        const fechaRequerida = extractColText(getCol("date_mm7xzcec")) || "";
        // 16. date_mm7xe5hm (FECHA AUTORIZACIÓN)
        const fechaAutorizacion = extractColText(getCol("date_mm7xe5hm")) || "";
        // 17. multiple_person_mm7xm663 (SOLICITANTE RESPONSABLE)
        const solicitanteResponsable = extractColText(getCol("multiple_person_mm7xm663")) || "-";
        // 18. color_mm7xcyf0 (ESTATUS COMPRA)
        const estatusCompra = extractColText(getCol("color_mm7xcyf0")) || "NO INICIADA";
        // 19. date_mm8f1mjd (FECHA DE INICIO DE COTIZACION)
        const fechaInicioCotizacion = extractColText(getCol("date_mm8f1mjd")) || "";
        // 20. lookup_mm8f4s7f (PROVEEDOR PRINCIPAL)
        const proveedorPrincipal = extractColText(getCol("lookup_mm8f4s7f")) || "-";
        // 21. long_text_mm7xeqbm (OBSERVACIONES/PROBLEMA/ACLARACION)
        const observaciones = extractColText(getCol("long_text_mm7xeqbm")) || "";
        // 22. numeric_mm7x8wd4 (PRECIO COTIZADO P1)
        const precioCotizadoP1 = extractColNumber(getCol("numeric_mm7x8wd4"), 0);
        // 23. date_mm8f4htg (FECHA PROMESA DE ENTREGA P1)
        const fechaPromesaP1 = extractColText(getCol("date_mm8f4htg")) || "";
        // 24. file_mm8fbwc3 (COTIZACION P1)
        const cotizacionP1Files = extractFileAssets(getCol("file_mm8fbwc3"));
        const cotizacionP1Url = extractColText(getCol("file_mm8fbwc3")) || "";
        // 25. lookup_mm8fgaym (PROVEEDOR ALTERNO)
        const proveedorAlterno = extractColText(getCol("lookup_mm8fgaym")) || "-";
        // 26. numeric_mm8fenqz (PRECIO COTIZADO P2)
        const precioCotizadoP2 = extractColNumber(getCol("numeric_mm8fenqz"), 0);
        // 27. date_mm8fbg8q (FECHA PROMESA DE ENTREGA P2)
        const fechaPromesaP2 = extractColText(getCol("date_mm8fbg8q")) || "";
        // 28. file_mm8fv0gq (COTIZACION P2)
        const cotizacionP2Files = extractFileAssets(getCol("file_mm8fv0gq"));
        const cotizacionP2Url = extractColText(getCol("file_mm8fv0gq")) || "";
        // 29. board_relation_mm8fcme (PROVEEDOR SELECCIONADO)
        const provSelIds = getLinkedIds(getCol("board_relation_mm8fcme"));
        const proveedorSeleccionadoNombre = extractColText(getCol("board_relation_mm8fcme")) || "";
        const proveedorSeleccionadoId = provSelIds[0] || "";
        // 30. lookup_mm9dq60t (PRECIO SIN IVA)
        const precioSinIva = extractColText(getCol("lookup_mm9dq60t")) || "-";
        // 30b. lookup_mm8fmn8y (PRECIO CON IVA)
        const precioConIva = extractColText(getCol("lookup_mm8fmn8y")) || "-";
        // 31. numeric_mm8fwa7d (PRECIO NEGOCIADO)
        const precioNegociado = extractColNumber(getCol("numeric_mm8fwa7d"), 0);
        // 32. color_mm8ffj9m (MONEDA)
        const moneda = extractColText(getCol("color_mm8ffj9m")) || "";
        // 33. color_mm8f3rp1 (CONDICIONES DE PAGO)
        const condicionesPago = extractColText(getCol("color_mm8f3rp1")) || "";
        // 34. date_mm7xzqpd (FECHA COMPROMISO PROVEEDOR)
        const fechaCompromisoProveedor = extractColText(getCol("date_mm7xzqpd")) || "";
        // 35. color_mm7xh28f (AUTORIZACION DE COMPRA)
        const autorizacionCompra = extractColText(getCol("color_mm7xh28f")) || "";
        // 36. text_mm8fnwcp (JUSTIFICACION DE COMPRA)
        const justificacionCompra = extractColText(getCol("text_mm8fnwcp")) || "";
        // 37. color_mm8f3fnj (GENERAR OC)
        const generarOc = extractColText(getCol("color_mm8f3fnj")) || "PENDIENTE";
        // 38. numeric_mm7xthfb (CANTIDAD REQUERIDA)
        const cantidadRequerida = extractColNumber(getCol("numeric_mm7xthfb"), 0);

        return {
            gestionItemId: String(item.id),
            indice: idx + 1,
            grupoId: item.group?.id || "",
            grupoTitulo: item.group?.title || "",
            grupoColor: item.group?.color || "#037f4c",
            name,
            subelementosCount,
            articuloId: articuloIds[0] || null,
            articuloNombre,
            leadTime,
            bomFabricacionUrl,
            ofIds,
            ofRelacionada,
            ofFolioDetectado,
            sku,
            codigoProveedor,
            familia,
            subfamilia,
            naturaleza,
            cantidadAComprar,
            unidad,
            prioridad,
            fechaRequerida,
            fechaAutorizacion,
            solicitanteResponsable,
            estatusCompra,
            fechaInicioCotizacion,
            proveedorPrincipal,
            observaciones,
            precioCotizadoP1,
            fechaPromesaP1,
            cotizacionP1Files,
            cotizacionP1Url,
            proveedorAlterno,
            precioCotizadoP2,
            fechaPromesaP2,
            cotizacionP2Files,
            cotizacionP2Url,
            proveedorSeleccionadoId,
            proveedorSeleccionadoNombre,
            precioSinIva,
            precioConIva,
            precioNegociado,
            moneda,
            condicionesPago,
            fechaCompromisoProveedor,
            autorizacionCompra,
            justificacionCompra,
            generarOc,
            cantidadRequerida
        };
    });

    return {
        totalItems: items.length,
        items
    };
}

/**
 * Guarda en Monday (GESTION DE COMPRA - 18436902791) todas las columnas editables
 * y mueve el ítem de grupo si cambia el Estatus Compra.
 */
export async function actualizarItemsGestionDeCompra({
    fetchMonday,
    cambios = []
}) {
    const actualizados = [];
    const errores = [];

    const BATCH_SIZE = 5;
    for (let i = 0; i < cambios.length; i += BATCH_SIZE) {
        const batch = cambios.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (item) => {
            const colValues = {};

            if (item.cantidadAComprar !== undefined && item.cantidadAComprar !== "") {
                colValues["numeric_mm7xdfcn"] = Number(item.cantidadAComprar);
            }
            if (item.cantidadRequerida !== undefined && item.cantidadRequerida !== "") {
                colValues["numeric_mm7xthfb"] = Number(item.cantidadRequerida);
            }
            if (item.prioridad) {
                colValues["color_mm7xmvpf"] = { label: item.prioridad };
            }
            if (item.fechaRequerida) {
                colValues["date_mm7xzcec"] = { date: item.fechaRequerida };
            }
            if (item.fechaAutorizacion) {
                colValues["date_mm7xe5hm"] = { date: item.fechaAutorizacion };
            }
            if (item.estatusCompra) {
                colValues["color_mm7xcyf0"] = { label: item.estatusCompra };
            }
            if (item.fechaInicioCotizacion) {
                colValues["date_mm8f1mjd"] = { date: item.fechaInicioCotizacion };
            }
            if (item.observaciones !== undefined) {
                colValues["long_text_mm7xeqbm"] = { text: String(item.observaciones) };
            }
            if (item.precioCotizadoP1 !== undefined && item.precioCotizadoP1 !== "") {
                colValues["numeric_mm7x8wd4"] = Number(item.precioCotizadoP1);
            }
            if (item.fechaPromesaP1) {
                colValues["date_mm8f4htg"] = { date: item.fechaPromesaP1 };
            }
            if (item.precioCotizadoP2 !== undefined && item.precioCotizadoP2 !== "") {
                colValues["numeric_mm8fenqz"] = Number(item.precioCotizadoP2);
            }
            if (item.fechaPromesaP2) {
                colValues["date_mm8fbg8q"] = { date: item.fechaPromesaP2 };
            }
            if (item.proveedorSeleccionadoId) {
                colValues["board_relation_mm8fcme"] = { item_ids: [Number(item.proveedorSeleccionadoId)] };
            }
            if (item.precioNegociado !== undefined && item.precioNegociado !== "") {
                colValues["numeric_mm8fwa7d"] = Number(item.precioNegociado);
            }
            if (item.moneda) {
                colValues["color_mm8ffj9m"] = { label: item.moneda };
            }
            if (item.condicionesPago) {
                colValues["color_mm8f3rp1"] = { label: item.condicionesPago };
            }
            if (item.fechaCompromisoProveedor) {
                colValues["date_mm7xzqpd"] = { date: item.fechaCompromisoProveedor };
            }
            if (item.autorizacionCompra) {
                colValues["color_mm7xh28f"] = { label: item.autorizacionCompra };
            }
            if (item.justificacionCompra !== undefined) {
                colValues["text_mm8fnwcp"] = String(item.justificacionCompra);
            }
            if (item.generarOc) {
                colValues["color_mm8f3fnj"] = { label: item.generarOc };
            }

            try {
                const updMutation = `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
                    change_multiple_column_values (
                        board_id: $boardId,
                        item_id: $itemId,
                        column_values: $cols,
                        create_labels_if_missing: true
                    ) { id }
                }`;

                const resp = await fetchMonday(updMutation, {
                    boardId: BOARD_GESTION_COMPRA,
                    itemId: String(item.gestionItemId),
                    cols: JSON.stringify(colValues)
                });

                const targetGroup = MAP_ESTATUS_A_GRUPO_GESTION[item.estatusCompra];
                if (targetGroup && item.grupoId && targetGroup !== item.grupoId) {
                    const moveMutation = `mutation ($itemId: ID!, $groupId: String!) {
                        move_item_to_group (item_id: $itemId, group_id: $groupId) { id }
                    }`;
                    await fetchMonday(moveMutation, {
                        itemId: String(item.gestionItemId),
                        groupId: targetGroup
                    });
                }

                if (resp.data?.change_multiple_column_values?.id) {
                    actualizados.push(item.gestionItemId);
                } else {
                    errores.push({ id: item.gestionItemId, error: resp.errors });
                }
            } catch (e) {
                errores.push({ id: item.gestionItemId, error: e.message });
            }
        }));
    }

    return {
        totalActualizados: actualizados.length,
        totalErrores: errores.length,
        errores
    };
}

/**
 * Sube un archivo de cotización a COTIZACION P1 (file_mm8fbwc3) o COTIZACION P2 (file_mm8fv0gq) en GESTION DE COMPRA
 */
export async function subirArchivoCotizacionGestion({
    token,
    gestionItemId,
    columnId,
    fileName,
    fileBase64,
    mimeType = "application/pdf"
}) {
    const buffer = Buffer.from(fileBase64, "base64");
    const res = await uploadFileToMonday(gestionItemId, token, buffer, fileName, columnId, mimeType);
    if (res.errors) {
        throw new Error(`Error al subir archivo a ${columnId}: ${JSON.stringify(res.errors)}`);
    }
    return res;
}

/**
 * Una vez rellenados los datos en GESTION DE COMPRA (18436902791),
 * carga las compras para las Órdenes de Fabricación y genera las Órdenes de Compra en Monday (18435123821)
 */
export async function generarOrdenesDeCompraDesdeGestion({
    fetchMonday,
    itemsGestion = [],
    catalogoProveedores = []
}) {
    const todayStr = new Date().toISOString().split('T')[0];

    const provById = new Map();
    const provByName = new Map();
    for (const p of catalogoProveedores) {
        provById.set(String(p.id), p);
        provByName.set(normalizeStr(p.nombre), p);
    }

    const gruposPorProveedor = new Map();

    for (const item of itemsGestion) {
        let provId = item.proveedorSeleccionadoId || null;
        let provNombre = item.proveedorSeleccionadoNombre || item.proveedorPrincipal || "PROVEEDOR POR DEFINIR";

        if (!provId && provNombre && provByName.has(normalizeStr(provNombre))) {
            provId = provByName.get(normalizeStr(provNombre)).id;
        } else if (provId && provById.has(String(provId))) {
            provNombre = provById.get(String(provId)).nombre;
        }

        const key = provId ? `ID_${provId}` : `NOM_${normalizeStr(provNombre)}`;
        if (!gruposPorProveedor.has(key)) {
            gruposPorProveedor.set(key, {
                proveedorId: provId,
                proveedorNombre: provNombre,
                moneda: item.moneda || "MXN",
                condicionesPago: item.condicionesPago || "CONTADO",
                fechaComprometida: item.fechaCompromisoProveedor || item.fechaRequerida || todayStr,
                prioridad: item.prioridad === "CRÍTICA" ? "URGENTE" : (item.prioridad || "NORMAL"),
                ofsNombresSet: new Set(),
                ofsIdsSet: new Set(),
                partidas: []
            });
        }

        const grp = gruposPorProveedor.get(key);
        if (item.ofFolioDetectado) grp.ofsNombresSet.add(item.ofFolioDetectado);
        if (item.ofRelacionada && item.ofRelacionada !== "SIN OF") grp.ofsNombresSet.add(item.ofRelacionada);
        (item.ofIds || []).forEach(id => grp.ofsIdsSet.add(String(id)));

        grp.partidas.push(item);
    }

    const resultadosOC = [];

    // Consultar las OCs existentes en ÓRDENES DE COMPRA (18435123821) para calcular el siguiente consecutivo en formato OC-YYYY-MM-XX (ej. OC-2026-11-55)
    const now = new Date();
    const yearMonthPrefix = `OC-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`;
    let maxConsecutivo = 0;

    try {
        const existingOcsQuery = `query {
            boards(ids: [${BOARD_ORDENES_DE_COMPRA}]) {
                items_page(limit: 500) {
                    items {
                        name
                    }
                }
            }
        }`;
        const existingOcsRes = await fetchMonday(existingOcsQuery);
        const existingOcs = existingOcsRes.data?.boards?.[0]?.items_page?.items || [];
        for (const ocItem of existingOcs) {
            const nm = String(ocItem.name || "").trim();
            const m = nm.match(/^OC-\d{4}-\d{2}-(\d+)/i);
            if (m) {
                const num = parseInt(m[1], 10);
                if (!isNaN(num) && num > maxConsecutivo) {
                    maxConsecutivo = num;
                }
            }
        }
        if (maxConsecutivo === 0 && existingOcs.length > 0) {
            maxConsecutivo = existingOcs.length;
        }
    } catch (e) {
        console.warn("[Generar OC]: No se pudo consultar consecutivo previo de OC:", e.message);
    }

    for (const grp of gruposPorProveedor.values()) {
        maxConsecutivo += 1;
        const ofsTexto = [...grp.ofsNombresSet].join(", ") || "-";
        const itemNameOC = `${yearMonthPrefix}${String(maxConsecutivo).padStart(2, '0')}`;

        const headerCols = {
            "date_mm7xytge": { date: todayStr },
            "date_mm8f45wm": { date: grp.fechaComprometida || todayStr },
            "color_mm8fvdt5": { label: grp.prioridad === "BAJA" ? "NORMAL" : grp.prioridad },
            "color_mm8fwjg7": { label: grp.condicionesPago },
            "color_mm8fsf4m": { label: grp.moneda },
            "color_mm7xx0e8": { label: "PENDIENTE DE CONFIRMACION" },
            "text_mm8fvgsb": ofsTexto
        };

        if (grp.proveedorId) {
            headerCols["board_relation_mm8fk8az"] = { item_ids: [Number(grp.proveedorId)] };
        }

        const createOCMutation = `mutation ($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
            create_item (
                board_id: $boardId,
                group_id: $groupId,
                item_name: $itemName,
                column_values: $columnValues,
                create_labels_if_missing: true
            ) {
                id
                name
            }
        }`;

        const ocRes = await fetchMonday(createOCMutation, {
            boardId: BOARD_ORDENES_DE_COMPRA,
            groupId: "group_mm7zxt4h",
            itemName: itemNameOC.slice(0, 255),
            columnValues: JSON.stringify(headerCols)
        });

        const ocItemId = ocRes.data?.create_item?.id;
        if (!ocItemId) {
            throw new Error(`Error al crear OC para proveedor "${grp.proveedorNombre}": ${JSON.stringify(ocRes.errors)}`);
        }

        // Consolidar partidas con el mismo SKU (o artículo) dentro del mismo proveedor para crear 1 solo subitem con la suma de cantidades
        const partidasConsolidadasMap = new Map();
        for (const part of grp.partidas) {
            const skuKey = (part.sku && part.sku !== '-' && part.sku !== 'S/SKU')
                ? normalizeStr(part.sku)
                : (part.articuloId ? `ART_${part.articuloId}` : normalizeStr(part.name));

            const cant = Number(part.cantidadAComprar || part.cantidadRequerida || 1);
            const precioFinal = Number(part.precioNegociado) > 0
                ? Number(part.precioNegociado)
                : (Number(part.precioCotizadoP1) > 0 ? Number(part.precioCotizadoP1) : Number(part.precioCotizadoP2) || 0);

            if (partidasConsolidadasMap.has(skuKey)) {
                const ex = partidasConsolidadasMap.get(skuKey);
                ex.cantidadTotal += cant;
                if (precioFinal > 0 && ex.precioFinal <= 0) {
                    ex.precioFinal = precioFinal;
                }
                if (part.gestionItemId) {
                    ex.gestionItemIds.push(String(part.gestionItemId));
                }
            } else {
                partidasConsolidadasMap.set(skuKey, {
                    name: part.name || part.articuloNombre || "PARTIDA",
                    articuloId: part.articuloId || null,
                    cantidadTotal: cant,
                    precioFinal,
                    fechaCompromiso: part.fechaCompromisoProveedor || grp.fechaComprometida || todayStr,
                    gestionItemIds: part.gestionItemId ? [String(part.gestionItemId)] : []
                });
            }
        }

        const partidasConsolidadas = [...partidasConsolidadasMap.values()];
        const subitemsCreados = [];
        const BATCH_SIZE = 5;

        for (let i = 0; i < partidasConsolidadas.length; i += BATCH_SIZE) {
            const batch = partidasConsolidadas.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (partCons) => {
                const subCols = {
                    "numeric_mm8fhc9y": Number(partCons.cantidadTotal),
                    "numeric_mm8fptc1": Number(partCons.precioFinal),
                    "date0": { date: partCons.fechaCompromiso }
                };

                if (partCons.articuloId) {
                    subCols["board_relation_mm8fpvn5"] = { item_ids: [Number(partCons.articuloId)] };
                }

                const createSubMutation = `mutation ($parentId: ID!, $itemName: String!, $columnValues: JSON!) {
                    create_subitem (
                        parent_item_id: $parentId,
                        item_name: $itemName,
                        column_values: $columnValues,
                        create_labels_if_missing: true
                    ) { id name }
                }`;

                const subRes = await fetchMonday(createSubMutation, {
                    parentId: String(ocItemId),
                    itemName: partCons.name.slice(0, 255),
                    columnValues: JSON.stringify(subCols)
                });

                if (subRes.data?.create_subitem?.id) {
                    subitemsCreados.push(subRes.data.create_subitem.id);
                }

                // Marcar en GESTION DE COMPRA todos los ítems originales consolidados como OC GENERADA
                for (const gId of partCons.gestionItemIds) {
                    const updGestionMutation = `mutation ($boardId: ID!, $itemId: ID!, $cols: JSON!) {
                        change_multiple_column_values (
                            board_id: $boardId,
                            item_id: $itemId,
                            column_values: $cols
                        ) { id }
                    }`;
                    await fetchMonday(updGestionMutation, {
                        boardId: BOARD_GESTION_COMPRA,
                        itemId: String(gId),
                        cols: JSON.stringify({
                            "color_mm7xcyf0": { label: "OC GENERADA" },
                            "color_mm8f3fnj": { label: "GENERAR OC" }
                        })
                    });

                    const moveMutation = `mutation ($itemId: ID!, $groupId: String!) {
                        move_item_to_group (item_id: $itemId, group_id: $groupId) { id }
                    }`;
                    await fetchMonday(moveMutation, {
                        itemId: String(gId),
                        groupId: GRUPOS_GESTION_COMPRA.OC_GENERADA
                    });
                }
            }));
        }

        resultadosOC.push({
            ocItemId,
            nombreOC: itemNameOC,
            proveedor: grp.proveedorNombre,
            ordenesFabricacion: ofsTexto,
            partidasCreadas: subitemsCreados.length,
            moneda: grp.moneda,
            condicionesPago: grp.condicionesPago
        });
    }

    return resultadosOC;
}
