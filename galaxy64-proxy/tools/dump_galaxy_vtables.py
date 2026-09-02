#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dump_galaxy_vtables.py — Cartographie les vtables d'un Galaxy64.dll

Repond a la seule question qui compte quand un jeu ne declenche rien :
« dans CE binaire, a quel index se trouve SetAchievement ? »

Le DLL de GOG est compile avec ses traces : chaque methode de facade
reference une chaine qui porte son nom ("SetAchievement: name=%s"). L'outil
retrouve les vtables par RTTI, puis nomme chaque slot d'apres la chaine que
sa fonction reference. Aucune supposition, tout est lu dans le fichier.

C'est exactement l'algorithme applique a l'execution par
src/interface_resolver.cpp. Cet outil sert a le verifier hors ligne, et a
epingler un index dans galaxy_proxy.ini quand le scan echoue.

Usage :
    python dump_galaxy_vtables.py Galaxy64_o.dll
    python dump_galaxy_vtables.py Galaxy64_o.dll --classe StatsFacade

Aucune dependance externe : stdlib seule.
"""

import argparse
import re
import struct
import sys
from bisect import bisect_right

# ============================================================================
# Lecture du PE
# ============================================================================


class Pe:
    """Vue minimale d'un PE64 : sections, .pdata, adressage par RVA."""

    def __init__(self, path):
        with open(path, "rb") as f:
            self.raw = f.read()

        if self.raw[:2] != b"MZ":
            raise ValueError("ce fichier n'est pas un executable Windows")

        e_lfanew = struct.unpack_from("<I", self.raw, 0x3C)[0]
        if self.raw[e_lfanew:e_lfanew + 4] != b"PE\0\0":
            raise ValueError("signature PE absente")

        num_sections = struct.unpack_from("<H", self.raw, e_lfanew + 6)[0]
        opt_size = struct.unpack_from("<H", self.raw, e_lfanew + 20)[0]
        opt = e_lfanew + 24

        magic = struct.unpack_from("<H", self.raw, opt)[0]
        if magic != 0x20B:
            raise ValueError("seul le format PE32+ (x64) est gere")

        self.image_base = struct.unpack_from("<Q", self.raw, opt + 24)[0]
        self.size_of_image = struct.unpack_from("<I", self.raw, opt + 56)[0]

        # DataDirectory[3] = table des fonctions (.pdata)
        exc_rva, exc_size = struct.unpack_from("<II", self.raw, opt + 112 + 3 * 8)

        self.sections = []
        sec = opt + opt_size
        for _ in range(num_sections):
            name = self.raw[sec:sec + 8].rstrip(b"\0").decode("ascii", "replace")
            vsize, vaddr, rsize, rptr = struct.unpack_from("<IIII", self.raw, sec + 8)
            chars = struct.unpack_from("<I", self.raw, sec + 36)[0]
            self.sections.append(
                dict(name=name, vaddr=vaddr, vsize=vsize,
                     data=self.raw[rptr:rptr + rsize], exec=bool(chars & 0x20000000))
            )
            sec += 40

        self.funcs = []
        if exc_rva:
            pdata = self.read(exc_rva, exc_size)
            for off in range(0, (len(pdata) // 12) * 12, 12):
                begin, end, _unwind = struct.unpack_from("<III", pdata, off)
                if begin or end:
                    self.funcs.append((begin, end))
            self.funcs.sort()
        self._starts = [f[0] for f in self.funcs]

        self.version = self._read_version()

    # -- adressage --

    def section_of(self, rva):
        for s in self.sections:
            if s["vaddr"] <= rva < s["vaddr"] + s["vsize"]:
                return s
        return None

    def read(self, rva, n):
        s = self.section_of(rva)
        if not s:
            return b""
        off = rva - s["vaddr"]
        return s["data"][off:off + n]

    def u64(self, rva):
        b = self.read(rva, 8)
        return struct.unpack("<Q", b)[0] if len(b) == 8 else None

    def is_exec(self, rva):
        s = self.section_of(rva)
        return bool(s and s["exec"])

    def func_bounds(self, rva):
        i = bisect_right(self._starts, rva) - 1
        if i >= 0 and self.funcs[i][0] <= rva < self.funcs[i][1]:
            return self.funcs[i]
        return None

    def _read_version(self):
        # La ressource VERSIONINFO contient "FileVersion" en UTF-16.
        m = re.search(b"F\0i\0l\0e\0V\0e\0r\0s\0i\0o\0n\0\0\0", self.raw)
        if not m:
            return "?"
        tail = self.raw[m.end():m.end() + 80]
        text = tail.decode("utf-16-le", "ignore")
        m2 = re.search(r"\d+\.\d+\.\d+\.\d+", text)
        return m2.group(0) if m2 else "?"


# ============================================================================
# Deroulement des thunks et references de chaines
# ============================================================================
# Meme logique que src/pattern_scanner.cpp : Galaxy64.dll est lie en
# incrementiel, donc chaque entree de vtable pointe vers un `jmp` de 5 octets.


def resolve_thunk(pe, rva, hops=4):
    for _ in range(hops):
        code = pe.read(rva, 5)
        if len(code) == 5 and code[0] == 0xE9:
            target = rva + 5 + struct.unpack_from("<i", code, 1)[0]
            if not pe.is_exec(target):
                return rva
            rva = target
            continue
        return rva
    return rva


def referenced_strings(pe, rva, limit=0x4000):
    """Chaines ASCII referencees en RIP-relatif par la fonction."""
    rva = resolve_thunk(pe, rva)
    bounds = pe.func_bounds(rva)
    if not bounds:
        return []

    begin, end = bounds
    body = pe.read(begin, min(end - begin, limit))
    out = []

    for i in range(3, len(body) - 4):
        # lea/mov r64, [rip+disp32] : REX, opcode, modrm(mod=00 rm=101)
        if not (0x40 <= body[i - 3] <= 0x4F):
            continue
        if body[i - 2] not in (0x8D, 0x8B):
            continue
        if (body[i - 1] & 0xC7) != 0x05:
            continue

        disp = struct.unpack_from("<i", body, i)[0]
        target = begin + i + 4 + disp
        s = pe.section_of(target)
        if not s or s["name"] != ".rdata":
            continue

        raw = pe.read(target, 200)
        z = raw.find(b"\0")
        if z < 6:
            continue
        try:
            text = raw[:z].decode("ascii")
        except UnicodeDecodeError:
            continue
        if not all(0x20 <= ord(c) < 0x7F for c in text):
            continue
        if text not in out:
            out.append(text)

    return out


# ============================================================================
# RTTI : retrouver les vtables et leurs classes
# ============================================================================


def find_vtables(pe):
    """{rva de vtable: nom de classe demangle a la MSVC}"""
    type_descriptors = {}
    for s in pe.sections:
        if s["name"] not in (".rdata", ".data"):
            continue
        for m in re.finditer(rb"\.\?A[VU][A-Za-z0-9_@?$]{1,300}\x00", s["data"]):
            # Un TypeDescriptor x64 commence 16 octets avant son nom.
            type_descriptors[s["vaddr"] + m.start() - 16] = m.group(0)[:-1].decode()

    # RTTICompleteObjectLocator : signature=1, ..., pTypeDescriptor, ..., pSelf
    locators = {}
    for s in pe.sections:
        if s["name"] != ".rdata":
            continue
        data = s["data"]
        for off in range(0, len(data) - 24, 4):
            if struct.unpack_from("<I", data, off)[0] != 1:
                continue
            td = struct.unpack_from("<I", data, off + 12)[0]
            if struct.unpack_from("<I", data, off + 20)[0] != s["vaddr"] + off:
                continue  # pSelf doit pointer sur le locator lui-meme
            if td in type_descriptors:
                locators[s["vaddr"] + off] = type_descriptors[td]

    # La vtable commence juste apres le pointeur vers son locator.
    vtables = {}
    rdata = next(s for s in pe.sections if s["name"] == ".rdata")
    by_addr = {pe.image_base + rva: rva for rva in locators}
    for off in range(0, len(rdata["data"]) - 8, 8):
        q = struct.unpack_from("<Q", rdata["data"], off)[0]
        if q in by_addr:
            vtables[rdata["vaddr"] + off + 8] = locators[by_addr[q]]
    return vtables


def vtable_length(pe, vt_rva, maximum=128):
    n = 0
    while n < maximum:
        v = pe.u64(vt_rva + n * 8)
        if v is None or not pe.is_exec(v - pe.image_base):
            break
        n += 1
    return n


# ============================================================================
# Sortie
# ============================================================================

# Ce qui, dans une chaine, ressemble a un nom de methode.
METHOD_RE = re.compile(r"^([A-Za-z][A-Za-z0-9]{3,45}):")


def dump(pe, vt_rva, klass):
    n = vtable_length(pe, vt_rva)
    print(f"\n=== {klass}")
    print(f"    vtable RVA 0x{vt_rva:x} — {n} slots")

    for i in range(n):
        slot = pe.u64(vt_rva + i * 8) - pe.image_base
        body = resolve_thunk(pe, slot)
        names = [m.group(1) for m in
                 (METHOD_RE.match(s) for s in referenced_strings(pe, body)) if m]
        seen = []
        for x in names:
            if x not in seen:
                seen.append(x)
        label = seen[0] if seen else "?"
        extra = "" if len(seen) <= 1 else f"   (aussi : {', '.join(seen[1:3])})"
        print(f"    [{i:3}] +0x{body:<8x} {label}{extra}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dll", help="chemin vers Galaxy64.dll ou Galaxy64_o.dll")
    ap.add_argument("--classe", default=None,
                    help="ne montrer que les classes dont le nom contient ceci "
                         "(defaut : StatsFacade et les facades User)")
    args = ap.parse_args()

    try:
        pe = Pe(args.dll)
    except (OSError, ValueError) as e:
        print(f"erreur : {e}", file=sys.stderr)
        return 2

    print(f"{args.dll}")
    print(f"  version du SDK : {pe.version}")
    print(f"  base d'image   : 0x{pe.image_base:x}")
    print(f"  fonctions .pdata : {len(pe.funcs)}")

    vtables = find_vtables(pe)
    if args.classe:
        wanted = {vt: k for vt, k in vtables.items() if args.classe in k}
    else:
        wanted = {vt: k for vt, k in vtables.items()
                  if "StatsFacade@facade" in k or "UserFacade@facade" in k}

    if not wanted:
        print("\nAucune vtable correspondante. Essaie --classe Facade pour "
              "lister plus large.", file=sys.stderr)
        return 1

    for vt, klass in sorted(wanted.items()):
        dump(pe, vt, klass)

    print("\nPour epingler un index dans galaxy_proxy.ini :")
    print("  [stats]")
    print("  set_achievement_index=<le slot SetAchievement ci-dessus>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
