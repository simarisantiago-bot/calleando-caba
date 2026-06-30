"""
apply_overrides.py — Mergea data/overrides.json a data/geo_cache.json.

overrides.json tiene la forma:
    {
        "clave normalizada": {"lat": -34.xxx, "lon": -58.xxx}
    }

Para cada override, intenta resolver la GEOMETRÍA COMPLETA de la calle:
  1. Pregunta a Overpass qué ways highway hay en un radio de 50m del punto.
  2. Toma el way más cercano y extrae su `name` de OSM.
  3. Segunda query: trae TODOS los ways de CABA con ese mismo `name`.
  4. Los combina como MultiLineString -> la calle entera se dibuja como línea azul.
  5. Si algo falla, fallback a marker (punto) en las coords originales.

El resultado se escribe en el cache bajo el `id` de cada entrada (clave|tipo),
que es como lo indexa la app (geoCache[entrada.id]). Una clave puede mapear a
varias entradas (distintos tipos): se escriben todas.

Seguridad: si la resolución cae a pin (p. ej. por un error de red) pero ya
existía una LÍNEA en el cache para ese id, se conserva la línea previa en vez
de degradarla. Así re-correr el script es idempotente y no destructivo.

Uso:
    python apply_overrides.py
"""

import json
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import requests

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"
OVERRIDES = BASE / "data" / "overrides.json"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
RADIO_METROS = 50
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)  # S, W, N, E

# Mínima similitud entre el nombre del Excel y el nombre OSM del way más cercano
# para aceptar el match automático. Si no llega al threshold, fallback a pin.
SIMILITUD_MIN = 0.5


def _norm(s):
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def overpass(query, reintentos=3):
    """POST a Overpass con reintentos y backoff ante rate limit (429/504) o
    errores transitorios de red. Devuelve dict o None."""
    espera = 5
    for intento in range(reintentos):
        try:
            r = requests.post(
                OVERPASS_URL,
                data={"data": query},
                timeout=60,
                headers={"User-Agent": USER_AGENT},
            )
            if r.status_code == 200:
                return r.json()
            # 429 (Too Many Requests) / 504 (timeout del servidor): reintentar.
            if r.status_code in (429, 504) and intento < reintentos - 1:
                time.sleep(espera)
                espera *= 2
                continue
            return None
        except (requests.RequestException, ValueError):
            if intento < reintentos - 1:
                time.sleep(espera)
                espera *= 2
                continue
            return None
    return None


def way_mas_cercano(lat, lon, radio_m=RADIO_METROS):
    """Busca ways highway en un radio. Devuelve el más cercano (con tags)."""
    deg = radio_m / 111320.0  # 1 grado ≈ 111 km
    s, w = lat - deg, lon - deg
    n, e = lat + deg, lon + deg
    query = (
        '[out:json][timeout:25];'
        f'(way["highway"]({s},{w},{n},{e}););'
        'out geom tags;'
    )
    data = overpass(query)
    if not data:
        return None
    ways = [el for el in data.get("elements", [])
            if el.get("type") == "way" and el.get("geometry")]
    if not ways:
        return None

    def dist2_min(way):
        return min(
            (pt["lat"] - lat) ** 2 + (pt["lon"] - lon) ** 2
            for pt in way["geometry"]
        )

    ways.sort(key=dist2_min)
    return ways[0]


def todos_los_ways_con_nombre(name):
    """Trae TODOS los ways highway en CABA con el name exacto dado."""
    if not name:
        return None
    name_safe = name.replace('\\', '\\\\').replace('"', '\\"')
    s, w, n, e = CABA_BBOX
    query = (
        '[out:json][timeout:30];'
        f'(way["highway"]["name"="{name_safe}"]({s},{w},{n},{e}););'
        'out geom;'
    )
    data = overpass(query)
    if not data:
        return None
    ways = [el for el in data.get("elements", [])
            if el.get("type") == "way" and el.get("geometry")]
    return ways or None


def ways_a_linea(ways):
    """Combina varios ways en estructura de cache tipo 'line'."""
    lineas = []
    for w in ways:
        coords = [[pt["lon"], pt["lat"]] for pt in w["geometry"]]
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
        "source": "override-resolved",
        "ways": len(lineas),
    }


def punto_fallback(lat, lon):
    return {
        "tipo": "point",
        "center": [lat, lon],
        "bbox": [lat - 0.001, lat + 0.001, lon - 0.001, lon + 0.001],
        "source": "override",
    }


