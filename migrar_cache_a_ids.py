"""
migrar_cache_a_ids.py — Cambia las claves del geo_cache.json de `clave` a `id`
(formato `clave|tipo`).

Para cada entrada del cache vieja:
  1. Busca en calles.json todas las entradas con esa clave.
  2. Si hay UNA, migración directa.
  3. Si hay VARIAS, asigna según el tipo cacheado:
       - line → primera entrada con tipo línea (calle, avenida, etc.)
       - area → primera entrada tipo barrio
       - point → primera entrada tipo área (plaza, plazoleta, parque...)

Las entradas con clave que NO existen en el nuevo calles.json se descartan
(ej. la Avenida Vélez Sársfield que agregué a mano se vuelve a perder y se
re-agregará después como entrada extra).

Uso:
    python migrar_cache_a_ids.py
"""

import json
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"

TIPOS_LINEA = {
    "calle", "avenida", "pasaje peatonal", "pasaje", "autopista",
    "sendero", "paseo", "puente", "túnel", "tunel",
    "sendero peatonal", "puente peatonal",
}
TIPOS_AREA = {
    "plaza", "plazoleta", "parque", "jardín", "jardin", "jardín botánico",
    "espacio verde", "espacio público", "espacio publico",
    "cantero central", "canteros centrales", "cantero",
    "patio de recreación", "patio",
}
TIPOS_BARRIO = {"barrio"}


def main():
    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache_viejo = json.load(f)

    # Índice clave -> [entradas]
    por_clave = defaultdict(list)
    for c in calles:
        por_clave[c["clave"]].append(c)

    nuevo = {}
    sin_match = []
    ambiguos_resueltos = 0
    directos = 0

    for clave_vieja, entry in cache_viejo.items():
        # Si la key vieja ya es un id (tiene "|"), copiar tal cual
        if "|" in clave_vieja:
            nuevo[clave_vieja] = entry
            continue

        candidatos = por_clave.get(clave_vieja, [])
        if not candidatos:
            sin_match.append(clave_vieja)
            continue

        if len(candidatos) == 1:
            nuevo[candidatos[0]["id"]] = entry
            directos += 1
            continue

        # Resolver ambiguo según tipo del cache
        cache_tipo = entry.get("tipo")  # "line", "area", "point"
        elegido = None

        if cache_tipo == "line":
            elegido = next((c for c in candidatos if c["tipo"] in TIPOS_LINEA), None)
        elif cache_tipo == "area":
            elegido = next((c for c in candidatos if c["tipo"] in TIPOS_BARRIO), None)
        elif cache_tipo == "point":
            elegido = next((c for c in candidatos if c["tipo"] in TIPOS_AREA), None)
            if not elegido:
                elegido = next((c for c in candidatos if c["tipo"] in TIPOS_BARRIO), None)

        if not elegido:
            # Fallback: tomar el primero
            elegido = candidatos[0]

        nuevo[elegido["id"]] = entry
        ambiguos_resueltos += 1

    # Guardar
    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(nuevo, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)

    print(f"Migración completada:")
    print(f"  Entradas en cache viejo: {len(cache_viejo)}")
    print(f"  Migradas directas (clave única): {directos}")
    print(f"  Migradas con resolución de ambigüedad: {ambiguos_resueltos}")
    print(f"  Entradas en cache nuevo: {len(nuevo)}")
    if sin_match:
        print(f"  Sin match en calles.json (descartadas): {len(sin_match)}")
        for k in sin_match[:5]:
            print(f"    - {k}")


if __name__ == "__main__":
    main()
