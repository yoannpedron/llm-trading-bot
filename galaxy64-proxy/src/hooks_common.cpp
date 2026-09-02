// ============================================================================
// hooks_common.cpp — Orchestration de la pose des hooks
// ============================================================================

#include "hooks.h"
#include "galaxy_proxy.h"
#include "config.h"

namespace proxy {
namespace hooks {

// Definis dans hooks_stats.cpp / hooks_user.cpp.
bool InstallStatsHooks();
bool InstallUserHooks();
void RemoveStatsHooks();
void RemoveUserHooks();

namespace {

SRWLOCK g_lock = SRWLOCK_INIT;

bool g_statsDone   = false;
bool g_userDone    = false;
bool g_dumped      = false;

// Au-dela de cette limite, on cesse d'essayer : soit le jeu n'utilise pas
// ces interfaces, soit quelque chose ne se resoudra jamais. Sans ce garde-
// fou, ProcessData() relancerait un scan a chaque image.
constexpr int kMaxAttempts = 600;
int g_attempts = 0;

} // namespace

namespace detail {

bool InstallOn(const resolve::Slot& slot, void* replacement, void** outOriginal,
               hook::DetourHook& detour, hook::VtableHook& vtable,
               const char* label) {
    if (!slot.Ok() || !replacement || !outOriginal) return false;

    const bool preferVtable = config::UseVtablePatching();

    // Chemin nominal : detour du corps de la fonction. Il intercepte tout
    // appelant, y compris ceux qui ne passent pas par la vtable de l'objet
    // (adresse mise en cache par le jeu, vtable recopiee, appel interne de
    // la DLL a sa propre methode).
    if (!preferVtable && detour.Install(slot.target, replacement)) {
        *outOriginal = detour.Original();
        ProxyLog("Hook pose sur %s : MinHook @ +0x%llX (slot %d, %s)",
                 label,
                 static_cast<unsigned long long>(
                     static_cast<uint8_t*>(slot.target) -
                     reinterpret_cast<uint8_t*>(g_originalModule)),
                 slot.index, resolve::SourceName(slot.source));
        return true;
    }

    // Repli : remplacement du pointeur dans la vtable. N'ecrit pas un octet
    // de code, donc marche meme quand le prologue resiste au trampoline.
    if (vtable.Install(slot.vtable, static_cast<size_t>(slot.index), replacement)) {
        *outOriginal = vtable.Original();
        ProxyLog("Hook pose sur %s : patch de vtable, slot %d (%s)%s",
                 label, slot.index, resolve::SourceName(slot.source),
                 preferVtable ? "" : " — MinHook a echoue, repli");
        return true;
    }

    ProxyLog("Hook NON pose sur %s (slot %d)", label, slot.index);
    return false;
}

} // namespace detail

void InstallAll() {
    AcquireSRWLockExclusive(&g_lock);

    if (!g_statsDone || !g_userDone) {
        if (++g_attempts <= kMaxAttempts) {
            if (config::DumpVtables() && !g_dumped) {
                void* stats = g_original.stats ? g_original.stats() : nullptr;
                void* user  = g_original.user  ? g_original.user()  : nullptr;
                if (stats || user) {
                    if (stats) resolve::DumpVtable(stats, "IStats");
                    if (user)  resolve::DumpVtable(user,  "IUser");
                    g_dumped = true;
                }
            }

            if (!g_statsDone) g_statsDone = InstallStatsHooks();
            if (!g_userDone)  g_userDone  = InstallUserHooks();

            if (g_attempts == kMaxAttempts && (!g_statsDone || !g_userDone)) {
                ProxyLog("Hooks: abandon apres %d tentatives (stats=%s, user=%s)",
                         kMaxAttempts,
                         g_statsDone ? "ok" : "echec",
                         g_userDone  ? "ok" : "echec");
            }
        }
    }

    ReleaseSRWLockExclusive(&g_lock);
}

void RemoveAll() {
    AcquireSRWLockExclusive(&g_lock);

    RemoveStatsHooks();
    RemoveUserHooks();
    hook::ShutdownEngine();

    g_statsDone = false;
    g_userDone  = false;
    g_attempts  = 0;

    ReleaseSRWLockExclusive(&g_lock);
}

bool Settled() {
    AcquireSRWLockShared(&g_lock);
    const bool done = (g_statsDone && g_userDone) || g_attempts >= kMaxAttempts;
    ReleaseSRWLockShared(&g_lock);
    return done;
}

} // namespace hooks
} // namespace proxy