def resolver_override(clave_excel, lat, lon, osm_name=None):
    """
    Intenta resolver geometría completa. Aplica check de similitud entre
    nombre del Excel y nombre OSM del way más cercano. Si no se parece,
    devuelve pin + sugerencia del nombre OSM encontrado para revisión manual.

    Si se pasa `osm_name` (p. ej. calles renombradas, cuyo nombre OSM no se
    parece al del Excel), se saltea el chequeo de similitud y se trae la línea
    completa directamente por ese nombre.
    """
    if osm_name:
        todos = todos_los_ways_con_nombre(osm_name)
        time.sleep(1.1)
        if todos:
            geo = ways_a_linea(todos)
            if geo:
                return geo, f"línea por osm_name: '{osm_name}' ({geo['ways']} ways)", None
        # No encontró nada con ese nombre: cae al flujo normal por punto.

    near = way_mas_cercano(lat, lon)
    time.sleep(1.1)
    if not near:
        return punto_fallback(lat, lon), "pin (sin way cerca)", None

    tags = near.get("tags") or {}
    name = tags.get("name", "")

    if not name:
        # Way sin nombre: no podemos verificar similitud -> pin con nota
        return punto_fallback(lat, lon), "pin (way OSM sin nombre cerca)", None

    sim = SequenceMatcher(None, _norm(clave_excel), _norm(name)).ratio()

    if sim < SIMILITUD_MIN:
        # El way cercano es OTRA calle. Pin + reportar el candidato.
        return punto_fallback(lat, lon), f"pin (way cerca: '{name}', similitud {sim:.2f})", name

    # Similitud suficiente: traer toda la calle con ese nombre OSM
    todos = todos_los_ways_con_nombre(name)
    time.sleep(1.1)
    if not todos:
        geo = ways_a_linea([near])
        return (geo or punto_fallback(lat, lon)), f"línea local (sim {sim:.2f}, name '{name}')", None

    geo = ways_a_linea(todos)
    if not geo:
        return punto_fallback(lat, lon), "fallo combinar geometrías", None
    return geo, f"línea completa: '{name}' ({geo['ways']} ways, sim {sim:.2f})", None


def main():
    if not OVERRIDES.exists():
        raise SystemExit("No existe data/overrides.json")

    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)
    with OVERRIDES.open(encoding="utf-8") as f:
        overrides = json.load(f)

    # Mapa clave -> [(id, tipo, nombre_busqueda)]. La app indexa por id (clave|tipo),
    # así que una clave puede corresponder a varias entradas (distintos tipos).
    clave_a_entradas = {}
    for c in calles:
        clave_a_entradas.setdefault(c["clave"], []).append(c)

    aplicados = 0
    fallback_punto = 0
    conservados = 0
    sugerencias = []  # [(clave_excel, nombre_osm_cercano)]
    invalidos = []

    print(f"Resolviendo {len(overrides)} overrides via Overpass...")
    print(f"(threshold similitud nombre Excel <-> nombre OSM: {SIMILITUD_MIN})")
    print()

    for i, (clave, coords) in enumerate(overrides.items(), 1):
        entradas = clave_a_entradas.get(clave)
        if not entradas:
            invalidos.append(clave)
            continue
        try:
            lat = float(coords["lat"])
            lon = float(coords["lon"])
        except (KeyError, TypeError, ValueError):
            invalidos.append(clave)
            continue

        # Para comparar similitud uso el nombre legible del Excel, no la clave
        nombre_excel = entradas[0]["nombre_busqueda"]
        osm_name = coords.get("osm_name") if isinstance(coords, dict) else None

        geo, mensaje, sugerencia = resolver_override(nombre_excel, lat, lon, osm_name)

        # Escribir bajo el id de cada entrada con esa clave.
        for c in entradas:
            id_ = c["id"]
            previo = cache.get(id_)
            # No degradar una línea existente a pin por un fallo de red.
            if geo["tipo"] == "point" and previo and previo.get("tipo") == "line":
                conservados += 1
                continue
            cache[id_] = geo

        if geo["tipo"] == "point":
            fallback_punto += 1
            if sugerencia:
                sugerencias.append((nombre_excel, sugerencia))
        aplicados += 1

        marca = "LIN" if geo["tipo"] == "line" else "PIN"
        ids_txt = ", ".join(c["id"] for c in entradas)
        print(f"  [{i:2d}/{len(overrides)}] {marca} {nombre_excel[:34]:34s} -> {ids_txt} | {mensaje}")

    # Guardar
    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)

    print()
    print(f"Total overrides aplicados: {aplicados}")
    print(f"  Con línea completa: {aplicados - fallback_punto}")
    print(f"  Como pin (fallback): {fallback_punto}")
    if conservados:
        print(f"  Líneas previas conservadas (no degradadas a pin): {conservados}")
    if sugerencias:
        print()
        print(f"CANDIDATOS DE OSM (calles cercanas al pin, distinto nombre):")
        print(f"  -> Si reconocés alguno como nombre alternativo, decímelo")
        print(f"    y reemplazo el pin por la línea real de esa calle.")
        for excel, osm in sugerencias:
            print(f"  - '{excel}'  ->  candidato OSM: '{osm}'")
    if invalidos:
        print(f"Inválidos: {len(invalidos)}")
        for k in invalidos[:10]:
            print(f"  - {k}")
    print(f"Cache total: {len(cache)} / {len(calles)} ({100*len(cache)/len(calles):.1f}%)")


if __name__ == "__main__":
    main()
