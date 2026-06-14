"""
generar_curiosidades.py — Genera data/curiosidades.json a partir del listado
curado del documento Markdown, validando que cada entrada exista en calles.json.

Estructura del JSON de salida:
{
  "secciones": [
    {
      "id": "apodos",
      "titulo": "Nombres nacidos de apodos y seudónimos",
      "descripcion": "...",
      "items": [
        {
          "id": "azucena maizani|calle",
          "nombre": "Azucena Maizani",
          "identidad": "La Ñata Gaucha",
          "curiosidad": "..."
        }
      ]
    }
  ]
}

Uso:
    python generar_curiosidades.py
"""

import json
import re
import unicodedata
from pathlib import Path


BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
OUTPUT = BASE / "data" / "curiosidades.json"


def clave(texto):
    if not isinstance(texto, str):
        return ""
    s = unicodedata.normalize("NFKD", texto)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


# Cargar calles para validar y obtener IDs
with CALLES_JSON.open(encoding="utf-8") as f:
    calles = json.load(f)

# Indices auxiliares
por_clave = {}
for c in calles:
    por_clave.setdefault(c["clave"], []).append(c)


def buscar(clave_buscada, tipo_pref=None):
    """Busca en calles.json. Si hay varios con misma clave, preferir el tipo dado."""
    encontrados = por_clave.get(clave_buscada, [])
    if not encontrados:
        return None
    if tipo_pref:
        tipo_norm = tipo_pref.lower().strip()
        for e in encontrados:
            if e["tipo"] == tipo_norm:
                return e
    return encontrados[0]


# =========================================================================
# Datos curados del documento
# =========================================================================

