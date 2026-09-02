// ============================================================================
// pattern_scanner.cpp — Lecture du binaire charge en memoire
//
// Aucun desassembleur embarque : on ne cherche pas a decoder le flot
// d'instructions, seulement a reconnaitre trois encodages precis
// (lea/mov RIP-relatif, mov imm64, call rel32) a l'interieur de bornes de
// fonction donnees par .pdata. C'est suffisant pour identifier une methode
// par la chaine de journal qu'elle reference, et ca tient en quelques
// centaines de lignes au lieu d'une dependance a Zydis ou Capstone.
// ============================================================================

#include "pattern_scanner.h"
#include "galaxy_proxy.h"

#include <cstring>

namespace proxy {
namespace scan {

namespace {

// Longueur maximale exploree dans une fonction. Les facades de GOG font
// quelques centaines d'octets ; au-dela, on est probablement en train de
// suivre un thunk mal resolu.
constexpr size_t kMaxFunctionScan = 0x4000;

// Longueur maximale d'une chaine de journal consideree.
constexpr size_t kMaxStringLen = 256;

const IMAGE_NT_HEADERS64* NtHeaders(uint8_t* base) {
    const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return nullptr;

    const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return nullptr;
    if (nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return nullptr;
    return nt;
}

} // namespace

// ============================================================================
// ModuleInfo
// ============================================================================

bool GetModuleInfo(HMODULE module, ModuleInfo& out) {
    out = ModuleInfo{};
    if (!module) return false;

    auto* base = reinterpret_cast<uint8_t*>(module);
    const IMAGE_NT_HEADERS64* nt = NtHeaders(base);
    if (!nt) return false;

    out.base = base;
    out.size = nt->OptionalHeader.SizeOfImage;

    const auto* sec = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; ++i, ++sec) {
        uint8_t* start = base + sec->VirtualAddress;
        size_t   len   = sec->Misc.VirtualSize;

        if ((sec->Characteristics & IMAGE_SCN_MEM_EXECUTE) && !out.text) {
            out.text     = start;
            out.textSize = len;
        }
        if (std::memcmp(sec->Name, ".rdata", 6) == 0 && !out.rdata) {
            out.rdata     = start;
            out.rdataSize = len;
        }
    }

    // Table des fonctions x64. Sans elle, impossible de connaitre les bornes
    // d'une fonction sans desassembler : le resolveur par chaines ne
    // fonctionnera pas et on retombera sur les indices de repli.
    const IMAGE_DATA_DIRECTORY& exc =
        nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXCEPTION];
    if (exc.VirtualAddress && exc.Size >= sizeof(RUNTIME_FUNCTION)) {
        out.pdata      = reinterpret_cast<const RUNTIME_FUNCTION*>(base + exc.VirtualAddress);
        out.pdataCount = exc.Size / sizeof(RUNTIME_FUNCTION);
    }

    return out.text != nullptr;
}

bool IsInsideModule(const ModuleInfo& mi, const void* p) {
    const auto* b = static_cast<const uint8_t*>(p);
    return mi.Valid() && b >= mi.base && b < mi.base + mi.size;
}

bool IsExecutable(const ModuleInfo& mi, const void* p) {
    const auto* b = static_cast<const uint8_t*>(p);
    return mi.text && b >= mi.text && b < mi.text + mi.textSize;
}

// ============================================================================
// Fonctions
// ============================================================================

const uint8_t* ResolveThunk(const ModuleInfo& mi, const uint8_t* fn) {
    // Quatre sauts suffisent largement ; au-dela, on suspecte une boucle.
    for (int hop = 0; hop < 4 && fn; ++hop) {
        if (!IsExecutable(mi, fn) || !IsExecutable(mi, fn + 6)) return fn;

        if (fn[0] == 0xE9) {                       // jmp rel32
            int32_t rel;
            std::memcpy(&rel, fn + 1, sizeof(rel));
            const uint8_t* next = fn + 5 + rel;
            if (!IsExecutable(mi, next)) return fn;
            fn = next;
            continue;
        }
        if (fn[0] == 0xEB) {                       // jmp rel8
            const uint8_t* next = fn + 2 + static_cast<int8_t>(fn[1]);
            if (!IsExecutable(mi, next)) return fn;
            fn = next;
            continue;
        }
        return fn;
    }
    return fn;
}

bool FunctionBounds(const ModuleInfo& mi, const uint8_t* fn,
                    const uint8_t** begin, const uint8_t** end) {
    if (!mi.pdata || !mi.pdataCount || !IsInsideModule(mi, fn)) return false;

    const DWORD rva = static_cast<DWORD>(fn - mi.base);

    // .pdata est triee par BeginAddress croissant : recherche dichotomique.
    size_t lo = 0, hi = mi.pdataCount;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        if (mi.pdata[mid].BeginAddress <= rva) lo = mid + 1;
        else                                   hi = mid;
    }
    if (lo == 0) return false;

