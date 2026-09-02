// ============================================================================
// hooks_user.cpp — Interception de IUser
//
// But : faire croire au jeu que l'utilisateur est connecte, meme sans client
// GOG Galaxy. Sans cela, rien ne part : la propre implementation de GOG
// commence par « SetAchievement: not signed in with Galaxy » et sort
// immediatement, et la plupart des jeux verifient SignedIn() avant meme
// d'appeler quoi que ce soit.
//
// Nuance importante : on APPELLE l'original avant de repondre true. Cela ne
// change rien au resultat vu par le jeu, mais laisse la machine interne de
// GOG suivre son cours quand le client tourne pour de bon. Repondre true
// sans jamais executer l'original ferait diverger l'etat interne de la DLL.
// ============================================================================

#include "hooks.h"
#include "galaxy_proxy.h"
#include "config.h"

namespace proxy {
namespace hooks {

namespace {

using BoolMethodFn = bool (*)(void* self);

BoolMethodFn g_signedInOriginal   = nullptr;
BoolMethodFn g_isLoggedOnOriginal = nullptr;

hook::DetourHook g_signedInDetour;
hook::VtableHook g_signedInVtable;
hook::DetourHook g_isLoggedOnDetour;
hook::VtableHook g_isLoggedOnVtable;

bool g_saidSignedIn   = false;
bool g_saidIsLoggedOn = false;

bool Hook_SignedIn(void* self) {
    const bool real = g_signedInOriginal ? g_signedInOriginal(self) : false;
    if (real) return true;
    if (!config::ForceSignedIn()) return false;

    if (!g_saidSignedIn) {
        g_saidSignedIn = true;
        ProxyLog("IUser::SignedIn force a true (le client GOG ne repond pas)");
    }
    return true;
}

bool Hook_IsLoggedOn(void* self) {
    const bool real = g_isLoggedOnOriginal ? g_isLoggedOnOriginal(self) : false;
    if (real) return true;
    if (!config::ForceSignedIn()) return false;

    if (!g_saidIsLoggedOn) {
        g_saidIsLoggedOn = true;
        ProxyLog("IUser::IsLoggedOn force a true (le client GOG ne repond pas)");
    }
    return true;
}

} // namespace

bool InstallUserHooks() {
    if (g_signedInOriginal) return true;

    if (!config::ForceSignedIn()) {
        ProxyLog("IUser: forcage desactive ([user] force_signed_in=0)");
        return true;   // rien a faire, mais rien en attente non plus
    }

    if (!g_original.user) return false;
    void* user = g_original.user();
    if (!user) return false;

    const resolve::Slot signedIn = resolve::FindUserSignedIn(user);
    if (!signedIn.Ok()) return false;

    void* original = nullptr;
    if (!detail::InstallOn(signedIn, reinterpret_cast<void*>(&Hook_SignedIn),
                           &original, g_signedInDetour, g_signedInVtable,
                           "IUser::SignedIn")) {
        return false;
    }
    g_signedInOriginal = reinterpret_cast<BoolMethodFn>(original);

    // IsLoggedOn n'ecrit aucune trace : elle n'est localisable que par
    // ancrage, ce qui peut echouer sur un SDK inconnu. Ne pas la trouver
    // n'annule pas SignedIn, deja pose.
    const resolve::Slot isLoggedOn = resolve::FindUserIsLoggedOn(user);
    if (isLoggedOn.Ok()) {
        void* loggedOnOriginal = nullptr;
        if (detail::InstallOn(isLoggedOn, reinterpret_cast<void*>(&Hook_IsLoggedOn),
                              &loggedOnOriginal, g_isLoggedOnDetour, g_isLoggedOnVtable,
                              "IUser::IsLoggedOn")) {
            g_isLoggedOnOriginal = reinterpret_cast<BoolMethodFn>(loggedOnOriginal);
        }
    }

    return true;
}

void RemoveUserHooks() {
    g_signedInDetour.Remove();
    g_signedInVtable.Remove();
    g_isLoggedOnDetour.Remove();
    g_isLoggedOnVtable.Remove();

    g_signedInOriginal   = nullptr;
    g_isLoggedOnOriginal = nullptr;
}

} // namespace hooks
} // namespace proxy