SECCIONES = [
    {
        "id": "apodos",
        "titulo": "Nombres bajo apodo o seudónimo",
        "descripcion": "Calles dedicadas a personalidades bajo sus nombres artísticos.",
        "items": [
            {
                "clave": "azucena maizani", "tipo": "calle",
                "identidad": "La Ñata Gaucha",
                "curiosidad": "Célebre cantautora de tangos. Hacía sus presentaciones vestida con trajes masculinos o atuendos de gaucho, ganándose ese apodo popular.",
            },
            {
                "clave": "roberto sanchez", "tipo": "calle",
                "identidad": "Sandro de América",
                "curiosidad": "Icónico cantautor y pionero del rock en español. No figura en el callejero como “Sandro”, sino bajo su nombre real de nacimiento.",
            },
            {
                "clave": "almafuerte", "tipo": "avenida",
                "identidad": "Pedro Bonifacio Palacios",
                "curiosidad": "No es un apellido real: es el seudónimo literario del poeta y escritor argentino.",
            },
            {
                "clave": "gabriela mistral", "tipo": "calle",
                "identidad": "Lucila Godoy Alcayaga",
                "curiosidad": "Homenajeada bajo el seudónimo con el que ganó el Premio Nobel de Literatura en 1945.",
            },
            {
                "clave": "pola", "tipo": "calle",
                "identidad": "Policarpa Salavarrieta",
                "curiosidad": "El nombre minimalista corresponde al sobrenombre de la heroína y patriota colombiana fusilada en Bogotá.",
            },
        ],
    },
    {
        "id": "mujeres-pioneras",
        "titulo": "Pioneras y mujeres con historia",
        "descripcion": "Hitos del trazado urbano dedicados a mujeres pioneras en distintos campos.",
        "items": [
            {
                "clave": "ana diaz", "tipo": "calle",
                "identidad": "Primera propietaria",
                "curiosidad": "Primera mujer propietaria de un solar en Buenos Aires (1580). Su lote estaba en la esquina sudoeste de las actuales Florida y Corrientes.",
            },
            {
                "clave": "amalia celia figueredo", "tipo": "calle",
                "identidad": "Primera aviadora",
                "curiosidad": "Primera mujer aviadora de Argentina y Latinoamérica. Obtuvo su licencia de piloto en 1895.",
            },
            {
                "clave": "paquita bernardo", "tipo": "calle",
                "identidad": "Primera bandoneonista",
                "curiosidad": "Primera mujer bandoneonista destacada profesionalmente, en una época en que el instrumento era casi exclusivo de hombres.",
            },
            {
                "clave": "virginia bolten", "tipo": "calle",
                "identidad": "Primera oradora obrera",
                "curiosidad": "Primera oradora mujer en una concentración obrera en Argentina (1890). Militante anarquista y feminista. Lideró la primera publicación feminista del país, La Voz de la Mujer.",
            },
        ],
    },
    {
        "id": "literatura",
        "titulo": "Calles literarias",
        "descripcion": "Arterias que no homenajean a una persona ni a un lugar real, sino a obras de ficción.",
        "items": [
            {
                "clave": "adan buenosayres", "tipo": "puente",
                "identidad": "Novela de Marechal",
                "curiosidad": "Lleva el nombre de la famosa novela vanguardista del escritor argentino Leopoldo Marechal.",
            },
            {
                "clave": "amalia", "tipo": "calle",
                "identidad": "Novela de José Mármol",
                "curiosidad": "Inspirada directamente en Amalia, la célebre novela de José Mármol publicada en 1851.",
            },
            {
                "clave": "el alma que canta", "tipo": "plazoleta",
                "identidad": "Revista de tangos",
                "curiosidad": "Nombrada en honor a la mítica revista de música popular fundada en 1916 por Vicente Buchieri, cuna de las letras de tango de la época.",
            },
        ],
    },
    {
        "id": "cronologicos",
        "titulo": "Extremos del callejero",
        "descripcion": "Las vidas más largas y las más cortas que el callejero conmemora.",
        "items": [
            {
                "clave": "alicia moreau de justo", "tipo": "avenida",
                "identidad": "Más longeva: 101 años (1885-1986)",
                "curiosidad": "Pionera de la medicina y los derechos cívicos femeninos. Cruzó tres siglos de historia argentina.",
            },
            {
                "clave": "doctor esteban laureano maradona", "tipo": "calle",
                "identidad": "Centenaria: 100 años (1895-1995)",
                "curiosidad": "Conocido como el “médico de los pobres”, dedicado a la medicina comunitaria y rural.",
            },
            {
                "clave": "paseo marcela brenda iglesias", "tipo": "paseo",
                "identidad": "La más joven: 6 años (1990-1996)",
                "curiosidad": "Niña fallecida tras la caída de una escultura en el Paseo de la Infanta. Su historia redefinió los controles de seguridad en CABA.",
            },
            {
                "clave": "candela sol rodriguez", "tipo": "calle",
                "identidad": "11 años (1999-2011)",
                "curiosidad": "Homenaje a la niña cuyo caso causó conmoción nacional en 2011.",
            },
        ],
    },
    {
        "id": "presidentes",
        "titulo": "Presidentes de la Nación en el callejero",
        "descripcion": "Eje cronológico de mandatarios con calles asignadas en CABA.",
        "items": [
            {"clave": "rivadavia",           "tipo": "avenida", "identidad": "1826-1827", "curiosidad": "Bernardino Rivadavia, primer presidente."},
            {"clave": "general urquiza",     "tipo": "calle",   "identidad": "1854-1860", "curiosidad": "Justo José de Urquiza, primer presidente de la Confederación."},
            {"clave": "pedernera",           "tipo": "calle",   "identidad": "1860",      "curiosidad": "Juan Esteban Pedernera, presidente interino."},
            {"clave": "derqui",              "tipo": "avenida", "identidad": "1860-1861", "curiosidad": "Santiago Derqui, mandatario constitucional de la Confederación."},
            {"clave": "bartolome mitre",     "tipo": "calle",   "identidad": "1862-1868", "curiosidad": "Primer presidente de la nación unificada."},
            {"clave": "sarmiento",           "tipo": "calle",   "identidad": "1868-1874", "curiosidad": "Domingo Faustino Sarmiento, impulsor de la educación pública."},
            {"clave": "presidente nicolas avellaneda", "tipo": "parque", "identidad": "1874-1880", "curiosidad": "Presidente entre 1874 y 1880."},
            {"clave": "presidente julio a roca", "tipo": "avenida", "identidad": "1880-1886 / 1898-1904", "curiosidad": "Presidente en dos períodos. Sobre la Diagonal Sur."},
            {"clave": "carlos pellegrini",   "tipo": "calle",   "identidad": "1890-1892", "curiosidad": "Asumió tras la renuncia de Juárez Celman."},
            {"clave": "presidente luis saenz pena", "tipo": "calle", "identidad": "1892-1895", "curiosidad": "Ejerció la presidencia entre 1892 y 1895."},
            {"clave": "presidente jose evaristo uriburu", "tipo": "calle", "identidad": "1895-1898", "curiosidad": "Mandatario entre 1895 y 1898."},
            {"clave": "presidente quintana", "tipo": "avenida", "identidad": "1904-1906", "curiosidad": "Falleció en el ejercicio del cargo."},
            {"clave": "presidente figueroa alcorta", "tipo": "avenida", "identidad": "1906-1910", "curiosidad": "Completó el mandato tras la muerte de Quintana."},
            {"clave": "diagonal norte presidente roque saenz pena", "tipo": "avenida", "identidad": "1910-1914", "curiosidad": "Autor de la ley de voto universal, secreto y obligatorio. Sobre la Diagonal Norte."},
            {"clave": "doctor victorino de la plaza", "tipo": "calle", "identidad": "1914-1916", "curiosidad": "Sucedió a Roque Sáenz Peña."},
            {"clave": "hipolito yrigoyen",   "tipo": "calle",   "identidad": "1916-1922 / 1928-1930", "curiosidad": "Primer presidente electo por voto secreto y obligatorio."},
            {"clave": "marcelo t de alvear", "tipo": "calle",   "identidad": "1922-1928", "curiosidad": "Presidente de la Nación entre 1922 y 1928."},
            {"clave": "general agustin p justo", "tipo": "espacio verde", "identidad": "1932-1938", "curiosidad": "Mandatario en el período 1932-1938."},
            {"clave": "presidente roberto m ortiz", "tipo": "calle", "identidad": "1938-1940", "curiosidad": "Ejerció entre 1938 y 1940. Renunció por enfermedad."},
            {"clave": "presidente ramon s castillo", "tipo": "avenida", "identidad": "1940-1943", "curiosidad": "Completó el mandato de Ortiz."},
            {"clave": "teniente general juan domingo peron", "tipo": "calle", "identidad": "1946-1955 / 1973-1974", "curiosidad": "Tres veces presidente constitucional."},
            {"clave": "arturo frondizi",     "tipo": "autopista", "identidad": "1958-1962", "curiosidad": "Mandatario constitucional desarrollista."},
            {"clave": "presidente doctor arturo umberto illia", "tipo": "autopista", "identidad": "1963-1966", "curiosidad": "Presidente constitucional."},
            {"clave": "presidente hector j campora", "tipo": "autopista", "identidad": "1973", "curiosidad": "Breve presidencia constitucional en 1973."},
            {"clave": "paseo del bajo raul alfonsin", "tipo": "autopista", "identidad": "1983-1989", "curiosidad": "Primer presidente del retorno definitivo de la democracia."},
        ],
    },
]