    const RUNTIME_FUNCTION& rf = mi.pdata[lo - 1];
    if (rva < rf.BeginAddress || rva >= rf.EndAddress) return false;
    if (rf.EndAddress <= rf.BeginAddress) return false;

    if (begin) *begin = mi.base + rf.BeginAddress;
    if (end)   *end   = mi.base + rf.EndAddress;
    return true;
}

// ============================================================================
// Chaines
// ============================================================================

size_t FindStringsWithPrefix(const ModuleInfo& mi, const char* prefix,
                             const uint8_t** out, size_t maxOut) {
    if (!mi.rdata || !prefix || !*prefix || !out || !maxOut) return 0;

    const size_t prefixLen = std::strlen(prefix);
    if (prefixLen >= mi.rdataSize) return 0;

    size_t found = 0;
    const uint8_t* start = mi.rdata;
    const uint8_t* limit = mi.rdata + mi.rdataSize - prefixLen;

    for (const uint8_t* p = start; p < limit; ++p) {
        if (*p != static_cast<uint8_t>(prefix[0])) continue;
        if (std::memcmp(p, prefix, prefixLen) != 0) continue;

        // La correspondance doit debuter une chaine, sinon "GetAchievement:"
        // ferait aussi correspondre la fin de "...GetAchievement:".
        if (p != start && p[-1] != '\0') continue;

        // ...et se terminer par un nul a distance raisonnable.
        const uint8_t* q = p + prefixLen;
        const uint8_t* qEnd = p + kMaxStringLen;
        if (qEnd > mi.rdata + mi.rdataSize) qEnd = mi.rdata + mi.rdataSize;
        while (q < qEnd && *q != '\0') ++q;
        if (q >= qEnd) continue;

        out[found++] = p;
        if (found == maxOut) break;
    }

    return found;
}

// ============================================================================
// References
// ============================================================================

namespace {

// Une reference RIP-relative se termine par un deplacement de 4 octets ;
// l'adresse visee est celle de l'instruction SUIVANTE plus ce deplacement.
// On teste chaque position, puis on verifie l'encodage en amont pour
// eliminer les coincidences.
bool LooksLikeRipRelative(const uint8_t* fnBegin, const uint8_t* at) {
    if (at - fnBegin < 3) return false;
    const uint8_t rex    = at[-3];
    const uint8_t opcode = at[-2];
    const uint8_t modrm  = at[-1];

    if (rex < 0x40 || rex > 0x4F) return false;          // prefixe REX
    if (opcode != 0x8D && opcode != 0x8B) return false;  // lea / mov
    return (modrm & 0xC7) == 0x05;                       // mod=00, r/m=101 (RIP)
}

// `mov r64, imm64` : REX.W + B8+r, puis 8 octets d'adresse absolue.
bool LooksLikeMovImm64(const uint8_t* fnBegin, const uint8_t* at) {
    if (at - fnBegin < 2) return false;
    const uint8_t rex    = at[-2];
    const uint8_t opcode = at[-1];
    if (rex < 0x48 || rex > 0x4F) return false;
    return opcode >= 0xB8 && opcode <= 0xBF;
}

struct Visited {
    static constexpr size_t kMax = 48;
    const uint8_t* items[kMax];
    size_t count = 0;

