// ============================================================================
// test_resolver.cpp — Le resolveur reel, confronte a un vrai Galaxy64.dll
//
// Ce test compile src/pattern_scanner.cpp et src/interface_resolver.cpp tels
// quels — pas une reimplementation — et les fait tourner sur une vraie DLL du
// SDK GOG. L'image est mappee a sa base preferee (0x180000000) en recopiant
// chaque section a son adresse virtuelle : les pointeurs absolus des vtables
// sont alors valides sans relocation, et le code travaille exactement comme
// dans le jeu.
//
// Il tourne sous Linux/g++ grace aux doublures de tests/stubs/. C'est
// delibere : le but est de pouvoir verifier la resolution sur n'importe
// quelle DLL de n'importe quel jeu, sans machine Windows.
//
// Usage :
//     ./run_tests.sh /chemin/vers/Galaxy64_o.dll
//
// Ce qui est verifie :
//   1. les vtables de StatsFacade et PeerUserFacade sont retrouvees par RTTI ;
//   2. chaque methode resolue reference bien la chaine qui porte son nom
//      (verification independante de l'index) ;
//   3. sur le SDK 1.123 de reference, les index valent 8, 10, 1 et 18.
// ============================================================================

#include "pattern_scanner.h"
#include "interface_resolver.h"
#include "galaxy_proxy.h"
#include "config.h"

#include <sys/mman.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <string>
#include <vector>

// ============================================================================
// Doublures des dependances
// ============================================================================
// Aucun ini, aucun cache : on teste le scenario interessant, celui d'un jeu
// inconnu lance pour la premiere fois, ou tout doit se resoudre seul.

namespace proxy {

OriginalFunctions g_original       = {};
HMODULE           g_originalModule = nullptr;

bool g_verboseLog = false;

void ProxyLog(const char* fmt, ...) {
    va_list a; va_start(a, fmt);
    std::printf("      | "); std::vprintf(fmt, a); std::printf("\n");
    va_end(a);
}
void ProxyLogVerbose(const char* fmt, ...) {
    if (!g_verboseLog) return;
    va_list a; va_start(a, fmt);
    std::printf("      . "); std::vprintf(fmt, a); std::printf("\n");
    va_end(a);
}
const char* SelfDirectory()      { return ""; }
const char* OriginalDllVersion() { return ""; }
bool HasOriginalDll()            { return true; }
bool EnsureOriginalLoaded()      { return true; }

namespace config {
void Load() {}
bool Verbose()                  { return g_verboseLog; }
bool DumpVtables()              { return false; }
bool ForceSignedIn()            { return true; }
bool UseVtablePatching()        { return false; }
int  StatsSetAchievementIndex() { return -1; }
int  StatsStoreIndex()          { return -1; }
int  UserSignedInIndex()        { return -1; }
int  UserIsLoggedOnIndex()      { return -1; }
int  CachedIndex(const char*, const char*) { return -1; }
void StoreIndex(const char*, const char*, int) {}
} // namespace config
} // namespace proxy