# =========================================================================
# Validación y armado final
# =========================================================================

salida = {"secciones": []}
no_encontrados = []
encontrados = 0
total = 0

for seccion in SECCIONES:
    items_validados = []
    for item in seccion["items"]:
        total += 1
        ent = buscar(item["clave"], item.get("tipo"))
        if not ent:
            no_encontrados.append((seccion["id"], item["clave"], item.get("tipo", "")))
            continue
        items_validados.append({
            "id": ent["id"],
            "nombre": ent["nombre_busqueda"],
            "tipo": ent["tipo"],
            "identidad": item["identidad"],
            "curiosidad": item["curiosidad"],
        })
        encontrados += 1
    salida["secciones"].append({
        "id": seccion["id"],
        "titulo": seccion["titulo"],
        "descripcion": seccion["descripcion"],
        "items": items_validados,
    })

with OUTPUT.open("w", encoding="utf-8") as f:
    json.dump(salida, f, ensure_ascii=False, indent=2)

print(f"Guardado: {OUTPUT}")
print(f"Items validados: {encontrados}/{total}")
if no_encontrados:
    print(f"\nNO ENCONTRADOS ({len(no_encontrados)}):")
    for s, k, t in no_encontrados:
        print(f"  [{s:15s}] clave={k!r}  tipo={t!r}")
        # Sugerir similares
        partes = k.split()
        if partes:
            ultimo = partes[-1]
            sims = [c['clave'] for c in calles if ultimo in c['clave']][:5]
            if sims:
                print(f"    sugerencias: {sims}")