    bool AddIfNew(const uint8_t* p) {
        for (size_t i = 0; i < count; ++i)
            if (items[i] == p) return false;
        if (count < kMax) items[count++] = p;
        return true;
    }
};

bool ReferencesImpl(const ModuleInfo& mi, const uint8_t* fn,
                    const uint8_t* const* targets, size_t count,
                    int depth, Visited& visited) {
    fn = ResolveThunk(mi, fn);

    const uint8_t* begin = nullptr;
    const uint8_t* end   = nullptr;
    if (!FunctionBounds(mi, fn, &begin, &end)) return false;
    if (!visited.AddIfNew(begin)) return false;

    size_t len = static_cast<size_t>(end - begin);
    if (len > kMaxFunctionScan) len = kMaxFunctionScan;
    if (len < 8) return false;

    // Appels directs rencontres, explores seulement si la profondeur le
    // permet et si rien n'a ete trouve dans le corps courant.
    const uint8_t* callees[16];
    size_t calleeCount = 0;

    for (size_t i = 0; i + 4 <= len; ++i) {
        const uint8_t* at = begin + i;

        int32_t disp;
        std::memcpy(&disp, at, sizeof(disp));
        const uint8_t* ripTarget = at + 4 + disp;

        const bool hasQword = (i + 8 <= len);
        uint64_t abs64 = 0;
        if (hasQword) std::memcpy(&abs64, at, sizeof(abs64));

        for (size_t t = 0; t < count; ++t) {
            if (ripTarget == targets[t] && LooksLikeRipRelative(begin, at)) return true;
            if (hasQword && abs64 == reinterpret_cast<uintptr_t>(targets[t]) &&
                LooksLikeMovImm64(begin, at)) return true;
        }

        if (depth > 0 && at[0] == 0xE8 && calleeCount < 16 && i + 5 <= len) {
            int32_t rel;
            std::memcpy(&rel, at + 1, sizeof(rel));
            const uint8_t* callee = at + 5 + rel;
            if (IsExecutable(mi, callee)) callees[calleeCount++] = callee;
        }
    }

    for (size_t c = 0; c < calleeCount; ++c) {
        if (ReferencesImpl(mi, callees[c], targets, count, depth - 1, visited))
            return true;
    }

    return false;
}

} // namespace

bool FunctionReferencesAny(const ModuleInfo& mi, const uint8_t* fn,
                           const uint8_t* const* targets, size_t count,
                           int depth) {
    if (!mi.Valid() || !fn || !targets || !count) return false;
    Visited visited;
    return ReferencesImpl(mi, fn, targets, count, depth, visited);
}

bool FirstReferencedString(const ModuleInfo& mi, const uint8_t* fn,
                           char* out, size_t outSize) {
    if (!out || outSize < 2) return false;
    out[0] = '\0';

    fn = ResolveThunk(mi, fn);

    const uint8_t* begin = nullptr;
    const uint8_t* end   = nullptr;
    if (!FunctionBounds(mi, fn, &begin, &end)) return false;

    size_t len = static_cast<size_t>(end - begin);
    if (len > kMaxFunctionScan) len = kMaxFunctionScan;

    for (size_t i = 0; i + 4 <= len; ++i) {
        const uint8_t* at = begin + i;
        if (!LooksLikeRipRelative(begin, at)) continue;

        int32_t disp;
        std::memcpy(&disp, at, sizeof(disp));
        const uint8_t* target = at + 4 + disp;

        if (!mi.rdata || target < mi.rdata || target >= mi.rdata + mi.rdataSize) continue;

        // Chaine ASCII imprimable d'au moins 6 caracteres : en dessous, le
        // risque de tomber sur des donnees quelconques est trop grand pour
        // que l'information soit utile.
        size_t n = 0;
        while (n < kMaxStringLen && target + n < mi.rdata + mi.rdataSize) {
            const uint8_t c = target[n];
            if (c == '\0') break;
            if (c < 0x20 || c > 0x7E) { n = 0; break; }
            ++n;
        }
        if (n < 6) continue;

        const size_t copy = (n < outSize - 1) ? n : outSize - 1;
        std::memcpy(out, target, copy);
        out[copy] = '\0';
        return true;
    }

    return false;
}

