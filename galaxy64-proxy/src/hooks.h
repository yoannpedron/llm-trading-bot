#pragma once
// ============================================================================
// hooks.h — Pose et depose des interceptions
//
// Deux familles :
//   - IStats : SetAchievement et StoreStatsAndAchievements, notifies au
//     launcher par le pipe nomme puis transmis a l'implementation d'origine ;
//   - IUser  : SignedIn et IsLoggedOn, forces a true pour que le jeu
//     declenche ses succes meme sans client GOG Galaxy.
//
// Les interfaces n'existent qu'apres Init(), et certaines versions du SDK
// les rendent nulles jusqu'a la premiere passe de ProcessData(). InstallAll()
// est donc idempotente et rejouable : on la rappelle jusqu'a ce que tout
// soit en place.
// ============================================================================

#include "interface_resolver.h"
#include "vtable_hook.h"

namespace proxy {
namespace hooks {

// Tente de poser les hooks manquants. Sans effet une fois tout en place.
// Thread-safe.
void InstallAll();

// Retire tout. A appeler avant de transmettre Shutdown() a la vraie DLL :
// apres, les vtables visees peuvent avoir disparu.
void RemoveAll();

// Vrai quand plus rien n'est en attente (soit pose, soit abandonne).
bool Settled();

namespace detail {

// Pose une interception sur `slot` selon [hook] mode, avec repli automatique
// sur le patch de vtable si MinHook echoue. `outOriginal` recoit de quoi
// appeler la fonction d'origine (trampoline MinHook, ou ancien pointeur de
// slot).
bool InstallOn(const resolve::Slot& slot, void* replacement, void** outOriginal,
               hook::DetourHook& detour, hook::VtableHook& vtable,
               const char* label);

} // namespace detail
} // namespace hooks
} // namespace proxy
