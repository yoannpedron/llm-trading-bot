#!/usr/bin/env bash
# ============================================================================
# run_tests.sh — Verifie le resolveur contre une vraie Galaxy64.dll
#
# Compile src/pattern_scanner.cpp et src/interface_resolver.cpp tels quels,
# avec les doublures de stubs/, et les fait tourner sur la DLL fournie.
#
#   ./run_tests.sh /chemin/vers/Galaxy64_o.dll [-v]
#
# La DLL n'est pas versionnee ici : prends celle d'un de tes jeux GOG.
# ============================================================================
set -u

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../src"
out="$here/test_resolver"

if [ $# -lt 1 ]; then
    echo "usage: $0 <Galaxy64_o.dll> [-v]" >&2
    exit 2
fi

echo "== Verification syntaxique de toutes les sources =="
fail=0
for f in "$src"/*.cpp; do
    if ! g++ -std=c++17 -fsyntax-only -Wall -Wextra -Wno-unused-parameter \
             -Wno-format -I"$here/stubs" -I"$src" "$f"; then
        echo "  ECHEC : $(basename "$f")" >&2
        fail=1
    fi
done
[ $fail -eq 0 ] && echo "  toutes les sources compilent"
[ $fail -ne 0 ] && exit 1

echo
echo "== Resolution sur une vraie DLL =="
g++ -std=c++17 -g -O1 -Wall -Wextra -Wno-unused-parameter -Wno-format \
    -I"$here/stubs" -I"$src" \
    "$here/test_resolver.cpp" "$src/pattern_scanner.cpp" "$src/interface_resolver.cpp" \
    -o "$out" || exit 1

"$out" "$@"
