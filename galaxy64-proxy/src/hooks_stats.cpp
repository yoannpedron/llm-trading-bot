// ============================================================================
// hooks_stats.cpp — Interception de IStats
//
// Transposition directe de l'ancien MockStats, sans le mock : au lieu de
// reimplementer l'interface, on detourne les deux methodes qui nous
// interessent dans l'implementation reelle. La sequence est la meme —
// journal, notification IPC, puis transmission a l'original — mais elle
// s'execute a l'interieur du code de GOG, sur la vtable de GOG, donc sans
// aucune hypothese sur la disposition des autres methodes.
// ============================================================================

#include "hooks.h"
#include "galaxy_proxy.h"
#include "ipc_client.h"

namespace proxy {
namespace hooks {

namespace {

// Sur x64, __cdecl / __stdcall / __fastcall se confondent : une fonction
// libre dont le premier parametre est le `this` a exactement l'ABI d'une
// methode virtuelle.
using SetAchievementFn = void (*)(void* self, const char* name);
using StoreFn          = void (*)(void* self, void* listener);

SetAchievementFn g_setAchievementOriginal = nullptr;
StoreFn          g_storeOriginal          = nullptr;

hook::DetourHook g_setAchievementDetour;
hook::VtableHook g_setAchievementVtable;
hook::DetourHook g_storeDetour;
hook::VtableHook g_storeVtable;

// --------------------------------------------------------------------------
// Les detours
// --------------------------------------------------------------------------

void Hook_SetAchievement(void* self, const char* name) {
    ProxyLog("SetAchievement intercepte: %s", name ? name : "(null)");

    if (name) {
        SendAchievementNotification(name);
    }

    // Toujours transmettre : si le client GOG tourne vraiment, le succes
    // doit aussi remonter chez eux. Notre notification est un ajout, pas un
    // remplacement.
    if (g_setAchievementOriginal) {
        g_setAchievementOriginal(self, name);
    }
}

void Hook_StoreStatsAndAchievements(void* self, void* listener) {
    ProxyLog("StoreStatsAndAchievements intercepte");
    SendStoreNotification();

    if (g_storeOriginal) {
        g_storeOriginal(self, listener);
    }
}

} // namespace

// --------------------------------------------------------------------------
// Pose
// --------------------------------------------------------------------------

bool InstallStatsHooks() {
    if (g_setAchievementOriginal) return true;   // deja en place

    if (!g_original.stats) return false;
    void* stats = g_original.stats();
    if (!stats) return false;                    // pas encore pret

    const resolve::Slot setAch = resolve::FindStatsSetAchievement(stats);
    if (!setAch.Ok()) {
        ProxyLog("IStats::SetAchievement introuvable — aucune interception "
                 "de succes ne sera possible");
        return false;
    }

    void* original = nullptr;
    if (!detail::InstallOn(setAch, reinterpret_cast<void*>(&Hook_SetAchievement),
                           &original, g_setAchievementDetour, g_setAchievementVtable,
                           "IStats::SetAchievement")) {
        return false;
    }
    g_setAchievementOriginal = reinterpret_cast<SetAchievementFn>(original);

    // StoreStatsAndAchievements est secondaire : son echec ne doit pas
    // annuler l'interception des succes, qui est la raison d'etre du proxy.
    const resolve::Slot store = resolve::FindStatsStore(stats);
    if (store.Ok()) {
        void* storeOriginal = nullptr;
        if (detail::InstallOn(store, reinterpret_cast<void*>(&Hook_StoreStatsAndAchievements),
                              &storeOriginal, g_storeDetour, g_storeVtable,
                              "IStats::StoreStatsAndAchievements")) {
            g_storeOriginal = reinterpret_cast<StoreFn>(storeOriginal);
        }
    } else {
        ProxyLog("IStats::StoreStatsAndAchievements introuvable — "
                 "notification de persistance desactivee");
    }

    return true;
}

void RemoveStatsHooks() {
    g_setAchievementDetour.Remove();
    g_setAchievementVtable.Remove();
    g_storeDetour.Remove();
    g_storeVtable.Remove();

    g_setAchievementOriginal = nullptr;
    g_storeOriginal          = nullptr;
}

} // namespace hooks
} // namespace proxy
