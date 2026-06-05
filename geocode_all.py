"""
geocode_all.py — Pre-geocoding masivo OPTIMIZADO.

Estrategia (mucho más rápida que ir uno por uno):

  1. BULK DOWNLOAD: una sola query a Overpass baja TODAS las calles
     (ways con highway+name) en el bbox de CABA, y otra baja TODOS
     los espacios verdes/plazas con name. Total: 2 requests grandes.

  2. INDEXADO LOCAL: armamos un diccionario nombre_normalizado -> [elementos],
     uniendo ways del mismo nombre (la avenida Corrientes tiene 100+ tramos).

  3. MATCH LOCAL: para cada una de las 2964 entradas del Excel buscamos
     en el índice. Esto es instantáneo.

  4. FALLBACK NOMINATIM: solo para las entradas que NO matchearon
     localmente (probablemente 200-500), consultamos Nominatim en vivo
     respetando rate limit. Tarda 5-10 minutos.

Tiempo total estimado: ~10-15 minutos (vs. ~15 horas del approach naïve).

Reanudable: si se interrumpe (Ctrl+C), guarda lo procesado y al
volver a correr continúa desde donde quedó.

Uso:
    python geocode_all.py

Salida:
    data/geo_cache.json         (clave -> {tipo, geometry, bbox, source})
    data/geocoding_report.txt   (resumen + fallos)
"""

import json
import signal
import sys
import time
import unicodedata
from pathlib import Path

import requests

# ---------- Configuración ----------
BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"
REPORT_PATH = BASE / "data" / "geocoding_report.txt"
OSM_DUMP = BASE / "data" / "_osm_bulk.json"  # cache del bulk download

USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]

# Bbox CABA (sur, oeste, norte, este)
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)
VIEWBOX = "-58.531,-34.706,-58.335,-34.527"
DELAY_NOMINATIM = 1.1

TIPOS_LINEA = {
    "calle", "avenida", "pasaje peatonal", "autopista",
    "sendero", "paseo", "puente", "túnel", "tunel",
    "sendero peatonal", "puente peatonal",
}

_estado = {"cache": None, "interrumpido": False}


def _norm(s):
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def guardar_cache(cache):
    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)


def manejar_interrupcion(signum, frame):
    print("\n\n[!] Interrupción detectada. Guardando progreso...")
    _estado["interrumpido"] = True
    if _estado["cache"] is not None:
        guardar_cache(_estado["cache"])
        print(f"[!] Cache guardado: {len(_estado['cache'])} entradas")
    sys.exit(0)


signal.signal(signal.SIGINT, manejar_interrupcion)


# =================================================================
# OVERPASS BULK
# =================================================================

def overpass_post(query, mirror_index=0):
    """Postea una query Overpass, con failover entre mirrors."""
    for i in range(mirror_index, len(OVERPASS_MIRRORS)):
        url = OVERPASS_MIRRORS[i]
        print(f"  -> Overpass mirror: {url}")
        try:
            r = requests.post(
                url,
                data={"data": query},
                timeout=300,
                headers={"User-Agent": USER_AGENT},
            )
            if r.status_code == 200:
                return r.json()
            print(f"     HTTP {r.status_code}, probando siguiente mirror...")
        except (requests.RequestException, ValueError) as e:
            print(f"     Error: {type(e).__name__}: {e}, probando siguiente mirror...")
    return None


def descargar_calles_caba():
    """Una query: todas las ways con highway+name en CABA."""
    s, w, n, e = CABA_BBOX
    query = (
        '[out:json][timeout:300];'
        f'(way["highway"]["name"]({s},{w},{n},{e}););'
        'out geom;'
    )
    print("[1/2] Descargando todas las calles de CABA desde Overpass...")
    t0 = time.time()
    data = overpass_post(query)
    if not data:
        print("     FALLO. No se pudo bajar el dataset de calles.")
        return None
    print(f"     OK: {len(data.get('elements', []))} ways en {time.time()-t0:.1f}s")
    return data