// ============================================================================
// Signatures d'octets
// ============================================================================

const uint8_t* FindPattern(const ModuleInfo& mi, const char* idaPattern) {
    if (!mi.text || !idaPattern) return nullptr;

    uint8_t bytes[128];
    bool    wild[128];
    size_t  n = 0;

    for (const char* p = idaPattern; *p && n < 128; ) {
        while (*p == ' ') ++p;
        if (!*p) break;

        if (*p == '?') {
            wild[n]  = true;
            bytes[n] = 0;
            ++n;
            while (*p == '?') ++p;
            continue;
        }

        auto hex = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        const int hi = hex(p[0]);
        const int lo = hex(p[1]);
        if (hi < 0 || lo < 0) return nullptr;   // signature mal formee

        wild[n]  = false;
        bytes[n] = static_cast<uint8_t>((hi << 4) | lo);
        ++n;
        p += 2;
    }

    if (n == 0 || n > mi.textSize) return nullptr;

    const uint8_t* limit = mi.text + mi.textSize - n;
    for (const uint8_t* p = mi.text; p <= limit; ++p) {
        size_t i = 0;
        for (; i < n; ++i) {
            if (!wild[i] && p[i] != bytes[i]) break;
        }
        if (i == n) return p;
    }
    return nullptr;
}

// ============================================================================
// Vtables
// ============================================================================

size_t VtableLength(const ModuleInfo& mi, void** vtable, size_t maxLen) {
    if (!vtable || !IsInsideModule(mi, vtable)) return 0;

    size_t n = 0;
    for (; n < maxLen; ++n) {
        void** slot = vtable + n;
        if (!IsInsideModule(mi, slot) || !IsInsideModule(mi, slot + 1)) break;
        if (!IsExecutable(mi, *slot)) break;
    }
    return n;
}

const char* RttiClassName(const ModuleInfo& mi, void* object) {
    // L'objet lui-meme vit dans le tas de la vraie DLL, pas dans son image :
    // on ne verifie donc que sa vtable, qui, elle, doit etre dans .rdata.
    if (!object) return nullptr;

    void** vtable = *reinterpret_cast<void***>(object);
    if (!IsInsideModule(mi, vtable) || !IsInsideModule(mi, vtable - 1)) return nullptr;

    // MSVC place un pointeur vers le RTTICompleteObjectLocator juste avant
    // le premier slot de la vtable.
    auto* col = static_cast<const uint32_t*>(vtable[-1]);
    if (!col || !IsInsideModule(mi, col) || !IsInsideModule(mi, col + 6)) return nullptr;
    if (col[0] != 1) return nullptr;               // signature x64

    const uint32_t selfRva = col[5];
    if (mi.base + selfRva != reinterpret_cast<const uint8_t*>(col)) return nullptr;

    const uint32_t tdRva = col[3];
    if (tdRva == 0 || tdRva >= mi.size) return nullptr;

    // TypeDescriptor : { void* pVFTable; void* spare; char name[]; }
    const char* name = reinterpret_cast<const char*>(mi.base + tdRva + 2 * sizeof(void*));
    if (!IsInsideModule(mi, name) || name[0] != '.') return nullptr;
    return name;
}

} // namespace scan
} // namespace proxy