namespace {

// ============================================================================
// Chargement manuel de l'image
// ============================================================================

struct Image {
    uint8_t*    base = nullptr;
    std::string version;
};

std::string ReadFileVersion(const std::vector<uint8_t>& raw) {
    // "FileVersion" en UTF-16 dans la ressource VERSIONINFO, suivi de la
    // valeur. Suffisant pour reconnaitre le SDK de reference.
    static const uint8_t key[] = {'F',0,'i',0,'l',0,'e',0,'V',0,'e',0,'r',0,
                                  's',0,'i',0,'o',0,'n',0,0,0};
    for (size_t i = 0; i + sizeof(key) + 80 < raw.size(); ++i) {
        if (std::memcmp(raw.data() + i, key, sizeof(key)) != 0) continue;
        std::string out;
        const uint8_t* p = raw.data() + i + sizeof(key);
        for (int k = 0; k < 80 && out.size() < 24; k += 2) {
            const char c = static_cast<char>(p[k]);
            if (p[k + 1] != 0) break;
            if (c == '\0') { if (!out.empty()) break; continue; }
            if ((c >= '0' && c <= '9') || c == '.') out.push_back(c);
            else if (!out.empty()) break;
        }
        if (out.size() >= 5) return out;
    }
    return "";
}

Image MapImage(const char* path) {
    Image img;

    FILE* f = std::fopen(path, "rb");
    if (!f) { std::perror(path); return img; }
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (size <= 0x400) { std::fclose(f); return img; }

    std::vector<uint8_t> raw(static_cast<size_t>(size));
    const bool read = std::fread(raw.data(), 1, raw.size(), f) == raw.size();
    std::fclose(f);
    if (!read) return img;

    if (raw[0] != 'M' || raw[1] != 'Z') {
        std::fprintf(stderr, "%s : ce n'est pas un executable Windows\n", path);
        return img;
    }

    uint32_t lfanew; std::memcpy(&lfanew, raw.data() + 0x3C, 4);
    const uint8_t* nt = raw.data() + lfanew;
    if (std::memcmp(nt, "PE\0\0", 4) != 0) return img;

    uint16_t numSections; std::memcpy(&numSections, nt + 6, 2);
    uint16_t optSize;     std::memcpy(&optSize,     nt + 20, 2);
    const uint8_t* opt = nt + 24;

    uint16_t magic;       std::memcpy(&magic,       opt + 0,  2);
    if (magic != 0x20B) {
        std::fprintf(stderr, "%s : seul le x64 (PE32+) est gere\n", path);
        return img;
    }

    uint64_t imageBase;   std::memcpy(&imageBase,   opt + 24, 8);
    uint32_t sizeOfImage; std::memcpy(&sizeOfImage, opt + 56, 4);
    uint32_t sizeOfHdrs;  std::memcpy(&sizeOfHdrs,  opt + 60, 4);

    void* addr = mmap(reinterpret_cast<void*>(imageBase), sizeOfImage,
                      PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (addr == MAP_FAILED || addr != reinterpret_cast<void*>(imageBase)) {
        std::fprintf(stderr,
                     "mmap impossible a la base preferee 0x%llx — sans elle, "
                     "les pointeurs des vtables seraient faux\n",
                     static_cast<unsigned long long>(imageBase));
        return img;
    }

    auto* base = static_cast<uint8_t*>(addr);
    std::memcpy(base, raw.data(), sizeOfHdrs);

    const uint8_t* sec = opt + optSize;
    for (uint16_t i = 0; i < numSections; ++i, sec += 40) {
        uint32_t vaddr, rawSize, rawPtr;
        std::memcpy(&vaddr,   sec + 12, 4);
        std::memcpy(&rawSize, sec + 16, 4);
        std::memcpy(&rawPtr,  sec + 20, 4);
        if (rawSize && static_cast<size_t>(rawPtr) + rawSize <= raw.size())
            std::memcpy(base + vaddr, raw.data() + rawPtr, rawSize);
    }

    img.base    = base;
    img.version = ReadFileVersion(raw);
    return img;
}

// ============================================================================
// Recherche des vtables par RTTI
// ============================================================================
// Meme principe que scan::RttiClassName, mais en sens inverse : on part du
// nom de classe pour retrouver la vtable, ce dont la DLL n'a pas besoin a
// l'execution (elle recoit l'objet) mais dont le test a besoin pour se
// fabriquer un objet factice.

void** FindVtableByClassName(const proxy::scan::ModuleInfo& mi, const char* needle) {
    if (!mi.rdata) return nullptr;

    auto* const rdata = mi.rdata;
    const size_t n = mi.rdataSize;

    for (size_t off = 0; off + 8 <= n; off += 8) {
        auto** candidate = reinterpret_cast<void**>(rdata + off + 8);
        void* colPtr;
        std::memcpy(&colPtr, rdata + off, 8);
        if (!proxy::scan::IsInsideModule(mi, colPtr)) continue;

        auto* col = static_cast<const uint32_t*>(colPtr);
        if (!proxy::scan::IsInsideModule(mi, col + 6)) continue;
        if (col[0] != 1) continue;
        if (mi.base + col[5] != reinterpret_cast<const uint8_t*>(col)) continue;

        const uint32_t tdRva = col[3];
        if (!tdRva || tdRva + 16 >= mi.size) continue;

        const char* name = reinterpret_cast<const char*>(mi.base + tdRva + 16);
        if (name[0] != '.') continue;
        if (!std::strstr(name, needle)) continue;

        if (proxy::scan::VtableLength(mi, candidate, 128) >= 8) return candidate;
    }
    return nullptr;
}

// ============================================================================
// Assertions
// ============================================================================

int g_failures = 0;
int g_checks   = 0;

void Ok(bool condition, const char* what) {
    ++g_checks;
    if (!condition) ++g_failures;
    std::printf("  [%s] %s\n", condition ? "OK   " : "ECHEC", what);
}

void Equals(const char* what, int got, int expected) {
    ++g_checks;
    const bool ok = (got == expected);
    if (!ok) ++g_failures;
    std::printf("  [%s] %-44s attendu %2d, obtenu %2d\n",
                ok ? "OK   " : "ECHEC", what, expected, got);
}

// Verification independante de l'index : la fonction resolue reference-t-elle
// bien une chaine qui porte le nom attendu ? C'est ce qui rend le test utile
// sur une DLL dont on ignore la disposition.
bool SlotNamesMethod(const proxy::scan::ModuleInfo& mi,
                     const proxy::resolve::Slot& slot, const char* method) {
    if (!slot.Ok()) return false;
    char text[200];
    if (!proxy::scan::FirstReferencedString(
            mi, static_cast<const uint8_t*>(slot.target), text, sizeof(text)))
        return false;
    return std::strstr(text, method) == text;
}

} // namespace

// ============================================================================

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr,
                     "usage: %s <Galaxy64_o.dll> [-v]\n"
                     "\n"
                     "Pointe-le vers la vraie DLL du SDK GOG d'un de tes jeux.\n",
                     argv[0]);
        return 2;
    }
    for (int i = 2; i < argc; ++i)
        if (std::strcmp(argv[i], "-v") == 0) proxy::g_verboseLog = true;

    Image img = MapImage(argv[1]);
    if (!img.base) return 2;

    proxy::g_originalModule = reinterpret_cast<HMODULE>(img.base);

    proxy::scan::ModuleInfo mi;
    if (!proxy::scan::GetModuleInfo(proxy::g_originalModule, mi)) {
        std::fprintf(stderr, "GetModuleInfo a echoue\n");
        return 2;
    }

    std::printf("%s\n", argv[1]);
    std::printf("  SDK %s — image 0x%zx, .text 0x%zx, .rdata 0x%zx, "
                "%zu fonctions dans .pdata\n\n",
                img.version.empty() ? "(version inconnue)" : img.version.c_str(),
                mi.size, mi.textSize, mi.rdataSize, mi.pdataCount);

    const bool isReferenceSdk = (img.version == "1.123.0.0");

    // ---------------------------------------------------------------- IStats
    std::printf("--- IStats ---\n");
    void** statsVtable = FindVtableByClassName(mi, "StatsFacade@facade");
    Ok(statsVtable != nullptr, "vtable de StatsFacade retrouvee par RTTI");
    if (!statsVtable) { std::printf("\nECHEC\n"); return 1; }

    void* fakeStats = &statsVtable;
    std::printf("       classe %s, %zu slots\n",
                proxy::scan::RttiClassName(mi, fakeStats),
                proxy::scan::VtableLength(mi, statsVtable, 128));

    const auto setAch = proxy::resolve::FindStatsSetAchievement(fakeStats);
    const auto store  = proxy::resolve::FindStatsStore(fakeStats);

    Ok(setAch.Ok(), "SetAchievement resolu");
    Ok(setAch.source == proxy::resolve::Source::LogString,
       "SetAchievement identifie dans le binaire (pas par repli)");
    Ok(SlotNamesMethod(mi, setAch, "SetAchievement"),
       "le slot retenu reference bien \"SetAchievement...\"");
    Ok(store.Ok() && SlotNamesMethod(mi, store, "StoreStatsAndAchievements"),
       "le slot retenu reference bien \"StoreStatsAndAchievements...\"");

    // Le thunk d'edition de liens incrementale doit avoir ete deroule :
    // MinHook ne peut pas poser de trampoline sur 5 octets de `jmp`.
    Ok(setAch.target != statsVtable[setAch.index],
       "thunk deroule (la cible du hook n'est pas l'entree de vtable)");

    std::printf("       SetAchievement : slot %d, +0x%llx (%s)\n",
                setAch.index,
                static_cast<unsigned long long>(
                    static_cast<uint8_t*>(setAch.target) - mi.base),
                proxy::resolve::SourceName(setAch.source));

    // ----------------------------------------------------------------- IUser
    std::printf("\n--- IUser ---\n");
    void** userVtable = FindVtableByClassName(mi, "PeerUserFacade@facade");
    Ok(userVtable != nullptr, "vtable de PeerUserFacade retrouvee par RTTI");
    if (userVtable) {
        void* fakeUser = &userVtable;
        std::printf("       classe %s, %zu slots\n",
                    proxy::scan::RttiClassName(mi, fakeUser),
                    proxy::scan::VtableLength(mi, userVtable, 128));

        const auto signedIn   = proxy::resolve::FindUserSignedIn(fakeUser);
        const auto isLoggedOn = proxy::resolve::FindUserIsLoggedOn(fakeUser);

        Ok(signedIn.Ok(),   "SignedIn resolu");
        Ok(isLoggedOn.Ok(), "IsLoggedOn resolu");
        Ok(signedIn.source == proxy::resolve::Source::Anchor,
           "SignedIn ancre sur la famille SignIn (pas de repli aveugle)");
        Ok(isLoggedOn.source == proxy::resolve::Source::Anchor,
           "IsLoggedOn ancre entre DeleteUserData et RequestEncryptedAppTicket");

        // Ces deux-la n'ecrivent aucune trace : c'est justement pourquoi
        // elles sont localisees par ancrage. Le verifier evite de confondre
        // un ancrage juste avec un ancrage qui aurait glisse d'un cran.
        Ok(!SlotNamesMethod(mi, signedIn, "SignIn"),
           "le slot SignedIn n'est pas une surcharge de SignIn");

        if (isReferenceSdk) {
            Equals("IUser::SignedIn (SDK 1.123)",   signedIn.index,   1);
            Equals("IUser::IsLoggedOn (SDK 1.123)", isLoggedOn.index, 18);
        } else {
            std::printf("       SignedIn = %d, IsLoggedOn = %d\n",
                        signedIn.index, isLoggedOn.index);
        }
    }

    if (isReferenceSdk) {
        std::printf("\n--- Index de reference (SDK 1.123.0.0) ---\n");
        Equals("IStats::SetAchievement",            setAch.index,  8);
        Equals("IStats::StoreStatsAndAchievements", store.index,  10);
    }

    std::printf("\n%s — %d verification(s), %d echec(s)\n",
                g_failures ? "ECHEC" : "TOUT PASSE", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