def descargar_areas_caba():
    """Plazas, parques, jardines, barrios — todo lo que tenga name dentro del bbox."""
    s, w, n, e = CABA_BBOX
    query = (
        '[out:json][timeout:300];'
        '('
        # Plazas (square / pedestrian area / pedestrian zone)
        f'  way["place"="square"]["name"]({s},{w},{n},{e});'
        f'  relation["place"="square"]["name"]({s},{w},{n},{e});'
        # Parques y áreas recreativas
        f'  way["leisure"~"park|garden|recreation_ground|playground|nature_reserve"]["name"]({s},{w},{n},{e});'
        f'  relation["leisure"~"park|garden|recreation_ground|playground|nature_reserve"]({s},{w},{n},{e});'
        # Landuse recreativo
        f'  way["landuse"~"recreation_ground|grass|forest"]["name"]({s},{w},{n},{e});'
        # Barrios / suburbs / neighbourhoods
        f'  node["place"~"suburb|neighbourhood|quarter"]["name"]({s},{w},{n},{e});'
        f'  relation["place"~"suburb|neighbourhood|quarter"]["name"]({s},{w},{n},{e});'
        f'  relation["boundary"="administrative"]["admin_level"~"^(8|9|10)$"]["name"]({s},{w},{n},{e});'
        # Plazas como nodos individuales
        f'  node["place"="square"]["name"]({s},{w},{n},{e});'
        ');'
        'out center geom;'
    )
    print("[2/2] Descargando plazas/parques/barrios de CABA desde Overpass...")
    t0 = time.time()
    data = overpass_post(query)
    if not data:
        print("     FALLO. No se pudo bajar el dataset de áreas.")
        return None
    print(f"     OK: {len(data.get('elements', []))} elementos en {time.time()-t0:.1f}s")
    return data


# =================================================================
# INDEXADO Y MATCH LOCAL
# =================================================================

def construir_indice_calles(data):
    """Devuelve {nombre_normalizado: [ways...]}."""
    if not data:
        return {}
    idx = {}
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        name = (el.get("tags") or {}).get("name")
        if not name:
            continue
        clave = _norm(name)
        idx.setdefault(clave, []).append(el)
    print(f"  Índice calles: {len(idx)} nombres únicos")
    return idx


def construir_indice_areas(data):
    """Devuelve {nombre_normalizado: [elementos...]}."""
    if not data:
        return {}
    idx = {}
    for el in data.get("elements", []):
        name = (el.get("tags") or {}).get("name")
        if not name:
            continue
        clave = _norm(name)
        idx.setdefault(clave, []).append(el)
    print(f"  Índice áreas: {len(idx)} nombres únicos")
    return idx


def ways_a_multilinestring(ways):
    """Combina varios ways en una MultiLineString GeoJSON con bbox."""
    lineas = []
    for w in ways:
        geom = w.get("geometry")
        if not geom:
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in geom]
        if len(coords) >= 2:
            lineas.append(coords)
    if not lineas:
        return None

    todos = [pt for ln in lineas for pt in ln]
    lons = [p[0] for p in todos]
    lats = [p[1] for p in todos]

    if len(lineas) == 1:
        geometry = {"type": "LineString", "coordinates": lineas[0]}
    else:
        geometry = {"type": "MultiLineString", "coordinates": lineas}

    return {
        "tipo": "line",
        "geometry": geometry,
        "bbox": [min(lats), max(lats), min(lons), max(lons)],
        "source": "overpass-bulk",
        "ways": len(lineas),
    }


def elemento_a_geo(el):
    """Convierte un elemento (node/way/relation) en estructura de geometría."""
    et = el.get("type")
    if et == "node":
        lat = el.get("lat")
        lon = el.get("lon")
        if lat is None or lon is None:
            return None
        return {
            "tipo": "point",
            "center": [lat, lon],
            "bbox": [lat - 0.001, lat + 0.001, lon - 0.001, lon + 0.001],
            "source": "overpass-bulk",
        }

    if et == "way":
        geom = el.get("geometry")
        if not geom:
            return None
        coords = [[pt["lon"], pt["lat"]] for pt in geom]
        if len(coords) < 3:
            # Tratar como punto
            if coords:
                lon, lat = coords[0]
                return {
                    "tipo": "point",
                    "center": [lat, lon],
                    "bbox": [lat - 0.001, lat + 0.001, lon - 0.001, lon + 0.001],
                    "source": "overpass-bulk",
                }
            return None
        # Cerrar polígono si no está cerrado
        if coords[0] != coords[-1]:
            coords.append(coords[0])
        lats = [p[1] for p in coords]
        lons = [p[0] for p in coords]
        center_lat = sum(lats) / len(lats)
        center_lon = sum(lons) / len(lons)
        return {
            "tipo": "point",
            "center": [center_lat, center_lon],
            "geometry": {"type": "Polygon", "coordinates": [coords]},
            "bbox": [min(lats), max(lats), min(lons), max(lons)],
            "source": "overpass-bulk",
        }

    if et == "relation":
        # Overpass devuelve "center" con out center
        center = el.get("center") or {}
        lat = center.get("lat")
        lon = center.get("lon")
        if lat is None or lon is None:
            return None
        return {
            "tipo": "point",
            "center": [lat, lon],
            "bbox": [lat - 0.002, lat + 0.002, lon - 0.002, lon + 0.002],
            "source": "overpass-bulk",
        }

    return None


