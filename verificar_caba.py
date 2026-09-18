"""
verificar_caba.py — Chequea que las geometrías de data/geo_cache.json caigan
realmente dentro de la Ciudad Autónoma de Buenos Aires.

Por qué existe: hay calles homónimas en el Conurbano (hay cinco "Emilio Castro"
distintas en el AMBA, por ejemplo). Si una consulta a Overpass/Nominatim trae la
del partido equivocado, el bbox suelto de CABA no lo detecta —los dos puntos
caen en el mismo rectángulo— pero el polígono administrativo real sí.

Detecta:
    - Entradas cuyas coordenadas caen mayoritariamente fuera del límite de CABA
      (típicamente: se geocodificó la calle homónima de otro partido).
    - Coordenadas imposibles (lat/lon invertidas, ceros, fuera de Argentina).

El límite se lee de data/limite_caba.json. Para regenerarlo desde OpenStreetMap:

    python verificar_caba.py --actualizar-limite

No modifica geo_cache.json — solo informa. Correr antes de un "commitea y pushea"
junto con verificar_integridad.py.

Uso:
    python verificar_caba.py

Salida: reporte por consola. Código de salida 0 si no encontró problemas,
1 si encontró alguno (útil para un hook o CI).
"""

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
LIMITE = DATA_DIR / "limite_caba.json"

RELACION_CABA = 3082668  # relation de CABA en OpenStreetMap

# Si este porcentaje o más de los nodos de una entrada cae fuera de CABA,
# se asume que se geocodificó el lugar equivocado. Por debajo es normal:
# los barrios ribereños y las avenidas que corren sobre el límite rozan
# el borde, y eso no es un error.
UMBRAL_FALLA = 0.90

# Casos que cruzan el límite por naturaleza y no son errores.
# Los puentes sobre el Riachuelo tienen media traza en Provincia, y la
# General Paz *es* el límite, así que sus nodos caen sobre la línea.
EXCEPCIONES = {"general paz|avenida"}
TIPOS_EXENTOS = {"puente"}

MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)


# --------------------------------------------------------------------------
# Límite de CABA
# --------------------------------------------------------------------------

def actualizar_limite():
    """Baja el límite de CABA de OSM y lo guarda en data/limite_caba.json."""
    consulta = f"[out:json][timeout:180];rel({RELACION_CABA});out geom;"
    datos = urllib.parse.urlencode({"data": consulta}).encode()
    crudo = None
    for url in MIRRORS:
        try:
            print(f"Consultando {url} ...")
            pedido = urllib.request.Request(
                url, data=datos,
                headers={"User-Agent": "calleando-caba/1.0"})
            with urllib.request.urlopen(pedido, timeout=180) as resp:
                crudo = json.loads(resp.read().decode("utf-8"))
            break
        except Exception as err:  # noqa: BLE001 — cualquier fallo: probar el siguiente mirror
            print(f"    falló: {err}")
    if crudo is None:
        print("[FALLA] No se pudo consultar Overpass en ningún mirror.")
        return 1

    relacion = crudo["elements"][0]
    tramos = [
        [(p["lon"], p["lat"]) for p in m["geometry"]]
        for m in relacion["members"]
        if m["type"] == "way" and m.get("role") in ("outer", "") and "geometry" in m
    ]
    anillos = encadenar(tramos)
    abiertos = [a for a in anillos if a[0] != a[-1]]
    if abiertos:
        print(f"[AVISO] {len(abiertos)} anillo(s) quedaron abiertos.")

    with open(LIMITE, "w", encoding="utf-8", newline="\n") as f:
        json.dump({
            "relation": RELACION_CABA,
            "fuente": "OpenStreetMap (ODbL)",
            "anillos": [[[round(x, 7), round(y, 7)] for x, y in a] for a in anillos],
        }, f, ensure_ascii=False)
        f.write("\n")
    print(f"[OK] {len(anillos)} anillo(s), "
          f"{sum(len(a) for a in anillos)} nodos -> {LIMITE.name}")
    return 0


def encadenar(tramos):
    """Une tramos sueltos en anillos, pegándolos por sus extremos comunes."""
    anillos, usados = [], [False] * len(tramos)
    for i in range(len(tramos)):
        if usados[i]:
            continue
        usados[i] = True
        anillo = list(tramos[i])
        creciendo = True
        while creciendo:
            creciendo = False
            for j in range(len(tramos)):
                if usados[j]:
                    continue
                t = tramos[j]
                if anillo[-1] == t[0]:
                    anillo += t[1:]
                elif anillo[-1] == t[-1]:
                    anillo += t[::-1][1:]
                elif anillo[0] == t[-1]:
                    anillo = t[:-1] + anillo
                elif anillo[0] == t[0]:
                    anillo = t[::-1][:-1] + anillo
                else:
                    continue
                usados[j] = True
                creciendo = True
        anillos.append(anillo)
    anillos.sort(key=len, reverse=True)
    return anillos


