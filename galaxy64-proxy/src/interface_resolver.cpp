// ============================================================================
// interface_resolver.cpp — Identification des methodes dans la vraie vtable
// ============================================================================

#include "interface_resolver.h"
#include "pattern_scanner.h"
#include "galaxy_proxy.h"
#include "config.h"

#include <cstring>
#include <cstdio>

namespace proxy {
namespace resolve {

namespace {

// Une vtable d'interface GOG depasse rarement 40 entrees ; 128 laisse de la
// marge sans risquer de lire au-dela de .rdata.
constexpr size_t kMaxVtableSlots = 128;

// Nombre d'adresses de chaines retenues par prefixe. Une methode reference
// typiquement deux a trois variantes ("...: not signed in with Galaxy",
// "...: name=%s").
constexpr size_t kMaxStringsPerPrefix = 16;

bool ModuleOfOriginal(scan::ModuleInfo& mi) {
    return g_originalModule && scan::GetModuleInfo(g_originalModule, mi);
}

void** VtableOf(void* object) {
    if (!object) return nullptr;
    return *reinterpret_cast<void***>(object);
}

// --------------------------------------------------------------------------
// Coeur : quel slot reference la chaine qui nomme cette methode ?
// --------------------------------------------------------------------------
// `depth` = 0 : la chaine doit etre referencee par la methode elle-meme.
//               C'est le cas sur toutes les facades v1.123 verifiees.
// `depth` = 1 : on suit un niveau d'appels directs, pour les versions ou la
//               facade delegue a un helper.
//
// Retourne -1 si zero ou plusieurs slots correspondent : une ambiguite ne
// vaut pas mieux qu'une supposition, et il vaut mieux basculer sur le repli
// en le disant que hooker la mauvaise methode en silence.
int FindSlotReferencing(const scan::ModuleInfo& mi, void** vtable, size_t vtableLen,
                        const char* prefix, int depth) {
    const uint8_t* strings[kMaxStringsPerPrefix];
    const size_t stringCount =
        scan::FindStringsWithPrefix(mi, prefix, strings, kMaxStringsPerPrefix);

    if (stringCount == 0) {
        ProxyLogVerbose("Resolveur: aucune chaine '%s' dans le binaire", prefix);
        return -1;
    }

    int found = -1;
    int matches = 0;
    for (size_t i = 0; i < vtableLen; ++i) {
        const auto* fn = static_cast<const uint8_t*>(vtable[i]);
        if (scan::FunctionReferencesAny(mi, fn, strings, stringCount, depth)) {
            if (matches == 0) found = static_cast<int>(i);
            ++matches;
        }
    }

    if (matches == 1) {
        ProxyLogVerbose("Resolveur: '%s' -> slot %d (profondeur %d)", prefix, found, depth);
        return found;
    }
    if (matches > 1) {
        ProxyLog("Resolveur: '%s' correspond a %d slots — ambigu, ignore", prefix, matches);
    }
    return -1;
}

// Essaie profondeur 0, puis profondeur 1.
int FindSlotByLogString(const scan::ModuleInfo& mi, void** vtable, size_t vtableLen,
                        const char* prefix) {
    int slot = FindSlotReferencing(mi, vtable, vtableLen, prefix, 0);
    if (slot < 0) slot = FindSlotReferencing(mi, vtable, vtableLen, prefix, 1);
    return slot;
}

// --------------------------------------------------------------------------
// Assemblage d'un Slot valide
// --------------------------------------------------------------------------

Slot MakeSlot(const scan::ModuleInfo& mi, void** vtable, size_t vtableLen,
              int index, Source source) {
    Slot s;
    if (index < 0 || static_cast<size_t>(index) >= vtableLen) return s;

    auto* raw = static_cast<uint8_t*>(vtable[index]);
    if (!scan::IsExecutable(mi, raw)) return s;

    // Les entrees de vtable de Galaxy64.dll pointent vers des thunks `jmp`
    // de 5 octets (edition de liens incrementale). MinHook doit detourner le
    // corps reel, pas le thunk : 5 octets ne suffisent pas a poser un saut
    // et le trampoline ecraserait le thunk voisin.
    const uint8_t* body = scan::ResolveThunk(mi, raw);

    s.index  = index;
    s.target = const_cast<uint8_t*>(body);
    s.vtable = vtable;
    s.source = source;
    return s;
}

// --------------------------------------------------------------------------
// Resolution generique pour une methode identifiable par sa trace
// --------------------------------------------------------------------------

Slot ResolveByLogString(void* object, const char* label, const char* logPrefix,
                        const char* cacheKey, int pinnedIndex, int fallbackIndex) {
    Slot result;

    scan::ModuleInfo mi;
    if (!ModuleOfOriginal(mi)) {
        ProxyLog("Resolveur: en-tetes PE de Galaxy64_o.dll illisibles");
        return result;
    }

    void** vtable = VtableOf(object);
    const size_t len = scan::VtableLength(mi, vtable, kMaxVtableSlots);
    if (len == 0) {
        ProxyLog("Resolveur: vtable de %s illisible", label);
        return result;
    }

    // 1. Epinglage explicite : l'utilisateur a toujours le dernier mot.
    if (pinnedIndex >= 0) {
        result = MakeSlot(mi, vtable, len, pinnedIndex, Source::Pinned);
        if (result.Ok()) return result;
        ProxyLog("Resolveur: indice epingle %d invalide pour %s (%zu slots)",
                 pinnedIndex, label, len);
    }

    // 2. Lecture du binaire — le cas nominal.
    const int scanned = FindSlotByLogString(mi, vtable, len, logPrefix);
    if (scanned >= 0) {
        result = MakeSlot(mi, vtable, len, scanned, Source::LogString);
        if (result.Ok()) {
            config::StoreIndex(OriginalDllVersion(), cacheKey, scanned);
            return result;
        }
    }

    // 3. Resolution memorisee lors d'un lancement precedent.
    const int cached = config::CachedIndex(OriginalDllVersion(), cacheKey);
    if (cached >= 0) {
        result = MakeSlot(mi, vtable, len, cached, Source::Cache);
        if (result.Ok()) {
            ProxyLog("Resolveur: %s repris du cache (slot %d)", label, cached);
            return result;
        }
    }

    // 4. Ordre des en-tetes publics. A signaler : c'est exactement le pari
    //    qui faisait echouer l'ancienne version en silence.
    ProxyLog("Resolveur: %s NON identifie dans le binaire — repli sur "
             "l'indice %d des en-tetes publics. Verifie-le avec "
             "[log] dump_vtables=1 puis epingle-le dans galaxy_proxy.ini.",
             label, fallbackIndex);
    return MakeSlot(mi, vtable, len, fallbackIndex, Source::Fallback);
}

} // namespace

// ============================================================================
// Noms lisibles
// ============================================================================

const char* SourceName(Source s) {
    switch (s) {
        case Source::Pinned:    return "epingle dans l'ini";
        case Source::LogString: return "lu dans le binaire";
        case Source::Anchor:    return "deduit par ancrage";
        case Source::Pattern:   return "signature d'octets";
        case Source::Cache:     return "cache";
        case Source::Fallback:  return "REPLI (en-tetes publics)";
        default:                return "inconnu";
    }
}

// ============================================================================
// IStats
// ============================================================================
// Indices de repli : ordre des en-tetes publics v1.148, ou SetAchievement
// est en 8 et StoreStatsAndAchievements en 10. Ces deux valeurs se trouvent
// coincider avec le binaire v1.123 verifie — mais rien ne garantit qu'elles
// tiennent ailleurs, d'ou le scan.

Slot FindStatsSetAchievement(void* stats) {
    return ResolveByLogString(stats, "IStats::SetAchievement",
                              "SetAchievement:", "set_achievement",
                              config::StatsSetAchievementIndex(), 8);
}

Slot FindStatsStore(void* stats) {
    return ResolveByLogString(stats, "IStats::StoreStatsAndAchievements",
                              "StoreStatsAndAchievements:", "store",
                              config::StatsStoreIndex(), 10);
}

// ============================================================================
// IUser
// ============================================================================
// SignedIn et IsLoggedOn sont de simples accesseurs : elles n'ecrivent
// aucune trace et ne referencent donc aucune chaine. On les situe par
// rapport a des voisines, elles, identifiables.

Slot FindUserSignedIn(void* user) {
    Slot result;

    scan::ModuleInfo mi;
    if (!ModuleOfOriginal(mi)) return result;

    void** vtable = VtableOf(user);
    const size_t len = scan::VtableLength(mi, vtable, kMaxVtableSlots);
    if (len == 0) {
        ProxyLog("Resolveur: vtable de IUser illisible");
        return result;
    }

    const int pinned = config::UserSignedInIndex();
    if (pinned >= 0) {
        result = MakeSlot(mi, vtable, len, pinned, Source::Pinned);
        if (result.Ok()) return result;
    }

    // Ancrage : la famille des surcharges de SignIn commence juste apres
    // SignedIn et GetGalaxyID. Sur le binaire v1.123, le premier slot qui
    // reference "SignIn:" est le 3 ; SignedIn est donc en 1.
    //
    // On ne peut pas utiliser FindSlotByLogString ici : les six surcharges
    // de SignIn partagent les memes chaines, la correspondance est donc
    // multiple par construction. On prend le premier slot correspondant.
    const uint8_t* strings[kMaxStringsPerPrefix];
    const size_t n = scan::FindStringsWithPrefix(mi, "SignIn:", strings, kMaxStringsPerPrefix);
    if (n > 0) {
        for (size_t i = 0; i < len; ++i) {
            if (!scan::FunctionReferencesAny(mi, static_cast<const uint8_t*>(vtable[i]),
                                             strings, n, 0))
                continue;

            const int signedIn = static_cast<int>(i) - 2;
            if (signedIn >= 1) {
                result = MakeSlot(mi, vtable, len, signedIn, Source::Anchor);
                if (result.Ok()) {
                    ProxyLogVerbose("Resolveur: SignIn* commence au slot %zu "
                                    "-> SignedIn = %d", i, signedIn);
                    return result;
                }
            }
            break;
        }
    }

    // Repli : SignedIn est la premiere methode declaree de IUser dans toutes
    // les versions publiees du SDK, donc le slot 1 (le 0 etant le
    // destructeur scalaire deleting de MSVC).
    ProxyLog("Resolveur: IUser::SignedIn non ancre — repli sur le slot 1");
    return MakeSlot(mi, vtable, len, 1, Source::Fallback);
}

Slot FindUserIsLoggedOn(void* user) {
    Slot result;

    scan::ModuleInfo mi;
    if (!ModuleOfOriginal(mi)) return result;

    void** vtable = VtableOf(user);
    const size_t len = scan::VtableLength(mi, vtable, kMaxVtableSlots);
    if (len == 0) return result;

    const int pinned = config::UserIsLoggedOnIndex();
    if (pinned >= 0) {
        result = MakeSlot(mi, vtable, len, pinned, Source::Pinned);
        if (result.Ok()) return result;
    }

    // Ancrage : dans l'ordre de declaration du SDK, IsLoggedOn est coincee
    // entre DeleteUserData et RequestEncryptedAppTicket. Ces deux-la
    // ecrivent une trace, donc se laissent identifier.
    // Verifie sur v1.123 : DeleteUserData = 17, RequestEncryptedAppTicket
    // = 19, donc IsLoggedOn = 18 (la ou les en-tetes v1.148 disent 15).
    const int before = FindSlotByLogString(mi, vtable, len, "DeleteUserData:");
    const int after  = FindSlotByLogString(mi, vtable, len, "RequestEncryptedAppTicket:");

    if (before >= 0 && after == before + 2) {
        result = MakeSlot(mi, vtable, len, before + 1, Source::Anchor);
        if (result.Ok()) {
            ProxyLogVerbose("Resolveur: IsLoggedOn ancre entre %d et %d -> slot %d",
                            before, after, before + 1);
            config::StoreIndex(OriginalDllVersion(), "is_logged_on", before + 1);
            return result;
        }
    }

    if (before >= 0 && after < 0) {
        // Un seul ancrage : plausible, mais on le dit.
        ProxyLog("Resolveur: IsLoggedOn ancre sur le seul DeleteUserData "
                 "(slot %d) -> slot %d, a verifier", before, before + 1);
        result = MakeSlot(mi, vtable, len, before + 1, Source::Anchor);
        if (result.Ok()) return result;
    }

    const int cached = config::CachedIndex(OriginalDllVersion(), "is_logged_on");
    if (cached >= 0) {
        result = MakeSlot(mi, vtable, len, cached, Source::Cache);
        if (result.Ok()) return result;
    }

    ProxyLog("Resolveur: IUser::IsLoggedOn NON localise — aucun hook pose. "
             "Lance une fois avec [log] dump_vtables=1 puis renseigne "
             "[user] is_logged_on_index dans galaxy_proxy.ini.");
    return Slot{};
}

// ============================================================================
// Diagnostic
// ============================================================================

void DumpVtable(void* object, const char* label) {
    scan::ModuleInfo mi;
    if (!ModuleOfOriginal(mi)) return;

    void** vtable = VtableOf(object);
    const size_t len = scan::VtableLength(mi, vtable, kMaxVtableSlots);
    if (len == 0) {
        ProxyLog("Dump %s: vtable illisible", label);
        return;
    }

    const char* rtti = scan::RttiClassName(mi, object);
    ProxyLog("--- Dump vtable %s : %zu slots, classe %s ---",
             label, len, rtti ? rtti : "(RTTI absent)");

    for (size_t i = 0; i < len; ++i) {
        auto* raw  = static_cast<uint8_t*>(vtable[i]);
        auto* body = const_cast<uint8_t*>(scan::ResolveThunk(mi, raw));

        char text[160];
        const bool hasText = scan::FirstReferencedString(mi, body, text, sizeof(text));

        ProxyLog("  [%2zu] +0x%-6llX  %s",
                 i,
                 static_cast<unsigned long long>(body - mi.base),
                 hasText ? text : "(aucune chaine)");
    }

    ProxyLog("--- fin du dump %s ---", label);
}

} // namespace resolve
} // namespace proxy