# =================================================================
# NOMINATIM FALLBACK
# =================================================================

def nominatim_buscar(nombre):
    params = {
        "q": f"{nombre}, Ciudad Autónoma de Buenos Aires, Argentina",
        "format": "json",
        "polygon_geojson": "1",
        "limit": "5",
        "viewbox": VIEWBOX,
        "bounded": "1",
        "countrycodes": "ar",
    }
    try:
        r = requests.get(
            NOMINATIM_URL,
            params=params,
            timeout=30,
            headers={"User-Agent": USER_AGENT, "Accept-Language": "es"},
        )
        if r.status_code != 200:
            return None
        data = r.json()
        return data if isinstance(data, list) else None
    except (requests.RequestException, ValueError):
        return None


def nominatim_a_geometria(resultados, preferir_linea):
    if not resultados:
        return None
    en_caba = [
        r for r in resultados
        if "buenos aires" in r.get("display_name", "").lower()
        or "caba" in r.get("display_name", "").lower()
    ]
    pool = en_caba if en_caba else resultados

    if preferir_linea:
        lineas = [
            r for r in pool
            if r.get("geojson", {}).get("type") in ("LineString", "MultiLineString")
        ]
        if lineas:
            best = lineas[0]
            return {
                "tipo": "line",
                "geometry": best["geojson"],
                "bbox": [float(x) for x in best["boundingbox"]],
                "source": "nominatim",
            }
    best = pool[0]
    return {
        "tipo": "point",
        "center": [float(best["lat"]), float(best["lon"])],
        "geometry": best.get("geojson"),
        "bbox": [float(x) for x in best["boundingbox"]],
        "source": "nominatim",
    }


# =================================================================
# PIPELINE PRINCIPAL
# =================================================================

def cargar_o_descargar_osm():
    """Cachea el bulk download en disco para no repetirlo en cada corrida."""
    if OSM_DUMP.exists():
        edad_min = (time.time() - OSM_DUMP.stat().st_mtime) / 60
        print(f"Usando OSM dump existente ({edad_min:.0f} min de antigüedad).")
        with OSM_DUMP.open(encoding="utf-8") as f:
            return json.load(f)

    calles_data = descargar_calles_caba()
    areas_data = descargar_areas_caba()

    if not calles_data or not areas_data:
        return None

    dump = {"calles": calles_data, "areas": areas_data}
    OSM_DUMP.write_text(json.dumps(dump, ensure_ascii=False), encoding="utf-8")
    return dump


