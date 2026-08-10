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
    const FAVORITOS_KEY = "calleando_favoritos_v1";
    const TOUR_KEY = "calleando_tutorial_v1";
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

    // Versión oscurecida de algunos colores de COLORES_CATEGORIA, solo para
    // usar como color de TEXTO sobre fondo blanco (chip .popup-cat, tema
    // claro/Voyager). El color original de esas 5 categorías no llega al
    // contraste mínimo de WCAG AA (4.5:1) en texto chico; el resto de la
    // paleta ya lo cumple tal cual.
    const COLORES_CATEGORIA_TEXTO = {
        "FECHA":      "#9d6b03",
        "NATURALEZA": "#12883e",
        "ARTE":       "#cd4d0b",
        "RÍO":        "#07819e",
        "LUGAR":      "#0b8177",
    };

    // Versión aclarada de TODA la paleta, para usar como color de texto del
    // mismo chip cuando el tema es Oscuro: sobre fondo oscuro los colores
    // "de mapa" (pensados para líneas sobre un tile claro) no alcanzan 4.5:1.
    const COLORES_CATEGORIA_TEXTO_OSCURO = {
        "PERSONA":             "#7baef2",
        "LUGAR":               "#11c3b3",
        "NATURALEZA":          "#1bc75a",
        "ACCIÓN MILITAR":      "#ee9494",
        "CONCEPTO":            "#bd9cf6",
        "OTROS":               "#a6abb5",
        "ARTE":                "#f7905b",
        "BARCO":               "#96abe8",
        "FECHA":               "#e89e05",
        "CUERPO MILITAR":      "#ec9494",
        "PUEBLOS ORIGINARIOS": "#f4950b",
        "RELIGIÓN":            "#c999f4",
        "RÍO":                 "#0ab9e3",
        "INSTITUCIÓN":         "#9facbe",
        "LITERATURA":          "#ec90b9",
    };

    function colorTextoParaEntrada(entrada) {
        if (!entrada) return LINE_COLOR;
        const cat = (entrada.categoria || "").trim().toUpperCase();
        if (document.body.classList.contains("tema-oscuro")) {
            return COLORES_CATEGORIA_TEXTO_OSCURO[cat] || COLORES_CATEGORIA[cat] || LINE_COLOR;
        }
        return COLORES_CATEGORIA_TEXTO[cat] || COLORES_CATEGORIA[cat] || LINE_COLOR;
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
    let barriosGeo = null;         // FeatureCollection de los 48 barrios (heatmap)
    let curiosidades = null;       // datos de curiosidades.json (5 secciones temáticas)
    let fotosManual = {};          // {clave: {thumbUrl, pageUrl, autor, licencia}} precomputado
    let categoriaActiva = "";      // filtro de categoría: "" = todas
    let capaBase = null;           // capa base: TODAS las calles clickeables (canvas)
    let capaCategoria = null;      // overlay con todas las calles de la categoría
    let capaHeatmap = null;        // heatmap de barrios por densidad de categoría
    let capaCercaMio = null;       // overlay con las calles cercanas al usuario
    let marcadorUsuario = null;    // marcador de la ubicación del usuario
    let mapa;                      // instancia Leaflet
    let capaActual = null;         // polyline o marker dibujado por la última búsqueda
    let popupActual = null;        // popup actual
    let indiceActivo = -1;         // sugerencia resaltada con teclado
    let redibujandoPorZoom = false; // true mientras dibujarConMenosZoomSiHaceFalta() está probando distintos alejamientos (ver más abajo): evita que el "popupclose" de los cierres intermedios despinte la calle antes de tiempo
    let tourPasos = [];             // pasos del tutorial de bienvenida, armados en construirPasosTour()
    let tourPasoActual = 0;

    // ---------- DOM ----------
    const $input = document.getElementById("search-input");
    const $btnBuscar = document.getElementById("search-btn");
    const $btnRandom = document.getElementById("random-btn");
    const $btnNearme = document.getElementById("nearme-btn");
    const $btnEfemeride = document.getElementById("efemeride-btn");
    const $btnFavoritos = document.getElementById("favoritos-btn");
    const $favoritosCount = document.getElementById("favoritos-count");
    const $favoritosPanel = document.getElementById("favoritos-panel");
    const $favoritosPanelClose = document.getElementById("favoritos-panel-close");
    const $favoritosList = document.getElementById("favoritos-list");
    const $favoritosEmpty = document.getElementById("favoritos-empty");
    const $btnTheme = document.getElementById("theme-toggle-btn");
    const $themeMenu = document.getElementById("theme-menu");
    const $btnStats = document.getElementById("stats-btn");
    const $statsModal = document.getElementById("stats-modal");
    const $statsClose = document.getElementById("stats-close");
    const $statsOverlay = document.getElementById("stats-overlay");
    const $statsSummary = document.getElementById("stats-summary");
    const $statsTitle = document.getElementById("stats-title");
    const $statsCategorias = document.getElementById("stats-categorias");
    const $rankingBarrios = document.getElementById("stats-ranking-barrios");
    const $rankingCategoriaSelect = document.getElementById("ranking-categoria-select");
    const $rankingBarriosNota = document.getElementById("ranking-barrios-nota");
    const $statsCuriosidades = document.getElementById("stats-curiosidades");
    const $curiosidadesSecciones = document.getElementById("curiosidades-secciones");
    const $aboutBtn = document.getElementById("about-btn");
    const $aboutModal = document.getElementById("about-modal");
    const $aboutClose = document.getElementById("about-close");
    const $aboutOverlay = document.getElementById("about-overlay");
    const $tourReplayBtn = document.getElementById("tour-replay-btn");
    const $tourOverlay = document.getElementById("tour-overlay");
    const $tourSpotlight = document.getElementById("tour-spotlight");
    const $tourCard = document.getElementById("tour-card");
    const $tourStepCount = document.getElementById("tour-step-count");
    const $tourTitle = document.getElementById("tour-title");
    const $tourText = document.getElementById("tour-text");
    const $tourPrev = document.getElementById("tour-prev");
    const $tourNext = document.getElementById("tour-next");
    const $tourSkip = document.getElementById("tour-skip");
    const $btnLimpiar = document.getElementById("clear-btn");
    const $suggestions = document.getElementById("suggestions");
    const $toast = document.getElementById("status-toast");
    const $categoriaSelect = document.getElementById("categoria-select");
    const $categoriaFilterWrap = document.querySelector(".categoria-filter");
    const $categoriaFilterIcon = document.querySelector(".categoria-filter-icon");
    const $btnTools = document.getElementById("tools-btn");
    const $toolsPanel = document.getElementById("tools-panel");

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
    // 1b. IMÁGENES DE WIKIPEDIA (pageimages) + cache en sessionStorage
    // =================================================================
    //
    // Para no almacenar imágenes localmente, pedimos en vivo la imagen
    // principal del artículo de Wikipedia que mejor matchea el nombre de
    // la calle. La respuesta (URL del thumbnail + autor/licencia) se cachea
    // por término en memoria y en sessionStorage para no repetir requests.

    const WIKI_API = "https://es.wikipedia.org/w/api.php";
    const WIKI_CACHE_KEY = "calleando_wikimg_v1";
    const wikiMem = {}; // cache en memoria de la sesión

    function leerWikiCache() {
        try {
            return JSON.parse(sessionStorage.getItem(WIKI_CACHE_KEY) || "{}");
        } catch (_) {
            return {};
        }
    }

    function guardarWikiCache(key, data) {
        wikiMem[key] = data;
        try {
            const c = leerWikiCache();
            c[key] = data;
            sessionStorage.setItem(WIKI_CACHE_KEY, JSON.stringify(c));
        } catch (_) {
            /* sessionStorage lleno o no disponible: seguimos solo en memoria */
        }
    }

    // Convierte un fragmento HTML (como el campo Artist de Commons) en texto plano.
    // Commons suele incluir texto oculto (display:none) que no queremos mostrar.
    function quitarHtml(s) {
        const tmp = document.createElement("div");
        tmp.innerHTML = String(s || "");
        tmp.querySelectorAll('[style*="display:none"], [style*="display: none"]')
            .forEach((el) => el.remove());
        return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
    }

    // Segunda llamada (best-effort): autor + licencia del archivo en Commons.
    async function obtenerAtribucion(fileTitle) {
        try {
            const params = new URLSearchParams({
                action: "query", format: "json", origin: "*",
                prop: "imageinfo", iiprop: "extmetadata",
                titles: "File:" + fileTitle,
            });
            const resp = await fetch(`${WIKI_API}?${params.toString()}`);
            if (!resp.ok) return null;
            const json = await resp.json();
            const pages = (json && json.query && json.query.pages) || {};
            const page = Object.values(pages)[0];
            const meta = (page && page.imageinfo && page.imageinfo[0] &&
                          page.imageinfo[0].extmetadata) || {};
            return {
                autor: meta.Artist ? quitarHtml(meta.Artist.value) : "",
                licencia: meta.LicenseShortName ? quitarHtml(meta.LicenseShortName.value) : "",
            };
        } catch (_) {
            return null;
        }
    }

    // Busca la imagen principal de Wikipedia para un término de búsqueda.
    // Devuelve {thumbUrl, pageUrl, titulo, autor, licencia} o null si no hay.
    async function fetchStreetImage(searchTerm) {
        const term = (searchTerm || "").trim();
        if (!term) return null;
        const key = term.toLowerCase();

        // Cache: memoria -> sessionStorage (incluye misses para no repetir).
        if (key in wikiMem) return wikiMem[key];
        const disk = leerWikiCache();
        if (key in disk) { wikiMem[key] = disk[key]; return disk[key]; }

        try {
            const params = new URLSearchParams({
                action: "query", format: "json", origin: "*",
                generator: "search", gsrsearch: term, gsrlimit: "1",
                gsrnamespace: "0",
                prop: "pageimages|info|pageprops", piprop: "thumbnail|name",
                pithumbsize: "480", ppprop: "disambiguation", inprop: "url",
            });
            const resp = await fetch(`${WIKI_API}?${params.toString()}`);
            if (!resp.ok) { guardarWikiCache(key, null); return null; }
            const json = await resp.json();
            const pages = json && json.query && json.query.pages;
            const page = pages && Object.values(pages)[0];
            const thumb = page && page.thumbnail && page.thumbnail.source;
            // Páginas de desambiguación: no son la entidad buscada -> tratamos
            // como miss para que el llamador pruebe el término de fallback.
            const esDesambiguacion = page && page.pageprops &&
                "disambiguation" in page.pageprops;
            if (!thumb || esDesambiguacion) { guardarWikiCache(key, null); return null; }

            const data = {
                thumbUrl: thumb,
                pageUrl: page.fullurl || `https://es.wikipedia.org/?curid=${page.pageid}`,
                titulo: page.title || term,
                autor: "",
                licencia: "",
            };
            // Atribución (best-effort: si falla, mostramos igual con crédito genérico).
            if (page.pageimage) {
                const atr = await obtenerAtribucion(page.pageimage);
                if (atr) { data.autor = atr.autor; data.licencia = atr.licencia; }
            }
            guardarWikiCache(key, data);
            return data;
        } catch (_) {
            return null; // error de red: no cacheamos para poder reintentar
        }
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

        // Al cerrar el popup (botón X, click afuera, Esc) se despinta también
        // la calle/marcador resaltado. limpiarCapa() ya deja capaActual en
        // null antes de cerrar su propio popup, así que no hay doble remoción.
        mapa.on("popupclose", () => {
            // Mientras se prueban distintos alejamientos (ver
            // dibujarConMenosZoomSiHaceFalta) se cierra y reabre el popup
            // varias veces a propósito; no hay que despintar nada todavía.
            if (redibujandoPorZoom) return;
            if (capaActual) {
                mapa.removeLayer(capaActual);
                capaActual = null;
            }
            popupActual = null;
        });
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
            const activo = li.dataset.tema === temaActual;
            li.classList.toggle("activo", activo);
            li.setAttribute("aria-checked", String(activo));
        }
    }

    // =================================================================
    // 4. CARGA DE DATOS
    // =================================================================

    async function cargarDatos() {
        // Carga en paralelo: dataset, cache geo, barrios (heatmap), mapping y curiosidades.
        const [respCalles, respCache, respBarrios, respMap, respCuri, respFotos] = await Promise.all([
            // A diferencia de las demás, esta carga es indispensable: sin
            // calles.json la app entera queda inutilizable (buscador y mapa
            // sin nada que mostrar). El .catch() evita que un fallo de RED
            // (no solo un 404/500, que ya maneja el "!respCalles.ok" de
            // abajo) tire un unhandled rejection y deje todo roto en
            // silencio, sin ningún aviso para quien está usando la página.
            fetch("data/calles.json").catch(() => null),
            fetch("data/geo_cache.json").catch(() => null),
            fetch("data/barrios.geojson").catch(() => null),
            fetch("data/calle_barrios.json").catch(() => null),
            fetch("data/curiosidades.json").catch(() => null),
            fetch("data/fotos.json").catch(() => null),
        ]);

        if (!respCalles || !respCalles.ok) {
            console.error("Error cargando calles.json");
            // Sin esto no funciona nada (ni buscador ni mapa): el aviso
            // queda fijo en vez de desaparecer solo, para que no pase
            // desapercibido si quien lo ve mira la pantalla recién después.
            mostrarToast("No se pudieron cargar los datos. Recargá la página para reintentar.", 24 * 60 * 60 * 1000);
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
        if (respFotos && respFotos.ok) {
            try {
                fotosManual = await respFotos.json();
                console.log(`Fotos precomputadas: ${Object.keys(fotosManual).length}`);
            } catch (_) { fotosManual = {}; }
        }

        // Vincular cada entrada a su barrio para uso en autocomplete
        for (const c of calles) {
            c.barrio = calleBarrios[c.clave] || null;
        }

        poblarDropdownCategorias();
        poblarRankingCategoriaSelect();
    }

    // =================================================================
    // 5. AUTOCOMPLETE
    // =================================================================

    function entradaCoincideFiltro(entrada) {
        // Filtro de categoría activo
        if (categoriaActiva) {
            const cat = (entrada.categoria || "").trim().toUpperCase();
            if (cat !== categoriaActiva) return false;
        }
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
        // Despinta la calle/marcador buscado y cierra su popup, además de
        // limpiar los overlays de categoría/heatmap de la selección previa.
        limpiarCapa();

        categoriaActiva = (valor || "").trim().toUpperCase();
        if ($categoriaFilterWrap) {
            $categoriaFilterWrap.classList.toggle("active-filter", !!categoriaActiva);
        }
        actualizarURLCategoria(categoriaActiva);

        // El círculo del filtro muestra el color de la categoría elegida
        const colorCat = COLORES_CATEGORIA[categoriaActiva];
        if (colorCat) {
            if ($categoriaFilterWrap) $categoriaFilterWrap.style.backgroundColor = colorCat + "1a";
            if ($categoriaFilterIcon) $categoriaFilterIcon.style.fill = colorCat;
        } else {
            if ($categoriaFilterWrap) $categoriaFilterWrap.style.backgroundColor = "";
            if ($categoriaFilterIcon) $categoriaFilterIcon.style.fill = "";
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
                // Opacidad relativa al máximo (mínimo 0.05 para que siempre se vea
                // que el barrio existe, máximo 0.55 para que no tape demasiado el mapa).
                const alpha = n === 0 ? 0.02 : 0.05 + (n / max) * 0.50;
                return {
                    color: color,
                    weight: 0.8,
                    opacity: 0.5,
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
     * Capa base: dibuja TODAS las calles/plazas cacheadas, tenues y siempre
     * visibles, para que se pueda hacer click en cualquiera y ver su popup
     * (sin depender de la búsqueda ni del filtro de categoría).
     *
     * Se renderiza con canvas (L.canvas) en un pane inferior propio para que
     * aguante ~2.900 geometrías sin lag y quede por debajo de la selección,
     * el overlay de categoría y el heatmap. limpiarCapa() NO la toca.
     */
    function dibujarCapaBase() {
        if (capaBase) {
            mapa.removeLayer(capaBase);
            capaBase = null;
        }
        if (!mapa.getPane("baseCalles")) {
            mapa.createPane("baseCalles");
            // overlayPane usa zIndex 400; dejamos la base por debajo.
            mapa.getPane("baseCalles").style.zIndex = 350;
        }
        const renderer = L.canvas({ pane: "baseCalles" });
        const capas = [];

        // La capa es INVISIBLE (opacity 0): el mapa se ve igual que antes.
        // Solo sirve para captar el click. El `weight`/`radius` define el área
        // de click alrededor de cada calle (no se dibuja nada visible).
        for (const c of calles) {
            const geo = geoCache[c.id || c.clave];
            if (!geo) continue;

            if (geo.tipo === "line" && geo.geometry) {
                const layer = L.geoJSON(geo.geometry, {
                    renderer,
                    pane: "baseCalles",
                    interactive: true,
                    style: {
                        stroke: true,
                        weight: 7,     // área de click generosa
                        opacity: 0,    // invisible
                    },
                });
                layer.bindTooltip(c.nombre_busqueda, {
                    sticky: true,
                    direction: "top",
                    className: "barrio-tooltip",
                });
                layer.on("click", () => seleccionarEntrada(c));
                capas.push(layer);
            } else {
                const latlng = centroideDeGeo(geo);
                if (!latlng) continue;
                const marker = L.circleMarker(latlng, {
                    renderer,
                    pane: "baseCalles",
                    interactive: true,
                    radius: 8,         // área de click
                    stroke: false,
                    opacity: 0,        // invisible
                    fillOpacity: 0,
                });
                marker.bindTooltip(c.nombre_busqueda, {
                    direction: "top",
                    offset: [0, -4],
                    className: "barrio-tooltip",
                });
                marker.on("click", () => seleccionarEntrada(c));
                capas.push(marker);
            }
        }

        capaBase = L.layerGroup(capas).addTo(mapa);
        console.log(`Capa base clickeable: ${capas.length} odónimos`);
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
                if (contienen.length < MAX_SUGGESTIONS) contienen.push(c);
            } else if (c.desc_clave && c.desc_clave.includes(q)) {
                // Match en historia/descripción. Marcamos con flag para que
                // el render muestre el snippet.
                if (enDescripcion.length < MAX_SUGGESTIONS) {
                    enDescripcion.push({ ...c, _matchDesc: q });
                }
            }
        }

        // Dentro de "empiezan con": el match EXACTO va primero, luego los
        // nombres más cortos (más cercanos a la consulta) y alfabético. Así
        // "República" gana a "República Árabe Siria" al tipear "republica".
        empiezan.sort((a, b) => {
            const exA = a.clave === q ? 0 : 1;
            const exB = b.clave === q ? 0 : 1;
            if (exA !== exB) return exA - exB;
            if (a.clave.length !== b.clave.length) {
                return a.clave.length - b.clave.length;
            }
            return a.clave.localeCompare(b.clave);
        });

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
        actualizarURL(entrada);
        ubicarEnMapa(entrada);
    }

    // ---------- Links compartibles a una calle ----------
    // Refleja la calle seleccionada en la URL (?c=<id>) sin recargar, para
    // poder compartir un link directo. La app la abre al cargar (ver main()).
    function actualizarURL(entrada) {
        try {
            history.replaceState(null, "",
                location.pathname + "?c=" + encodeURIComponent(entrada.id));
        } catch (_) { /* history no disponible: ignorar */ }
    }

    function limpiarURL() {
        try { history.replaceState(null, "", location.pathname); } catch (_) {}
    }

    function linkDeEntrada(id) {
        return location.origin + location.pathname + "?c=" + encodeURIComponent(id);
    }

    // Al cargar: si la URL trae ?c=<id o clave>, seleccionar esa calle.
    // Devuelve true si encontró y aplicó algo (para no pisarlo después con
    // el filtro de categoría de seleccionarCategoriaDesdeURL, ver main()).
    function seleccionarDesdeURL() {
        const c = new URLSearchParams(location.search).get("c");
        if (!c) return false;
        const entrada = calles.find((x) => x.id === c)
            || calles.find((x) => x.clave === c);
        if (!entrada) return false;
        seleccionarEntrada(entrada);
        return true;
    }

    // ---------- Links compartibles a una vista filtrada por categoría ----------
    // Mismo mecanismo que actualizarURL/seleccionarDesdeURL pero para el
    // filtro de categoría (?cat=PERSONA), para poder compartir por ejemplo
    // "todas las plazas dedicadas a una fecha" en vez de solo una calle.
    function actualizarURLCategoria(categoria) {
        try {
            if (categoria) {
                history.replaceState(null, "",
                    location.pathname + "?cat=" + encodeURIComponent(categoria));
            } else {
                limpiarURL();
            }
        } catch (_) { /* history no disponible: ignorar */ }
    }

    // Al cargar: si la URL trae ?cat=<categoría> (y no había ?c= que ya
    // haya ganado la prioridad), aplicar ese filtro.
    function seleccionarCategoriaDesdeURL() {
        const cat = new URLSearchParams(location.search).get("cat");
        if (!cat) return false;
        const catNorm = cat.trim().toUpperCase();
        const valida = Array.from($categoriaSelect.options).some((o) => o.value === catNorm);
        if (!valida) return false;
        $categoriaSelect.value = catNorm;
        aplicarFiltroCategoria(catNorm);
        return true;
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
            const color = colorParaEntrada(item.entrada);
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

    /** Fecha de "hoy" en huso horario de Buenos Aires, como "YYYY-MM-DD".
     *  Se usa como semilla fija del día: así la calle del día es la misma
     *  para todos los visitantes sin importar el huso horario de cada uno. */
    function fechaDeHoyBA() {
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Argentina/Buenos_Aires",
        }).format(new Date());
    }

    /** Hash determinístico simple (FNV-1a-like) de un string a un entero >= 0. */
    function hashDeterministico(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        }
        return Math.abs(h);
    }

    /**
     * Elige la entrada "del día" entre las que tienen geometría cacheada,
     * usando la fecha de hoy (en Buenos Aires) como semilla. No respeta el
     * filtro de categoría/barrio activo: es un único valor fijo por día,
     * igual para todos los visitantes.
     */
    function calleDelDia() {
        if (!Array.isArray(calles) || calles.length === 0) return null;

        const tieneCache = (c) => !!geoCache[c.id || c.clave];
        const pool = calles.filter(tieneCache);
        if (pool.length === 0) return null;

        const indice = hashDeterministico(fechaDeHoyBA()) % pool.length;
        return pool[indice];
    }

    function mostrarCalleDelDia() {
        const elegida = calleDelDia();
        if (!elegida) {
            mostrarToast("Todavía no hay calles cacheadas.", 3000);
            return;
        }
        seleccionarEntrada(elegida);
    }

    const MESES_ES = {
        enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
        julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
    };

    /**
     * Busca, entre las entradas de categoría FECHA, la que tiene el mismo
     * día y mes que hoy (el año no importa para el match). El día/mes/año
     * se extraen de la propia descripción ("20 de febrero de 1813: ..."),
     * que ya viene consistente para casi todas — no hace falta ningún
     * campo nuevo en el Excel.
     *
     * Si hay más de una para el mismo día (raro pero posible), se elige
     * siempre la misma —orden alfabético por clave— para que sea igual
     * para todos los visitantes, mismo criterio que calleDelDia().
     *
     * Devuelve null la gran mayoría de los días: con ~45 entradas FECHA
     * sobre 365 días no hay match casi 7 de cada 8 veces, y está bien que
     * el botón simplemente no aparezca esos días en vez de forzar algo.
     */
    function efemerideDeHoy() {
        if (!Array.isArray(calles) || calles.length === 0) return null;

        const [anioActual, mesHoy, diaHoy] = fechaDeHoyBA().split("-").map(Number);

        const candidatas = [];
        for (const c of calles) {
            if ((c.categoria || "").trim().toUpperCase() !== "FECHA") continue;
            const m = /^(\d{1,2})\s+de\s+(\p{L}+)(?:\s+de\s+(\d{3,4}))?/iu.exec(c.descripcion || "");
            if (!m) continue;
            const dia = parseInt(m[1], 10);
            const mes = MESES_ES[m[2].toLowerCase()];
            if (mes === mesHoy && dia === diaHoy) {
                candidatas.push({ entrada: c, anio: m[3] ? parseInt(m[3], 10) : null });
            }
        }
        if (!candidatas.length) return null;

        candidatas.sort((a, b) => a.entrada.clave.localeCompare(b.entrada.clave));
        const elegida = candidatas[0];
        return {
            entrada: elegida.entrada,
            aniosTranscurridos: elegida.anio ? anioActual - elegida.anio : null,
        };
    }

    /** Muestra el botón "Un día como hoy" solo si hay una efeméride para
     *  la fecha de hoy; si no hay ninguna, el botón queda oculto (su
     *  estado por defecto en el HTML). */
    function inicializarEfemeride() {
        if (!$btnEfemeride) return;
        const resultado = efemerideDeHoy();
        if (!resultado) return;

        const { entrada, aniosTranscurridos } = resultado;
        $btnEfemeride.title = aniosTranscurridos != null
            ? `Un día como hoy, hace ${aniosTranscurridos} años: ${entrada.nombre_busqueda}`
            : `Un día como hoy: ${entrada.nombre_busqueda}`;
        $btnEfemeride.hidden = false;
        $btnEfemeride.addEventListener("click", () => seleccionarEntrada(entrada));
    }

    // =================================================================
    // FAVORITOS — calles marcadas a mano por quien navega, persistentes
    // en localStorage (a diferencia de la efeméride o "calle del día",
    // que son iguales para todos los visitantes).
    // =================================================================

    function leerFavoritos() {
        try {
            const arr = JSON.parse(localStorage.getItem(FAVORITOS_KEY) || "[]");
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }

    function guardarFavoritos(ids) {
        try {
            localStorage.setItem(FAVORITOS_KEY, JSON.stringify(ids));
        } catch (_) {
            // localStorage lleno o deshabilitado: no hay mucho más para
            // hacer, la marca de favorito simplemente no persiste.
        }
    }

    function esFavorito(id) {
        return leerFavoritos().includes(id);
    }

    /** Agrega o saca `id` de favoritos y devuelve si quedó marcado. */
    function alternarFavorito(id) {
        const favoritos = leerFavoritos();
        const idx = favoritos.indexOf(id);
        if (idx === -1) {
            favoritos.push(id);
        } else {
            favoritos.splice(idx, 1);
        }
        guardarFavoritos(favoritos);
        actualizarBadgeFavoritos();
        return idx === -1;
    }

    function actualizarBadgeFavoritos() {
        if (!$favoritosCount) return;
        const n = leerFavoritos().length;
        $favoritosCount.textContent = String(n);
        $favoritosCount.hidden = n === 0;
    }

    function renderFavoritosPanel() {
        if (!$favoritosList || !$favoritosEmpty) return;
        const ids = leerFavoritos();
        // El orden de guardado es el de "marcado más reciente al final";
        // se muestra al revés para que lo último marcado aparezca primero.
        const entradas = ids
            .slice()
            .reverse()
            .map((id) => calles.find((c) => c.id === id))
            .filter(Boolean);

        $favoritosEmpty.hidden = entradas.length > 0;
        $favoritosList.innerHTML = entradas.map((entrada) => `
            <li data-id="${escapeHtml(entrada.id)}">
                <span class="favoritos-item-info">
                    <span class="favoritos-item-title">${escapeHtml(entrada.nombre_busqueda)}</span>
                    <span class="favoritos-item-sub">${escapeHtml((entrada.tipo || "").trim())}</span>
                </span>
                <button type="button" class="favoritos-item-remove" data-id="${escapeHtml(entrada.id)}" aria-label="Sacar de favoritas">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
                    </svg>
                </button>
            </li>
        `).join("");
    }

    function abrirPanelFavoritos() {
        if (!$favoritosPanel || !$btnFavoritos) return;
        renderFavoritosPanel();
        $favoritosPanel.hidden = false;
        $btnFavoritos.setAttribute("aria-expanded", "true");
    }

    function cerrarPanelFavoritos() {
        if (!$favoritosPanel || !$btnFavoritos) return;
        $favoritosPanel.hidden = true;
        $btnFavoritos.setAttribute("aria-expanded", "false");
    }

    /** Refleja en un botón "★ favorita" del popup el estado actual. */
    function sincronizarBotonFavorito(boton, favorito) {
        boton.classList.toggle("es-favorito", favorito);
        boton.setAttribute("aria-pressed", String(favorito));
        const span = boton.querySelector("span");
        if (span) span.textContent = favorito ? "En favoritas" : "Favorita";
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

    // ---------- Posicionamiento del popup: pegado al trazado/punto ----------
    //
    // Preferencia visual: calles/avenidas norte-sur muestran el popup al
    // costado (no tapando el trazado); este-oeste, arriba o abajo. Los
    // puntos (plazas, parques, etc.) van arriba/abajo del pin, igual que
    // una calle este-oeste. Pero esa preferencia es solo el PRIMER intento:
    // si ninguno de esos dos lados entra completo en la pantalla (por
    // ejemplo, una calle este-oeste ancha con el popup más alto de lo que
    // hay lugar arriba/abajo), se prueba también el par PERPENDICULAR antes
    // de resignarse a achicar el contenido — importa que se vea completo el
    // popup Y el trazado/espacio, no en qué lado específico termina cayendo.
    //
    // Separación entre el trazado/punto y el popup. "extensionFormaPx" mide
    // el bounding box GEOMÉTRICO de la calle (el centro de la línea), pero
    // el trazo dibujado tiene weight:8 (o 3 para áreas) y se renderiza
    // centrado sobre esa línea, así que sobresale ~4px de cada lado del
    // bounding box geométrico. El gap tiene que cubrir eso además del hueco
    // visual real, si no el popup queda pegado justo encima del trazo.
    const POPUP_GAP = 22;
    const POPUP_ALTO_ESTIMADO = 200; // alto aprox. inicial (varía mucho según contenido)

    // Ancho del popup según el lado. Al costado de una calle norte-sur el
    // ancho "de siempre" (320px) ya se ve bien porque el alto disponible es
    // generoso (todo el largo de la pantalla). Arriba/abajo de una calle
    // este-oeste (o de un punto) el alto disponible es más chico —lo come
    // el propio trazado/espacio y los bordes de la pantalla—, así que ahí
    // conviene un popup más ANCHO: mismo texto en menos líneas, menos alto
    // total, aprovechando el espacio horizontal libre que sí sobra.
    const POPUP_ANCHO_NORMAL = 320;
    const POPUP_ANCHO_ESTIMADO = POPUP_ANCHO_NORMAL; // para abrirPopupPosicionado, antes de saber el lado real
    function anchoParaDireccion(dir) {
        if (dir === "izquierda" || dir === "derecha") return POPUP_ANCHO_NORMAL;
        // -20 de margen mínimo a cada lado de la pantalla (ver "limites") y
        // -36 del "chrome" propio del popup (padding del wrapper + margin
        // del content) que se suma AFUERA de este ancho: sin restarlo, en
        // pantallas chicas el wrapper terminaba más ancho de lo que entra.
        return Math.min(520, window.innerWidth - 20 - 36);
    }

    // Tamaño del ícono default de Leaflet (25x41, anclado en la punta
    // inferior): el cuerpo del pin sobresale esto por ENCIMA del punto
    // geográfico, aunque el bbox del lugar sea chico o no haya bbox. Si el
    // popup se abre "arriba" tiene que esquivarlo (si se abre "abajo" no
    // hace falta: el pin no tiene cuerpo por debajo de la punta).
    const MARKER_ICON_ALTO = 41;

    // ¿La forma es más "vertical" (norte-sur) u "horizontal" (este-oeste)?
    // Se compara en metros, no en grados: en CABA un grado de longitud mide
    // menos que uno de latitud, así que comparar grados directamente sesga
    // el resultado hacia "horizontal".
    function orientacionForma(bounds) {
        const lat0 = bounds.getCenter().lat;
        const metrosPorGradoLat = 111320;
        const metrosPorGradoLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
        const altoM = (bounds.getNorth() - bounds.getSouth()) * metrosPorGradoLat;
        const anchoM = (bounds.getEast() - bounds.getWest()) * metrosPorGradoLon;
        return altoM >= anchoM ? "vertical" : "horizontal";
    }

    // Medio ancho/alto EN PÍXELES de la forma (línea, polígono o bbox de un
    // punto), en la pantalla actual. El ancla es el CENTRO de la forma, no
    // un borde, así que para no invadirla hay que correr el popup, además
    // del hueco y su propio tamaño, esta mitad de la forma.
    function extensionFormaPx(bounds, direccion) {
        if (!bounds) return 0;
        const ne = mapa.latLngToContainerPoint(bounds.getNorthEast());
        const sw = mapa.latLngToContainerPoint(bounds.getSouthWest());
        if (direccion === "izquierda" || direccion === "derecha") {
            return Math.abs(ne.x - sw.x) / 2;
        }
        if (direccion === "arriba" || direccion === "abajo") {
            return Math.abs(sw.y - ne.y) / 2;
        }
        return 0;
    }

    // Leaflet siempre centra la caja horizontalmente en (ancla.x + offset.x)
    // y la hace crecer HACIA ARRIBA desde (ancla.y + offset.y) — esa es la
    // convención interna de L.Popup. A partir de eso, estas son las cuentas
    // para que la caja quede pegada a cada lado del ancla sin taparla.
    // "extension" es la mitad del ancho/alto de la forma en px (0 para
    // puntos sin bbox), para no terminar corriendo el popup desde el centro
    // de la forma hacia adentro de ella misma.
    function offsetParaDireccion(direccion, ancho, alto, extension) {
        const g = POPUP_GAP;
        const ext = extension || 0;
        switch (direccion) {
            case "derecha":
                return L.point(ext + g + ancho / 2, alto / 2);
            case "izquierda":
                return L.point(-(ext + g + ancho / 2), alto / 2);
            case "abajo":
                return L.point(0, ext + g + alto);
            case "arriba":
            default:
                return L.point(0, -(ext + g));
        }
    }

    /**
     * Ubica el popup ya renderizado probando, en orden, el par de lados
     * "natural" para la orientación de la forma y — si ninguno de esos dos
     * entra sin salirse de la pantalla — el par perpendicular. Se queda con
     * el primero que entre limpio; si ninguno entra limpio, con el que
     * menos se pase, y solo ahí achica el contenido (con scroll interno)
     * como último recurso.
     *
     * @param bounds LatLngBounds real de la forma (línea/área, o bbox del
     *   punto) para esquivarla, o null si no hay ninguna extensión propia.
     * @param orientacion "vertical" (calle norte-sur: prefiere izquierda/
     *   derecha) u "horizontal" (calle este-oeste o punto: prefiere arriba/
     *   abajo).
     * @param extensionMinArriba piso mínimo para la extensión "arriba" —
     *   el alto del ícono del marker (MARKER_ICON_ALTO), que sobresale
     *   aunque el bbox sea chico o no haya bbox. Opcional.
     */
    function posicionarPopup(popup, bounds, orientacion, extensionMinArriba) {
        const el = popup.getElement();
        if (!el) return;
        const wrapper = el.querySelector(".leaflet-popup-content-wrapper") || el;
        const contenido = el.querySelector(".leaflet-popup-content");
        if (contenido) {
            contenido.style.maxHeight = "";
            contenido.style.overflowY = "";
        }

        function extensionPara(dir) {
            let ext = extensionFormaPx(bounds, dir);
            if (dir === "arriba" && extensionMinArriba) ext = Math.max(ext, extensionMinArriba);
            return ext;
        }

        // El límite superior solo hace falta respetarlo si el popup cae
        // horizontalmente sobre la caja de búsqueda; si termina más a la
        // derecha, no hay conflicto y puede usar hasta el borde real de la
        // pantalla (más alto disponible = menos casos de tener que achicar).
        function limites(rect) {
            const cajaBusqueda = document.querySelector(".search-box");
            let arriba = 10;
            if (cajaBusqueda) {
                const cb = cajaBusqueda.getBoundingClientRect();
                const solapa = !rect || (rect.left < cb.right && rect.right > cb.left);
                if (solapa) arriba = cb.bottom + 10;
            }
            return { arriba, abajo: window.innerHeight - 10, izq: 10, der: window.innerWidth - 10 };
        }

        function correccionPara(dir) {
            const ext = extensionPara(dir);
            popup.options.maxWidth = anchoParaDireccion(dir);
            const rect0 = wrapper.getBoundingClientRect();
            popup.options.offset = offsetParaDireccion(dir, rect0.width, rect0.height, ext);
            popup.update();
            const rect = wrapper.getBoundingClientRect();
            const lim = limites(rect);
            let dx = 0;
            let dy = 0;
            if (rect.left < lim.izq) dx = lim.izq - rect.left;
            else if (rect.right > lim.der) dx = lim.der - rect.right;
            if (rect.top < lim.arriba) dy = lim.arriba - rect.top;
            else if (rect.bottom > lim.abajo) dy = lim.abajo - rect.bottom;
            return { dx, dy };
        }

        // Cuánto se pasa de los límites, contando SIEMPRE los dos ejes: al
        // comparar direcciones del mismo par (arriba vs abajo) el eje que no
        // corresponde da siempre igual en las dos, así que no cambia la
        // comparación — pero al comparar contra el par PERPENDICULAR sí hace
        // falta, si no un lado que entra horizontalmente pero se sale por
        // arriba/abajo (o viceversa) se cuenta como "entra limpio" por error.
        function invasionDe(corr) {
            return Math.abs(corr.dx) + Math.abs(corr.dy);
        }

        const parPreferido = orientacion === "vertical" ? ["izquierda", "derecha"] : ["arriba", "abajo"];
        const parPerpendicular = orientacion === "vertical" ? ["arriba", "abajo"] : ["izquierda", "derecha"];

        let mejor = null;
        for (const dir of parPreferido) {
            const corr = correccionPara(dir);
            const inv = invasionDe(corr);
            if (!mejor || inv < mejor.inv) mejor = { dir, inv };
            if (inv === 0) break;
        }
        if (mejor.inv > 0) {
            // Ninguno del par "natural" entra limpio: probamos el par
            // perpendicular, pero solo lo adoptamos si entra PERFECTAMENTE
            // limpio. La invasión vertical (dy) se puede corregir del todo
            // achicando el alto con scroll (ver abajo), pero no hay forma
            // equivalente de achicar el ancho sin reflowear el texto — así
            // que un lado perpendicular que también invade (aunque invada
            // "menos" en píxeles) no es mejor alternativa: se queda tapando
            // el trazado sin remedio, mientras que el par natural con
            // invasión vertical sí se termina resolviendo.
            for (const dir of parPerpendicular) {
                const corr = correccionPara(dir);
                const inv = invasionDe(corr);
                if (inv === 0) {
                    mejor = { dir, inv };
                    break;
                }
            }
        }

        const final = mejor.dir;
        // Reaplicar: el último intento del bucle puede haber dejado el
        // offset puesto en otro lado distinto al elegido.
        let { dx, dy } = correccionPara(final);
        // Si hace falta achicar es porque, al zoom actual, el trazado/punto
        // + el popup no entran los dos completos en la pantalla. El llamador
        // (dibujarResultado) usa este dato para, en vez de resignarse acá,
        // reintentar con el mapa más alejado (más zoom out = trazado más
        // chico en pantalla = más lugar para el popup) antes de llegar a
        // esta instancia. Solo si ya no se puede alejar más se termina
        // usando el achique con scroll de acá abajo como último recurso.
        const necesitoAchicar = dy !== 0;

        // Ni el mejor de los 4 lados entra sin salirse verticalmente (pasa
        // el tope o el piso de la pantalla) hay que achicar el contenido,
        // no tapar el trazado/espacio — vale para cualquier lado final, no
        // solo arriba/abajo: un popup a los costados también puede salirse
        // por arriba o abajo si es muy alto. "dy" ya es (casi) exactamente
        // cuánto se pasa, así que restándoselo a la altura actual el popup
        // queda del tamaño justo que sí entra (con scroll interno para lo
        // que no se vea de una). Se repite un par de veces por si el
        // redondeo del primer achique deja un resto.
        if (dy !== 0 && contenido) {
            for (let intento = 0; intento < 3 && dy !== 0; intento++) {
                const alturaActual = contenido.getBoundingClientRect().height;
                const alturaNueva = Math.max(80, alturaActual - Math.abs(dy) - 1);
                if (alturaNueva >= alturaActual) break; // ya no hay más para achicar
                contenido.style.maxHeight = alturaNueva + "px";
                contenido.style.overflowY = "auto";
                ({ dx, dy } = correccionPara(final));
            }
        }

        if (dx !== 0 || dy !== 0) {
            const actual = L.point(popup.options.offset);
            popup.options.offset = L.point(actual.x + dx, actual.y + dy);
            popup.update();
        }

        // La flechita solo tiene sentido cuando el popup terminó "arriba"
        // del trazado/punto (ver arriba); se resincroniza siempre porque el
        // lado final puede no coincidir con el usado al abrir el popup.
        el.classList.toggle("popup-sin-flecha", final !== "arriba");

        return necesitoAchicar;
    }

    // Abre el popup en una posición inicial cualquiera (se recalcula del
    // todo en posicionarPopup, una vez que hay tamaño real para medir).
    // Común a los tres casos (área, línea, marker).
    function abrirPopupPosicionado(latlng, popupHtml, direccionInicial) {
        return L.popup({
            offset: offsetParaDireccion(direccionInicial, POPUP_ANCHO_ESTIMADO, POPUP_ALTO_ESTIMADO, 0),
            autoPan: false, // la posición final la calcula posicionarPopup()
            className: "calleando-popup popup-sin-flecha",
        })
            .setLatLng(latlng)
            .setContent(popupHtml)
            .openOn(mapa);
    }

    const MAX_INTENTOS_ZOOM = 5;
    const INCREMENTO_PADDING_ZOOM = 55;

    /**
     * Repite `intento(padding)` con un padding cada vez mayor —lo que fuerza
     * un zoom más alejado en el fitBounds interno— mientras posicionarPopup()
     * siga necesitando achicar el contenido para entrar en pantalla. Así, en
     * vez de resignarse al scroll interno apenas no entra, primero se prueba
     * dejar más lugar en pantalla alejando el mapa (el trazado/punto ocupa
     * menos píxeles, y con maxWidth el popup no cambia de tamaño real).
     *
     * `intento` debe devolver lo mismo que posicionarPopup(): true si hizo
     * falta achicar (seguir probando), false si entró limpio.
     *
     * Se para en MAX_INTENTOS_ZOOM intentos o al llegar al zoom mínimo del
     * mapa, lo que pase primero; ahí sí queda el achique con scroll interno
     * del último intento como último recurso.
     *
     * Reabrir el popup en cada vuelta cierra el anterior (dispara
     * "popupclose"); redibujandoPorZoom evita que ese cierre intermedio
     * despinte la capa antes de que termine el bucle.
     */
    function dibujarConMenosZoomSiHaceFalta(paddingInicial, intento) {
        redibujandoPorZoom = true;
        let padding = paddingInicial;
        for (let i = 0; i < MAX_INTENTOS_ZOOM; i++) {
            const huboAchique = intento(padding);
            const enElPiso = mapa.getZoom() <= mapa.getMinZoom();
            if (!huboAchique || enElPiso) break;
            padding += INCREMENTO_PADDING_ZOOM;
        }
        redibujandoPorZoom = false;
    }

    function dibujarResultado(entrada, resultado) {
        const mediaId = "popup-media-" + (++mediaSeq);
        const popupHtml = construirPopup(entrada, mediaId);
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

            const bounds = capaActual.getBounds();
            const centro = bounds.getCenter();
            const orientacion = orientacionForma(bounds);
            dibujarConMenosZoomSiHaceFalta(40, (padding) => {
                mapa.fitBounds(bounds, { padding: [padding, padding], maxZoom: 15, animate: false });
                popupActual = abrirPopupPosicionado(centro, popupHtml, orientacion === "vertical" ? "derecha" : "abajo");
                return posicionarPopup(popupActual, bounds, orientacion);
            });
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

            // Popup pegado al trazado (al costado si es norte-sur, arriba o
            // abajo si es este-oeste), no centrado tapándolo.
            const bounds = capaActual.getBounds();
            const centro = bounds.getCenter();
            const orientacion = orientacionForma(bounds);
            dibujarConMenosZoomSiHaceFalta(80, (padding) => {
                mapa.fitBounds(bounds, { padding: [padding, padding], maxZoom: 17, animate: false });
                popupActual = abrirPopupPosicionado(centro, popupHtml, orientacion === "vertical" ? "derecha" : "abajo");
                return posicionarPopup(popupActual, bounds, orientacion);
            });
        } else {
            // Marker para plazas, parques, plazoletas, canteros, paseos, etc.
            capaActual = L.marker(resultado.center, {
                title: entrada.nombre_busqueda,
            }).addTo(mapa);

            // El ícono default de Leaflet trae su propio "popupAnchor"
            // ([1,-34]) que se SUMA a cualquier offset que le pasemos a
            // bindPopup, descuadrando todas las cuentas de más abajo (están
            // pensadas para que offset.y sea la única fuente de verdad). Se
            // neutraliza para que el marker se comporte igual que un popup
            // standalone (línea/área).
            if (capaActual.options.icon && capaActual.options.icon.options) {
                capaActual.options.icon.options.popupAnchor = [0, 0];
            }

            // El bbox (cuando existe) es el contorno real del lugar —una
            // plaza, un parque— y no un simple punto: el popup tiene que
            // esquivar ESE espacio, no solo el pin, para no taparlo.
            let boundsMarker = null;
            if (resultado.bbox) {
                const [latMin, latMax, lonMin, lonMax] = resultado.bbox.map(parseFloat);
                boundsMarker = L.latLngBounds([[latMin, lonMin], [latMax, lonMax]]);
                dibujarConMenosZoomSiHaceFalta(80, (padding) => {
                    mapa.fitBounds(boundsMarker, { padding: [padding, padding], maxZoom: 17, animate: false });
                    capaActual.bindPopup(popupHtml, {
                        offset: offsetParaDireccion("abajo", POPUP_ANCHO_ESTIMADO, POPUP_ALTO_ESTIMADO, 0),
                        autoPan: false,
                        className: "calleando-popup popup-sin-flecha",
                    }).openPopup();
                    // bindPopup()/openPopup() devuelven el marker (para
                    // encadenar), no el popup: hay que pedirlo aparte para
                    // poder medirlo/ajustarlo.
                    popupActual = capaActual.getPopup();
                    return posicionarPopup(popupActual, boundsMarker, "horizontal", MARKER_ICON_ALTO);
                });
            } else {
                // Sin bbox no hay ninguna extensión geográfica que "encoger"
                // al alejar el zoom: el pin ocupa el mismo tamaño en
                // píxeles a cualquier zoom, así que reintentar con más zoom
                // out no cambiaría nada — se resuelve en un solo intento.
                mapa.setView(resultado.center, 17, { animate: false });
                capaActual.bindPopup(popupHtml, {
                    offset: offsetParaDireccion("abajo", POPUP_ANCHO_ESTIMADO, POPUP_ALTO_ESTIMADO, 0),
                    autoPan: false,
                    className: "calleando-popup popup-sin-flecha",
                }).openPopup();
                popupActual = capaActual.getPopup();
                posicionarPopup(popupActual, boundsMarker, "horizontal", MARKER_ICON_ALTO);
            }
        }

        // El popup ya está en el DOM: cargamos la imagen de Wikipedia de forma
        // asíncrona. El contenedor tiene altura fija, así que mutamos su DOM sin
        // tocar popup.update() (eso re-renderiza el string y borraría la imagen).
        montarMediaPopup(mediaId, entrada);
    }

    // Dirección de contacto para el botón "Reportar error" de cada popup.
    const EMAIL_CONTACTO = "calleandocaba@gmail.com";

    // Arma un link al compositor web de Gmail (no mailto:) con el asunto y
    // cuerpo prellenados, incluyendo el id de la entrada al final para poder
    // ubicarla rápido en calles.json sin depender de que quien reporta
    // escriba bien el nombre. mailto: depende de que el navegador tenga un
    // cliente de correo configurado como predeterminado -algo que en la
    // práctica muchos usuarios no tienen, sobre todo en desktop- y ahí
    // simplemente no pasa nada al hacer click; el link de Gmail abre en una
    // pestaña nueva y funciona en cualquier navegador con sesión de Google.
    function enlaceReportarError(entrada) {
        const asunto = `Corrección en Calleando CABA: ${entrada.nombre_busqueda}`;
        const cuerpo =
            `Contame qué está mal en "${entrada.nombre_busqueda}" (${(entrada.tipo || "").trim()}):\n\n\n` +
            `—\nNo borres esta línea, ayuda a ubicar el dato: ${entrada.id}`;
        return `https://mail.google.com/mail/?view=cm&fs=1` +
            `&to=${encodeURIComponent(EMAIL_CONTACTO)}` +
            `&su=${encodeURIComponent(asunto)}` +
            `&body=${encodeURIComponent(cuerpo)}`;
    }

    function construirPopup(entrada, mediaId) {
        const subtitulo = (entrada.tipo || "").trim();
        const color = colorParaEntrada(entrada);
        const colorTexto = colorTextoParaEntrada(entrada);
        const cat = (entrada.categoria || "").trim();
        const enOscuro = document.body.classList.contains("tema-oscuro");

        // Chip de categoría con su color. El fondo en tema Oscuro se fija a
        // un gris sólido (en vez de una mezcla alfa sobre el color "de mapa",
        // cuyo contraste real es impredecible); el texto usa la variante
        // aclarada/oscurecida con contraste AA calculada arriba.
        const chip = cat
            ? `<span class="popup-cat" style="background-color: ${enOscuro ? "#3c4043" : color + "1a"}; color: ${colorTexto};">${escapeHtml(cat.toLowerCase())}</span>`
            : "";

        // Contenedor de imagen con skeleton; se rellena en montarMediaPopup().
        const media = mediaId
            ? `<div class="popup-media" id="${mediaId}"><div class="popup-media-skeleton"></div></div>`
            : "";

        return `
            ${media}
            <div class="popup-title">${escapeHtml(entrada.nombre_busqueda)}</div>
            ${subtitulo ? `<div class="popup-sub">${escapeHtml(subtitulo)}</div>` : ""}
            ${chip}
            ${entrada.descripcion ? `<div class="popup-desc">${escapeHtml(entrada.descripcion)}</div>` : ""}
            <div class="popup-actions">
                <button class="popup-fav-btn${esFavorito(entrada.id) ? " es-favorito" : ""}" type="button" data-id="${escapeHtml(entrada.id)}" aria-pressed="${esFavorito(entrada.id)}">
                    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                        <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                    </svg>
                    <span>${esFavorito(entrada.id) ? "En favoritas" : "Favorita"}</span>
                </button>
                <button class="popup-share-btn" type="button" data-id="${escapeHtml(entrada.id)}">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                        <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>
                    </svg>
                    <span>Compartir</span>
                </button>
                <a class="popup-report-btn" href="${escapeHtml(enlaceReportarError(entrada))}" target="_blank" rel="noopener noreferrer">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                        <line x1="4" y1="22" x2="4" y2="3"/>
                    </svg>
                    <span>Reportar error</span>
                </a>
            </div>
        `;
    }

    // ---------- Imagen del popup (Wikipedia) ----------
    let mediaSeq = 0;

    // Mismo isotipo que favicon.svg y el logo del header: pin con grilla de
    // manzanas en vez de un ícono genérico, para reforzar la marca cuando
    // no hay foto en vez de mostrar algo neutro. El fondo del contenedor
    // (.popup-media.es-fallback) sí sigue tiñéndose con --cat-color; el
    // ícono en sí usa el degradé fijo de la marca.
    function iconoFallback() {
        return `<svg viewBox="0 0 64 64" width="40" height="40" aria-hidden="true">
            <defs><linearGradient id="fallback-logo-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#4285f4"/><stop offset="1" stop-color="#1a73e8"/>
            </linearGradient></defs>
            <path fill="url(#fallback-logo-grad)" d="M32 4C20.4 4 11 13.4 11 25c0 14 16 32 19.4 35.6a2.3 2.3 0 0 0 3.2 0C37 57 53 39 53 25 53 13.4 43.6 4 32 4z"/>
            <rect x="27" y="20" width="4.5" height="4.5" rx="1" fill="#fff"/>
            <rect x="32.7" y="20" width="4.5" height="4.5" rx="1" fill="#fff"/>
            <rect x="27" y="25.7" width="4.5" height="4.5" rx="1" fill="#fff"/>
            <rect x="32.7" y="25.7" width="4.5" height="4.5" rx="1" fill="#fff"/>
        </svg>`;
    }

    function mostrarFallbackMedia(mediaId, color) {
        const c = document.getElementById(mediaId);
        if (!c) return;
        c.classList.add("es-fallback");
        c.style.setProperty("--cat-color", color);
        c.innerHTML = `<div class="popup-media-fallback">${iconoFallback()}</div>`;
    }

    // Overrides manuales del término de búsqueda, por id de entrada. Útil cuando
    // el odónimo es ambiguo y Wikipedia trae una imagen incorrecta. Reusa todo el
    // pipeline (incluida la atribución). Ej.: "Independencia" traía la Declaración
    // de EE.UU.; la redirigimos al Congreso de Tucumán de 1816.
    const BUSQUEDA_OVERRIDES = {
        "independencia|avenida": "Congreso de Tucumán",

        // Provincias argentinas: el odónimo solo ("Córdoba", "Santa Fe", "La
        // Rioja") es ambiguo en Wikipedia (provincia española, ciudad o página
        // de desambiguación), así que apuntamos al artículo de la provincia.
        "catamarca|calle": "Provincia de Catamarca",
        "chaco|calle": "Provincia del Chaco",
        "chubut|calle": "Provincia del Chubut",
        "cordoba|avenida": "Provincia de Córdoba (Argentina)",
        "corrientes|avenida": "Provincia de Corrientes",
        "entre rios|avenida": "Provincia de Entre Ríos",
        "formosa|calle": "Provincia de Formosa",
        "jujuy|calle": "Provincia de Jujuy",
        "la pampa|calle": "Provincia de La Pampa",
        "la rioja|calle": "Provincia de La Rioja (Argentina)",
        "mendoza|calle": "Provincia de Mendoza",
        "misiones|calle": "Provincia de Misiones",
        "neuquen|calle": "Provincia del Neuquén",
        "rio negro|calle": "Provincia de Río Negro",
        "salta|calle": "Provincia de Salta",
        "san juan|avenida": "Provincia de San Juan",
        "san luis|calle": "Provincia de San Luis",
        "santa cruz|calle": "Provincia de Santa Cruz",
        "santa fe|avenida": "Provincia de Santa Fe",
        "santiago del estero|calle": "Provincia de Santiago del Estero",
        "tierra del fuego|calle": "Provincia de Tierra del Fuego, Antártida e Islas del Atlántico Sur",
        "tucuman|calle": "Provincia de Tucumán",
    };

    // Extrae el nombre completo del comienzo de la descripción. Las entradas de
    // PERSONA arrancan con "Nombre Completo (años), rol...", y buscar ese nombre
    // completo en Wikipedia acierta mucho más que el odónimo corto (que suele
    // caer en páginas de desambiguación). Medido: PERSONA pasa de ~52% a ~84%.
    function nombreDesdeDescripcion(desc) {
        if (!desc) return "";
        let n = desc.split("(")[0];           // corta en las fechas "(1770-1820)"
        if (n === desc) n = desc.split(/[:;,]/)[0]; // sin paréntesis: corta en : ; ,
        return n.replace(/\s+/g, " ").replace(/[\s:;,]+$/, "").trim();
    }

    // Términos de búsqueda ordenados por probabilidad de acierto, con fallback.
    function terminosBusqueda(entrada) {
        const nombre = (entrada.nombre_busqueda || entrada.nombre_original || "").trim();
        const cat = (entrada.categoria || "").trim().toUpperCase();
        const desc = nombreDesdeDescripcion(entrada.descripcion);
        const override = BUSQUEDA_OVERRIDES[entrada.id];
        // El override (si existe) manda; después caen los términos automáticos.
        // Para PERSONA priorizamos el nombre completo; para el resto el odónimo.
        const orden = override
            ? [override, nombre]
            : cat.startsWith("PERSONA") ? [desc, nombre] : [nombre, desc];
        const vistos = new Set();
        return orden.filter((t) => {
            const k = (t || "").toLowerCase();
            if (!k || vistos.has(k)) return false;
            vistos.add(k);
            return true;
        });
    }

    async function montarMediaPopup(mediaId, entrada) {
        if (!document.getElementById(mediaId)) return;
        const color = colorParaEntrada(entrada);

        // 1) Foto precomputada (data/fotos.json — recuperadas vía Wikidata/Commons
        //    o curadas a mano). Tiene prioridad sobre la búsqueda en vivo.
        //    Se busca primero por id completo (clave|tipo), para permitir fotos
        //    distintas cuando dos odónimos distintos comparten la misma clave
        //    (ej. "El Pampero" calle = viento, cantero = globo aerostático).
        let data = fotosManual[entrada.id] || fotosManual[entrada.clave] || null;

        // 1b) Marca "sinFoto": el odónimo no tiene retrato adecuado y la búsqueda
        //     en vivo traía una imagen incorrecta -> forzamos el ícono de categoría.
        if (data && data.sinFoto) {
            mostrarFallbackMedia(mediaId, color);
            return;
        }

        // 2) Si no hay precomputada, probamos los términos en Wikipedia en vivo.
        if (!data || !data.thumbUrl) {
            const terminos = terminosBusqueda(entrada);
            for (const t of terminos) {
                data = await fetchStreetImage(t);
                if (!document.getElementById(mediaId)) return; // popup cerrado
                if (data && data.thumbUrl) break;
            }
        }

        if (data && data.thumbUrl) {
            const img = new Image();
            img.className = "popup-media-img";
            img.alt = data.titulo || entrada.nombre_busqueda || "";
            img.referrerPolicy = "no-referrer";
            img.onload = () => {
                const c = document.getElementById(mediaId);
                if (!c) return;
                c.innerHTML = "";
                // Fondo borroso de la misma imagen para rellenar el box sin
                // recortar al sujeto (la imagen va por delante con object-fit:contain).
                const bg = document.createElement("div");
                bg.className = "popup-media-bg";
                bg.style.backgroundImage = `url("${data.thumbUrl}")`;
                c.appendChild(bg);
                c.appendChild(img);
            };
            img.onerror = () => mostrarFallbackMedia(mediaId, color);
            img.src = data.thumbUrl;
        } else {
            mostrarFallbackMedia(mediaId, color);
        }
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

    /** Pobla el select de categoría del ranking de barrios (una sola vez,
     *  al cargar los datos), con el mismo criterio que poblarDropdownCategorias(). */
    function poblarRankingCategoriaSelect() {
        if (!$rankingCategoriaSelect) return;
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
            $rankingCategoriaSelect.appendChild(opt);
        }
    }

    /**
     * Ranking de barrios por cantidad de odónimos, opcionalmente filtrado
     * por categoría. Arranca de los 48 barrios de barriosGeo (si están
     * cargados) para que también se vean los que tienen 0 en una
     * categoría puntual, no solo los que tienen al menos 1.
     */
    function construirRankingBarrios(categoriaFiltro) {
        if (!$rankingBarrios) return;
        const filtro = (categoriaFiltro || "").trim().toUpperCase();

        const counts = new Map();
        if (barriosGeo && Array.isArray(barriosGeo.features)) {
            for (const f of barriosGeo.features) {
                const nombre = f.properties && f.properties.nombre;
                if (nombre) counts.set(nombre, 0);
            }
        }

        let sinBarrio = 0;
        for (const c of calles) {
            if (filtro && (c.categoria || "").trim().toUpperCase() !== filtro) continue;
            if (!c.barrio) { sinBarrio++; continue; }
            counts.set(c.barrio, (counts.get(c.barrio) || 0) + 1);
        }

        const ordenados = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        $rankingBarrios.innerHTML = "";

        const max = ordenados.length > 0 ? ordenados[0][1] : 0;
        const color = filtro ? (COLORES_CATEGORIA[filtro] || "#6b7280") : "#1a73e8";
        ordenados.forEach(([barrio, n], i) => {
            const pct = max > 0 ? (n / max) * 100 : 0;
            const li = document.createElement("li");
            li.className = "stats-bar ranking-barrio";
            li.innerHTML = `
                <span class="ranking-barrio-puesto">${i + 1}</span>
                <span class="stats-bar-label">${escapeHtml(barrio)}</span>
                <span class="stats-bar-track" style="background-color: ${color}40;">
                    <span class="stats-bar-fill" style="width: ${pct}%; background-color: ${color};"></span>
                </span>
                <span class="stats-bar-value">${n.toLocaleString("es-AR")}</span>
            `;
            $rankingBarrios.appendChild(li);
        });

        if ($rankingBarriosNota) {
            if (sinBarrio > 0) {
                const plural = sinBarrio === 1 ? "" : "s";
                $rankingBarriosNota.textContent =
                    `${sinBarrio.toLocaleString("es-AR")} odónimo${plural} sin barrio asignado, no incluido${plural} en el ranking.`;
                $rankingBarriosNota.hidden = false;
            } else {
                $rankingBarriosNota.hidden = true;
            }
        }
    }

    function construirEstadisticas() {
        if (!Array.isArray(calles) || calles.length === 0) return;

        const sub = calles;
        const ambito = "CABA";
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
                <span class="stats-bar-label">${escapeHtml(cat.toLowerCase())}</span>
                <span class="stats-bar-track" style="background-color: ${color}40;">
                    <span class="stats-bar-fill" style="width: ${pct}%; background-color: ${color};"></span>
                </span>
                <span class="stats-bar-value">${pct.toFixed(1)}% · ${n.toLocaleString("es-AR")}</span>
            `;
            $statsCategorias.appendChild(li);
        }

        // Ranking de barrios, según la categoría elegida en su propio select
        construirRankingBarrios($rankingCategoriaSelect ? $rankingCategoriaSelect.value : "");

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

        // Botón "calle del día"
        if ($btnRandom) {
            $btnRandom.addEventListener("click", mostrarCalleDelDia);
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
            // Navegación por teclado: Enter/Espacio elige, Escape cierra y
            // devuelve el foco al botón (mismo patrón que brand-home).
            $themeMenu.addEventListener("keydown", (e) => {
                const li = e.target.closest("li[data-tema]");
                if (!li) return;
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    aplicarTema(li.dataset.tema);
                    $themeMenu.hidden = true;
                    $btnTheme.focus();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    $themeMenu.hidden = true;
                    $btnTheme.focus();
                }
            });
            // Click fuera cierra el menú
            document.addEventListener("click", (e) => {
                if (!e.target.closest(".theme-toggle")) {
                    $themeMenu.hidden = true;
                }
            });
        }

        // Volver al inicio (limpia búsqueda, capa y URL, y recentra el mapa).
        function volverAlInicio() {
            $input.value = "";
            $btnLimpiar.hidden = true;
            $suggestions.hidden = true;
            limpiarCapa();
            limpiarURL();
            mapa.flyTo(CABA_CENTER, 13, { duration: 0.6 });
        }

        // Botón limpiar (cruz)
        $btnLimpiar.addEventListener("click", () => {
            volverAlInicio();
            $input.focus();
        });

        // Marca "Calleando CABA": vuelve al inicio.
        const $brandHome = document.getElementById("brand-home");
        if ($brandHome) {
            $brandHome.addEventListener("click", volverAlInicio);
            $brandHome.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    volverAlInicio();
                }
            });
        }

        // Botón "compartir" del popup: copia el link directo a la calle.
        document.addEventListener("click", (e) => {
            const btn = e.target.closest(".popup-share-btn");
            if (!btn) return;
            const url = linkDeEntrada(btn.dataset.id);
            const ok = () => {
                const span = btn.querySelector("span");
                const prev = span ? span.textContent : "";
                if (span) span.textContent = "¡Link copiado!";
                btn.classList.add("copiado");
                setTimeout(() => {
                    if (span) span.textContent = prev || "Compartir";
                    btn.classList.remove("copiado");
                }, 1800);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(ok).catch(
                    () => mostrarToast("Copiá el link: " + url, 6000));
            } else {
                mostrarToast("Copiá el link: " + url, 6000);
            }
        });

        // Botón "★ favorita" del popup: marca/desmarca en localStorage.
        document.addEventListener("click", (e) => {
            const btn = e.target.closest(".popup-fav-btn");
            if (!btn) return;
            const favorito = alternarFavorito(btn.dataset.id);
            sincronizarBotonFavorito(btn, favorito);
        });

        // Botón "Herramientas": abre/cierra el panel que agrupa los
        // controles del mapa (categorías, accesos rápidos, tema, datos).
        if ($btnTools && $toolsPanel) {
            $btnTools.addEventListener("click", (e) => {
                e.stopPropagation();
                $toolsPanel.hidden = !$toolsPanel.hidden;
                $btnTools.setAttribute("aria-expanded", String(!$toolsPanel.hidden));
            });
            document.addEventListener("click", (e) => {
                if ($toolsPanel.hidden) return;
                if (e.target.closest(".tools-panel") || e.target.closest(".tools-btn")) return;
                // El tutorial abre/cierra el panel a medida que avanza los
                // pasos: sus propios clicks (Siguiente/Anterior/Saltar) no
                // deben contar como "click afuera" y volver a cerrarlo.
                if (e.target.closest(".tour-card")) return;
                $toolsPanel.hidden = true;
                $btnTools.setAttribute("aria-expanded", "false");
            });
        }

        // Botón "Mis favoritas": abre/cierra el panel con la lista.
        if ($btnFavoritos && $favoritosPanel) {
            $btnFavoritos.addEventListener("click", () => {
                if ($favoritosPanel.hidden) {
                    abrirPanelFavoritos();
                } else {
                    cerrarPanelFavoritos();
                }
            });
        }
        if ($favoritosPanelClose) {
            $favoritosPanelClose.addEventListener("click", cerrarPanelFavoritos);
        }
        // Click fuera del panel (y no en el botón que lo abre) lo cierra.
        document.addEventListener("click", (e) => {
            if (!$favoritosPanel || $favoritosPanel.hidden) return;
            if (e.target.closest(".favoritos-panel") || e.target.closest(".favoritos-btn")) return;
            cerrarPanelFavoritos();
        });
        // Sacar una entrada de favoritas desde el propio panel.
        if ($favoritosList) {
            $favoritosList.addEventListener("click", (e) => {
                const quitar = e.target.closest(".favoritos-item-remove");
                if (quitar) {
                    alternarFavorito(quitar.dataset.id);
                    renderFavoritosPanel();
                    return;
                }
                const fila = e.target.closest("li[data-id]");
                if (!fila) return;
                const entrada = calles.find((c) => c.id === fila.dataset.id);
                if (entrada) {
                    cerrarPanelFavoritos();
                    seleccionarEntrada(entrada);
                }
            });
        }

        // Botón "X" (propio de Leaflet) del popup: además de despintar la
        // calle/marcador (ya lo hace el "popupclose" de inicializarMapa,
        // que dispara para CUALQUIER cierre), borra lo que había en el
        // buscador. Tiene que ir en fase de CAPTURA: el propio botón de
        // Leaflet llama stopPropagation() en su handler, así que un
        // listener normal (fase de burbuja) en document nunca lo vería.
        document.addEventListener("click", (e) => {
            if (!e.target.closest(".leaflet-popup-close-button")) return;
            $input.value = "";
            $btnLimpiar.hidden = true;
            limpiarURL();
        }, true);

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

        // Ranking de barrios: cambiar categoría re-dibuja solo esa sección
        if ($rankingCategoriaSelect) {
            $rankingCategoriaSelect.addEventListener("change", (e) => {
                construirRankingBarrios(e.target.value);
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
    // 9. TUTORIAL DE BIENVENIDA
    // =================================================================
    // Recorrido guiado (spotlight + tarjeta) que se muestra solo en la
    // primera visita real (sin ?c= ni ?cat= en la URL, y sin el flag de
    // localStorage), y que además se puede volver a ver a mano desde el
    // botón "Volver a ver el tutorial" del modal "Acerca de".

    /**
     * Arma la lista de pasos del tutorial. El paso de la efeméride ("Un
     * día como hoy") solo se agrega si ese botón está visible hoy, porque
     * no tiene sentido resaltar un elemento que no está en pantalla.
     */
    function construirPasosTour() {
        const pasos = [
            {
                target: null,
                titulo: "¡Bienvenido a Calleando CABA!",
                texto: "Te mostramos rápido cómo explorar el callejero porteño.",
            },
            {
                target: ".search-box",
                titulo: "Buscador",
                texto: "Buscá cualquier calle, plaza o avenida por nombre, tema o parte de su historia (ej: \"tango\", \"Malvinas\").",
            },
            {
                target: "#tools-btn",
                titulo: "Herramientas",
                texto: "Acá están agrupados todos los accesos rápidos del mapa.",
            },
            {
                target: "#random-btn",
                titulo: "Odónimo del día",
                texto: "Te muestra una calle distinta cada día, la misma para todos los visitantes.",
                abrirPanel: true,
            },
            {
                target: "#stats-btn",
                titulo: "Datos y curiosidades",
                texto: "Estadísticas del callejero y datos curiosos sobre Buenos Aires.",
                abrirPanel: true,
            },
            {
                target: "#theme-toggle-btn",
                titulo: "Estilo del mapa",
                texto: "Cambiá entre los mapas Voyager, Claro y Oscuro.",
                abrirPanel: true,
            },
            {
                target: ".categoria-filter",
                titulo: "Filtros temáticos",
                texto: "Filtrá el mapa por categoría: personas, lugares, fechas, naturaleza…",
                abrirPanel: true,
            },
            {
                target: "#favoritos-btn",
                titulo: "Mis favoritas",
                texto: "Guardá las calles que más te interesen para volver a verlas después.",
                abrirPanel: true,
            },
            {
                target: "#nearme-btn",
                titulo: "Ubicación",
                texto: "Mostrá las calles con historia más cercanas a donde estás parado.",
                abrirPanel: true,
            },
        ];

        if ($btnEfemeride && !$btnEfemeride.hidden) {
            pasos.push({
                target: "#efemeride-btn",
                titulo: "Un día como hoy",
                texto: "Hoy hay una efeméride para contar: tocá acá para verla.",
                abrirPanel: true,
            });
        }

        pasos.push({
            target: "#about-btn",
            titulo: "Acerca de",
            texto: "Info del proyecto, fuentes de datos y este mismo tutorial, para volver a verlo cuando quieras.",
            abrirPanel: true,
        });

        pasos.push({
            target: null,
            titulo: "¡Listo para explorar!",
            texto: "¡A explorar el callejero porteño!",
        });

        return pasos;
    }

    /** Ubica el spotlight y la tarjeta según el elemento del paso actual
     *  (o los centra en pantalla si el paso no apunta a nada). */
    function posicionarTour(selector) {
        if (!$tourSpotlight || !$tourCard) return;
        const target = selector ? document.querySelector(selector) : null;
        const esMobile = window.innerWidth <= 480;

        if (!target) {
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            $tourSpotlight.style.cssText = `top:${cy}px; left:${cx}px; width:0; height:0; border-radius:50%;`;
        } else {
            const r = target.getBoundingClientRect();
            const pad = 6;
            const circular = Math.abs(r.width - r.height) < 4;
            $tourSpotlight.style.cssText =
                `top:${r.top - pad}px; left:${r.left - pad}px; ` +
                `width:${r.width + pad * 2}px; height:${r.height + pad * 2}px; ` +
                `border-radius:${circular ? "50%" : "10px"};`;
        }

        if (esMobile) {
            // En mobile la tarjeta queda fija abajo (ver CSS), no hace
            // falta calcular su posición.
            $tourCard.style.top = "";
            $tourCard.style.left = "";
            $tourCard.style.transform = "";
            return;
        }

        if (!target) {
            $tourCard.style.top = "50%";
            $tourCard.style.left = "50%";
            $tourCard.style.transform = "translate(-50%, -50%)";
            return;
        }

        $tourCard.style.transform = "";
        const r = target.getBoundingClientRect();
        const margen = 14;
        const cardW = $tourCard.offsetWidth || 300;
        const cardH = $tourCard.offsetHeight || 160;
        let top, left;

        if (r.right + margen + cardW < window.innerWidth) {
            left = r.right + margen;
            top = r.top + r.height / 2 - cardH / 2;
        } else if (r.left - margen - cardW > 0) {
            left = r.left - margen - cardW;
            top = r.top + r.height / 2 - cardH / 2;
        } else if (r.bottom + margen + cardH < window.innerHeight) {
            top = r.bottom + margen;
            left = r.left + r.width / 2 - cardW / 2;
        } else {
            top = r.top - margen - cardH;
            left = r.left + r.width / 2 - cardW / 2;
        }

        top = Math.min(Math.max(top, margen), window.innerHeight - cardH - margen);
        left = Math.min(Math.max(left, margen), window.innerWidth - cardW - margen);
        $tourCard.style.top = `${top}px`;
        $tourCard.style.left = `${left}px`;
    }

    function mostrarPasoTour(indice) {
        if (indice < 0 || indice >= tourPasos.length) return;
        tourPasoActual = indice;
        const paso = tourPasos[indice];

        if ($toolsPanel) {
            $toolsPanel.hidden = !paso.abrirPanel;
        }
        if ($btnTools) {
            $btnTools.setAttribute("aria-expanded", String(!!paso.abrirPanel));
        }

        if ($tourStepCount) $tourStepCount.textContent = `${indice + 1} / ${tourPasos.length}`;
        if ($tourTitle) $tourTitle.textContent = paso.titulo;
        if ($tourText) $tourText.textContent = paso.texto;
        if ($tourPrev) $tourPrev.disabled = indice === 0;
        if ($tourNext) $tourNext.textContent = indice === tourPasos.length - 1 ? "Entendido" : "Siguiente";

        // Se posiciona en el mismo tick, sin esperar un frame: leer
        // getBoundingClientRect()/offsetWidth ya fuerza el layout al
        // vuelo, así que no hace falta requestAnimationFrame (que además
        // no se dispara si la pestaña queda en segundo plano, dejando la
        // tarjeta clavada en top:0;left:0 hasta que vuelva a primer plano).
        posicionarTour(paso.target);
    }

    function avanzarTour() {
        if (tourPasoActual >= tourPasos.length - 1) {
            cerrarTour();
            return;
        }
        mostrarPasoTour(tourPasoActual + 1);
    }

    function retrocederTour() {
        if (tourPasoActual === 0) return;
        mostrarPasoTour(tourPasoActual - 1);
    }

    function cerrarTour() {
        if ($tourOverlay) $tourOverlay.hidden = true;
        if ($toolsPanel) $toolsPanel.hidden = true;
        if ($btnTools) $btnTools.setAttribute("aria-expanded", "false");
        localStorage.setItem(TOUR_KEY, "1");
    }

    function iniciarTour() {
        tourPasos = construirPasosTour();
        if (tourPasos.length === 0 || !$tourOverlay) return;
        $tourOverlay.hidden = false;
        mostrarPasoTour(0);
    }

    function inicializarTour() {
        if ($tourNext) $tourNext.addEventListener("click", avanzarTour);
        if ($tourPrev) $tourPrev.addEventListener("click", retrocederTour);
        if ($tourSkip) $tourSkip.addEventListener("click", cerrarTour);
        if ($tourReplayBtn) {
            $tourReplayBtn.addEventListener("click", () => {
                if ($aboutModal) $aboutModal.hidden = true;
                setTimeout(iniciarTour, 150);
            });
        }
        document.addEventListener("keydown", (e) => {
            if (!$tourOverlay || $tourOverlay.hidden) return;
            if (e.key === "Escape") cerrarTour();
            else if (e.key === "ArrowRight") avanzarTour();
            else if (e.key === "ArrowLeft") retrocederTour();
        });
        window.addEventListener("resize", () => {
            if (!$tourOverlay || $tourOverlay.hidden) return;
            const paso = tourPasos[tourPasoActual];
            if (paso) posicionarTour(paso.target);
        });

        // Primera visita real: sin flag guardado y sin ?c=/?cat= en la URL
        // (un link compartido no debería interrumpirse con el tutorial).
        if (!localStorage.getItem(TOUR_KEY) && !location.search) {
            setTimeout(iniciarTour, 600);
        }
    }

    // =================================================================
    // 10. ARRANQUE
    // =================================================================

    async function main() {
        inicializarMapa();
        await cargarDatos();
        dibujarCapaBase();
        conectarEventos();
        inicializarEfemeride();
        actualizarBadgeFavoritos();
        inicializarTour();
        // ?c=<calle> tiene prioridad; si no hay ninguna (o no existe), se
        // prueba ?cat=<categoría> para restaurar un filtro compartido.
        if (!seleccionarDesdeURL()) {
            seleccionarCategoriaDesdeURL();
        }
    }

    document.addEventListener("DOMContentLoaded", main);
})();
