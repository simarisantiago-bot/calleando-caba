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
    let curiosidades = null;       // datos de curiosidades.json (5 secciones temáticas)
    let barrioActivo = "";         // filtro activo: "" = todos
    let categoriaActiva = "";      // filtro de categoría: "" = todas
    let capaBarrio = null;         // overlay del contorno del barrio activo
    let capaOverlayTodos = null;   // overlay con los 48 barrios simultáneos
    let capaOverlayComunas = null; // overlay con las 15 comunas simultáneas
    let capaCategoria = null;      // overlay con todas las calles de la categoría
    let capaHeatmap = null;        // heatmap de barrios por densidad de categoría
    let capaCercaMio = null;       // overlay con las calles cercanas al usuario
    let marcadorUsuario = null;    // marcador de la ubicación del usuario
    let mapa;                      // instancia Leaflet
    let capaActual = null;         // polyline o marker dibujado por la última búsqueda
    let popupActual = null;        // popup actual
    let indiceActivo = -1;         // sugerencia resaltada con teclado

    // ---------- DOM ----------
    const $input = document.getElementById("search-input");
    const $btnBuscar = document.getElementById("search-btn");
    const $btnRandom = document.getElementById("random-btn");
    const $btnNearme = document.getElementById("nearme-btn");
    const $btnTheme = document.getElementById("theme-toggle-btn");
    const $themeMenu = document.getElementById("theme-menu");
    const $btnStats = document.getElementById("stats-btn");
    const $statsModal = document.getElementById("stats-modal");
    const $statsClose = document.getElementById("stats-close");
    const $statsOverlay = document.getElementById("stats-overlay");
    const $statsSummary = document.getElementById("stats-summary");
    const $statsTitle = document.getElementById("stats-title");
    const $statsCategorias = document.getElementById("stats-categorias");
    const $statsCuriosidades = document.getElementById("stats-curiosidades");
    const $curiosidadesSecciones = document.getElementById("curiosidades-secciones");
    const $aboutBtn = document.getElementById("about-btn");
    const $aboutModal = document.getElementById("about-modal");
    const $aboutClose = document.getElementById("about-close");
    const $aboutOverlay = document.getElementById("about-overlay");
    const $btnLimpiar = document.getElementById("clear-btn");
    const $suggestions = document.getElementById("suggestions");
    const $toast = document.getElementById("status-toast");
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
        // Carga en paralelo: dataset, cache geo, barrios, comunas, mapping y curiosidades.
        const [respCalles, respCache, respBarrios, respComunas, respMap, respCuri] = await Promise.all([
            fetch("data/calles.json"),
            fetch("data/geo_cache.json").catch(() => null),
            fetch("data/barrios.geojson").catch(() => null),
            fetch("data/comunas.geojson").catch(() => null),
            fetch("data/calle_barrios.json").catch(() => null),
            fetch("data/curiosidades.json").catch(() => null),
        ]);

        if (!respCalles || !respCalles.ok) {
            console.error("Error cargando calles.json");
            mostrarToast("No se pudieron cargar los datos del Excel.", 6000);
            return;
        }
        calles = await respCalles.json();
        console.log(`Datos cargados: ${calles.length} entradas`);

        // Pre-computar versión normalizada de la descripción para búsqueda
        // por contenido. Hacerlo una sola vez al cargar (no en cada keystroke).
        for (const c of calles) {
            if (c.descripcion) {
                c.desc_clave = normalizar(c.descripcion);
            }
        }

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
        if (respCuri && respCuri.ok) {
            try {
                curiosidades = await respCuri.json();
                console.log(`Curiosidades cargadas: ${curiosidades.secciones.length} secciones`);
            } catch (_) { curiosidades = null; }
        }

        // Vincular cada entrada a su barrio para uso en autocomplete
        for (const c of calles) {
            c.barrio = calleBarrios[c.clave] || null;
        }

        poblarDropdownCategorias();
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
            const color = COLORES_CATEGORIA[cat];
            if (color) {
                // Texto del color de la categoría + fondo tenue (hex + alpha)
                opt.style.color = color;
                opt.style.backgroundColor = color + "1a";
                opt.style.fontWeight = "600";
            }
            $categoriaSelect.appendChild(opt);
        }
    }

    function aplicarFiltroCategoria(valor) {
        categoriaActiva = (valor || "").trim().toUpperCase();
        $categoriaSelect.classList.toggle("active-filter", !!categoriaActiva);

        // El texto del select muestra el color de la categoría elegida
        const colorCat = COLORES_CATEGORIA[categoriaActiva];
        if (colorCat) {
            $categoriaSelect.style.color = colorCat;
            $categoriaSelect.style.backgroundColor = colorCat + "1a";
        } else {
            $categoriaSelect.style.color = "";
            $categoriaSelect.style.backgroundColor = "";
        }

        // Limpiar overlays previos (círculos + heatmap de la última categoría)
        if (capaCategoria) {
            mapa.removeLayer(capaCategoria);
            capaCategoria = null;
        }
        if (capaHeatmap) {
            mapa.removeLayer(capaHeatmap);
            capaHeatmap = null;
        }

        if (!categoriaActiva) {
            // Volver a vista general
            mapa.flyTo(CABA_CENTER, 13, { duration: 0.6 });
            if ($input.value.length >= 2) {
                renderSugerencias(buscarSugerencias($input.value));
            }
            return;
        }

        // Heatmap de barrios según densidad de la categoría
        dibujarHeatmapBarrios();

        dibujarOverlayCategoria();

        if ($input.value.length >= 2) {
            renderSugerencias(buscarSugerencias($input.value));
        }
    }

    /**
     * Heatmap por barrio: pinta cada uno de los 48 barrios con un tono del
     * color de la categoría activa, según cuántas calles de esa categoría
     * existen en cada barrio. Más calles = más oscuro. Combinable con los
     * círculos individuales que dibuja dibujarOverlayCategoria().
     */
    function dibujarHeatmapBarrios() {
        if (!barriosGeo || !categoriaActiva) return;

        // Conteo de calles por barrio para la categoría activa.
        // Solo contamos las que tengan barrio asignado (mapeo previo).
        const conteo = new Map();
        for (const c of calles) {
            const cat = (c.categoria || "").trim().toUpperCase();
            if (cat !== categoriaActiva) continue;
            if (!c.barrio) continue;
            conteo.set(c.barrio, (conteo.get(c.barrio) || 0) + 1);
        }

        if (conteo.size === 0) return;
        const max = Math.max(...conteo.values());
        const color = COLORES_CATEGORIA[categoriaActiva] || LINE_COLOR;

        capaHeatmap = L.geoJSON(barriosGeo, {
            style: (feature) => {
                const n = conteo.get(feature.properties.nombre) || 0;
                // Opacidad muy baja: casi invisible de fondo, solo para contexto.
                // El overlay de categoría (círculos/líneas) es lo principal.
                const alpha = n === 0 ? 0.008 : 0.012 + (n / max) * 0.018;
                return {
                    color: color,
                    weight: 0.4,
                    opacity: 0.25,
                    fillColor: color,
                    fillOpacity: alpha,
                };
            },
            onEachFeature: (feature, layer) => {
                const nombre = feature.properties.nombre;
                const n = conteo.get(nombre) || 0;
                const sufijo = n === 1 ? "calle" : "calles";
                layer.bindTooltip(
                    `<strong>${nombre}</strong><br>${n} ${sufijo} de "${categoriaActiva.toLowerCase()}"`,
                    {
                        sticky: true,
                        direction: "top",
                        className: "barrio-tooltip",
                    }
                );
                layer.on("mouseover", () => layer.setStyle({ weight: 2.2 }));
                layer.on("mouseout", () => capaHeatmap.resetStyle(layer));
            },
        }).addTo(mapa);

        // El heatmap va POR DEBAJO de los círculos individuales
        capaHeatmap.bringToBack();
    }

    /**
     * Dibuja en el mapa el trazado completo de cada calle CACHEADA de la
     * categoría activa (combinado con filtro de barrio/comuna si hay).
     * Dibuja líneas para calles y puntos para plazas/espacios.
     */
    function dibujarOverlayCategoria() {
        const elementos = [];
        let cantidadCalles = 0;

        for (const c of calles) {
            if (!entradaCoincideFiltro(c)) continue;
            const key = c.id || c.clave;
            const geo = geoCache[key];
            if (!geo) continue;

            const color = colorParaEntrada(c);

            // Dibujar línea completa para calles/avenidas/pasajes
            if (geo.tipo === "line" && geo.geometry) {
                const lineLayer = L.geoJSON(geo.geometry, {
                    style: {
                        color: color,
                        weight: 2.5,
                        opacity: 0.8,
                        lineCap: "round",
                        lineJoin: "round",
                    },
                });
                lineLayer.bindTooltip(c.nombre_busqueda, {
                    permanent: false,
                    direction: "top",
                    className: "barrio-tooltip",
                });
                lineLayer.on("click", () => seleccionarEntrada(c));
                elementos.push(lineLayer);
                cantidadCalles++;
            } else {
                // Para puntos (plazas, espacios verdes): marcador circular
                let latlng;
                if (geo.geometry && geo.geometry.type === "Point") {
                    latlng = [geo.geometry.coordinates[1], geo.geometry.coordinates[0]];
                } else if (geo.bbox && geo.bbox.length === 4) {
                    const [latMin, latMax, lonMin, lonMax] = geo.bbox.map(parseFloat);
                    latlng = [(latMin + latMax) / 2, (lonMin + lonMax) / 2];
                } else {
                    continue;
                }

                const marker = L.circleMarker(latlng, {
                    radius: 5,
                    color: color,
                    weight: 2,
                    fillColor: color,
                    fillOpacity: 0.7,
                });
                marker.bindTooltip(c.nombre_busqueda, {
                    direction: "top",
                    offset: [0, -4],
                    className: "barrio-tooltip",
                });
                marker.on("click", () => seleccionarEntrada(c));
                elementos.push(marker);
                cantidadCalles++;
            }
        }

        if (elementos.length === 0) {
            mostrarToast("No hay calles cacheadas en esa categoría todavía.", 3000);
            return;
        }

        capaCategoria = L.layerGroup(elementos).addTo(mapa);
        mostrarToast(`${cantidadCalles} odónimos de "${categoriaActiva.toLowerCase()}"`, 2500);

        // Ajustar la vista para que se vean todos los elementos
        const group = L.featureGroup(elementos);
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

        // Prioridad: nombre que empieza con q > nombre que contiene > descripción.
        const empiezan = [];
        const contienen = [];
        const enDescripcion = [];

        for (const c of calles) {
            if (!c.clave) continue;
            if (!entradaCoincideFiltro(c)) continue;
            if (c.clave.startsWith(q)) {
                empiezan.push(c);
            } else if (c.clave.includes(q)) {
                contienen.push(c);
            } else if (c.desc_clave && c.desc_clave.includes(q)) {
                // Match en historia/descripción. Marcamos con flag para que
                // el render muestre el snippet.
                enDescripcion.push({ ...c, _matchDesc: q });
            }
            // Cortamos temprano si ya hay muchos por nombre
            if (empiezan.length >= MAX_SUGGESTIONS) break;
        }

        // Combinamos manteniendo prioridad
        return empiezan
            .concat(contienen)
            .concat(enDescripcion)
            .slice(0, MAX_SUGGESTIONS);
    }

    /**
     * Devuelve un snippet de la descripción con el término resaltado.
     * Para resaltar correctamente ignorando tildes, usamos la posición del
     * match en el texto normalizado y la aplicamos sobre el texto original
     * (que tiene la misma longitud porque normalizar() no cambia el nro de chars).
     */
    function snippetMatch(descripcion, q) {
        if (!descripcion || !q) return "";
        const descNorm = normalizar(descripcion);
        const idx = descNorm.indexOf(q);
        if (idx < 0) return "";

        const ventana = 50;
        const ini = Math.max(0, idx - ventana);
        const fin = Math.min(descripcion.length, idx + q.length + ventana);

        // Recortar usando posiciones del texto original
        const antes = descripcion.slice(ini, idx);
        const match = descripcion.slice(idx, idx + q.length);
        const despues = descripcion.slice(idx + q.length, fin);

        let texto = `${escapeHtml(antes)}<mark>${escapeHtml(match)}</mark>${escapeHtml(despues)}`;
        if (ini > 0) texto = "…" + texto;
        if (fin < descripcion.length) texto = texto + "…";
        return texto;
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

            // Si el match es por descripción, mostramos un snippet con
            // el término resaltado para que se entienda por qué aparece.
            const snippet = item._matchDesc
                ? snippetMatch(item.descripcion, item._matchDesc)
                : "";

            li.innerHTML = `
                <span class="suggestion-title">${escapeHtml(item.nombre_busqueda)}</span>
                <span class="suggestion-sub">${escapeHtml(item.tipo || "")}${item.categoria ? " · " + escapeHtml(item.categoria.toLowerCase()) : ""}</span>
                ${snippet ? `<span class="suggestion-snippet">${snippet}</span>` : ""}
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

    // =================================================================
    //   GEOLOCALIZACIÓN — "Cerca mío"
    // =================================================================

    const RADIO_CERCA_METROS = 200;

    /** Distancia en metros entre dos puntos (lat, lon) usando Haversine. */
    function distanciaMetros(lat1, lon1, lat2, lon2) {
        const R = 6371000; // radio Tierra en metros
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /** Devuelve [lat, lon] del centroide aproximado de una entrada del cache. */
    function centroideDeGeo(geo) {
        if (!geo) return null;
        if (geo.tipo === "point" && geo.center) return geo.center;
        if (geo.bbox && geo.bbox.length === 4) {
            const [latMin, latMax, lonMin, lonMax] = geo.bbox.map(parseFloat);
            return [(latMin + latMax) / 2, (lonMin + lonMax) / 2];
        }
        return null;
    }

    function limpiarCercaMio() {
        if (capaCercaMio) {
            mapa.removeLayer(capaCercaMio);
            capaCercaMio = null;
        }
        if (marcadorUsuario) {
            mapa.removeLayer(marcadorUsuario);
            marcadorUsuario = null;
        }
    }

    function buscarCercaMio() {
        if (!navigator.geolocation) {
            mostrarToast("Tu navegador no soporta geolocalización.", 3000);
            return;
        }
        $btnNearme.classList.add("localizando");
        mostrarToast("Buscando tu ubicación…", 8000);

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                $btnNearme.classList.remove("localizando");
                manejarUbicacionUsuario(pos.coords.latitude, pos.coords.longitude);
            },
            (err) => {
                $btnNearme.classList.remove("localizando");
                if (err.code === err.PERMISSION_DENIED) {
                    mostrarToast("Para usar 'Cerca mío' tenés que dar permiso de ubicación.", 4500);
                } else {
                    mostrarToast("No pudimos acceder a tu ubicación. Reintenta.", 4000);
                }
            },
            { timeout: 10000, maximumAge: 60000, enableHighAccuracy: true }
        );
    }

    function manejarUbicacionUsuario(lat, lon) {
        // Chequear que esté dentro de CABA
        const dentroCaba = lat >= -34.706 && lat <= -34.527 &&
                           lon >= -58.531 && lon <= -58.335;
        if (!dentroCaba) {
            mostrarToast(
                "Estás fuera de CABA. Esta función sólo funciona dentro de Ciudad de Buenos Aires.",
                5000
            );
            return;
        }

        limpiarCercaMio();

        // Marcador del usuario: círculo azul con pulso visual
        marcadorUsuario = L.circleMarker([lat, lon], {
            radius: 9,
            color: "#fff",
            weight: 3,
            fillColor: "#1a73e8",
            fillOpacity: 1,
        }).addTo(mapa);
        marcadorUsuario.bindTooltip("Estás acá", {
            permanent: true,
            direction: "top",
            offset: [0, -8],
            className: "barrio-tooltip",
        });

        // Buscar calles cacheadas dentro del radio
        const cercanas = [];
        for (const c of calles) {
            const key = c.id || c.clave;
            const geo = geoCache[key];
            if (!geo) continue;
            const centro = centroideDeGeo(geo);
            if (!centro) continue;
            const dist = distanciaMetros(lat, lon, centro[0], centro[1]);
            if (dist <= RADIO_CERCA_METROS) {
                cercanas.push({ entrada: c, dist, centro });
            }
        }

        if (cercanas.length === 0) {
            mostrarToast(`No hay calles cacheadas a menos de ${RADIO_CERCA_METROS} m. Probá zoom y hacé click en alguna.`, 5000);
            mapa.setView([lat, lon], 16);
            return;
        }

        cercanas.sort((a, b) => a.dist - b.dist);

        // Círculo de radio (área de búsqueda)
        const circuloRadio = L.circle([lat, lon], {
            radius: RADIO_CERCA_METROS,
            color: "#1a73e8",
            weight: 1.5,
            opacity: 0.5,
            fillColor: "#1a73e8",
            fillOpacity: 0.06,
            interactive: false,
        });

        // Un círculo chico por cada calle cercana
        const markers = [];
        for (const item of cercanas) {
            const color = colorParaCategoria(item.entrada.categoria);
            const distTxt = item.dist < 100
                ? `${Math.round(item.dist)} m`
                : `${(item.dist / 1).toFixed(0)} m`;
            const m = L.circleMarker(item.centro, {
                radius: 6,
                color: color,
                weight: 2,
                fillColor: "#fff",
                fillOpacity: 0.95,
            });
            m.bindTooltip(
                `<strong>${escapeHtml(item.entrada.nombre_busqueda)}</strong> · ${distTxt}`,
                { direction: "top", className: "barrio-tooltip", offset: [0, -4] }
            );
            m.on("click", () => seleccionarEntrada(item.entrada));
            markers.push(m);
        }

        capaCercaMio = L.layerGroup([circuloRadio, ...markers]).addTo(mapa);

        mostrarToast(
            `${cercanas.length} calle${cercanas.length === 1 ? "" : "s"} cerca tuyo. ` +
            `La más cercana: ${cercanas[0].entrada.nombre_busqueda} a ${Math.round(cercanas[0].dist)} m.`,
            5500
        );

        // Centrar en el usuario
        mapa.flyTo([lat, lon], 17, { duration: 0.8 });
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
        // Limpiar categoría y heatmap cuando se selecciona una calle
        if (capaCategoria) {
            mapa.removeLayer(capaCategoria);
            capaCategoria = null;
        }
        if (capaHeatmap) {
            mapa.removeLayer(capaHeatmap);
            capaHeatmap = null;
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
        for (const capa of [capaBarrio, capaOverlayTodos, capaOverlayComunas, capaCategoria, capaHeatmap]) {
            if (capa) mapa.removeLayer(capa);
        }
        capaBarrio = null;
        capaOverlayTodos = null;
        capaOverlayComunas = null;
        capaCategoria = null;
        capaHeatmap = null;
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
                    aplicarFiltroBarrio(valor);
                });
            },
        }).addTo(mapa);
        const bounds = capa.getBounds();
        mapa.flyTo(bounds.getCenter(), 12, {
            duration: 0.6,
        });
        return capa;
    }

    function dibujarContornoUnico(feature, maxZoom = 15) {
        const capa = L.geoJSON(feature, {
            style: {
                color: "#1a73e8",
                weight: 3.5,
                opacity: 0.95,
                dashArray: "",
                fillColor: "none",
                fillOpacity: 0,
            },
            interactive: false,
        }).addTo(mapa);

        const bounds = capa.getBounds();
        const center = bounds.getCenter();

        // Calcular zoom basado en el área del bounds
        const latDiff = bounds.getNorth() - bounds.getSouth();
        const lngDiff = bounds.getEast() - bounds.getWest();
        const maxDiff = Math.max(latDiff, lngDiff);

        let zoom = 13;
        if (maxDiff < 0.02) zoom = 16;
        else if (maxDiff < 0.05) zoom = 15;
        else if (maxDiff < 0.1) zoom = 14;
        else if (maxDiff < 0.2) zoom = 13;
        else zoom = 12;

        zoom = Math.min(zoom, maxZoom);

        mapa.flyTo(center, zoom, {
            duration: 0.7,
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
        limpiarCapa();
        barrioActivo = "";

        const isOverlay = valor === "__overlay_barrios__" || valor === "__overlay_comunas__";
        const isBarrio = valor && valor.startsWith("barrio:");
        const isComuna = valor && valor.startsWith("comuna:");

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
        const subtitulo = (entrada.tipo || "").trim();
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

    // =================================================================
    //   ESTADÍSTICAS — modal con distribución por categoría
    // =================================================================

    function abrirEstadisticas() {
        if (!$statsModal) return;
        construirEstadisticas();
        $statsModal.hidden = false;
        // Volver siempre a la pestaña Estadísticas al abrir
        cambiarTabEstadisticas("estadisticas");
    }

    function cambiarTabEstadisticas(tab) {
        const tabs = $statsModal && $statsModal.querySelectorAll(".stats-tab");
        const paneles = $statsModal && $statsModal.querySelectorAll(".stats-tabpanel");
        if (!tabs || !paneles) return;
        tabs.forEach((b) => {
            const activa = b.dataset.tab === tab;
            b.classList.toggle("activa", activa);
            b.setAttribute("aria-selected", activa ? "true" : "false");
        });
        paneles.forEach((p) => {
            p.hidden = p.dataset.panel !== tab;
        });
    }

    function cerrarEstadisticas() {
        if (!$statsModal) return;
        $statsModal.hidden = true;
    }

    /**
     * Recorre las descripciones de entradas tipo PERSONA buscando el año
     * de nacimiento entre paréntesis. Soporta variantes con guión normal y
     * em-dash (–), interrogantes y prefijos como ?o c.
     * Devuelve {topAnio, totalConFecha, decadas: Map}.
     */
    function calcularAniosNacimiento(subset) {
        // Captura: "(1791-1850)", "(c. 1791-?)", "(?1791?-?)", "(1791–1850)"
        const patron = /\(\s*[^\d]?(\d{4})[^\d]?\s*[-–]\s*[^\d]?(\d{4})?[^\d]?\s*\)/;
        const years = new Map();
        const decadas = new Map();
        let totalConFecha = 0;
        const fuente = Array.isArray(subset) ? subset : calles;

        for (const c of fuente) {
            const cat = (c.categoria || "").trim().toUpperCase();
            if (cat !== "PERSONA") continue;
            if (!c.descripcion) continue;
            const m = c.descripcion.match(patron);
            if (!m) continue;
            const anio = parseInt(m[1], 10);
            if (anio < 1300 || anio > 2025) continue;
            years.set(anio, (years.get(anio) || 0) + 1);
            const dec = Math.floor(anio / 10) * 10;
            decadas.set(dec, (decadas.get(dec) || 0) + 1);
            totalConFecha++;
        }

        // Año con más homenajeados
        let topAnio = null;
        let topCount = 0;
        for (const [anio, n] of years) {
            if (n > topCount) {
                topCount = n;
                topAnio = anio;
            }
        }
        return { topAnio, topCount, totalConFecha, decadas };
    }

    /**
     * Construye las "curiosidades" tipo "Sabías qué" sobre el dataset.
     * Datos calculados en vivo desde calles.json para que reflejen siempre
     * el estado actual.
     */
    function dibujarCuriosidades(subset, ambito) {
        if (!$statsCuriosidades) return;
        const fuente = Array.isArray(subset) ? subset : calles;
        const lugar = ambito && ambito !== "CABA" ? ambito : null;
        const items = [];

        // === Año de nacimiento más común ===
        const { topAnio, topCount, decadas } = calcularAniosNacimiento(fuente);
        if (topAnio && topCount >= 2) {
            items.push(
                `El año de nacimiento con más homenajeados${lugar ? ` en ${lugar}` : ""} es ` +
                `<strong>${topAnio}</strong>, con <strong>${topCount}</strong> personas.`
            );
        }

        // === Década más común ===
        if (decadas && decadas.size > 0) {
            const [d, n] = [...decadas.entries()].sort((a, b) => b[1] - a[1])[0];
            if (n >= 3) {
                items.push(
                    `La década con más nacimientos de homenajeados${lugar ? ` en ${lugar}` : ""} ` +
                    `es la de <strong>${d}s</strong>, con <strong>${n}</strong> personas.`
                );
            }
        }

        // === Personas / cosas presentes en varios tipos de odónimo ===
        const porClave = new Map();
        for (const c of fuente) {
            if (!porClave.has(c.clave)) porClave.set(c.clave, new Set());
            porClave.get(c.clave).add(c.tipo);
        }
        const multi = [...porClave.entries()]
            .filter(([, t]) => t.size >= 3)
            .map(([clave, tipos]) => {
                const ent = fuente.find((c) => c.clave === clave);
                return { nombre: ent ? ent.nombre_busqueda : clave, tipos: [...tipos] };
            });
        if (multi.length > 0) {
            const ejemplo = multi[Math.floor(Math.random() * multi.length)];
            items.push(
                `Hay <strong>${multi.length}</strong> personas o lugares con tres tipos distintos ` +
                `de odónimo${lugar ? ` en ${lugar}` : ""}. Por ejemplo, ` +
                `<strong>${escapeHtml(ejemplo.nombre)}</strong> es ${ejemplo.tipos.join(", ")}.`
            );
        }

        // === Top apellido recurrente (solo categoría PERSONA) ===
        const preps = new Set([
            "de", "del", "la", "las", "los", "y", "el", "en",
            "san", "santo", "santa", "don", "dona",
        ]);
        const apellidos = new Map();
        for (const c of fuente) {
            if ((c.categoria || "").trim().toUpperCase() !== "PERSONA") continue;
            const palabras = (c.nombre_busqueda || "").split(/\s+/);
            if (palabras.length === 0) continue;
            const ultima = palabras[palabras.length - 1].toLowerCase();
            if (preps.has(ultima) || /^\d/.test(ultima)) continue;
            apellidos.set(ultima, (apellidos.get(ultima) || 0) + 1);
        }
        const apellidosTop = [...apellidos.entries()]
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1]);
        if (apellidosTop.length >= 3) {
            const top3 = apellidosTop.slice(0, 3)
                .map(([a, n]) => `<strong>${a.charAt(0).toUpperCase() + a.slice(1)}</strong> (${n})`)
                .join(", ");
            items.push(`Los apellidos más recurrentes${lugar ? ` en ${lugar}` : " del callejero"} son ${top3}.`);
        }

        // === Tipo de odónimo más común ===
        const tipos = new Map();
        for (const c of fuente) {
            const t = (c.tipo || "").trim();
            if (t) tipos.set(t, (tipos.get(t) || 0) + 1);
        }
        const tiposTop = [...tipos.entries()].sort((a, b) => b[1] - a[1]);
        if (tiposTop.length > 0) {
            const [t, n] = tiposTop[0];
            items.push(
                `El tipo de odónimo más frecuente${lugar ? ` en ${lugar}` : ""} son las ` +
                `<strong>${t}s</strong>, con <strong>${n.toLocaleString("es-AR")}</strong> entradas.`
            );
        }

        // === Categoría más rara ===
        const cats = new Map();
        for (const c of fuente) {
            const cat = (c.categoria || "").trim().toUpperCase();
            if (cat) cats.set(cat, (cats.get(cat) || 0) + 1);
        }
        const catsTop = [...cats.entries()].sort((a, b) => a[1] - b[1]);
        if (catsTop.length > 0 && fuente.length >= 30) {
            const [cat, n] = catsTop[0];
            items.push(
                `La categoría con menos entradas${lugar ? ` en ${lugar}` : ""} es ` +
                `<strong>${cat.toLowerCase()}</strong>, con solo <strong>${n}</strong> odónimos.`
            );
        }

        $statsCuriosidades.innerHTML = "";
        for (const html of items) {
            const li = document.createElement("li");
            li.className = "curiosidad-item";
            li.innerHTML = html;
            $statsCuriosidades.appendChild(li);
        }
    }

    /**
     * Renderiza las 5 secciones temáticas de curiosidades en el modal.
     * Cada sección es colapsable (la primera abierta, el resto cerradas).
     * Cada item es clickeable y abre la calle en el mapa.
     */
    function dibujarSeccionesCuriosidades() {
        if (!$curiosidadesSecciones) return;
        $curiosidadesSecciones.innerHTML = "";
        if (!curiosidades || !Array.isArray(curiosidades.secciones)) return;

        for (let idx = 0; idx < curiosidades.secciones.length; idx++) {
            const seccion = curiosidades.secciones[idx];
            if (!seccion.items || seccion.items.length === 0) continue;

            const details = document.createElement("details");
            details.className = "curiosidad-grupo";
            if (idx === 0) details.open = true;

            const summary = document.createElement("summary");
            summary.innerHTML = `
                <span class="curiosidad-grupo-titulo">${escapeHtml(seccion.titulo)}</span>
                <span class="curiosidad-grupo-cuenta">${seccion.items.length}</span>
            `;
            details.appendChild(summary);

            if (seccion.descripcion) {
                const desc = document.createElement("p");
                desc.className = "curiosidad-grupo-desc";
                desc.textContent = seccion.descripcion;
                details.appendChild(desc);
            }

            const lista = document.createElement("ul");
            lista.className = "curiosidad-lista";
            for (const item of seccion.items) {
                const li = document.createElement("li");
                li.className = "curiosidad-card";
                li.innerHTML = `
                    <div class="curiosidad-card-head">
                        <span class="curiosidad-card-nombre">${escapeHtml(item.nombre)}</span>
                        <span class="curiosidad-card-tipo">${escapeHtml(item.tipo)}</span>
                    </div>
                    <div class="curiosidad-card-identidad">${escapeHtml(item.identidad)}</div>
                    <div class="curiosidad-card-texto">${escapeHtml(item.curiosidad)}</div>
                `;
                li.addEventListener("click", () => {
                    const entrada = calles.find((c) => c.id === item.id);
                    if (entrada) {
                        cerrarEstadisticas();
                        seleccionarEntrada(entrada);
                    }
                });
                lista.appendChild(li);
            }
            details.appendChild(lista);
            $curiosidadesSecciones.appendChild(details);
        }
    }

    /**
     * Subconjunto de `calles` que aplica según el filtro de barrio activo.
     * - Sin filtro: devuelve `calles` completo.
     * - Barrio individual (string): solo calles de ese barrio.
     * - Comuna (Set): solo calles cuyo barrio está en el Set.
     */
    function callesActivasParaStats() {
        if (!barrioActivo) return calles;
        if (typeof barrioActivo === "string") {
            return calles.filter((c) => c.barrio === barrioActivo);
        }
        if (barrioActivo instanceof Set) {
            return calles.filter((c) => barrioActivo.has(c.barrio));
        }
        return calles;
    }

    /** Etiqueta amigable del ámbito activo: "CABA", "Palermo", "Comuna 1" */
    function etiquetaAmbito() {
        if (!barrioActivo) return "CABA";
        if (typeof barrioActivo === "string") return barrioActivo;
        // Set de barrios = comuna. Identificamos el número buscándolo.
        if (comunasGeo) {
            const match = comunasGeo.features.find((f) =>
                f.properties.barrios && barrioActivo.has(f.properties.barrios[0])
            );
            if (match) return match.properties.nombre;
        }
        return "selección";
    }

    function construirEstadisticas() {
        if (!Array.isArray(calles) || calles.length === 0) return;

        const sub = callesActivasParaStats();
        const ambito = etiquetaAmbito();
        const total = sub.length;

        // Título dinámico
        if ($statsTitle) {
            $statsTitle.textContent = ambito === "CABA"
                ? "Estadísticas del callejero de CABA"
                : `Estadísticas — ${ambito}`;
        }

        const counts = new Map();
        for (const c of sub) {
            const cat = (c.categoria || "").trim().toUpperCase() || "(SIN CATEGORÍA)";
            counts.set(cat, (counts.get(cat) || 0) + 1);
        }

        // Cuántas tienen geometría cacheada
        const cacheadas = sub.reduce((n, c) => {
            const k = c.id || c.clave;
            return geoCache[k] ? n + 1 : n;
        }, 0);

        if ($statsSummary) {
            const pctCache = total > 0 ? ((cacheadas / total) * 100).toFixed(1) : "0";
            const lugar = ambito === "CABA" ? "el callejero" : ambito;
            $statsSummary.textContent =
                `${total.toLocaleString("es-AR")} odónimos en ${lugar} · ` +
                `${cacheadas.toLocaleString("es-AR")} con ubicación en el mapa (${pctCache}%)`;
        }

        // Ordenadas de mayor a menor
        const ordenadas = [...counts.entries()].sort((a, b) => b[1] - a[1]);

        if (!$statsCategorias) return;
        $statsCategorias.innerHTML = "";
        for (const [cat, n] of ordenadas) {
            const pct = total > 0 ? (n / total) * 100 : 0;
            const color = COLORES_CATEGORIA[cat] || "#6b7280";
            const li = document.createElement("li");
            li.className = "stats-bar";
            li.innerHTML = `
                <span class="stats-bar-label" style="color: ${color};">${escapeHtml(cat.toLowerCase())}</span>
                <span class="stats-bar-track" style="background-color: ${color}40;">
                    <span class="stats-bar-fill" style="width: ${pct}%; background-color: ${color};"></span>
                </span>
                <span class="stats-bar-value" style="color: ${color};">${pct.toFixed(1)}% · ${n.toLocaleString("es-AR")}</span>
            `;
            $statsCategorias.appendChild(li);
        }

        // Sección "¿Sabías que…?" recibe el subset filtrado
        dibujarCuriosidades(sub, ambito);

        // Secciones temáticas se mantienen globales (son curaduría editorial)
        dibujarSeccionesCuriosidades();
    }

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

        // Botón "Cerca mío" (geolocalización)
        if ($btnNearme) {
            $btnNearme.addEventListener("click", buscarCercaMio);
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

        // Filtro por categoría
        if ($categoriaSelect) {
            $categoriaSelect.addEventListener("change", (e) => {
                aplicarFiltroCategoria(e.target.value);
            });
        }

        // Modal de estadísticas
        if ($btnStats) {
            $btnStats.addEventListener("click", abrirEstadisticas);
        }
        if ($statsClose) {
            $statsClose.addEventListener("click", cerrarEstadisticas);
        }
        if ($statsOverlay) {
            $statsOverlay.addEventListener("click", cerrarEstadisticas);
        }
        // Click en las pestañas del modal de estadísticas
        if ($statsModal) {
            $statsModal.addEventListener("click", (e) => {
                const btn = e.target.closest(".stats-tab");
                if (!btn || !btn.dataset.tab) return;
                cambiarTabEstadisticas(btn.dataset.tab);
            });
        }

        // Modal "Acerca de"
        if ($aboutBtn) {
            $aboutBtn.addEventListener("click", (e) => {
                e.preventDefault();
                if ($aboutModal) $aboutModal.hidden = false;
            });
        }
        const cerrarAbout = () => { if ($aboutModal) $aboutModal.hidden = true; };
        if ($aboutClose) $aboutClose.addEventListener("click", cerrarAbout);
        if ($aboutOverlay) $aboutOverlay.addEventListener("click", cerrarAbout);

        // Cerrar cualquier modal con Escape
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if ($statsModal && !$statsModal.hidden) cerrarEstadisticas();
            if ($aboutModal && !$aboutModal.hidden) cerrarAbout();
        });
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