def main():
    if not CALLES_JSON.exists():
        raise SystemExit(f"No existe {CALLES_JSON}. Corré build_data.py primero.")

    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)

    if GEO_CACHE.exists():
        with GEO_CACHE.open(encoding="utf-8") as f:
            cache = json.load(f)
        print(f"Cache existente: {len(cache)} entradas geocodificadas")
    else:
        cache = {}
    _estado["cache"] = cache

    # ---- BULK DOWNLOAD ----
    dump = cargar_o_descargar_osm()
    if not dump:
        print("FATAL: no se pudo obtener el dataset OSM.")
        sys.exit(1)

    # ---- INDEXADO ----
    print("\nConstruyendo índices locales...")
    idx_calles = construir_indice_calles(dump["calles"])
    idx_areas = construir_indice_areas(dump["areas"])

    # ---- MATCH LOCAL ----
    print("\nMatcheando entradas del Excel contra el índice...")
    matched_calles = 0
    matched_areas = 0
    pendientes_nominatim = []

    for entrada in calles:
        if entrada["clave"] in cache:
            continue

        es_linea = entrada["tipo"] in TIPOS_LINEA
        clave_norm = entrada["clave"]
        # Probar también con/sin "avenida " prefix
        variantes = [clave_norm]
        if es_linea and not clave_norm.startswith("avenida "):
            variantes.append(f"avenida {clave_norm}")
        if clave_norm.startswith("avenida "):
            variantes.append(clave_norm.replace("avenida ", "", 1))

        geo = None
        if es_linea:
            for v in variantes:
                if v in idx_calles:
                    geo = ways_a_multilinestring(idx_calles[v])
                    if geo:
                        matched_calles += 1
                        break
            if not geo:
                # Quizá la entrada es tipo línea pero figura como área
                # (ej "paseo" puede ser un parque)
                for v in variantes:
                    if v in idx_areas:
                        geo = elemento_a_geo(idx_areas[v][0])
                        if geo:
                            matched_areas += 1
                            break
        else:
            for v in variantes:
                if v in idx_areas:
                    geo = elemento_a_geo(idx_areas[v][0])
                    if geo:
                        matched_areas += 1
                        break
            if not geo:
                # Plazoletas suelen estar como ways pequeños en idx_calles
                for v in variantes:
                    if v in idx_calles:
                        geo = ways_a_multilinestring(idx_calles[v])
                        if geo:
                            matched_calles += 1
                            break

        if geo:
            cache[entrada["clave"]] = geo
        else:
            pendientes_nominatim.append(entrada)

    print(f"  Match local: {matched_calles} calles + {matched_areas} áreas")
    print(f"  Pendientes para Nominatim: {len(pendientes_nominatim)}")
    guardar_cache(cache)

    # ---- FALLBACK NOMINATIM ----
    if pendientes_nominatim:
        print(f"\nConsultando Nominatim para {len(pendientes_nominatim)} entradas restantes...")
        print(f"  (rate limit: 1 req/seg -> estimado {len(pendientes_nominatim) * DELAY_NOMINATIM / 60:.1f} min)")

        fallos = []
        inicio = time.time()
        for i, entrada in enumerate(pendientes_nominatim, 1):
            if _estado["interrumpido"]:
                break

            nombre = entrada["nombre_busqueda"]
            es_linea = entrada["tipo"] in TIPOS_LINEA

            try:
                resultados = nominatim_buscar(nombre)
                time.sleep(DELAY_NOMINATIM)
                geo = nominatim_a_geometria(resultados, preferir_linea=es_linea)
            except Exception as e:
                geo = None
                print(f"    error: {type(e).__name__}: {e}")

            if geo:
                cache[entrada["clave"]] = geo
                estado = "OK"
            else:
                fallos.append(entrada)
                estado = "FAIL"

            if i % 10 == 0 or i <= 3:
                elapsed = time.time() - inicio
                rate = i / elapsed if elapsed > 0 else 0
                eta_min = (len(pendientes_nominatim) - i) / rate / 60 if rate > 0 else 0
                print(f"  [{i:4d}/{len(pendientes_nominatim)}] {estado} "
                      f"{nombre[:45]:45s} | ETA {eta_min:5.1f} min")

            if i % 25 == 0:
                guardar_cache(cache)

        guardar_cache(cache)
    else:
        fallos = []

    # ---- REPORTE ----
    generar_reporte(calles, cache, fallos, matched_calles, matched_areas)

    print()
    print(f"Finalizado.")
    print(f"  Total entradas:                {len(calles)}")
    print(f"  Geocodificadas (acumulado):    {len(cache)}  ({100*len(cache)/len(calles):.1f}%)")
    print(f"  No encontradas:                {len(calles) - len(cache)}")
    print(f"  Reporte: {REPORT_PATH}")


def generar_reporte(calles, cache, fallos_nominatim, matched_calles, matched_areas):
    no_cache = [c for c in calles if c["clave"] not in cache]
    fuentes = {}
    for v in cache.values():
        s = v.get("source", "?")
        fuentes[s] = fuentes.get(s, 0) + 1

    lineas = []
    lineas.append("=" * 60)
    lineas.append("REPORTE DE GEOCODING — Calleando CABA")
    lineas.append("=" * 60)
    lineas.append(f"Total entradas:               {len(calles)}")
    lineas.append(f"Geocodificadas (acumulado):   {len(cache)}  ({100*len(cache)/len(calles):.1f}%)")
    lineas.append(f"  Match local calles:         {matched_calles}")
    lineas.append(f"  Match local áreas:          {matched_areas}")
    lineas.append(f"  Match Nominatim fallback:   {len(cache) - matched_calles - matched_areas}")
    lineas.append(f"No encontradas:               {len(no_cache)}")
    lineas.append("")
    lineas.append("Fuentes en el cache:")
    for s, n in sorted(fuentes.items(), key=lambda x: -x[1]):
        lineas.append(f"  {s:20s} {n}")
    lineas.append("")
    lineas.append("-" * 60)
    lineas.append(f"NO ENCONTRADAS ({len(no_cache)}):")
    lineas.append("-" * 60)
    for c in no_cache[:300]:
        lineas.append(f"  [{c['tipo'][:12]:12s}] {c['nombre_busqueda']}")
    if len(no_cache) > 300:
        lineas.append(f"  ... y {len(no_cache)-300} más")

    REPORT_PATH.write_text("\n".join(lineas), encoding="utf-8")


if __name__ == "__main__":
    main()
