#!/bin/bash
# Lee rutas (una por línea) y falla si alguna NO puede ir al repo PÚBLICO (rt-web, GPL-3):
# bins de GM, definiciones/desensambles de terceros sin licencia, logs del camión y las
# carpetas de datos que van solo al espejo privado (ver tools/sync-privado.sh).
# Lo usan tools/hooks/pre-commit y tools/hooks/pre-push.

# Únicas excepciones: los ejemplos inventados del propio proyecto.
PERMITIDOS='^(defs/example\.xdf|defs/example_calibration\.bin)$'
PROHIBIDOS='^(calibracion|pruebas|logs|disenos|\.git-privado)/|rtweb-log-[^/]*\.csv$|\.(bin|src|ads|xdf|zip|csv)$'

malos=$(grep -v -E "$PERMITIDOS" | grep -i -E "$PROHIBIDOS" | sort -u)
if [ -n "$malos" ]; then
  echo "BLOQUEADO: estos archivos no pueden ir al repo público rt-web:" >&2
  echo "$malos" | sed 's/^/  - /' >&2
  echo "Van al espejo privado (rama datos) con tools/sync-privado.sh." >&2
  echo "Si de verdad es un archivo propio del proyecto, agrégalo a PERMITIDOS en tools/check-publico.sh." >&2
  exit 1
fi
