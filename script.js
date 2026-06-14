/* =============================================================
   Calleando CABA — lógica principal
   - Inicializa Leaflet con CartoDB Positron
   - Carga data/calles.json (generado por build_data.py)
   - Autocomplete contra ese dataset
   - Geocoding en vivo contra Nominatim + cache localStorage
   - Dibuja polyline (calles) o marker (plazas/parques) según tipo
   ============================================================= */

(() => {
    "use strict";

    // ---------- Configuración ----------
    const CABA_CENTER = [-34.6037, -58.3816];
    const CABA_BOUNDS = [
        [-34.706, -58.531],   // SW
        [-34.527, -58.335],   // NE
    ];
    const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
    const VIEWBOX = "-58.531,-34.706,-58.335,-34.527"; // long/lat, long/lat
    const CACHE_KEY = "calleando_geocache_v1";
    const MAX_SUGGESTIONS = 8;
    const LINE_COLOR = "#1a73e8";

    // Paleta de colores por categoría del Excel. Los colores fueron elegidos
    // para que sean distinguibles entre sí y mantengan buen contraste sobre
    // el mapa Voyager (claro) y Dark Matter (oscuro).
    const COLORES_CATEGORIA = {
        "PERSONA":            "#1a73e8", // azul (default Google)
        "LUGAR":              "#0d9488", // verde turquesa
        "NATURALEZA":         "#16a34a", // verde
        "ACCIÓN MILITAR":     "#dc2626", // rojo
        "CONCEPTO":           "#7c3aed", // violeta
        "OTROS":              "#6b7280", // gris medio
        "ARTE":               "#ea580c", // naranja
        "BARCO":              "#1e3a8a", // azul marino
        "FECHA":              "#ca8a04", // amarillo dorado
        "CUERPO MILITAR":     "#991b1b", // rojo oscuro
        "PUEBLOS ORIGINARIOS":"#a16207", // marrón terracota
        "RELIGIÓN":           "#9333ea", // violeta lavanda
        "RÍO":                "#0891b2", // cian
        "INSTITUCIÓN":        "#475569", // gris azulado
        "LITERATURA":         "#db2777", // rosa
    };

    function colorParaEntrada(entrada) {
        if (!entrada) return LINE_COLOR;
        const cat = (entrada.categoria || "").trim().toUpperCase();
        return COLORES_CATEGORIA[cat] || LINE_COLOR;
    }

    // Tipos que se dibujan como línea (calles); el resto como marcador.
    const TIPOS_LINEA = new Set([
        "calle", "avenida", "pasaje peatonal", "autopista",
        "sendero", "paseo", "puente", "túnel", "tunel",
        "sendero peatonal", "puente peatonal",
    ]);

    // ---------- Estado ----------
    let calles = [];               // array cargado desde calles.json
    let geoCache = {};             // {clave: {tipo, geometry, bbox, ...}} pre-geocodificado
    let calleBarrios = {};         // {clave: nombreBarrio} mapping
    let barriosGeo = null;         // FeatureCollection de los 48 barrios
    let comunasGeo = null;         // FeatureCollection de las 15 comunas
    let barrioActivo = "";         // filtro activo: "" = todos
    let categoriaActiva = "";      // filtro de categoría: "" = todas
    let capaBarrio = null;         // overlay del contorno del barrio activo
    let capaOverlayTodos = null;   // overlay con los 48 barrios simultáneos
    let capaOverlayComunas = null; // overlay con las 15 comunas simultáneas
    let capaCategoria = null;      // overlay con todas las calles de la categoría
    let mapa;                      // instancia Leaflet
    let capaActual = null;         // polyline o marker dibujado por la última búsqueda
    let popupActual = null;        // popup actual
    let indiceActivo = -1;         // sugerencia resaltada con teclado

    // ---------- DOM ----------
    const $input = document.getElementById("search-input");
    const $btnBuscar = document.getElementById("search-btn");
    const $btnRandom = document.getElementById("random-btn");
    const $btnTheme = document.getElementById("theme-toggle-btn");
    const $themeMenu = document.getElementById("theme-menu");
    const $btnLimpiar = document.getElementById("clear-btn");
    const $suggestions = document.getElementById("suggestions");
    const $toast = document.getElementById("status-toast");
    const $barrioSelect = document.getElementById("barrio-select");
    const $categoriaSelect = document.getElementById("categoria-select");

    // =================================================================
    // 1. UTILIDADES
    // =================================================================

    /** Quita tildes, pasa a minúsculas, normaliza espacios. */
    function normalizar(texto) {
        if (!texto) return "";
        return texto
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function esTipoLinea(tipo) {
        return TIPOS_LINEA.has((tipo || "").toLowerCase().trim());
    }

    function mostrarToast(mensaje, duracionMs = 3000) {
        $toast.textContent = mensaje;
        $toast.hidden = false;
        clearTimeout(mostrarToast._t);
        mostrarToast._t = setTimeout(() => { $toast.hidden = true; }, duracionMs);
    }

    function escapeHtml(s) {
        return String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // =================================================================
    // 2. CACHE DE GEOCODING (localStorage)
    // =================================================================

    function leerCache() {
        try {
            return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
        } catch (_) {
            return {};
        }
    }

    function guardarEnCache(clave, valor) {
        try {
            const cache = leerCache();
            cache[clave] = valor;
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch (_) {
            // localStorage lleno: silencioso
        }
    }

    // =================================================================
    // 3. INICIALIZACIÓN DEL MAPA
    // =================================================================

    function inicializarMapa() {
        // maxBounds = límites ESTRICTOS de CABA, con padding mínimo (~1 km).
        // CABA: norte -34.527 (Av. Gral. Paz), sur -34.705 (Riachuelo),
        //       oeste -58.531 (Av. Gral. Paz), este -58.335 (Río de la Plata).
        mapa = L.map("map", {
            center: CABA_CENTER,
            zoom: 13,
            zoomControl: true,
            maxBounds: [
                [-34.720, -58.545],   // SW (Riachuelo + Gral. Paz, con padding)
                [-34.515, -58.320],   // NE (Núñez + Río de la Plata, con padding)
            ],
            maxBoundsViscosity: 1.0, // impide el "rebote" fuera de CABA
            minZoom: 12,             // no permite alejarse más de CABA entera
            maxZoom: 19,
        });

        // Capa de tiles: Voyager (default), Positron (claro), Dark Matter (oscuro).
        // El tema se guarda en localStorage para persistir entre visitas.
        aplicarTema(localStorage.getItem("calleando_tema") || "voyager");

        // Reposicionar el control de zoom para no chocar con la caja de búsqueda
        mapa.zoomControl.setPosition("bottomright");
    }

    // Capas de tiles disponibles
    const TEMAS = {
        voyager: {
            url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
            subdomains: "abcd",
            label: "Voyager",
        },
        claro: {
            url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
            subdomains: "abcd",
            label: "Claro",
        },
        oscuro: {
            url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            subdomains: "abcd",
            label: "Oscuro",
        },
    };

    let capaTiles = null;
    let temaActual = "voyager";

    function aplicarTema(nombre) {
        if (!TEMAS[nombre]) nombre = "voyager";
        if (capaTiles) {
            mapa.removeLayer(capaTiles);
        }
        const tema = TEMAS[nombre];
        capaTiles = L.tileLayer(tema.url, {
            attribution: "",
            subdomains: tema.subdomains,
            maxZoom: 19,
        }).addTo(mapa);
        temaActual = nombre;
        localStorage.setItem("calleando_tema", nombre);
        document.body.classList.toggle("tema-oscuro", nombre === "oscuro");
        marcarTemaActivo();
    }

    function marcarTemaActivo() {
        if (!$themeMenu) return;
        for (const li of $themeMenu.querySelectorAll("li[data-tema]")) {
            li.classList.toggle("activo", li.dataset.tema === temaActual);
        }
    }

    // =================================================================
    // 4. CARGA DE DATOS
    // =================================================================

    async function cargarDatos() {
        // Carga en paralelo: dataset, cache geo, barrios, comunas y mapping calle->barrio.
        const [respCalles, respCache, respBarrios, respComunas, respMap] = await Promise.all([
            fetch("data/calles.json"),
            fetch("data/geo_cache.json").catch(() => null),
            fetch("data/barrios.geojson").catch(() => null),
            fetch("data/comunas.geojson").catch(() => null),
            fetch("data/calle_barrios.json").catch(() => null),
        ]);

        if (!respCalles || !respCalles.ok) {
            console.error("Error cargando calles.json");
            mostrarToast("No se pudieron cargar los datos del Excel.", 6000);
            return;
        }
        calles = await respCalles.json();
        console.log(`Datos cargados: ${calles.length} entradas`);

        if (respCache && respCache.ok) {
            try {
                geoCache = await respCache.json();
                console.log(`Geo-cache pre-cargado: ${Object.keys(geoCache).length} geometrías`);
            } catch (_) {
                geoCache = {};
            }
        } else {
            console.log("Sin geo-cache pre-generado — usando modo en vivo.");
        }

        if (respBarrios && respBarrios.ok) {
            try {
                barriosGeo = await respBarrios.json();
                console.log(`Barrios cargados: ${barriosGeo.features.length}`);
            } catch (_) { barriosGeo = null; }
        }
        if (respComunas && respComunas.ok) {
            try {
                comunasGeo = await respComunas.json();
                console.log(`Comunas cargadas: ${comunasGeo.features.length}`);
            } catch (_) { comunasGeo = null; }
        }
        if (respMap && respMap.ok) {
            try {
                calleBarrios = await respMap.json();
                console.log(`Mapeo calle->barrio: ${Object.keys(calleBarrios).length}`);
            } catch (_) { calleBarrios = {}; }
        }

        // Vincular cada entrada a su barrio para uso en autocomplete
        for (const c of calles) {
            c.barrio = calleBarrios[c.clave] || null;
        }

        poblarDropdownBarrios();
        poblarDropdownCategorias();
    }

    function poblarDropdownBarrios() {
        // Separador después de las opciones de overlay
        if (barriosGeo) {
            const sepBarrios = document.createElement("option");
            sepBarrios.disabled = true;
            sepBarrios.textContent = "── Barrios ──";
            $barrioSelect.appendChild(sepBarrios);

            const nombres = barriosGeo.features
                .map((f) => f.properties.nombre)
                .sort((a, b) => a.localeCompare(b, "es"));
            for (const n of nombres) {
                const opt = document.createElement("option");
                opt.value = `barrio:${n}`;
                opt.textContent = n;
                $barrioSelect.appendChild(opt);
            }
        }
        // Comunas al final
        if (comunasGeo) {
            const sepComunas = document.createElement("option");
            sepComunas.disabled = true;
            sepComunas.textContent = "── Comunas ──";
            $barrioSelect.appendChild(sepComunas);

            const comunas = comunasGeo.features
                .slice()
                .sort((a, b) => a.properties.comuna - b.properties.comuna);
            for (const c of comunas) {
                const opt = document.createElement("option");
                opt.value = `comuna:${c.properties.comuna}`;
                opt.textContent = c.properties.nombre;
                $barrioSelect.appendChild(opt);
            }
        }
    }

    // =================================================================
    // 5. AUTOCOMPLETE
    // =================================================================

    function entradaCoincideFiltro(entrada) {
        // Filtro de categoría (combinable con el de barrio)
        if (categoriaActiva) {
            const cat = (entrada.categoria || "").trim().toUpperCase();
            if (cat !== categoriaActiva) return false;
        }
        // barrioActivo puede ser: "" (sin filtro), un string (barrio único)
        // o un Set (todos los barrios de una comuna).
        if (!barrioActivo) return true;
        if (typeof barrioActivo === "string") return entrada.barrio === barrioActivo;
        if (barrioActivo instanceof Set) return barrioActivo.has(entrada.barrio);
        return true;
    }

    /** Pobla el dropdown de categorías a partir de las entradas cargadas. */
    function poblarDropdownCategorias() {
        if (!$categoriaSelect) return;
        const counts = new Map();
        for (const c of calles) {
            const cat = (c.categoria || "").trim().toUpperCase();
            if (!cat) continue;
            counts.set(cat, (counts.get(cat) || 0) + 1);
        }
        const ordenadas = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        for (const [cat, n] of ordenadas) {
            const opt = document.createElement("option");
            opt.value = cat;
            opt.textContent = `${cat.charAt(0) + cat.slice(1).toLowerCase()} (${n})`;
            $categoriaSelect.appendChild(opt);
        }
    }

    function aplicarFiltroCategoria(valor) {
        categoriaActiva = (valor || "").trim().toUpperCase();
        $categoriaSelect.classList.toggle("active-filter", !!categoriaActiva);

        // Limpiar overlay previo de categoría
        if (capaCategoria) {
            mapa.removeLayer(capaCategoria);
            capaCategoria = null;
        }

        if (!categoriaActiva) {
            // Volver a vista general
            mapa.flyTo(CABA_CENTER, 13, { duration: 0.6 });
            if ($input.value.length >= 2) {
                renderSugerencias(buscarSugerencias($input.value));
            }
            return;
        }

        dibujarOverlayCategoria();

        if ($input.value.length >= 2) {
            renderSugerencias(buscarSugerencias($input.value));
        }
    }

    /**
     * Dibuja en el mapa un punto chico por cada calle CACHEADA de la
     * categoría activa (combinado con filtro de barrio/comuna si hay).
     * Permite ver de un vistazo dónde se concentran las calles del Excel.
     */
    function dibujarOverlayCategoria() {
        const puntos = [];
        for (const c of calles) {
            if (!entradaCoincideFiltro(c)) continue;
            const key = c.id || c.clave;
            const geo = geoCache[key];
            if (!geo) continue;

            // Para línea: usar el centro del bbox
            // Para punto: el center
            let latlng;
            if (geo.tipo === "point" && geo.center) {
                latlng = [geo.center[0], geo.center[1]];
            } else if (geo.bbox && geo.bbox.length === 4) {
                const [latMin, latMax, lonMin, lonMax] = geo.bbox.map(parseFloat);
                latlng = [(latMin + latMax) / 2, (lonMin + lonMax) / 2];
            } else {
                continue;
            }

            const color = colorParaEntrada(c);
            const marker = L.circleMarker(latlng, {
                radius: 4,
                color: color,
                weight: 1.5,
                fillColor: color,
                fillOpacity: 0.6,
            });
            marker.bindTooltip(c.nombre_busqueda, {
                direction: "top",
                offset: [0, -4],
                className: "barrio-tooltip",
            });
            marker.on("click", () => seleccionarEntrada(c));
            puntos.push(marker);
        }

        if (puntos.length === 0) {
            mostrarToast("No hay calles cacheadas en esa categoría todavía.", 3000);
            return;
        }

        capaCategoria = L.layerGroup(puntos).addTo(mapa);
        mostrarToast(`${puntos.length} calles de "${categoriaActiva.toLowerCase()}"`, 2500);

        // Ajustar la vista para que se vean todos los puntos
        const group = L.featureGroup(puntos);
        try {
            mapa.flyToBounds(group.getBounds(), {
                padding: [40, 40],
                duration: 0.7,
                maxZoom: 14,
            });
        } catch (_) {
            // si solo hay 1 punto, getBounds da un rectángulo degenerado
        }
    }

    function buscarSugerencias(consulta) {
        const q = normalizar(consulta);
        if (q.length < 2) return [];

        // Prioridad: coincidencias al inicio, luego "contiene".
        const empiezan = [];
        const contienen = [];
        for (const c of calles) {
            if (!c.clave) continue;
            if (!entradaCoincideFiltro(c)) continue;
            if (c.clave.startsWith(q)) {
                empiezan.push(c);
            } else if (c.clave.includes(q)) {
                contienen.push(c);
            }
            if (empiezan.length >= MAX_SUGGESTIONS) break;
        }

        return empiezan.concat(contienen).slice(0, MAX_SUGGESTIONS);
    }

    function renderSugerencias(items) {
        $suggestions.innerHTML = "";
        indiceActivo = -1;

        if (items.length === 0) {
            $suggestions.hidden = true;
            return;
        }

        for (const item of items) {
            const li = document.createElement("li");
            li.setAttribute("role", "option");
            // Usamos id (clave|tipo) para identificar la entrada unívocamente
            li.dataset.id = item.id || item.clave;
            li.innerHTML = `
                <span class="suggestion-title">${escapeHtml(item.nombre_busqueda)}</span>
                <span class="suggestion-sub">${escapeHtml(item.tipo || "")}${item.categoria ? " · " + escapeHtml(item.categoria.toLowerCase()) : ""}</span>
            `;
            li.addEventListener("click", () => seleccionarEntrada(item));
            $suggestions.appendChild(li);
        }
        $suggestions.hidden = false;
    }

    function moverIndice(delta) {
        const lis = $suggestions.querySelectorAll("li");
        if (lis.length === 0) return;

        if (indiceActivo >= 0 && lis[indiceActivo]) {
            lis[indiceActivo].classList.remove("active");
        }
        indiceActivo = (indiceActivo + delta + lis.length) % lis.length;
        lis[indiceActivo].classList.add("active");
        lis[indiceActivo].scrollIntoView({ block: "nearest" });
    }

    // =================================================================
    // 6. SELECCIÓN Y GEOCODING
    // =================================================================

    function seleccionarEntrada(entrada) {
        $input.value = entrada.nombre_busqueda;
        $suggestions.hidden = true;
        $btnLimpiar.hidden = false;
        ubicarEnMapa(entrada);
    }

    /**
     * Elige una entrada al azar entre las que tienen geometría cacheada
     * y respeta el filtro de barrio/comuna activo. Si no hay ninguna que
     * cumpla, lo intenta sin filtro como fallback.
     */
    function calleAlAzar() {
        if (!Array.isArray(calles) || calles.length === 0) return;

        const tieneCache = (c) => {
            const k = c.id || c.clave;
            return !!geoCache[k];
        };

        // Primer intento: respeta filtro de barrio/comuna activo
        let pool = calles.filter((c) => tieneCache(c) && entradaCoincideFiltro(c));
        // Si el filtro deja vacío (ej. comuna sin nada), caer al universo
        if (pool.length === 0) {
            pool = calles.filter(tieneCache);
        }
        if (pool.length === 0) {
            mostrarToast("Todavía no hay calles cacheadas.", 3000);
            return;
        }
        const elegida = pool[Math.floor(Math.random() * pool.length)];
        seleccionarEntrada(elegida);
    }

    /** Busca por texto libre cuando el usuario aprieta el botón Buscar. */
    function buscarPorTexto() {
        const q = normalizar($input.value);
        if (!q) return;

        const exacta = calles.find((c) => c.clave === q);
        if (exacta) {
            ubicarEnMapa(exacta);
            $suggestions.hidden = true;
            return;
        }

        const sugerencias = buscarSugerencias($input.value);
        if (sugerencias.length > 0) {
            ubicarEnMapa(sugerencias[0]);
            $suggestions.hidden = true;
        } else {
            mostrarToast(`No encontramos "${$input.value}" en el listado.`);
        }
    }

    async function ubicarEnMapa(entrada) {
        limpiarCapa();
        mostrarToast("Buscando ubicación…", 8000);

        try {
            const resultado = await obtenerGeometria(entrada);
            if (!resultado) {
                mostrarToast(
                    `No pudimos ubicar "${entrada.nombre_busqueda}" en el mapa. ` +
                    `Puede no estar indexado en OpenStreetMap.`,
                    5000,
                );
                return;
            }

            dibujarResultado(entrada, resultado);
            // Ocultar toast en cuanto se dibuja
            $toast.hidden = true;
        } catch (err) {
            console.error(err);
            mostrarToast("Error al consultar el geocoder. Reintenta en unos segundos.", 4000);
        }
    }

    /**
     * Obtiene la geometría de una entrada.
     * Orden de prioridad:
     *   1. Geo-cache pre-generado (data/geo_cache.json — Fase 2, instantáneo)
     *   2. Cache del usuario en localStorage (búsquedas previas en este navegador)
     *   3. Consulta en vivo a Nominatim (fallback)
     * Devuelve { tipo: 'line'|'point', geometry: GeoJSON, bbox?, center? } o null.
     */
    async function obtenerGeometria(entrada) {
        // Buscar por id (clave|tipo) primero, después por clave (legacy)
        const claveCache = entrada.id || entrada.clave;

        // 1. Cache pre-generado
        if (geoCache[claveCache]) {
            return geoCache[claveCache];
        }
        if (geoCache[entrada.clave]) {
            return geoCache[entrada.clave];
        }

        // 2. Cache local del navegador (de búsquedas previas en vivo)
        const cache = leerCache();
        if (cache[claveCache]) {
            return cache[claveCache];
        }
        if (cache[entrada.clave]) {
            return cache[entrada.clave];
        }

        // Construcción de la query para Nominatim
        const params = new URLSearchParams({
            q: `${entrada.nombre_busqueda}, Ciudad Autónoma de Buenos Aires, Argentina`,
            format: "json",
            polygon_geojson: "1",
            addressdetails: "0",
            limit: "8",
            viewbox: VIEWBOX,
            bounded: "1",
            countrycodes: "ar",
        });

        const resp = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
            headers: { "Accept-Language": "es" },
        });
        if (!resp.ok) throw new Error("Nominatim HTTP " + resp.status);

        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) {
            return null;
        }

        const preferenciaLinea = esTipoLinea(entrada.tipo);
        const mejor = elegirMejorResultado(data, preferenciaLinea);
        if (!mejor) return null;

        const geom = mejor.geojson;
        let resultado;

        if (preferenciaLinea && geom &&
            (geom.type === "LineString" || geom.type === "MultiLineString")) {
            resultado = {
                tipo: "line",
                geometry: geom,
                bbox: mejor.boundingbox,
            };
        } else {
            resultado = {
                tipo: "point",
                center: [parseFloat(mejor.lat), parseFloat(mejor.lon)],
                geometry: geom || null,
                bbox: mejor.boundingbox,
            };
        }

        guardarEnCache(entrada.id || entrada.clave, resultado);
        return resultado;
    }

    /**
     * De los resultados de Nominatim, elige el más adecuado.
     * Si preferimos línea, priorizamos LineString/MultiLineString en CABA.
     */
    function elegirMejorResultado(resultados, preferenciaLinea) {
        const enCaba = resultados.filter((r) => {
            const dn = (r.display_name || "").toLowerCase();
            return dn.includes("buenos aires") || dn.includes("caba");
        });
        const pool = enCaba.length > 0 ? enCaba : resultados;

        if (preferenciaLinea) {
            const lineas = pool.filter((r) =>
                r.geojson && (r.geojson.type === "LineString" || r.geojson.type === "MultiLineString")
            );
            if (lineas.length > 0) return lineas[0];
        }

        return pool[0];
    }

    // =================================================================
    // 7. DIBUJADO EN EL MAPA
    // =================================================================

    function limpiarCapa() {
        if (capaActual) {
            mapa.removeLayer(capaActual);
            capaActual = null;
        }
        // closePopup() sin argumentos cierra cualquier popup abierto; evita
        // pasarle un objeto que podría ser un marker (no un popup) y crashear.
        mapa.closePopup();
        popupActual = null;
    }

    // =================================================================
    // 7b. FILTRO POR BARRIO
    // =================================================================

    function quitarOverlays() {
        for (const capa of [capaBarrio, capaOverlayTodos, capaOverlayComunas]) {
            if (capa) mapa.removeLayer(capa);
        }
        capaBarrio = null;
        capaOverlayTodos = null;
        capaOverlayComunas = null;
    }

    /** Dibuja una FeatureCollection como overlay con tooltips y click->filtrar. */
    function dibujarOverlay(featureCollection, onClickValor) {
        const capa = L.geoJSON(featureCollection, {
            style: {
                color: "#1a73e8",
                weight: 1.3,
                opacity: 0.75,
                fillColor: "#1a73e8",
                fillOpacity: 0.05,
            },
            onEachFeature: (feature, layer) => {
                const nombre = feature.properties.nombre;
                layer.bindTooltip(nombre, {
                    sticky: true,
                    direction: "top",
                    className: "barrio-tooltip",
                });
                layer.on("mouseover", () => {
                    layer.setStyle({ weight: 2.8, fillOpacity: 0.18 });
                });
                layer.on("mouseout", () => {
                    capa.resetStyle(layer);
                });
                layer.on("click", () => {
                    const valor = onClickValor(feature);
                    $barrioSelect.value = valor;
                    aplicarFiltroBarrio(valor);
                });
            },
        }).addTo(mapa);
        mapa.flyToBounds(capa.getBounds(), {
            padding: [20, 20],
            duration: 0.6,
            maxZoom: 13,
        });
        return capa;
    }

    function dibujarContornoUnico(feature, maxZoom = 15) {
        const capa = L.geoJSON(feature, {
            style: {
                color: "#1a73e8",
                weight: 2.5,
                opacity: 0.9,
                fillColor: "#1a73e8",
                fillOpacity: 0.08,
                dashArray: "6 4",
            },
            interactive: false,
        }).addTo(mapa);
        mapa.flyToBounds(capa.getBounds(), {
            padding: [40, 40],
            duration: 0.7,
            maxZoom,
        });
        return capa;
    }

    /** Devuelve el conjunto de barrios pertenecientes a una comuna. */
    function barriosDeComuna(numero) {
        if (!comunasGeo) return new Set();
        const f = comunasGeo.features.find((x) => x.properties.comuna === numero);
        return new Set((f && f.properties.barrios) || []);
    }

    function aplicarFiltroBarrio(valor) {
        quitarOverlays();
        if (capaCategoria) {
            mapa.removeLayer(capaCategoria);
            capaCategoria = null;
        }
        barrioActivo = "";

        const isOverlay = valor === "__overlay_barrios__" || valor === "__overlay_comunas__";
        const isBarrio = valor && valor.startsWith("barrio:");
        const isComuna = valor && valor.startsWith("comuna:");

        $barrioSelect.classList.toggle(
            "active-filter",
            !!valor && valor !== ""
        );

        // Vista general
        if (!valor) {
            mapa.flyTo(CABA_CENTER, 13, { duration: 0.6 });
            return;
        }

        // Overlay: todos los barrios
        if (valor === "__overlay_barrios__") {
            capaOverlayTodos = dibujarOverlay(barriosGeo, (f) => `barrio:${f.properties.nombre}`);
            return;
        }

        // Overlay: todas las comunas
        if (valor === "__overlay_comunas__") {
            capaOverlayComunas = dibujarOverlay(comunasGeo, (f) => `comuna:${f.properties.comuna}`);
            return;
        }

        // Filtro por barrio individual
        if (isBarrio) {
            const nombre = valor.slice("barrio:".length);
            const feature = barriosGeo && barriosGeo.features.find(
                (f) => f.properties.nombre === nombre
            );
            if (!feature) return;
            barrioActivo = nombre;
            capaBarrio = dibujarContornoUnico(feature, 15);
            if ($input.value.length >= 2) {
                renderSugerencias(buscarSugerencias($input.value));
            }
            return;
        }

        // Filtro por comuna individual
        if (isComuna) {
            const numero = parseInt(valor.slice("comuna:".length), 10);
            const feature = comunasGeo && comunasGeo.features.find(
                (f) => f.properties.comuna === numero
            );
            if (!feature) return;
            // Marcamos barrioActivo como un SET de barrios para que el filtro
            // del autocomplete pueda usarlo.
            barrioActivo = barriosDeComuna(numero);
            capaBarrio = dibujarContornoUnico(feature, 14);
            if ($input.value.length >= 2) {
                renderSugerencias(buscarSugerencias($input.value));
            }
            return;
        }
    }

    function dibujarResultado(entrada, resultado) {
        const popupHtml = construirPopup(entrada);
        const color = colorParaEntrada(entrada);

        if (resultado.tipo === "area") {
            // Polígono (barrio entero, plaza grande)
            capaActual = L.geoJSON(resultado.geometry, {
                style: {
                    color: color,
                    weight: 3,
                    opacity: 0.95,
                    fillColor: color,
                    fillOpacity: 0.15,
                },
            }).addTo(mapa);

            mapa.fitBounds(capaActual.getBounds(), {
                padding: [40, 40],
                maxZoom: 15,
            });

            // Popup en el centro (usamos center si está, sino bounds)
            const centro = resultado.center
                ? L.latLng(resultado.center[0], resultado.center[1])
                : capaActual.getBounds().getCenter();
            popupActual = L.popup({
                offset: [0, -6],
                autoPan: true,
                className: "calleando-popup",
            })
                .setLatLng(centro)
                .setContent(popupHtml)
                .openOn(mapa);
        } else if (resultado.tipo === "line") {
            // GeoJSON LineString/MultiLineString -> Polyline
            capaActual = L.geoJSON(resultado.geometry, {
                style: {
                    color: color,
                    weight: 8,
                    opacity: 0.9,
                    lineCap: "round",
                    lineJoin: "round",
                },
            }).addTo(mapa);

            mapa.fitBounds(capaActual.getBounds(), {
                padding: [80, 80],
                maxZoom: 17,
            });

            // Abrir popup en el centro del bounds
            const centro = capaActual.getBounds().getCenter();
            popupActual = L.popup({
                offset: [0, -6],
                autoPan: true,
                className: "calleando-popup",
            })
                .setLatLng(centro)
                .setContent(popupHtml)
                .openOn(mapa);
        } else {
            // Marker para plazas, parques, etc.
            capaActual = L.marker(resultado.center, {
                title: entrada.nombre_busqueda,
            }).addTo(mapa);

            if (resultado.bbox) {
                const [latMin, latMax, lonMin, lonMax] = resultado.bbox.map(parseFloat);
                mapa.fitBounds([[latMin, lonMin], [latMax, lonMax]], {
                    padding: [80, 80],
                    maxZoom: 17,
                });
            } else {
                mapa.setView(resultado.center, 17);
            }

            popupActual = capaActual.bindPopup(popupHtml, {
                offset: [0, -10],
                className: "calleando-popup",
            }).openPopup();
        }
    }

    function construirPopup(entrada) {
        const partes = [
            entrada.tipo,
            entrada.barrio && `barrio: ${entrada.barrio}`,
        ].filter(Boolean);
        const subtitulo = partes.join(" · ");
        const color = colorParaEntrada(entrada);
        const cat = (entrada.categoria || "").trim();

        // Chip de categoría con su color
        const chip = cat
            ? `<span class="popup-cat" style="background-color: ${color}1a; color: ${color};">${escapeHtml(cat.toLowerCase())}</span>`
            : "";

        return `
            <div class="popup-title" style="color: ${color};">${escapeHtml(entrada.nombre_busqueda)}</div>
            ${subtitulo ? `<div class="popup-sub">${escapeHtml(subtitulo)}</div>` : ""}
            ${chip}
            ${entrada.descripcion ? `<div class="popup-desc">${escapeHtml(entrada.descripcion)}</div>` : ""}
        `;
    }

    // =================================================================
    // 8. EVENTOS DE UI
    // =================================================================

    function conectarEventos() {
        // Tipeo en el input -> autocomplete
        $input.addEventListener("input", () => {
            const valor = $input.value;
            $btnLimpiar.hidden = valor.length === 0;
            const sugerencias = buscarSugerencias(valor);
            renderSugerencias(sugerencias);
        });

        // Teclas: Enter, flechas, Escape
        $input.addEventListener("keydown", (e) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                moverIndice(1);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                moverIndice(-1);
            } else if (e.key === "Enter") {
                e.preventDefault();
                const lis = $suggestions.querySelectorAll("li");
                if (indiceActivo >= 0 && lis[indiceActivo]) {
                    const id = lis[indiceActivo].dataset.id;
                    const entrada = calles.find((c) => (c.id || c.clave) === id);
                    if (entrada) {
                        seleccionarEntrada(entrada);
                        return;
                    }
                }
                buscarPorTexto();
            } else if (e.key === "Escape") {
                $suggestions.hidden = true;
            }
        });

        // Botón buscar
        $btnBuscar.addEventListener("click", buscarPorTexto);

        // Botón "calle al azar"
        if ($btnRandom) {
            $btnRandom.addEventListener("click", calleAlAzar);
        }

        // Botón de tema (abre menú con opciones)
        if ($btnTheme && $themeMenu) {
            $btnTheme.addEventListener("click", (e) => {
                e.stopPropagation();
                $themeMenu.hidden = !$themeMenu.hidden;
                marcarTemaActivo();
            });
            $themeMenu.addEventListener("click", (e) => {
                const li = e.target.closest("li[data-tema]");
                if (!li) return;
                aplicarTema(li.dataset.tema);
                $themeMenu.hidden = true;
            });
            // Click fuera cierra el menú
            document.addEventListener("click", (e) => {
                if (!e.target.closest(".theme-toggle")) {
                    $themeMenu.hidden = true;
                }
            });
        }

        // Botón limpiar (cruz)
        $btnLimpiar.addEventListener("click", () => {
            $input.value = "";
            $btnLimpiar.hidden = true;
            $suggestions.hidden = true;
            limpiarCapa();
            mapa.flyTo(CABA_CENTER, 13, { duration: 0.6 });
            $input.focus();
        });

        // Cerrar sugerencias al click fuera
        document.addEventListener("click", (e) => {
            if (!e.target.closest(".search-box")) {
                $suggestions.hidden = true;
            }
        });

        // Reabrir sugerencias al volver al input
        $input.addEventListener("focus", () => {
            if ($input.value.length >= 2) {
                const sugerencias = buscarSugerencias($input.value);
                renderSugerencias(sugerencias);
            }
        });

        // Filtro por barrio
        $barrioSelect.addEventListener("change", (e) => {
            aplicarFiltroBarrio(e.target.value);
            // Si hay categoría activa, redibujarla con el nuevo filtro de barrio aplicado
            if (categoriaActiva) {
                dibujarOverlayCategoria();
            }
        });

        // Filtro por categoría
        if ($categoriaSelect) {
            $categoriaSelect.addEventListener("change", (e) => {
                aplicarFiltroCategoria(e.target.value);
            });
        }
    }

    // =================================================================
    // 9. ARRANQUE
    // =================================================================

    async function main() {
        inicializarMapa();
        await cargarDatos();
        conectarEventos();
    }

    document.addEventListener("DOMContentLoaded", main);
})();
