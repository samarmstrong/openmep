#!/usr/bin/env bash
# Download the public ARCH + MEP IFC pairs used for real-fixture tests and evals
# and verify their checksums. Files are mirrored by the ifc-bench dataset
# (CC BY 4.0) from buildingSMART's Community Sample Test Files. Usage:
#   fixtures/fetch-public-ifc.sh [duplex|wbdg_office|dental_clinic ...]
set -euo pipefail

BASE="https://huggingface.co/datasets/sylvainHellin/ifc-bench/resolve/main/projects"
DEST="${IFC_FIXTURE_DIR:-$(cd "$(dirname "$0")" && pwd)/public}"

# sha256  relative-path
MANIFEST="
707a032566dee8e969a44d95509be46d646440e2443624709f8d3ae2b45f4656 duplex/arc.ifc
285f85de4424416ba6bade121588dbe0ae278fb4fdb0f4b782051cfdc7c92972 duplex/mep.ifc
7108485ac8d2856922a83f1353aea8c6eaab60ff393546750bf648200617a544 wbdg_office/arc.ifc
835263f1a9f84663e19b2d1a73420a09919293d7932a3a514d1fa26ede3dcc1e wbdg_office/mep.ifc
b90fe57b8aa9329d762a564770e697d4f7357677484e3a78ede4ab6d2163c0c0 dental_clinic/arc.ifc
72bdbfeb104d044bcd1ae644f9a5c6e72fd7750c2fd15fe98de2c53a04850e8d dental_clinic/mep.ifc
"

projects=("$@")
if [ ${#projects[@]} -eq 0 ]; then
  projects=(duplex wbdg_office)
fi

while read -r sha rel; do
  [ -z "$rel" ] && continue
  project="${rel%%/*}"
  keep=0
  for p in "${projects[@]}"; do [ "$p" = "$project" ] && keep=1; done
  [ $keep -eq 1 ] || continue

  out="$DEST/$rel"
  mkdir -p "$(dirname "$out")"
  if [ ! -f "$out" ]; then
    echo "fetching $rel"
    curl -sSL --fail -o "$out" "$BASE/$rel"
    curl -sSL --fail -o "$(dirname "$out")/license.txt" "$BASE/$project/license.txt" || true
  fi
  actual="$(shasum -a 256 "$out" | cut -d' ' -f1)"
  if [ "$actual" != "$sha" ]; then
    echo "checksum mismatch for $rel: expected $sha got $actual" >&2
    exit 1
  fi
  echo "ok $rel"
done <<< "$MANIFEST"