# --------------------------------------------------------------------------
# Geometría
# --------------------------------------------------------------------------

def dentro_de(x, y, anillo):
    """Point-in-polygon por ray casting."""
    adentro = False
    n = len(anillo)
    j = n - 1
    for i in range(n):
        xi, yi = anillo[i]
        xj, yj = anillo[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            adentro = not adentro
        j = i
    return adentro


def en_caba(x, y, anillos):
    return any(dentro_de(x, y, a) for a in anillos)


def puntos_de(geometria):
    """Aplana cualquier geometría GeoJSON a una lista de [lon, lat]."""
    tipo = geometria.get("type")
    coords = geometria.get("coordinates")
    if tipo == "Point":
        return [coords]
    if tipo == "LineString":
        return coords
    if tipo in ("MultiLineString", "Polygon"):
        return [p for parte in coords for p in parte]
    if tipo == "MultiPolygon":
        return [p for poli in coords for anillo in poli for p in anillo]
    return []


def plausible(x, y):
    """Descarta coordenadas imposibles: invertidas, en cero, fuera del país."""
    return -74 < x < -53 and -56 < y < -21


# --------------------------------------------------------------------------

def main():
    if "--actualizar-limite" in sys.argv:
        return actualizar_limite()

    if not LIMITE.exists():
        print(f"[FALLA] Falta {LIMITE}.")
        print("        Generalo con: python verificar_caba.py --actualizar-limite")
        return 1

    with open(LIMITE, encoding="utf-8") as f:
        anillos = [[(x, y) for x, y in a] for a in json.load(f)["anillos"]]
    with open(DATA_DIR / "geo_cache.json", encoding="utf-8") as f:
        cache = json.load(f)

    problemas = 0
    fallas, avisos, absurdas = [], [], []

    for clave, entrada in sorted(cache.items()):
        geometria = entrada.get("geometry")
        if not geometria:
            continue
        puntos = puntos_de(geometria)
        if not puntos:
            continue

        raras = [p for p in puntos if not plausible(p[0], p[1])]
        if raras:
            absurdas.append((clave, len(raras), raras[0]))
            continue

        tipo = clave.split("|")[-1] if "|" in clave else ""
        if clave in EXCEPCIONES or tipo in TIPOS_EXENTOS:
            continue

        fuera = [p for p in puntos if not en_caba(p[0], p[1], anillos)]
        if not fuera:
            continue
        proporcion = len(fuera) / len(puntos)
        registro = (clave, len(fuera), len(puntos), proporcion, fuera[0])
        (fallas if proporcion >= UMBRAL_FALLA else avisos).append(registro)

    # ---- coordenadas imposibles ----
    if absurdas:
        problemas += len(absurdas)
        print(f"[FALLA] {len(absurdas)} entrada(s) con coordenadas imposibles:")
        for clave, n, ejemplo in absurdas:
            print(f"    - {clave}: {n} punto(s), ej. {ejemplo}")
    else:
        print("[OK] Sin coordenadas imposibles.")

    # ---- fuera de CABA ----
    if fallas:
        problemas += len(fallas)
        print(f"[FALLA] {len(fallas)} entrada(s) mayormente fuera de CABA "
              f"(probable calle homónima de otro partido):")
        for clave, nf, nt, prop, ejemplo in sorted(fallas, key=lambda r: -r[3]):
            print(f"    - {clave}: {prop:.0%} fuera ({nf}/{nt}), ej. {ejemplo}")
    else:
        print(f"[OK] Ninguna entrada supera el {UMBRAL_FALLA:.0%} de nodos fuera de CABA.")

    if avisos:
        print(f"\n[AVISO] {len(avisos)} entrada(s) rozan el límite. Es esperable en "
              f"barrios ribereños y calles que corren sobre el borde:")
        for clave, nf, nt, prop, _ in sorted(avisos, key=lambda r: -r[3])[:15]:
            print(f"    - {clave}: {prop:.0%} fuera ({nf}/{nt})")
        if len(avisos) > 15:
            print(f"    ... y {len(avisos) - 15} más")

    print()
    print(f"Total: {len(cache)} geometrías chequeadas contra "
          f"{len(anillos)} anillo(s) del límite de CABA.")
    if problemas:
        print(f"\n{problemas} problema(s) encontrados.")
        return 1
    print("\nTodo dentro de CABA.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
